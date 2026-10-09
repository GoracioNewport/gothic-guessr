#!/usr/bin/env python
"""Build vector web fonts from Gothic II bitmap font atlases.

Input (produced by tools/extract_ui_assets.py, see SPEC §9.6):
    public/ui/gothic/<NAME>.png   RGBA atlas, glyph shape in the alpha channel
    public/ui/gothic/<NAME>.json  {"height": px, "atlasWidth", "atlasHeight",
                                   "glyphs": {"<charcode>": {width, u0, v0, u1, v1}}}
    uv are 0..1, v from the top; u1/v1 are the *inclusive* last texel, so the ink of a
    glyph is exactly `width` columns starting at round(u0 * atlasWidth).

Output: public/ui/gothic/fonts/<Family>.ttf, .woff, .woff2 (woff2 only if brotli imports).

Code pages: the atlas is indexed by the byte value of the game's 8-bit text, so the charcode -> Unicode
mapping depends on the localisation the atlas comes from: Windows-1252 for the English/German fonts
(the default), Windows-1251 for the Russian release, Windows-1250 for the Polish one. Localised atlases
are extracted by `tools/extract_ui_assets.py --fonts <source> --lang ru|pl` into public/ui/gothic/<lang>/
and their JSON records the code page. Slots a localiser left untouched (pixel-identical to the same slot
of the English atlas, the "reference") keep their Windows-1252 meaning, so a stray Latin "Š" left at
0x8A of a Russian atlas does not turn into "Љ".

Pipeline per glyph: crop alpha -> upscale 8x (bicubic, i.e. a mild blur) -> threshold at 50 %
-> potracer -> cubic Béziers -> Cu2Qu -> TrueType glyf. Potrace returns outer contours and
holes with opposite orientation, so counters (O, A, e ...) survive as nonzero-winding holes.

Metrics: unitsPerEm 1000, the nominal atlas height (32 px for the OLD font, 18 px for
DEFAULT) maps to 1000 units, so `font-size: 32px` reproduces the game's pixel size 1:1.
The baseline is the bottom of "H" (row below its last ink row); advance = glyph width.

Usage:
    python tools/build_webfont.py            # builds all fonts listed in FONTS
    python tools/build_webfont.py --only GothicOld --preview out.png
    python tools/build_webfont.py --lang ru  # Gothic Old RU / Gothic Default RU from public/ui/gothic/ru/
    python tools/build_webfont.py --lang pl --preview pl.png
    python tools/build_webfont.py --lang ru --atlas-dir /tmp/ru --codepage cp1251 --out-dir /tmp/fonts
Run with: uv run --with numpy --with pillow --with potracer --with fonttools --with brotli python tools/build_webfont.py
"""
from __future__ import annotations

import argparse
import codecs
import dataclasses
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

try:
    import potrace  # package "potracer" on PyPI, module name "potrace"
except ImportError:  # pragma: no cover
    sys.exit("potracer is required: pip install potracer")

from fontTools.agl import UV2AGL
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "public" / "ui" / "gothic"
OUT_DIR = ASSETS / "fonts"

UPEM = 1000
UPSCALE = 8
NOTDEF_CODE = 127  # the game draws a box for DEL; it makes a fine .notdef


@dataclass(frozen=True)
class FontSpec:
    atlas: str  # base name of the .png/.json pair
    family: str  # CSS font-family
    file_stem: str  # output file name without extension
    alphamax: float = 1.0  # potrace corner threshold (1.0 = smoothest)
    codepage: str | None = None  # None: the atlas JSON "codepage", else cp1252
    atlas_dir: Path | None = None  # None: public/ui/gothic
    level: int = 127  # stroke weight 0..255: 127 keeps the pixel width, every 32 above erodes 1/8 px per side


