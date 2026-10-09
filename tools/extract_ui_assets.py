"""Extract Gothic II UI textures and bitmap fonts from the game archives into public/ui/gothic/.

Textures -> PNG (RGBA). Fonts -> atlas PNG + <name>.json with per-glyph metrics (ZenGin .FNT):
  { "height": px, "atlas": "FONT_OLD_20_WHITE.png", "atlasWidth": w, "atlasHeight": h,
    "glyphs": { "<charcode>": { "width": px, "u0":..,"v0":..,"u1":..,"v1":.. } } }   (uv in 0..1, v from top)
Painted maps also get small WebP thumbnails for the start screen (<MAP>_THUMB.webp, 256 px wide,
~3x their CSS size): the 1024 px PNGs are ~700 kB each.
Menu art read from one specific archive (the merged VFS shows only the last mounted copy of a name):
  MENU_BACK_ADDON.webp  the Night of the Raven start screen (STARTSCREEN in Textures_Addon.vdf: water mages in blue
                        smoke), the main menu backdrop. Stored square 1024x1024 in the game, which stretches it to the
                        4:3 screen; saved here already stretched (1366x1024) as WebP.
  MENU_GOTHIC_G2.png    the classic Gothic II logo (MENU_GOTHIC in Textures.vdf; the addon archives replace it with
                        the "Night of the Raven" logo, which is what MENU_GOTHIC.png holds).
Site icons from the game's own window icon (System/g2_classic.ico, 32x32):
  favicon.ico           the .ico as is
  icon-32.png           the same image as RGBA PNG
  icon-192.png          scaled x6 with nearest neighbour (the pixel art stays crisp)
  apple-touch-icon.png  180x180, opaque dark background #100c08, the icon nearest-scaled to 160 px at (10, 10)
The game install is $GOTHIC2_DIR (tools/g2env.py); `npm run assets` (tools/build_assets.sh) runs every mode in order.
Usage: python tools/extract_ui_assets.py [out_dir]
       python tools/extract_ui_assets.py --thumbs-only [out_dir]   (thumbnails from existing PNGs)
       python tools/extract_ui_assets.py --menu-only [out_dir]     (only the menu art above)
       python tools/extract_ui_assets.py --icons-only [out_dir]    (only the site icons above)
       python tools/extract_ui_assets.py --fonts SOURCE --lang ru|pl [--codepage CP] [out_dir]
           fonts of a localised release (Russian: Windows-1251, Polish: Windows-1250) into
           public/ui/gothic/<lang>/ for tools/build_webfont.py --lang; SOURCE is a .vdf/.mod archive, a
           directory of archives (or a game dir with Data/), or a directory of loose FONT_*.FNT + .TGA/-C.TEX
           files. See docs/FONTS.md "Russian and Polish game fonts".
Run with: uv run --with zenkit --with pillow --with numpy python tools/extract_ui_assets.py
"""
import io, json, os, sys
import zenkit
from PIL import Image
from g2env import data_path, system_path

ARCHIVES = ['Textures.vdf', 'Textures_Addon.vdf', 'Textures_Fonts_Apostroph.vdf', 'Textures_multilingual_Jowood.vdf', 'Textures_Addon_Menu_English.vdf']
TEXTURES = ['MENU_INGAME', 'MENU_CHOICE_BACK', 'MENU_BUTTONBACK', 'MENU_INPUT_BACK', 'MENU_SLIDER_BACK', 'MENU_SLIDER_POS',
            'MENU_GOTHIC', 'MENU_GOTHICSHADOW', 'MENU_MASKE', 'MENU_SAVELOAD_BACK',
            'LOG_PAPER', 'LOG_BACK', 'BOOK_BROWN_L', 'BOOK_BROWN_R', 'BOOK_WOOD_L', 'BOOK_WOOD_R', 'BOOK_RED_L', 'BOOK_RED_R',
            'BAR_BACK', 'BAR_HEALTH', 'BAR_MANA', 'BAR_MISC', 'BAR_TEMPMAX',
            'INV_BACK', 'INV_SLOT', 'INV_SLOT_HIGHLIGHTED', 'INV_SLOT_FOCUS', 'INV_TITLE', 'INV_DESC',
            'DLG_CONVERSATION', 'DLG_CHOICE', 'DLG_AMBIENT',
            'MAP_NEWWORLD', 'MAP_OLDWORLD', 'MAP_ADDONWORLD', 'CURSOR']
