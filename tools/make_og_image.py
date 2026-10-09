"""The link-preview (Open Graph) image: public/ui/gothic/og-image.jpg, 1200x630.

Variant C of the 2026-10-09 comparison, picked by the owner: a real panorama (Khorinis monastery courtyard), the Gothic II
logo, the title and the painted Khorinis map with a pin. Needs the full-resolution panoramas in public/data/panos and the
private manifest (for the node key). Variants A/B (menu art) were dropped.

It also reads the extracted UI assets (MENU_GOTHIC_G2.png, MAP_NEWWORLD.png, fonts/GothicOld.ttf, GothicDefault.ttf),
so run it after tools/extract_ui_assets.py and tools/build_webfont.py (tools/build_assets.sh does it in that order).

Usage (repo root): uv run --with pillow python tools/make_og_image.py [--assets DIR] [--out FILE] [--data DIR]
                   [--server-data DIR]     (defaults: public/ui/gothic, <assets>/og-image.jpg, public/data, server-data)
"""
import argparse
import json
import os

from PIL import Image, ImageDraw, ImageFont

ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
ap.add_argument('--assets', default='public/ui/gothic', help='extracted UI assets (default %(default)s)')
ap.add_argument('--out', help='output JPEG (default <assets>/og-image.jpg)')
ap.add_argument('--data', default='public/data', help='published public dataset (default %(default)s)')
ap.add_argument('--server-data', default='server-data', help='private manifests (default %(default)s)')
ARGS = ap.parse_args()
G = os.path.join(ARGS.assets, '')
OUT = ARGS.out or G + 'og-image.jpg'
W, H = 1200, 630
OLD = G + 'fonts/GothicOld.ttf'
DEF = G + 'fonts/GothicDefault.ttf'
GOLD = (214, 178, 96)
LIGHT = (236, 222, 190)
DIM = (190, 176, 150)
TAG = 'Where are you in the world of Gothic II?'

logo = Image.open(G + 'MENU_GOTHIC_G2.png').convert('RGBA')
logo = logo.crop(logo.getbbox())


def cover(im, w, h, fx=0.5, fy=0.5):
    s = max(w / im.width, h / im.height)
    im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    x, y = round((im.width - w) * fx), round((im.height - h) * fy)
    return im.crop((x, y, x + w, y + h))


def contain(im, w, h):
    s = min(w / im.width, h / im.height)
    return im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)


def text(d, xy, s, size, font=DEF, fill=LIGHT, anchor='la'):
    f = ImageFont.truetype(font, size)
    for dx, dy in ((0, 3), (2, 2)):
        d.text((xy[0] + dx, xy[1] + dy), s, font=f, fill=(0, 0, 0, 200), anchor=anchor)
    d.text(xy, s, font=f, fill=fill, anchor=anchor)


def hgrad(stops):
    g = Image.new('L', (W, 1))
    for x in range(W):
        t = x / (W - 1)
        for (a, va), (b, vb) in zip(stops, stops[1:]):
            if a <= t <= b:
                g.putpixel((x, 0), round(va + (vb - va) * (t - a) / (b - a)))
                break
    return g.resize((W, H))


def shade(stops):
    s = Image.new('RGBA', (W, H), (6, 8, 12, 255))
    s.putalpha(hgrad(stops))
    return s


def scaled_logo(width):
    return logo.resize((width, round(logo.height * width / logo.width)), Image.LANCZOS)


# C: a real panorama (monastery courtyard) with the painted map and a pin
key = next(n['key'] for n in json.load(open(os.path.join(ARGS.server_data, 'khorinis', 'manifest.json')))['nodes'] if n['wp'] == 'NW_MONASTERY_PLACE_09')


def face(name):
    im = Image.new('RGB', (2048, 2048))
    for c in range(2):
        for r in range(2):
            im.paste(Image.open(os.path.join(ARGS.data, 'panos', key, f'{name}_{c}_{r}.webp')).convert('RGB'), (c * 1024, r * 1024))
    return im


strip = Image.new('RGB', (4096, 2048))
strip.paste(face('right'), (0, 0))
strip.paste(face('back'), (2048, 0))
c = strip.crop((900, 560, 900 + 2280, 560 + 1200)).resize((W, H), Image.LANCZOS).convert('RGBA')
c = Image.alpha_composite(c, shade([(0, 220), (0.4, 160), (0.6, 0), (1, 0)]))
lg = scaled_logo(430)
c.alpha_composite(lg, (56, 56))
d = ImageDraw.Draw(c)
y = 56 + lg.height
text(d, (60, y + 18), 'Gothic Guessr', 86, OLD, GOLD)
text(d, (64, y + 126), TAG, 30)
mp = contain(Image.open(G + 'MAP_NEWWORLD.png').convert('RGBA'), 300, 200)
frame = Image.new('RGBA', (mp.width + 12, mp.height + 12), (201, 164, 76, 255))
frame.alpha_composite(mp, (6, 6))
px, py = round(frame.width * 0.62), round(frame.height * 0.36)
ImageDraw.Draw(frame).ellipse((px - 10, py - 10, px + 10, py + 10), fill=(200, 40, 30, 255), outline=(255, 240, 200, 255), width=3)
c.alpha_composite(frame, (56, H - frame.height - 40))
c.convert('RGB').save(OUT, quality=86, optimize=True, progressive=True)
print(OUT)

