#!/usr/bin/env python3
"""Build a smaller public dataset for deployment by re-encoding the published panoramas at a lower face size.

Reads the published layout (public/data: worlds.json, <slug>/world.json, <slug>/map/, panos/<key>/) and writes a
complete copy to the output directory, ready for deploy/scripts/push-data.sh --source:

  <out>/worlds.json                       copied
  <out>/<slug>/world.json                 pano.faceSize / tileSize / nbTiles rewritten for the new size
  <out>/<slug>/map/                       hard links to the published tiles (no extra disk)
  <out>/panos/<key>/base_<face>.webp      hard links to the published 512 px base faces (kept as they are)
  <out>/panos/<key>/<face>_<c>_<r>.webp   the 2048 px face re-assembled from its tiles, downscaled with Lanczos,
                                          cut into nbTiles x nbTiles tiles, WebP method 4 at --quality

Nothing else under public/data is copied (panos-cmp in particular maps keys to place names and must never ship).
The owner picked 1536 px q70 on 2026-10-08 after comparing variants in dev/compare.html. Tiles are re-encoded from
the q78 originals, so they carry slight generation loss compared with a fresh render at that setting.

Usage:
  uv run --with pillow python tools/make_release.py [--face 1536] [--quality 70] [--out out/release-f1536q70] [--workers N]
Re-running skips nodes whose tiles already exist (use --force to rebuild).
"""
import argparse
import json
import os
import shutil
import sys
from concurrent.futures import ProcessPoolExecutor

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'public', 'data')
FACES = ['front', 'right', 'back', 'left', 'top', 'bottom']
SRC_FACE, SRC_TILE = 2048, 1024


def link_or_copy(src, dst):
    if os.path.exists(dst):
        return
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def encode_node(job):
    key, out_root, face_size, tiles, quality, force = job
    src = os.path.join(SRC, 'panos', key)
    dst = os.path.join(out_root, 'panos', key)
    tile = face_size // tiles
    names = ['%s_%d_%d.webp' % (f, c, r) for f in FACES for c in range(tiles) for r in range(tiles)]
    if not force and all(os.path.exists(os.path.join(dst, n)) for n in names):
        return key, 0
    os.makedirs(dst, exist_ok=True)
    for face in FACES:
        link_or_copy(os.path.join(src, 'base_%s.webp' % face), os.path.join(dst, 'base_%s.webp' % face))
        full = Image.new('RGB', (SRC_FACE, SRC_FACE))
        n = SRC_FACE // SRC_TILE
        for c in range(n):
            for r in range(n):
                with Image.open(os.path.join(src, '%s_%d_%d.webp' % (face, c, r))) as im:
                    full.paste(im.convert('RGB'), (c * SRC_TILE, r * SRC_TILE))
        img = full if face_size == SRC_FACE else full.resize((face_size, face_size), Image.LANCZOS)
        for c in range(tiles):
            for r in range(tiles):
                box = (c * tile, r * tile, (c + 1) * tile, (r + 1) * tile)
                path = os.path.join(dst, '%s_%d_%d.webp' % (face, c, r))
                img.crop(box).save(path + '.tmp', 'WEBP', quality=quality, method=4)
                os.replace(path + '.tmp', path)
    return key, 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--face', type=int, default=1536)
    ap.add_argument('--tiles', type=int, default=2, help='tiles per face edge')
    ap.add_argument('--quality', type=int, default=70)
    ap.add_argument('--out', default=None)
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 2))
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args()
    out = os.path.abspath(args.out or os.path.join(ROOT, 'out', 'release-f%dq%d' % (args.face, args.quality)))
    if out.startswith(SRC + os.sep):
        sys.exit('refusing to write inside public/data')

    index = json.load(open(os.path.join(SRC, 'worlds.json')))
    os.makedirs(out, exist_ok=True)
    shutil.copy2(os.path.join(SRC, 'worlds.json'), os.path.join(out, 'worlds.json'))
    keys = set()
    for w in index['worlds']:
        slug = w['slug']
        world = json.load(open(os.path.join(SRC, w['world'])))
        world['pano'].update(faceSize=args.face, tileSize=args.face // args.tiles, nbTiles=args.tiles)
        os.makedirs(os.path.join(out, slug), exist_ok=True)
        with open(os.path.join(out, slug, 'world.json'), 'w') as f:
            json.dump(world, f, separators=(',', ':'))
        src_map = os.path.join(SRC, slug, 'map')
        for dirpath, _, files in os.walk(src_map):
            rel = os.path.relpath(dirpath, src_map)
            os.makedirs(os.path.join(out, slug, 'map', rel), exist_ok=True)
            for name in files:
                link_or_copy(os.path.join(dirpath, name), os.path.join(out, slug, 'map', rel, name))
        manifest = json.load(open(os.path.join(ROOT, 'server-data', slug, 'manifest.json')))
        keys.update(n['key'] for n in manifest['nodes'])

    jobs = [(k, out, args.face, args.tiles, args.quality, args.force) for k in sorted(keys)]
    done = encoded = 0
    with ProcessPoolExecutor(args.workers) as pool:
        for _, did in pool.map(encode_node, jobs, chunksize=8):
            done += 1
            encoded += did
            if done % 250 == 0 or done == len(jobs):
                print('%d/%d nodes (%d encoded)' % (done, len(jobs), encoded), flush=True)
    print('done:', out)


if __name__ == '__main__':
    main()
