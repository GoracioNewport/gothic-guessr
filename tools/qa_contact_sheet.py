"""QA helper: pick random nodes from a built dataset, stitch their tiles into small equirect previews and lay them out on a
contact sheet, so a human can spot bad camera positions (inside walls, pitch-black caves, floating).

Usage: python tools/qa_contact_sheet.py out/khorinis --n 24 --seed 1 --starts-only --out qa_sheet.jpg
"""
import argparse, json, os, random, sys
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(__file__))
from g2pipeline import equirect_from_faces, FACES


def load_faces(pano_dir, face_size, tile):
    n = face_size // tile
    faces = {}
    for f in FACES:
        img = Image.new('RGB', (face_size, face_size))
        for r in range(n):
            for c in range(n):
                img.paste(Image.open(os.path.join(pano_dir, '%s_%d_%d.webp' % (f, c, r))), (c * tile, r * tile))
        faces[f] = np.asarray(img)
    return faces


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dataset')
    ap.add_argument('--n', type=int, default=24)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--starts-only', action='store_true')
    ap.add_argument('--ids', default='', help='comma-separated node ids instead of random')
    ap.add_argument('--out', default='qa_sheet.jpg')
    ap.add_argument('--w', type=int, default=1024, help='width of each equirect thumbnail')
    args = ap.parse_args()
    m = json.load(open(os.path.join(args.dataset, 'manifest.json')))
    pano = m['pano']
    if args.ids:
        ids = [int(x) for x in args.ids.split(',')]
    else:
        pool = m['starts'] if args.starts_only else [nd['id'] for nd in m['nodes']]
        random.seed(args.seed); ids = random.sample(pool, min(args.n, len(pool)))
    cols = 3; W = args.w; H = W // 2
    rows = (len(ids) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * W, rows * (H + 22)), (20, 20, 20))
    d = ImageDraw.Draw(sheet)
    for k, nid in enumerate(ids):
        nd = m['nodes'][nid]
        faces = load_faces(os.path.join(args.dataset, 'panos', str(nid)), pano['faceSize'], pano['tileSize'])
        eq = equirect_from_faces(faces, W, H)
        x = (k % cols) * W; y = (k // cols) * (H + 22)
        sheet.paste(eq, (x, y + 22))
        d.text((x + 4, y + 4), '#%d %s  links=%d  outdoor=%s' % (nid, nd['wp'], len(nd['links']), nd['outdoor']), fill=(255, 255, 0))
    sheet.save(args.out, quality=85)
    print('wrote', args.out, 'nodes', ids)


if __name__ == '__main__':
    main()