MAP_THUMBS = ['MAP_NEWWORLD', 'MAP_OLDWORLD', 'MAP_ADDONWORLD']
THUMB_WIDTH = 256
# (texture, archive it is read from, output file, stretch-to size or None)
MENU_ART = [('STARTSCREEN', 'Textures_Addon.vdf', 'MENU_BACK_ADDON.webp', (1366, 1024)),
            ('MENU_GOTHIC', 'Textures.vdf', 'MENU_GOTHIC_G2.png', None)]
FONTS = ['FONT_OLD_20_WHITE', 'FONT_OLD_10_WHITE', 'FONT_DEFAULT', 'FONT_20_BOOK', 'FONT_10_BOOK', 'FONT_OLD_20_WHITE_HI', 'FONT_OLD_10_WHITE_HI']


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    vfs = zenkit.Vfs()
    for a in ARCHIVES:
        vfs.mount_disk(data_path(a))

    def tex_png(base, path):
        node = vfs.find(base + '-C.TEX')
        if node is None:
            return None
        t = zenkit.Texture.load(node.open())
        img = Image.frombytes('RGBA', (t.width, t.height), t.mipmap_rgba(0))
        img.save(path)
        return (t.width, t.height, t.format.name)

    index = {'textures': {}, 'fonts': {}}
    for name in TEXTURES:
        info = tex_png(name, os.path.join(out_dir, name + '.png'))
        if info:
            index['textures'][name] = {'file': name + '.png', 'width': info[0], 'height': info[1], 'format': info[2]}
            print('texture', name, info)
        else:
            print('texture', name, 'MISSING')
    for name in FONTS:
        node = vfs.find(name + '.FNT')
        if node is None:
            print('font', name, 'MISSING'); continue
        f = zenkit.Font.load(node.open())
        atlas_base = f.name.rsplit('.', 1)[0].upper() if f.name else name
        info = tex_png(atlas_base, os.path.join(out_dir, name + '.png'))
        if not info:
            print('font', name, 'atlas missing', f.name); continue
        glyphs = {}
        for code, g in enumerate(f.glyphs):
            if g.width <= 0:
                continue
            glyphs[str(code)] = {'width': g.width, 'u0': g.top_left.x, 'v0': g.top_left.y, 'u1': g.bottom_right.x, 'v1': g.bottom_right.y}
        meta = {'name': name, 'height': f.height, 'atlas': name + '.png', 'atlasWidth': info[0], 'atlasHeight': info[1], 'glyphs': glyphs}
        json.dump(meta, open(os.path.join(out_dir, name + '.json'), 'w'))
        index['fonts'][name] = {'file': name + '.json', 'height': f.height, 'glyphs': len(glyphs), 'atlas': name + '.png'}
        print('font', name, 'height', f.height, 'glyphs', len(glyphs), 'atlas', info)
    json.dump(index, open(os.path.join(out_dir, 'index.json'), 'w'), indent=1)
    make_thumbs(out_dir)
    make_menu_art(out_dir)
    make_icons(out_dir)


ICON_SOURCE = 'g2_classic.ico'
TOUCH_ICON = (180, 160, (0x10, 0x0c, 0x08))  # canvas size, icon size, background


