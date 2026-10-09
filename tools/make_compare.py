#!/usr/bin/env python3
"""Build a small panorama compression sample for dev/compare.html (local tool, never part of a deployment).

Picks a fixed set of visually diverse nodes by waypoint name from the private manifests (server-data/<slug>/
manifest.json), re-assembles every 2048 px cube face from the published 1024 px tiles (public/data/panos/<key>/) and
writes one copy of each node per variant:

  public/data/panos-cmp/<variant>/<key>/base_<face>.webp            512 px base face
  public/data/panos-cmp/<variant>/<key>/<face>_<col>_<row>.webp     tiles, same naming as the real dataset
  public/data/panos-cmp/index.json                                  nodes, variants, measured and projected sizes

`orig` is a symlink to the real pano folder. The other variants are re-encoded from the q78 originals, so they carry a
little generation loss compared with a fresh render at that setting (WebP method 4 and base quality q-8, min 50, like
tools/g2pipeline.py write_pano). The real dataset is only read.

NOTE: index.json maps node keys to place names. public/data/panos-cmp must not be deployed: delete it (or leave it
out of the copy) before shipping public/data.

Usage:
  uv run --with pillow python tools/make_compare.py           # build what is missing
  uv run --with pillow python tools/make_compare.py --force   # rebuild every variant
"""
import argparse
import json
import os
import shutil
import sys
from concurrent.futures import ProcessPoolExecutor

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PANOS = os.path.join(ROOT, 'public', 'data', 'panos')
OUT = os.path.join(ROOT, 'public', 'data', 'panos-cmp')
FACES = ['front', 'right', 'back', 'left', 'top', 'bottom']
SRC_FACE, SRC_TILE, BASE = 2048, 1024, 512
FULL_DATASET_NODES = 5590

# (world, waypoint, label). Picked from a contact sheet of base faces: city, open fields, foliage, dark rock, wood
# interiors, stone architecture and sand, so both fine texture and smooth areas are represented.
NODES = [
    ('khorinis', 'NW_CITY_MAINSTREET_03', 'Khorinis: city main street'),
    ('khorinis', 'NW_CITY_HABOUR_06', 'Khorinis: harbour quay'),
    ('khorinis', 'NW_FARM1_FIELD_04', "Khorinis: Lobart's field"),
    ('khorinis', 'NW_FOREST_PATH_35', 'Khorinis: dense forest path'),
    ('khorinis', 'NW_FOREST_CAVE1_IN_02', 'Khorinis: forest cave (indoor)'),
    ('khorinis', 'NW_FARM1_INHOUSE_02', 'Khorinis: farmhouse interior'),
    ('khorinis', 'NW_MONASTERY_PLACE_09', 'Khorinis: monastery courtyard'),
    ('valley', 'OC_CENTER_04', 'Valley of Mines: castle courtyard'),
    ('valley', 'OW_MINE3_03', 'Valley of Mines: mine tunnel'),
    ('jharkendar', 'ADW_SWAMP_LOCH_07', 'Jharkendar: swamp'),
    ('jharkendar', 'ADW_CANYON_PATH_TO_LIBRARY_01', 'Jharkendar: canyon'),
    ('jharkendar', 'ADW_PIRATECAMP_HUT3_01', 'Jharkendar: pirate camp beach'),
    ('jharkendar', 'ADW_ADANOSTEMPEL_RAVEN_04', 'Jharkendar: Adanos temple'),
]

# name -> (faceSize, tileSize, quality); quality None = the published originals.
VARIANTS = {
    'orig': (2048, 1024, None),
    'f2048q65': (2048, 1024, 65),
    'f1536q70': (1536, 768, 70),
    'f1536q60': (1536, 768, 60),
    'f1024q75': (1024, 1024, 75),
}
ORIG_QUALITY = 78


def base_quality(q):
    return max(q - 8, 50)


def file_names(face_size, tile_size):
    n = face_size // tile_size
    names = ['base_%s.webp' % f for f in FACES]
    names += ['%s_%d_%d.webp' % (f, c, r) for f in FACES for r in range(n) for c in range(n)]
    return names


def assemble_face(src_dir, face):
    n = SRC_FACE // SRC_TILE
    img = Image.new('RGB', (SRC_FACE, SRC_FACE))
    for row in range(n):
        for col in range(n):
            with Image.open(os.path.join(src_dir, '%s_%d_%d.webp' % (face, col, row))) as t:
                img.paste(t.convert('RGB'), (col * SRC_TILE, row * SRC_TILE))
    return img


def encode_face(job):
    """Encode one face of one node for every re-encoded variant (the 2048 face is assembled once)."""
    key, face, variants = job
    full = assemble_face(os.path.join(PANOS, key), face)
    base = full.resize((BASE, BASE), Image.LANCZOS)
    for name, (face_size, tile_size, q) in variants:
        d = os.path.join(OUT, name, key)
        img = full if face_size == SRC_FACE else full.resize((face_size, face_size), Image.LANCZOS)
        base.save(os.path.join(d, 'base_%s.webp' % face), 'WEBP', quality=base_quality(q), method=4)
        n = face_size // tile_size
        for row in range(n):
            for col in range(n):
                box = (col * tile_size, row * tile_size, (col + 1) * tile_size, (row + 1) * tile_size)
                img.crop(box).save(os.path.join(d, '%s_%d_%d.webp' % (face, col, row)), 'WEBP', quality=q, method=4)
    return key, face


def dir_bytes(d, names):
    return sum(os.path.getsize(os.path.join(d, f)) for f in names)


def full_dataset_bytes():
    total = count = 0
    with os.scandir(PANOS) as it:
        for e in it:
            if not e.is_dir():
                continue
            count += 1
            with os.scandir(e.path) as files:
                total += sum(f.stat().st_size for f in files if f.is_file())
    return total, count