TEXT_LEVEL = 255  # stroke level of the text fonts (Gothic Default *): eroded 4/8 px per side, picked by the owner on 2026-10-08 in dev/fontweight.html
# Per-language overrides of TEXT_LEVEL (none: the owner picked one weight for all languages).
TEXT_LEVEL_LANG: dict[str, int] = {}

FONTS = [
    FontSpec("FONT_OLD_20_WHITE", "Gothic Old", "GothicOld"),
    # The text font traced at the pixel width reads too heavy at UI sizes (owner, 2026-10-08): thinner strokes.
    FontSpec("FONT_DEFAULT", "Gothic Default", "GothicDefault", alphamax=0.9, level=TEXT_LEVEL),
    # FONT_20_BOOK / FONT_OLD_10_WHITE are pixel-identical copies of the two above (only the
    # RGB tint differs), so they would only duplicate the files.
]

# Fonts of the localised releases (docs/FONTS.md "Russian and Polish game fonts"): same two atlases,
# extracted from the Russian (Windows-1251) or Polish (Windows-1250) game data into ASSETS/<lang>/.
LANG_CODEPAGES = {"ru": "cp1251", "pl": "cp1250"}
LANG_FONTS = {
    lang: [
        FontSpec("FONT_OLD_20_WHITE", f"Gothic Old {lang.upper()}", f"GothicOld{lang.upper()}",
                 codepage=cp, atlas_dir=ASSETS / lang),
        FontSpec("FONT_DEFAULT", f"Gothic Default {lang.upper()}", f"GothicDefault{lang.upper()}",
                 alphamax=0.9, codepage=cp, atlas_dir=ASSETS / lang, level=TEXT_LEVEL_LANG.get(lang, TEXT_LEVEL)),
    ]
    for lang, cp in LANG_CODEPAGES.items()
}

CODEPAGES = ("cp1252", "cp1250", "cp1251")
# OS/2 ulCodePageRange1 bits: 0 = Latin 1 (1252), 1 = Latin 2 (1250), 2 = Cyrillic (1251)
CODEPAGE_RANGE_BIT = {"cp1252": 0, "cp1250": 1, "cp1251": 2}

# Unicode characters the atlas lacks that can honestly reuse an existing glyph.
ALIASES = {
    0x2014: 0x2013,  # em dash -> en dash (code 151 is missing in the game fonts)
    0x2212: 0x2D,  # minus sign -> hyphen
    0x00AD: 0x2D,  # soft hyphen -> hyphen
    0x2032: 0x27,  # prime -> apostrophe
}


# ---------------------------------------------------------------------------
# atlas reading


class Atlas:
    def __init__(self, name: str, atlas_dir: Path = ASSETS):
        self.meta = json.loads((atlas_dir / f"{name}.json").read_text())
        img = Image.open(atlas_dir / self.meta["atlas"]).convert("RGBA")
        self.alpha = np.array(img)[..., 3]
        self.width, self.height = img.size
        self.px_height = int(self.meta["height"])
        self.glyphs: dict[int, dict] = {int(k): v for k, v in self.meta["glyphs"].items()}

    def crop(self, code: int) -> np.ndarray:
        """Binary ink mask of a glyph: rows = atlas cell rows, cols = exactly `width`."""
        g = self.glyphs[code]
        x0 = round(g["u0"] * self.width)
        y0 = round(g["v0"] * self.height)
        y1 = round(g["v1"] * self.height)
        w = int(g["width"])
        x0 = max(x0, 0)
        cell = self.alpha[y0:y1, x0 : x0 + w]
        if cell.shape[1] < w:  # pad if the cell touches the atlas edge
            cell = np.pad(cell, [(0, 0), (0, w - cell.shape[1])])
        return cell > 127


def ink_rows(mask: np.ndarray) -> tuple[int, int] | None:
    rows = np.where(mask.any(axis=1))[0]
    if len(rows) == 0:
        return None
    return int(rows.min()), int(rows.max())


# ---------------------------------------------------------------------------
# tracing