def make_icons(out_dir):
    """favicon.ico, icon-32.png, icon-192.png and apple-touch-icon.png from the game's window icon."""
    import shutil
    os.makedirs(out_dir, exist_ok=True)
    src = system_path(ICON_SOURCE)
    shutil.copyfile(src, os.path.join(out_dir, 'favicon.ico'))
    icon = Image.open(src).convert('RGBA')
    icon.save(os.path.join(out_dir, 'icon-32.png'))
    icon.resize((icon.width * 6, icon.height * 6), Image.NEAREST).save(os.path.join(out_dir, 'icon-192.png'))
    size, inner, bg = TOUCH_ICON
    touch = Image.new('RGB', (size, size), bg)
    scaled = icon.resize((inner, inner), Image.NEAREST)
    off = (size - inner) // 2
    touch.paste(scaled, (off, off), scaled)
    touch.save(os.path.join(out_dir, 'apple-touch-icon.png'))
    print('icons from', ICON_SOURCE, icon.size, '-> favicon.ico, icon-32.png, icon-192.png, apple-touch-icon.png')


def make_menu_art(out_dir):
    """Write the MENU_ART files, each texture read from its own archive, and list them in index.json."""
    os.makedirs(out_dir, exist_ok=True)
    index_path = os.path.join(out_dir, 'index.json')
    index = json.load(open(index_path)) if os.path.exists(index_path) else {}
    art = {}
    for name, archive, file, size in MENU_ART:
        vfs = zenkit.Vfs()
        vfs.mount_disk(data_path(archive))
        node = vfs.find(name + '-C.TEX')
        if node is None:
            print('menu art', name, 'MISSING in', archive); continue
        t = zenkit.Texture.load(node.open())
        img = Image.frombytes('RGBA', (t.width, t.height), t.mipmap_rgba(0))
        path = os.path.join(out_dir, file)
        if size:
            img = img.convert('RGB').resize(size, Image.LANCZOS)
        if file.endswith('.webp'):
            img.save(path, 'WEBP', quality=80, method=6)
        else:
            img.save(path)
        art[file.rsplit('.', 1)[0]] = {'file': file, 'source': f'{archive}:{name}', 'width': img.width, 'height': img.height,
                                       'format': t.format.name}
        print('menu art', file, 'from', archive, name, img.size, os.path.getsize(path), 'bytes')
    index['menu'] = art
    json.dump(index, open(index_path, 'w'), indent=1)


def make_thumbs(out_dir):
    """Write <MAP>_THUMB.webp next to each painted map PNG and list them in index.json."""
    index_path = os.path.join(out_dir, 'index.json')
    index = json.load(open(index_path)) if os.path.exists(index_path) else {}
    thumbs = {}
    for name in MAP_THUMBS:
        src = os.path.join(out_dir, name + '.png')
        if not os.path.exists(src):
            print('thumb', name, 'MISSING source'); continue
        img = Image.open(src).convert('RGBA')
        h = round(img.height * THUMB_WIDTH / img.width)
        thumb = img.resize((THUMB_WIDTH, h), Image.LANCZOS)
        file = name + '_THUMB.webp'
        thumb.save(os.path.join(out_dir, file), 'WEBP', quality=82, method=6)
        thumbs[name] = {'file': file, 'width': THUMB_WIDTH, 'height': h}
        print('thumb', name, (THUMB_WIDTH, h), os.path.getsize(os.path.join(out_dir, file)), 'bytes')
    index['thumbnails'] = thumbs
    json.dump(index, open(index_path, 'w'), indent=1)


# ---------------------------------------------------------------------------
# fonts of the localised releases (--fonts SOURCE --lang ru|pl)

LANG_CODEPAGES = {'ru': 'cp1251', 'pl': 'cp1250'}
ARCHIVE_EXTS = ('.vdf', '.mod')
REFERENCE_DIR = 'public/ui/gothic'  # the English (cp1252) atlases, to report which slots were redrawn


def _rgba_from_bytes(data):
    """A loose atlas file (.TGA, or a compiled -C.TEX) -> RGBA image. Grey TGAs without alpha use luminance."""
    data = bytes(data)
    if data[:4] == b'ZTEX':
        t = zenkit.Texture.load(data)
        return Image.frombytes('RGBA', (t.width, t.height), t.mipmap_rgba(0)), t.format.name
    img = Image.open(io.BytesIO(data))
    img.load()
    if 'A' in img.getbands():
        return img.convert('RGBA'), img.format or 'TGA'
    lum = img.convert('L')
    white = Image.new('L', lum.size, 255)
    return Image.merge('RGBA', (white, white, white, lum)), (img.format or 'TGA') + '-luminance'