def resolve_nodes():
    manifests = {}
    out = []
    for world, wp, label in NODES:
        if world not in manifests:
            with open(os.path.join(ROOT, 'server-data', world, 'manifest.json')) as fh:
                manifests[world] = {n['wp']: n for n in json.load(fh)['nodes']}
        node = manifests[world].get(wp)
        if node is None:
            sys.exit('waypoint %s not found in server-data/%s/manifest.json' % (wp, world))
        key = node['key']
        missing = [f for f in file_names(SRC_FACE, SRC_TILE) if not os.path.isfile(os.path.join(PANOS, key, f))]
        if missing:
            sys.exit('pano folder of %s (%s) is incomplete: %s' % (wp, key, ', '.join(missing[:4])))
        out.append({'key': key, 'label': label, 'world': world, 'wp': wp, 'outdoor': node['outdoor']})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--force', action='store_true', help='rebuild variants that already exist')
    ap.add_argument('--jobs', type=int, default=os.cpu_count() or 4)
    args = ap.parse_args()

    nodes = resolve_nodes()
    os.makedirs(OUT, exist_ok=True)

    jobs = []
    for node in nodes:
        key = node['key']
        todo = []
        for name, (face_size, tile_size, q) in VARIANTS.items():
            d = os.path.join(OUT, name, key)
            if q is None:
                os.makedirs(os.path.dirname(d), exist_ok=True)
                if not os.path.islink(d):
                    if os.path.exists(d):
                        shutil.rmtree(d)
                    os.symlink(os.path.relpath(os.path.join(PANOS, key), os.path.dirname(d)), d)
                continue
            complete = all(os.path.isfile(os.path.join(d, f)) for f in file_names(face_size, tile_size))
            if complete and not args.force:
                continue
            if os.path.isdir(d):
                shutil.rmtree(d)
            os.makedirs(d)
            todo.append((name, VARIANTS[name]))
        jobs += [(key, face, todo) for face in FACES if todo]

    if jobs:
        print('encoding %d faces with %d workers...' % (len(jobs), args.jobs), flush=True)
        with ProcessPoolExecutor(max_workers=args.jobs) as pool:
            for i, _ in enumerate(pool.map(encode_face, jobs), 1):
                if i % 12 == 0 or i == len(jobs):
                    print('  %d/%d' % (i, len(jobs)), flush=True)

    print('measuring the full dataset...', flush=True)
    full_bytes, full_nodes = full_dataset_bytes()
    orig_sample = sum(dir_bytes(os.path.join(PANOS, n['key']), file_names(SRC_FACE, SRC_TILE)) for n in nodes)

    variants = []
    for name, (face_size, tile_size, q) in VARIANTS.items():
        names = file_names(face_size, tile_size)
        total = sum(dir_bytes(os.path.join(OUT, name, n['key']), names) for n in nodes)
        avg = total / len(nodes)
        ratio = total / orig_sample
        variants.append({
            'name': name,
            'faceSize': face_size,
            'tileSize': tile_size,
            'nbTiles': face_size // tile_size,
            'baseSize': BASE,
            'quality': ORIG_QUALITY if q is None else q,
            'baseQuality': base_quality(ORIG_QUALITY if q is None else q),
            'reencoded': q is not None,
            'avgKB': round(avg / 1024, 1),
            'ratioToOrig': round(ratio, 3),
            # avg KB on this sample x 5590 nodes
            'projectedGB': round(avg * FULL_DATASET_NODES / 1e9, 2),
            # the real size of public/data/panos scaled by this variant's size ratio on the sample
            'projectedScaledGB': round(full_bytes * ratio / 1e9, 2),
        })

    index = {
        'note': ('Variants other than "orig" are re-encoded from the published WebP q78 tiles (faces re-assembled to '
                 '2048 px, downscaled with Lanczos, WebP method 4, base faces at quality-8), so they carry slight '
                 'generation loss compared with a fresh render at the same setting. Local comparison data: do not '
                 'deploy public/data/panos-cmp.'),
        'path': 'panos-cmp/{variant}/{key}',
        'base': 'base_{face}.webp',
        'tile': '{face}_{col}_{row}.webp',
        'fullDataset': {'nodes': FULL_DATASET_NODES, 'measuredNodes': full_nodes, 'bytes': full_bytes,
                        'GB': round(full_bytes / 1e9, 2)},
        'sampleNodes': len(nodes),
        'nodes': [{'key': n['key'], 'label': n['label'], 'world': n['world'], 'wp': n['wp']} for n in nodes],
        'variants': variants,
    }
    with open(os.path.join(OUT, 'index.json'), 'w') as fh:
        json.dump(index, fh, indent=2)
        fh.write('\n')

    print('\nfull dataset: %d nodes, %.2f GB (avg %.0f KB/node); sample: %d nodes'
          % (full_nodes, full_bytes / 1e9, full_bytes / max(full_nodes, 1) / 1024, len(nodes)))
    print('%-10s %9s %5s %4s %9s %7s %12s %14s' % ('variant', 'face', 'tile', 'q', 'KB/node', 'ratio', 'proj. GB', 'proj. GB (sc.)'))
    for v in variants:
        print('%-10s %9s %5d %4d %9.1f %7.3f %12.2f %14.2f' % (
            v['name'], '%dx%d' % (v['faceSize'], v['faceSize']), v['tileSize'], v['quality'], v['avgKB'],
            v['ratioToOrig'], v['projectedGB'], v['projectedScaledGB']))
    print('\nwrote %s' % os.path.relpath(os.path.join(OUT, 'index.json'), ROOT))


if __name__ == '__main__':
    main()
