"""Self-test of the code page handling in tools/build_webfont.py and tools/extract_ui_assets.py --fonts.

Builds tiny synthetic font atlases (no game data needed) and checks that charcodes map to the right
Unicode code points for cp1252 / cp1251 / cp1250, that slots a localiser left untouched keep their
Latin meaning, and (if zenkit is installed) that a loose FONT_*.FNT + .TGA pair goes through the
extractor into a working "Gothic Default RU" font.

Run:
    uv run --with numpy --with pillow --with potracer --with fonttools --with brotli --with zenkit==1.3.0.4 \
        python tools/test_font_codepages.py
"""
from __future__ import annotations

import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_webfont as bw  # noqa: E402

try:
    import zenkit  # noqa: F401
    import extract_ui_assets as ex
except ImportError:  # pragma: no cover
    ex = None

CELL_W, CELL_H, COLS = 8, 16, 16  # 16x16 cells of 8x16 px -> a 128x256 atlas, one cell per charcode
LATIN = [ord("H"), ord("x"), 32, 0x8A, 0xA8, 0xB3, 0xC0, 0x98]


def shape(code: int, variant: int = 0) -> np.ndarray:
    """A distinct 6x10 ink pattern per (code, variant): a frame with a notch whose place encodes both."""
    m = np.zeros((CELL_H, CELL_W), bool)
    if code == 32:
        return m
    m[2:12, 1:7] = True
    k = (code * 7 + variant * 13) % 24
    m[4 + k // 6, 2 + (k % 6) // 2 : 4 + (k % 6) // 2] = False
    if code == ord("H"):
        m[2:12, 1:7] = True  # solid, baseline = row 12
    return m


def write_atlas(directory: Path, name: str, variants: dict[int, int], codepage: str | None = None) -> dict:
    """Atlas PNG + JSON like extract_ui_assets.py writes them. variants: code -> shape variant."""
    w, h = CELL_W * COLS, CELL_H * COLS
    alpha = np.zeros((h, w), np.uint8)
    glyphs = {}
    for code, var in variants.items():
        cx, cy = (code % COLS) * CELL_W, (code // COLS) * CELL_H
        alpha[cy : cy + CELL_H, cx : cx + CELL_W] = shape(code, var) * 255
        glyphs[str(code)] = {"width": CELL_W, "u0": cx / w, "v0": cy / h, "u1": (cx + CELL_W) / w, "v1": (cy + CELL_H) / h}
    rgba = np.dstack([np.full_like(alpha, 255)] * 3 + [alpha])
    directory.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, "RGBA").save(directory / f"{name}.png")
    meta = {"name": name, "height": CELL_H, "atlas": f"{name}.png", "atlasWidth": w, "atlasHeight": h, "glyphs": glyphs}
    if codepage:
        meta["codepage"] = codepage
    (directory / f"{name}.json").write_text(json.dumps(meta))
    return meta


def write_fnt(path: Path, atlas_name: str, meta: dict) -> None:
    """ZenGin .FNT: "1\\n" name "\\n" u32 height, u32 count(256), u8 widths[256], vec2 uv0[256], vec2 uv1[256]."""
    widths = bytearray(256)
    uv0, uv1 = [(0.0, 0.0)] * 256, [(0.0, 0.0)] * 256
    for code, g in meta["glyphs"].items():
        c = int(code)
        widths[c] = g["width"]
        uv0[c], uv1[c] = (g["u0"], g["v0"]), (g["u1"], g["v1"])
    out = b"1\n" + atlas_name.encode() + b"\n" + struct.pack("<II", meta["height"], 256) + bytes(widths)
    out += b"".join(struct.pack("<ff", *p) for p in uv0) + b"".join(struct.pack("<ff", *p) for p in uv1)
    path.write_bytes(out)


def cmap_of(info: dict) -> dict[int, str]:
    from fontTools.ttLib import TTFont

    return TTFont(info["files"]["ttf"]).getBestCmap()


class CodeToUnicode(unittest.TestCase):
    def test_ascii_is_identity_in_every_codepage(self):
        for cp in bw.CODEPAGES:
            for code in (0x21, ord("A"), ord("z"), 0x7E):
                self.assertEqual(bw.code_to_unicode(code, cp), code)

    def test_cp1252_default_unchanged(self):
        self.assertEqual(bw.code_to_unicode(0xC0), 0x00C0)  # À
        self.assertEqual(bw.code_to_unicode(0x8A), 0x0160)  # Š
        self.assertIsNone(bw.code_to_unicode(0x81))

    def test_cp1251_russian(self):
        cp = "cp1251"
        self.assertEqual(bw.code_to_unicode(0xC0, cp), 0x0410)  # А
        self.assertEqual(bw.code_to_unicode(0xFF, cp), 0x044F)  # я
        self.assertEqual(bw.code_to_unicode(0xA8, cp), 0x0401)  # Ё
        self.assertEqual(bw.code_to_unicode(0xB8, cp), 0x0451)  # ё
        self.assertEqual(bw.code_to_unicode(0xB9, cp), 0x2116)  # №
        self.assertEqual(bw.code_to_unicode(0xAB, cp), 0x00AB)  # «
        self.assertIsNone(bw.code_to_unicode(0x98, cp))

    def test_cp1250_polish(self):
        cp = "cp1250"
        expected = {0xA5: "Ą", 0xB9: "ą", 0xC6: "Ć", 0xE6: "ć", 0xCA: "Ę", 0xEA: "ę", 0xA3: "Ł", 0xB3: "ł",
                    0xD1: "Ń", 0xF1: "ń", 0xD3: "Ó", 0xF3: "ó", 0x8C: "Ś", 0x9C: "ś", 0x8F: "Ź", 0x9F: "ź",
                    0xAF: "Ż", 0xBF: "ż", 0x84: "„", 0x94: "”"}
        for code, ch in expected.items():
            self.assertEqual(bw.code_to_unicode(code, cp), ord(ch), hex(code))

    def test_normalize_codepage(self):
        self.assertEqual(bw.normalize_codepage("1251"), "cp1251")
        self.assertEqual(bw.normalize_codepage("windows-1250"), "cp1250")
        self.assertEqual(bw.normalize_codepage("CP1252"), "cp1252")
        with self.assertRaises(ValueError):
            bw.normalize_codepage("utf-8")

    def test_lang_specs(self):
        ru = {s.file_stem: s for s in bw.LANG_FONTS["ru"]}
        pl = {s.file_stem: s for s in bw.LANG_FONTS["pl"]}
        self.assertEqual(ru["GothicOldRU"].family, "Gothic Old RU")
        self.assertEqual(ru["GothicDefaultRU"].family, "Gothic Default RU")
        self.assertEqual(pl["GothicOldPL"].family, "Gothic Old PL")
        self.assertEqual(pl["GothicDefaultPL"].family, "Gothic Default PL")
        self.assertEqual({s.codepage for s in ru.values()}, {"cp1251"})
        self.assertEqual({s.codepage for s in pl.values()}, {"cp1250"})


class SyntheticBuild(unittest.TestCase):
    """English reference atlas + a 'localised' one where 0xA8, 0xB3, 0xC0 were redrawn and 0x8A was not."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.ref_dir, self.loc_dir, self.out = root / "ref", root / "loc", root / "fonts"
        write_atlas(self.ref_dir, "FONT_DEFAULT", {c: 0 for c in LATIN})
        redrawn = {0xA8, 0xB3, 0xC0}
        write_atlas(self.loc_dir, "FONT_DEFAULT", {c: (1 if c in redrawn else 0) for c in LATIN}, codepage="cp1251")

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, codepage=None, reference=True, atlas_dir=None, stem="T"):
        spec = bw.FontSpec("FONT_DEFAULT", f"Test {stem}", stem, alphamax=0.9, atlas_dir=atlas_dir or self.loc_dir)
        return bw.build_font(spec, verbose=False, out_dir=self.out, codepage=codepage,
                             reference_dir=self.ref_dir if reference else None)

    def test_codepage_from_atlas_json(self):
        info = self.build()
        self.assertEqual(info["codepage"], "cp1251")
        cmap = cmap_of(info)
        self.assertIn(0x0410, cmap)  # А  (0xC0, redrawn)
        self.assertIn(0x0401, cmap)  # Ё  (0xA8, redrawn)
        self.assertIn(0x0456, cmap)  # і  (0xB3 in cp1251, redrawn)
        self.assertNotIn(0x00C0, cmap)  # no À: that slot is Cyrillic now
        self.assertEqual(info["stale"], [0x8A, 0x98])
        self.assertIn(0x0160, cmap)  # untouched 0x8A keeps its Latin Š ...
        self.assertNotIn(0x0409, cmap)  # ... and does not pretend to be Љ
        self.assertIn(0x02DC, cmap)  # 0x98 is undefined in cp1251; the untouched glyph is still the cp1252 tilde

    def test_without_reference_maps_everything_by_codepage(self):
        info = self.build(reference=False)
        cmap = cmap_of(info)
        self.assertEqual(info["stale"], [])
        self.assertIn(0x0409, cmap)  # 0x8A -> Љ when nothing tells us the slot is stale
        self.assertNotIn(0x0160, cmap)
        self.assertNotIn(0x02DC, cmap)  # 0x98 is undefined in cp1251 and dropped

    def test_cp1250_override(self):
        info = self.build(codepage="windows-1250", stem="PL")
        cmap = cmap_of(info)
        self.assertEqual(info["codepage"], "cp1250")
        self.assertIn(0x0142, cmap)  # ł from 0xB3
        self.assertIn(0x0154, cmap)  # Ŕ from 0xC0
        self.assertIn(0x0160, cmap)  # Š: same character in cp1250 and cp1252, so never "stale"
        self.assertEqual(info["stale"], [0x98])  # undefined in cp1250, kept as the cp1252 tilde

    def test_cp1252_ignores_reference(self):
        info = self.build(codepage="cp1252", atlas_dir=self.ref_dir, stem="EN")
        cmap = cmap_of(info)
        self.assertIn(0x00C0, cmap)
        self.assertIn(0x0160, cmap)
        self.assertEqual(info["stale"], [])

    def test_name_and_os2(self):
        from fontTools.ttLib import TTFont

        info = self.build(stem="GothicDefaultRU")
        font = TTFont(info["files"]["ttf"])
        self.assertEqual(font["name"].getDebugName(1), "Test GothicDefaultRU")
        self.assertEqual(font["OS/2"].ulCodePageRange1, 1 << 2)  # Cyrillic
        self.assertTrue((self.out / "GothicDefaultRU.woff").exists())


@unittest.skipIf(ex is None, "zenkit not installed")
class LooseExtract(unittest.TestCase):
    def test_loose_fnt_tga_to_font(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ref = root / "ref"
            write_atlas(ref, "FONT_DEFAULT", {c: 0 for c in LATIN})
            # a loose localised font: FONT_DEFAULT.FNT + FONT_DEFAULT.TGA, 0xC0 and 0xB3 redrawn
            work = root / "src"
            meta = write_atlas(work / "tmp", "FONT_DEFAULT", {c: (1 if c in (0xB3, 0xC0) else 0) for c in LATIN})
            work.mkdir(exist_ok=True)
            Image.open(work / "tmp" / "FONT_DEFAULT.png").save(work / "FONT_DEFAULT.TGA")
            write_fnt(work / "FONT_DEFAULT.FNT", "FONT_DEFAULT.TGA", meta)
            for f in (work / "tmp").iterdir():
                f.unlink()
            (work / "tmp").rmdir()

            out = root / "ru"
            index = ex.extract_locale_fonts(str(work), "ru", str(out), ref_dir=str(ref), names=["FONT_DEFAULT"])
            self.assertEqual(index["codepage"], "cp1251")
            font = index["fonts"]["FONT_DEFAULT"]
            self.assertEqual(font["redrawn"], [0xB3, 0xC0])
            self.assertEqual(font["glyphs"], len(LATIN))
            got = json.loads((out / "FONT_DEFAULT.json").read_text())
            self.assertEqual(got["codepage"], "cp1251")
            self.assertEqual(got["height"], CELL_H)

            spec = bw.FontSpec("FONT_DEFAULT", "Gothic Default RU", "GothicDefaultRU", alphamax=0.9, atlas_dir=out)
            info = bw.build_font(spec, verbose=False, out_dir=root / "fonts", reference_dir=ref)
            cmap = cmap_of(info)
            self.assertIn(0x0410, cmap)
            self.assertIn(0x0456, cmap)
            self.assertIn(0x0160, cmap)  # untouched Š
            self.assertEqual(info["stale"], [0x8A, 0x98, 0xA8])  # 0xA8 was not redrawn in this one
            self.assertIn(0x00A8, cmap)  # so it stays the diaeresis, not Ё
            self.assertNotIn(0x0401, cmap)

    def test_source_rejects_unknown_file(self):
        with tempfile.NamedTemporaryFile(suffix=".zip") as f:
            with self.assertRaises(SystemExit):
                ex.FontSource(f.name)


if __name__ == "__main__":
    unittest.main(verbosity=2)