class FontSource:
    """Font files from archives (mounted like the engine: newest copy of a name wins) or a loose directory."""

    def __init__(self, path):
        self.path = os.path.abspath(path)
        self.archives, self.loose = [], {}
        if os.path.isfile(self.path):
            if not self.path.lower().endswith(ARCHIVE_EXTS):
                raise SystemExit(f'{path}: expected a .vdf/.mod archive or a directory')
            self.archives = [self.path]
        elif os.path.isdir(self.path):
            data = os.path.join(self.path, 'Data')
            for d in ([data] if os.path.isdir(data) else []) + [self.path]:
                self.archives = sorted(os.path.join(d, f) for f in os.listdir(d) if f.lower().endswith(ARCHIVE_EXTS))
                if self.archives:
                    break
            if not self.archives:
                for root, _, files in os.walk(self.path):
                    for f in files:
                        self.loose.setdefault(f.upper(), os.path.join(root, f))
        else:
            raise SystemExit(f'{path}: not found')
        self.vfs = None
        if self.archives:
            self.vfs = zenkit.Vfs()
            for a in self.archives:
                self.vfs.mount_disk(a)

    def read(self, name):
        """Bytes of the file called `name` (case-insensitive), or None."""
        if self.vfs is not None:
            node = self.vfs.find(name)
            return bytes(node.data) if node is not None else None
        p = self.loose.get(name.upper())
        return open(p, 'rb').read() if p else None

    def atlas(self, base):
        """(RGBA image, format) of a font texture: the compiled -C.TEX if present, else the .TGA."""
        for name in (base + '-C.TEX', base + '.TGA'):
            data = self.read(name)
            if data is not None:
                return _rgba_from_bytes(data)
        return None

    def inventory(self):
        """{archive (or 'loose'): [FONT_* file names]}, to see which archive carries which font."""
        if not self.archives:
            return {'loose': sorted(n for n in self.loose if n.startswith('FONT_'))}
        out = {}
        for a in self.archives:
            v = zenkit.Vfs()
            v.mount_disk(a)
            names, stack = [], [v.root]
            while stack:
                for c in stack.pop().children:
                    if c.is_dir():
                        stack.append(c)
                    elif c.name.upper().startswith('FONT_'):
                        names.append(c.name.upper())
            if names:
                out[os.path.basename(a)] = sorted(names)
        return out


def _ink(img, g, w, h):
    """Binary ink mask of one glyph cell (same cropping rule as tools/build_webfont.py)."""
    import numpy as np
    x0 = max(round(g['u0'] * w), 0)
    y0, y1 = round(g['v0'] * h), round(g['v1'] * h)
    a = np.array(img)[..., 3][y0:y1, x0:x0 + int(g['width'])]
    return a > 127


def redrawn_slots(img, glyphs, ref_dir, name):
    """Charcodes >= 0x80 whose glyph differs from the English atlas of the same name (None if no reference)."""
    import numpy as np
    ref_json = os.path.join(ref_dir, name + '.json')
    if not os.path.exists(ref_json):
        return None
    ref = json.load(open(ref_json))
    ref_img = Image.open(os.path.join(ref_dir, ref['atlas'])).convert('RGBA')
    out = []
    for code, g in glyphs.items():
        if int(code) < 0x80:
            continue
        r = ref['glyphs'].get(code)
        a = _ink(img, g, img.width, img.height)
        b = _ink(ref_img, r, ref_img.width, ref_img.height) if r else None
        if b is None or a.shape != b.shape or not np.array_equal(a, b):
            out.append(int(code))
    return sorted(out)