def trace_mask(mask: np.ndarray, alphamax: float, level: int = 127) -> list[list]:
    """Return potrace curves for a binary ink mask, upscaled 8x with a mild blur."""
    h, w = mask.shape
    big = Image.fromarray((mask * 255).astype(np.uint8)).resize(
        (w * UPSCALE, h * UPSCALE), Image.BICUBIC
    )
    # 1 px of empty margin so contours touching the cell edge still close properly
    arr = np.pad(np.array(big) > min(level, 127), UPSCALE, mode="constant")
    # level > 127 thins the strokes: erode the 8x mask by (level - 127) / 32 upscaled pixels per side
    # (level 255 = 4/8 of a source pixel per side), keeping counters open and stems at least 1 source px wide.
    for _ in range(max(0, (level - 127) // 32)):
        arr = arr & np.roll(arr, 1, 0) & np.roll(arr, -1, 0) & np.roll(arr, 1, 1) & np.roll(arr, -1, 1)
    # potracer convention: True = white (background), False = black (ink)
    bitmap = potrace.Bitmap(~arr)
    path = bitmap.trace(turdsize=UPSCALE, alphamax=alphamax, opticurve=True, opttolerance=0.2)
    return list(path.curves)


def draw_curves(pen, curves, baseline_px: float, scale: float) -> None:
    """Feed potrace curves (upscaled pixel coords, y down) to a fontTools pen in font units."""
    off = UPSCALE  # the padding added in trace_mask

    def pt(p):
        x = (p.x - off) / UPSCALE * scale
        y = (baseline_px - (p.y - off) / UPSCALE) * scale
        return (round(x, 2), round(y, 2))

    for curve in curves:
        start = pt(curve.start_point)
        pen.moveTo(start)
        for seg in curve.segments:
            if seg.is_corner:
                pen.lineTo(pt(seg.c))
                pen.lineTo(pt(seg.end_point))
            else:
                pen.curveTo(pt(seg.c1), pt(seg.c2), pt(seg.end_point))
        pen.closePath()


# ---------------------------------------------------------------------------
# font assembly


def synth_diaeresis(atlas: "Atlas", base_uni: int, codepage: str) -> np.ndarray | None:
    """Mask of `base` with two dots on top, the dots cut from the game's own `i` (None if anything is missing).

    The dots sit as far above the base letter as the i-dot sits above the i stem, centred at 30 % and 70 % of the
    advance. A capital needs room above it inside the atlas cell; without it the caller falls back to no glyph.
    """
    base_code = bytes(chr(base_uni), "utf-8").decode("utf-8").encode(codepage, errors="ignore")
    if len(base_code) != 1 or base_code[0] not in atlas.glyphs or ord("i") not in atlas.glyphs:
        return None
    base = atlas.crop(base_code[0])
    i_mask = atlas.crop(ord("i"))
    i_rows = np.where(i_mask.any(axis=1))[0]
    gaps = np.where(np.diff(i_rows) > 1)[0]
    if len(gaps) == 0:
        return None
    dot_rows = i_rows[: gaps[0] + 1]
    stem_top = int(i_rows[gaps[0] + 1])
    dot = i_mask[dot_rows[0] : dot_rows[-1] + 1]
    cols = np.where(dot.any(axis=0))[0]
    dot = dot[:, cols[0] : cols[-1] + 1]
    gap = stem_top - int(dot_rows[-1]) - 1
    b_rows = ink_rows(base)
    if b_rows is None:
        return None
    bottom = b_rows[0] - gap  # exclusive bottom row of the dots
    top = bottom - dot.shape[0]
    if top < 0:
        return None
    out = base.copy()
    w = out.shape[1]
    for centre in (0.3, 0.7):
        x0 = int(round(centre * w - dot.shape[1] / 2))
        x0 = min(max(x0, 0), w - dot.shape[1])
        out[top:bottom, x0 : x0 + dot.shape[1]] |= dot
    return out


def glyph_name(code: int, uni: int | None) -> str:
    if uni is not None and uni in UV2AGL:
        return UV2AGL[uni]
    if uni is not None:
        return f"uni{uni:04X}"
    return f"code{code}"


def normalize_codepage(codepage: str) -> str:
    """'1251', 'cp1251', 'windows-1251' -> 'cp1251'; only the three game code pages are accepted."""
    name = codecs.lookup(str(codepage).strip().lower()).name  # e.g. 'cp1251'
    if name not in CODEPAGES:
        raise ValueError(f"unsupported code page {codepage!r}, expected one of {', '.join(CODEPAGES)}")
    return name


def code_to_unicode(code: int, codepage: str = "cp1252") -> int | None:
    """Charcode (byte value) of a game font atlas -> Unicode code point, None if undefined.

    The game draws 8-bit text byte by byte, so a slot means whatever the release's code page says:
    cp1252 for the English/German fonts, cp1251 for the Russian one, cp1250 for the Polish one.
    """
    if code < 0x80:
        return code
    try:
        return ord(bytes([code]).decode(codepage))
    except UnicodeDecodeError:
        return None


def stale_codes(atlas: "Atlas", reference: "Atlas | None", codepage: str) -> set[int]:
    """Slots of a localised atlas that still hold the reference (Windows-1252) glyph.

    A slot counts as stale when its ink mask is pixel-identical to the reference atlas' slot with the
    same charcode while the two code pages assign it different characters: the localiser did not
    redraw it, so the glyph still shows the cp1252 character, not the cp125x one.
    """
    if reference is None or codepage == "cp1252":
        return set()
    out = set()
    for code in atlas.glyphs:
        if code < 0x80 or code not in reference.glyphs:
            continue
        if code_to_unicode(code, codepage) == code_to_unicode(code, "cp1252"):
            continue
        a, b = atlas.crop(code), reference.crop(code)
        if a.shape == b.shape and a.any() and np.array_equal(a, b):
            out.add(code)
    return out


def _rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def build_font(
    spec: FontSpec,
    verbose: bool = True,
    out_dir: Path = OUT_DIR,
    codepage: str | None = None,
    reference_dir: Path | None = ASSETS,
) -> dict:
    """Trace one atlas into <out_dir>/<file_stem>.ttf/.woff/.woff2 and return build info.

    codepage: overrides spec.codepage and the atlas JSON; reference_dir: where the Windows-1252 atlas
    of the same name lives (used to find untouched slots of a localised atlas; None disables it).
    """
    atlas_dir = spec.atlas_dir or ASSETS
    atlas = Atlas(spec.atlas, atlas_dir)
    codepage = normalize_codepage(codepage or spec.codepage or atlas.meta.get("codepage") or "cp1252")
    reference = None
    if codepage != "cp1252" and reference_dir is not None:
        ref_json = reference_dir / f"{spec.atlas}.json"
        if ref_json.exists() and ref_json.resolve() != (atlas_dir / f"{spec.atlas}.json").resolve():
            reference = Atlas(spec.atlas, reference_dir)
    stale = stale_codes(atlas, reference, codepage)
    scale = UPEM / atlas.px_height

    # baseline = row below the last ink row of "H" (fallback: "x", then the global bottom)
    base_from = None
    for probe in (ord("H"), ord("x")):
        if probe in atlas.glyphs:
            r = ink_rows(atlas.crop(probe))
            if r:
                base_from = r[1] + 1
                break
    if base_from is None:
        raise RuntimeError(f"{spec.atlas}: cannot find H/x to estimate the baseline")
    baseline_px = base_from

    glyph_order = [".notdef", "space"]
    cmap: dict[int, str] = {}
    glyphs: dict = {}
    metrics: dict[str, tuple[int, int]] = {}
    top_px, bottom_px = baseline_px, baseline_px
    mapped = []

    # .notdef from the DEL box, or an empty box of the H advance
    pen = TTGlyphPen(None)
    if NOTDEF_CODE in atlas.glyphs:
        nd_mask = atlas.crop(NOTDEF_CODE)
        draw_curves(Cu2QuPen(pen, max_err=1.0), trace_mask(nd_mask, spec.alphamax, spec.level), baseline_px, scale)
        nd_adv = int(atlas.glyphs[NOTDEF_CODE]["width"])
    else:
        nd_adv = int(atlas.glyphs[ord("H")]["width"])
    glyphs[".notdef"] = pen.glyph()
    metrics[".notdef"] = (round(nd_adv * scale), 0)

    # space (+ nbsp) carries the game's own, rather wide, space advance
    space_adv = int(atlas.glyphs.get(32, {"width": nd_adv // 2})["width"])
    glyphs["space"] = TTGlyphPen(None).glyph()
    metrics["space"] = (round(space_adv * scale), 0)
    cmap[0x20] = "space"
    cmap[0xA0] = "space"

    # redrawn slots first, so a stale slot never takes a code point a localised glyph claims
    for code in sorted(atlas.glyphs, key=lambda c: (c in stale, c)):
        if code in (32, NOTDEF_CODE):
            continue
        uni = code_to_unicode(code, "cp1252" if code in stale else codepage)
        if code in stale and uni in cmap:
            continue
        if uni is None or uni < 0x21:
            continue
        mask = atlas.crop(code)
        rows = ink_rows(mask)
        if rows is None:
            continue  # unused slot in the atlas
        name = glyph_name(code, uni)
        if name in glyphs:
            cmap[uni] = name
            continue
        curves = trace_mask(mask, spec.alphamax, spec.level)
        pen = TTGlyphPen(None)
        draw_curves(Cu2QuPen(pen, max_err=1.0), curves, baseline_px, scale)
        glyphs[name] = pen.glyph()
        advance = int(atlas.glyphs[code]["width"])
        metrics[name] = (round(advance * scale), 0)
        glyph_order.append(name)
        cmap[uni] = name
        mapped.append(uni)
        top_px = min(top_px, rows[0])
        bottom_px = max(bottom_px, rows[1] + 1)

    # Ё/ё: the Russian atlases have no slot for them (cp1251 0xA8/0xB8 stay Latin), yet Russian text uses ё a lot.
    # Stamp two copies of the dot of `i` over Е/е at the i-dot's distance above the letter, then trace like any glyph.
    if codepage == "cp1251":
        for uni, base_uni in ((0x0451, 0x0435), (0x0401, 0x0415)):
            mask = synth_diaeresis(atlas, base_uni, codepage)
            if uni in cmap or mask is None:
                continue
            name = glyph_name(0, uni)
            curves = trace_mask(mask, spec.alphamax, spec.level)
            pen = TTGlyphPen(None)
            draw_curves(Cu2QuPen(pen, max_err=1.0), curves, baseline_px, scale)
            glyphs[name] = pen.glyph()
            metrics[name] = metrics[cmap[base_uni]]
            glyph_order.append(name)
            cmap[uni] = name
            mapped.append(uni)
            rows = ink_rows(mask)
            top_px = min(top_px, rows[0])
        # No room above the capital in the small atlas: Ё falls back to Е (Ё is rare; the text font never needs it).
        if 0x0401 not in cmap and 0x0415 in cmap:
            cmap[0x0401] = cmap[0x0415]

    for uni, target in ALIASES.items():
        if uni not in cmap and target in cmap:
            cmap[uni] = cmap[target]

    # vertical metrics: ink extents, then padded so ascender + descender == 1 em
    ascender_px = baseline_px - top_px
    descender_px = bottom_px - baseline_px
    extra = atlas.px_height - (ascender_px + descender_px)
    if extra > 0:
        ascender_px += extra
    ascender = round(ascender_px * scale)
    descender = -round(descender_px * scale)

    cap_h = ink_rows(atlas.crop(ord("H")))
    x_h = ink_rows(atlas.crop(ord("x"))) if ord("x") in atlas.glyphs else None
    cap_height = round((baseline_px - cap_h[0]) * scale) if cap_h else ascender
    x_height = round((baseline_px - x_h[0]) * scale) if x_h else cap_height * 2 // 3

    ps_name = f"{spec.file_stem}-Regular"
    fb = FontBuilder(UPEM, isTTF=True)
    fb.setupGlyphOrder(glyph_order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=ascender, descent=descender, lineGap=0)
    fb.setupNameTable(
        {
            "familyName": spec.family,
            "styleName": "Regular",
            "uniqueFontIdentifier": f"{ps_name};gothic2-guessr",
            "fullName": f"{spec.family} Regular",
            "psName": ps_name,
            "version": "Version 1.0",
            "copyright": "Glyph shapes extracted from the Gothic II bitmap font "
            f"{spec.atlas} ({codepage}) (Piranha Bytes / THQ Nordic). Not for redistribution.",
            "description": "Auto-traced from the game's font atlas by tools/build_webfont.py "
            "(potracer + fontTools).",
        }
    )
    fb.setupOS2(
        version=4,
        sTypoAscender=ascender,
        sTypoDescender=descender,
        sTypoLineGap=0,
        usWinAscent=ascender,
        usWinDescent=-descender,
        sxHeight=x_height,
        sCapHeight=cap_height,
        fsSelection=(1 << 6) | (1 << 7),  # REGULAR | USE_TYPO_METRICS
        achVendID="GOTH",
        usWeightClass=400,
        usWidthClass=5,
        fsType=0,
        ulCodePageRange1=1 << CODEPAGE_RANGE_BIT[codepage],
    )
    fb.setupPost(isFixedPitch=0)

    out_dir.mkdir(parents=True, exist_ok=True)
    ttf_path = out_dir / f"{spec.file_stem}.ttf"
    fb.save(ttf_path)

    outputs = {"ttf": ttf_path}
    for flavor in ("woff", "woff2"):
        font = TTFont(ttf_path)
        font.flavor = flavor
        out = out_dir / f"{spec.file_stem}.{flavor}"
        try:
            font.save(out)
            outputs[flavor] = out
        except ImportError as e:  # brotli missing for woff2
            print(f"  ! {flavor} skipped: {e}", file=sys.stderr)

    info = {
        "family": spec.family,
        "codepage": codepage,
        "atlas_dir": _rel(atlas_dir),
        "stale": sorted(stale),
        "files": {k: _rel(v) for k, v in outputs.items()},
        "sizes": {k: v.stat().st_size for k, v in outputs.items()},
        "glyphs": len(glyph_order),
        "codepoints": sorted(cmap),
        "aliases": {f"U+{k:04X}": f"U+{v:04X}" for k, v in ALIASES.items() if k in cmap},
        "px_height": atlas.px_height,
        "baseline_px": baseline_px,
        "ascender": ascender,
        "descender": descender,
        "cap_height": cap_height,
        "x_height": x_height,
    }
    if verbose:
        print(
            f"{spec.family} ({codepage}): {len(glyph_order)} glyphs, {len(cmap)} codepoints, "
            f"baseline row {baseline_px}/{atlas.px_height} px, asc {ascender} desc {descender}, "
            f"cap {cap_height} x {x_height}"
        )
        if stale:
            print(f"  {len(stale)} untouched cp1252 slots kept as Latin: "
                  + " ".join(f"0x{c:02X}" for c in sorted(stale)))
        for k, v in outputs.items():
            print(f"  {_rel(v)}  {v.stat().st_size} bytes")
    return info


PREVIEW_SAMPLES = {
    "cp1252": "Gothic II Guessr — Khorinis 1234567890 ÄÖÜ äöü ß é",
    "cp1251": "Готика II — Хоринис, Яркендар 1234567890 ЁЖЩЪЫЭЮЯ ёжщъыэюя № «»",
    "cp1250": "Gothic II — Górnicza Dolina 1234567890 ĄĆĘŁŃÓŚŹŻ ąćęłńóśźż „”",
}


def render_preview(infos: list[dict], out: Path) -> None:
    """Rasterise a sample line with each built TTF (FreeType via Pillow) for a quick check.

    Characters missing from a font render as its .notdef box, so a wrong code page shows at once.
    """
    from PIL import ImageDraw, ImageFont

    lines = []
    for info in infos:
        ttf = Path(info["files"]["ttf"])
        ttf = ttf if ttf.is_absolute() else ROOT / ttf
        sample = PREVIEW_SAMPLES.get(info.get("codepage", "cp1252"), PREVIEW_SAMPLES["cp1252"])
        for size in (18, 32, 64):
            font = ImageFont.truetype(str(ttf), size)
            lines.append((font, size, sample))
    height = sum(int(s * 1.4) + 8 for _, s, _ in lines) + 16
    img = Image.new("RGB", (1800, height), (20, 20, 30))
    d = ImageDraw.Draw(img)
    y = 8
    for font, size, sample in lines:
        d.text((8, y), sample, font=font, fill=(255, 223, 175))
        y += int(size * 1.4) + 8
    img.save(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--level", type=int, help="override the trace threshold (127 = pixel width; higher = thinner)")
    ap.add_argument("--only", action="append", help="file stem(s) to build, e.g. GothicOld")
    ap.add_argument("--preview", type=Path, help="write a PNG rasterised with the built TTFs")
    ap.add_argument("--json", type=Path, help="write build info as JSON")
    ap.add_argument("--lang", choices=sorted(LANG_FONTS),
                    help="build the localised families (Gothic Old RU, ...) from public/ui/gothic/<lang>/")
    ap.add_argument("--codepage", help="charcode mapping of the atlas: cp1252 (default), cp1251 (ru), cp1250 (pl)")
    ap.add_argument("--atlas-dir", type=Path, help="directory with the <atlas>.png/.json pairs")
    ap.add_argument("--out-dir", type=Path, default=OUT_DIR, help=f"output directory (default {_rel(OUT_DIR)})")
    ap.add_argument("--reference", type=Path, default=ASSETS,
                    help="directory of the cp1252 atlases used to spot untouched slots (default %(default)s)")
    ap.add_argument("--no-reference", action="store_true", help="map every slot with the code page as is")
    args = ap.parse_args()

    if args.codepage:
        try:
            args.codepage = normalize_codepage(args.codepage)
        except (LookupError, ValueError) as e:
            ap.error(str(e))
    base = LANG_FONTS[args.lang] if args.lang else FONTS
    specs = [s for s in base if not args.only or s.file_stem in args.only]
    infos = []
    for spec in specs:
        atlas_dir = args.atlas_dir or spec.atlas_dir or ASSETS
        spec = dataclasses.replace(spec, atlas_dir=atlas_dir, level=args.level if args.level is not None else spec.level)
        if not (atlas_dir / f"{spec.atlas}.json").exists():
            print(f"{_rel(atlas_dir)}/{spec.atlas}: atlas missing, skipped "
                  "(extract it with tools/extract_ui_assets.py --fonts, see docs/FONTS.md)", file=sys.stderr)
            continue
        infos.append(build_font(spec, out_dir=args.out_dir, codepage=args.codepage,
                                reference_dir=None if args.no_reference else args.reference))
    if args.preview and infos:
        render_preview(infos, args.preview)
        print(f"preview: {args.preview}")
    if args.json:
        args.json.write_text(json.dumps(infos, indent=1))


if __name__ == "__main__":
    main()