def extract_locale_fonts(source, lang, out_dir=None, codepage=None, ref_dir=REFERENCE_DIR, names=None):
    """Write <out_dir>/<FONT>.png + .json (with "codepage") for each font found in `source`; return the index."""
    codepage = codepage or LANG_CODEPAGES[lang]
    out_dir = out_dir or os.path.join('public/ui/gothic', lang)
    src = FontSource(source)
    os.makedirs(out_dir, exist_ok=True)
    print('source', src.path, f'({len(src.archives)} archives)' if src.archives else f'(loose, {len(src.loose)} files)')
    for archive, files in src.inventory().items():
        print('  ', archive, ' '.join(f for f in files if f.endswith('.FNT')))
    index = {'lang': lang, 'codepage': codepage, 'source': os.path.basename(src.path), 'fonts': {}}
    for name in names or FONTS:
        data = src.read(name + '.FNT')
        if data is None:
            print('font', name, 'MISSING'); continue
        f = zenkit.Font.load(data)
        atlas_base = f.name.rsplit('.', 1)[0].upper() if f.name else name
        got = src.atlas(atlas_base)
        if not got:
            print('font', name, 'atlas missing', f.name); continue
        img, fmt = got
        img.save(os.path.join(out_dir, name + '.png'))
        glyphs = {}
        for code, g in enumerate(f.glyphs):
            if g.width <= 0:
                continue
            glyphs[str(code)] = {'width': g.width, 'u0': g.top_left.x, 'v0': g.top_left.y, 'u1': g.bottom_right.x, 'v1': g.bottom_right.y}
        meta = {'name': name, 'height': f.height, 'atlas': name + '.png', 'atlasWidth': img.width, 'atlasHeight': img.height,
                'codepage': codepage, 'lang': lang, 'glyphs': glyphs}
        json.dump(meta, open(os.path.join(out_dir, name + '.json'), 'w'))
        redrawn = redrawn_slots(img, glyphs, ref_dir, name) if ref_dir else None
        index['fonts'][name] = {'file': name + '.json', 'height': f.height, 'glyphs': len(glyphs), 'atlas': name + '.png',
                                'format': fmt, 'redrawn': redrawn}
        note = '' if redrawn is None else f', {len(redrawn)} slots >= 0x80 differ from the English atlas'
        if redrawn is not None and not redrawn:
            note += ' (SAME AS ENGLISH: this source holds no localised font)'
        print('font', name, 'height', f.height, 'glyphs', len(glyphs), 'atlas', (img.width, img.height, fmt) , note)
    json.dump(index, open(os.path.join(out_dir, 'index.json'), 'w'), indent=1)
    return index


def fonts_cli(argv):
    import argparse
    ap = argparse.ArgumentParser(prog='extract_ui_assets.py --fonts', description='Extract the fonts of a localised release.')
    ap.add_argument('--fonts', required=True, metavar='SOURCE', help='.vdf/.mod, a directory of archives or of loose FNT+TGA files')
    ap.add_argument('--lang', required=True, choices=sorted(LANG_CODEPAGES))
    ap.add_argument('--codepage', choices=['cp1250', 'cp1251', 'cp1252'], help='default: cp1251 for ru, cp1250 for pl')
    ap.add_argument('--reference', default=REFERENCE_DIR, help='English atlases to compare with (default %(default)s)')
    ap.add_argument('out_dir', nargs='?', help='default public/ui/gothic/<lang>')
    a = ap.parse_args(argv)
    extract_locale_fonts(a.fonts, a.lang, a.out_dir, a.codepage, a.reference)


if __name__ == '__main__':
    args = sys.argv[1:]
    if args and any(x == '--fonts' or x.startswith('--fonts=') for x in args):
        fonts_cli(args)
    elif args and args[0] == '--thumbs-only':
        make_thumbs(args[1] if len(args) > 1 else 'public/ui/gothic')
    elif args and args[0] == '--menu-only':
        make_menu_art(args[1] if len(args) > 1 else 'public/ui/gothic')
    elif args and args[0] == '--icons-only':
        make_icons(args[1] if len(args) > 1 else 'public/ui/gothic')
    else:
        main(args[0] if args else 'public/ui/gothic')
