# Web fonts from the Gothic II bitmap fonts

Two vector families are built from the game's font atlases so ordinary CSS can use them. Like everything under
`public/ui/gothic/`, the atlases and the fonts are not in the repository: `npm run assets` (`tools/build_assets.sh`)
builds them from your own copy of the game (`GOTHIC2_DIR`, plus `GOTHIC2_RU_DIR` / `GOTHIC2_PL_DIR` for the Russian
and Polish families below).

| Family (CSS `font-family`) | Source atlas | Native size | Files (`public/ui/gothic/fonts/`) |
|---|---|---|---|
| `"Gothic Old"` | `FONT_OLD_20_WHITE` | 32 px | `GothicOld.woff2` (15.9 KB), `GothicOld.woff` (21.6 KB), `GothicOld.ttf` (84 KB) |
| `"Gothic Default"` | `FONT_DEFAULT` | 18 px | `GothicDefault.woff2` (14.2 KB), `GothicDefault.woff` (17.7 KB), `GothicDefault.ttf` (47 KB) |

`FONT_20_BOOK` and `FONT_OLD_10_WHITE` are pixel-identical to the two above (only the RGB tint of the atlas differs),
so no third family is built. Both fonts are Regular, TrueType outlines (`glyf`), 1000 units per em.

```css
@font-face {
  font-family: "Gothic Old";
  src: url("/ui/gothic/fonts/GothicOld.woff2") format("woff2"),
       url("/ui/gothic/fonts/GothicOld.woff") format("woff");
  font-display: block;
}
h1 { font-family: "Gothic Old", Georgia, serif; }      /* 32px reproduces the game 1:1 */
p  { font-family: "Gothic Default", Georgia, serif; }  /* 18px reproduces the game 1:1 */
```

The harness `dev/fonts.html` (`npx vite`, then `/dev/fonts.html`) shows both families at several sizes, the full ASCII
and Latin-1 ranges, the serif fallback for Cyrillic, and a vector-vs-bitmap strip at native size.

## How they are built

`tools/build_webfont.py` (Python: numpy, pillow, potracer, fonttools, brotli for woff2):

1. Read `<atlas>.json`: per charcode `{width, u0, v0, u1, v1}`. `u1`/`v1` are the inclusive last texel, so the ink of
   a glyph is exactly `width` columns starting at `round(u0 * atlasWidth)`; the shape is the alpha channel (binary).
2. Upscale each glyph's alpha 8x with bicubic interpolation and threshold at 50 % (a mild blur that turns the pixel
   staircase into diagonals), then trace with potracer (`turdsize=8`, `alphamax=1.0`, `0.9` for the text font).
   potracer returns outer contours and holes with opposite orientation, so counters survive under nonzero winding.
3. Cubic Béziers go through `Cu2QuPen` (max error 1 unit) into `TTGlyphPen`, then `fontTools.fontBuilder.FontBuilder`
   assembles `glyf`, `cmap`, `hmtx`, `hhea`, `OS/2` (v4, USE_TYPO_METRICS), `name`, `post`; `.woff`/`.woff2` are
   re-saves of the TTF (woff2 needs the `brotli` module, otherwise it is skipped with a message).

Metrics:

- Scale: the nominal atlas height (32 px / 18 px) is 1 em, so `font-size: 32px` for Gothic Old and `18px` for
  Gothic Default render the glyphs at the game's pixel size.
- Baseline: the row under the last ink row of `H` (atlas row 27 of 38 for the OLD font, 15 of 18 for DEFAULT).
- Ascender/descender from the ink extents, padded to one em: Gothic Old 750/-250, cap height 562, x-height 438;
  Gothic Default 833/-167, cap height 667, x-height 444. Line gap 0, so `line-height: 1` equals the game's row height.
- Advance = the glyph's `width` from the game (its ink spans the full width, so adjacent uppercase serifs touch exactly
  as the game draws them; add `letter-spacing` in CSS if you want air). The space keeps the game's wide advance
  (17 px of 32 for Gothic Old, 10 of 18 for Default); U+00A0 maps to the same glyph.
- `.notdef` is the game's own box glyph (charcode 127).

Rebuild everything with `npm run assets`, or only the fonts:
`python tools/build_webfont.py [--preview out.png] [--json info.json] [--only GothicOld]`.

### Stroke weight of the text fonts

Traced at the pixel width, `Gothic Default` reads too heavy at UI sizes (owner, 2026-10-08). `FontSpec.level` thins
the strokes: 127 keeps the pixel width, every 32 above it erodes the 8x mask by 1/8 of a source pixel per side before
tracing. The text fonts use `TEXT_LEVEL = 255` (4/8 px per side) in every language: the owner picked it on 2026-10-08
in `dev/fontweight.html`, which compares levels 127–287 with the real UI strings (variants in
`public/ui/gothic/fonts-cmp/`, built by `npm run assets` with `--level N --out-dir <tmp>/lN`, woff2 only;
`ASSETS_FONT_LEVELS=0` skips them). The display font (`Gothic Old*`) stays at 127. Try other
values without touching the repo: `build_webfont.py --only GothicDefault --level 223 --out-dir /tmp/x --preview /tmp/x.png`.

## Coverage and what is missing

175 glyphs, 179 code points per font. Charcodes 32–255 of the atlas are mapped as Windows-1252; of the 0x80–0x9F
block the game has ‚ „ Š Œ Ž ‘ ’ “ ” – ™ š œ ž Ÿ. Aliases that reuse an existing glyph:
U+2014 em dash → en dash, U+2212 minus → hyphen, U+00AD soft hyphen → hyphen, U+2032 prime → apostrophe.

Not in the game fonts, so they fall back to the next family in the CSS stack:

- ASCII: `*` `[` `]` `^` `` ` `` (backtick).
- Latin-1 symbols: `¢ £ ¤ ¥ ¦ ¨ ª « ¬ ¯ ° ± ² ³ ´ µ ¶ · ¸ ¹ º » ¼ ½ ¾`.
- cp1252 extras: `€ ƒ … † ‡ ˆ ‰ ‹ • ˜ ›` (codes 128, 131, 133–136, 137, 139, 149, 152, 155) and `—` (151, aliased
  to the en dash). The ellipsis and the euro sign therefore come from the fallback font.
- Everything outside Latin-1: Cyrillic, Greek, arrows, etc. Pick a serif fallback with a similar colour/weight
  for Russian UI text.

No hinting and no kerning; the outlines are traced pixels, so sizes far above native look deliberately chunky and
sizes below ~14 px (Gothic Old) / ~12 px (Gothic Default) blur.

## Fallback font: Alegreya (SPEC §10.8)

Before the Russian and Polish atlases were extracted (next section), the game fonts stopped at Latin-1: German works
(ä ö ü ß are there), Polish lacked ą ć ę ł ń ś ź ż and Russian the whole Cyrillic block. Letting the browser fall back
per glyph would have drawn "Górnicza" with an Alegreya-or-Georgia "ó" next to Gothic letters, so for `pl` and `ru` the
whole UI used one OFL family instead: **Alegreya** (`@fontsource/alegreya`, Juan Pablo del Peral, SIL OFL 1.1).

Since the localised game fonts are wired in (see "Wiring" below), Alegreya is only the fallback behind the game fonts
in every language: the few characters no game font has (`« » … · * [ ]`), nicknames in a script the active
language's game font lacks (`.g2-ext-script`), and the long prose of the legal dialog (`.g2-legal-body`, all
languages, for readability).

```css
@import '@fontsource/alegreya/latin-400.css';      /* + latin-ext-400, cyrillic-400 and the same three at 700 */
:root {
  --g2-font-display: 'Gothic Old', 'Alegreya', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif;
  --g2-font-text: 'Gothic Default', 'Alegreya', 'Palatino Linotype', Palatino, Georgia, serif;
}
```

- Only the `latin`, `latin-ext` and `cyrillic` subsets, weights 400 and 700 (table headers and other default-bold
  elements, otherwise synthesized). Each `@font-face` carries a `unicode-range`, so a page downloads a subset only
  when one of its characters is on screen (an ellipsis, a middle dot, a Cyrillic nickname in an English list).
- Alegreya defaults to old-style figures (a 0 reads as an o), so `.g2-ext-script` and `.g2-legal-body` turn on
  lining figures (`font-feature-settings: 'lnum' 1`).

### Why Alegreya

Candidates were the installed packages: Alegreya SC, Alegreya, Cormorant SC, EB Garamond, Philosopher. Each was put
into both variables and the start screen rendered in `ru` and `pl` next to the English Gothic one
(`dev/screens.html`, 1280×720):

- **Alegreya**: calligraphic humanist serif with broad-nib modulation and a dark, even colour, the closest in weight and
  texture to the chunky Gothic bitmaps; very readable at 15-18 px, full Polish and Cyrillic. Chosen.
- Alegreya SC: the same design in small caps; good for headings, but descriptions and hints in all small caps read
  poorly. Pairing it with Alegreya for headings would look closest to the game menu, but adds a second family; kept
  as an option if a future pass wants it (`--g2-font-display` only).
- Cormorant SC: elegant but thin and all small caps; body text becomes pale and hard to read on the dark panels.
- EB Garamond: a fine book face, but light and bookish next to the menu frames; headings lose the Gothic heft.
- Philosopher: rounded, semi-sans, reads as modern UI rather than a medieval game.

## Russian and Polish game fonts (Gothic Old RU/PL, Gothic Default RU/PL)

The Russian and Polish releases of Gothic II draw their text with the same bitmap fonts (`FONT_OLD_20_WHITE`,
`FONT_DEFAULT`, ...), redrawn for their 8-bit code page: the engine has no Unicode and indexes the 256-slot atlas by
the byte value of the text, so a Russian atlas holds Cyrillic in **Windows-1251** order (А…я at 0xC0–0xFF, Ё 0xA8,
ё 0xB8, № 0xB9) and a Polish one holds ą ć ę ł ń ó ś ź ż in **Windows-1250** order (ą 0xB9, ł 0xB3, ś 0x9C, ź 0x9F,
ż 0xBF, ...). With those atlases `pl` and `ru` use real Gothic letters instead of the Alegreya fallback. The atlases
were extracted from the Steam language depots (`public/ui/gothic/ru/`, `public/ui/gothic/pl/`) and the four families
are built into `public/ui/gothic/fonts/` (`GothicOldRU`, `GothicDefaultRU`, `GothicOldPL`, `GothicDefaultPL`, each as
`.woff2`, `.woff` and `.ttf`); "Wiring" at the end says how the UI uses them.

### Where the fonts legally come from (state of 2026-10)

- The local install (Steam app 39510 "Gothic II: Gold Classic", English) has **no** localised fonts: all four font
  archives (`Textures.vdf`, `Textures_Addon.vdf`, `Textures_Fonts_Apostroph.vdf`, `Textures_Addon_Menu_English.vdf`)
  hold Latin-1 atlases only (checked with zenkit; slots 0xC0–0xFF are À…ÿ in every copy). `Textures_multilingual_Jowood.vdf`
  and the `.mod` files carry no fonts.
- The Steam release itself ships both languages as official language depots. From the Steam client's own app info
  cache (`appcache/appinfo.vdf`) for app 39510:

  | Depot | Language | Size |
  |---|---|---|
  | 39511 | base content (all languages) | 3.27 GB |
  | 39517 | english | 74 MB |
  | 39512 | german | 1.96 GB |
  | 39516 | **polish** | 2.43 GB |
  | 39518 | **russian** | 2.19 GB |
  | 39513 / 39514 / 39515 | french / italian / spanish | ~0.2 GB each |

  The store page lists Polish and Russian with interface, full audio and subtitles
  (https://store.steampowered.com/app/39510/, https://store.steampowered.com/api/appdetails?appids=39510). The Russian
  text is the Akella localisation, repaired in a Steam update of October 2022
  (https://ixbt.games/news/2022/10/27/gothic-1-i-gothic-2-polucili-obnovlenie-s-russkoi-lokalizaciei-v-steam-ot-snowball-studios-i-akella.html,
  https://stopgame.ru/newsdata/55606/v_steam_versiyah_pervoy_i_vtoroy_gothic_obnovili_russkuyu_lokalizaciyu). The
  Polish depot with full audio is the CD Projekt localisation (the only Polish dub of Gothic II / Noc Kruka).
- GOG's Gothic 2 Gold Edition also lists Polski and Русский (https://www.gog.com/en/game/gothic_2_gold_edition) as
  separate language installers; that is a separate purchase, so Steam is the way here.
- Code pages: Gothic Modding Community docs (Polish = windows-1250, Russian = windows-1251,
  https://github.com/Gothic-Modding-Community/gmc/blob/main/docs/zengin/tools/daedalus_tools/daedalus_language_server.md)
  and the Gothic script sources note that the game "does not support multibyte encodings and Unicode" and needs the
  matching "fontmap texture" (https://github.com/VaanaCZ/gothic-1-classic-scripts#encoding). OpenGothic draws text
  the same way, one atlas slot per byte (`common/utils/gthfont.cpp` in https://github.com/Try/OpenGothic).
- What exactly sits in depots 39516/39518 (which archive name, compiled `-C.TEX` or loose `.TGA`) is not visible
  without downloading them; the extractor prints an inventory, so that does not matter.

Do not take fonts from fan "русификатор"/"spolszczenie" packages: they are not ours to use, and the official depots
contain the same thing.

### Get the localised game files (once)

Option A keeps the English install untouched (the other tools read it), so it is the preferred one. Both need a
Steam account that owns the game.

**A. Download only the language depot (Steam console).**

1. Open the Steam console: run `steam://open/console` (browser address bar, `open steam://open/console` on macOS,
   `steam steam://open/console` on Linux; under Wine/CrossOver run `steam.exe steam://open/console` inside the
   prefix). The Steam window gets a *Console* tab.
2. Type `download_depot 39510 39518` for Russian, then `download_depot 39510 39516` for Polish. Each takes a while
   (2.2 / 2.4 GB, mostly speech); the console prints the target folder when done, inside the Steam folder:
   `<Steam>/steamapps/content/app_39510/depot_39518/` (and `depot_39516`).
3. Point `GOTHIC2_RU_DIR` and `GOTHIC2_PL_DIR` at those two folders and run `npm run assets`. Nothing has to be
   launched or installed.

**B. Switch the game language (if the console route fails).**

1. Steam → Library → right-click *Gothic II: Gold Classic* → *Properties* → *General* → *Language* → *Русский*.
   Steam downloads depot 39518 and swaps the language files in the install.
2. Copy the whole `Gothic II/Data` folder to `~/Gothic2-locale/ru/Data` (the game itself does not have to be started).
3. Repeat with *Polski* → `~/Gothic2-locale/pl/Data`. Use `GOTHIC2_RU_DIR=~/Gothic2-locale/ru` and
   `GOTHIC2_PL_DIR=~/Gothic2-locale/pl`.
4. Switch the language back to *English* and let Steam finish, because the panorama and UI pipelines expect the
   English install (`Textures_Addon_Menu_English.vdf`, English speech/menus).

### Build the families

`npm run assets` with `GOTHIC2_RU_DIR` / `GOTHIC2_PL_DIR` set runs both steps below for both languages. By hand,
one command per step (Python deps come from uv, nothing is installed into the repo):

```sh
EX="uv run --with zenkit==1.3.0.4 --with pillow --with numpy python"
WF="uv run --with numpy --with pillow --with potracer --with fonttools --with brotli python"

# 1. atlases -> public/ui/gothic/ru/ and public/ui/gothic/pl/ (FONT_*.png + .json with "codepage")
$EX tools/extract_ui_assets.py --fonts ".../steamapps/content/app_39510/depot_39518" --lang ru
$EX tools/extract_ui_assets.py --fonts ".../steamapps/content/app_39510/depot_39516" --lang pl
#    (or --fonts ~/Gothic2-locale/ru  - a game dir with Data/, a single .vdf, or a folder of loose FONT_*.FNT + .TGA)

# 2. vector fonts -> public/ui/gothic/fonts/GothicOldRU.woff2, GothicDefaultRU.woff2, GothicOldPL..., GothicDefaultPL...
$WF tools/build_webfont.py --lang ru --preview /tmp/ru.png
$WF tools/build_webfont.py --lang pl --preview /tmp/pl.png
```

What to look at:

- Step 1 lists every archive with the `FONT_*.FNT` it carries and, per font, how many slots at 0x80 and above differ
  from the English atlas in `public/ui/gothic/`. `SAME AS ENGLISH` means the source holds no localised font (wrong
  folder, or the depot ships its fonts elsewhere: pass the folder with all of `Data/`). Archives are mounted the way
  the engine does it, the newest copy of a file name wins; to force one archive pass that `.vdf` alone.
- Step 2 prints, per family, the code page, glyph count, metrics and the slots kept as Latin. A slot whose glyph is
  pixel-identical to the English atlas while the code pages disagree (e.g. a leftover "Š" at 0x8A in a Russian font,
  which cp1251 calls "Љ") keeps its Windows-1252 meaning instead of claiming a Cyrillic or Polish code point it does
  not draw; `--no-reference` turns that off. The preview PNG renders a Russian ("Готика II — Хоринис, Яркендар …
  Ёё №«»") or Polish ("Górnicza Dolina … ĄĆĘŁŃÓŚŹŻ ąćęłńóśźż „”") line at 18/32/64 px: any box there is a
  character the font lacks.
- Options: `--codepage cp1250|cp1251|cp1252` overrides the code page (both tools), `--atlas-dir` / `--out-dir` /
  `--reference` move the inputs and outputs, `--only GothicOldRU` builds one family. OS/2 `ulCodePageRange1` is set
  to Cyrillic or Latin 2 accordingly; family names are `Gothic Old RU`, `Gothic Default RU`, `Gothic Old PL`,
  `Gothic Default PL`.

Self-test (synthetic atlases, no game data):
`uv run --with numpy --with pillow --with potracer --with fonttools --with brotli --with zenkit==1.3.0.4 python tools/test_font_codepages.py`.

### Wiring

`src/style.css` declares the four families next to `Gothic Old` / `Gothic Default` (woff2 + woff, `font-display:
block`, so the UI never flashes in the fallback) and puts them first under `:lang()`:

```css
:lang(pl) {
  --g2-font-display: 'Gothic Old PL', 'Gothic Old', 'Alegreya', ... serif;
  --g2-font-text: 'Gothic Default PL', 'Gothic Default', 'Alegreya', ... serif;
}
:lang(ru) {
  --g2-font-display: 'Gothic Old RU', 'Gothic Old', 'Alegreya', ... serif;
  --g2-font-text: 'Gothic Default RU', 'Gothic Default', 'Alegreya', ... serif;
}
```

- `<html lang>` is set by `src/i18n` (`initLanguage` / `setLanguage`), so every rule that uses
  `var(--g2-font-display)` / `var(--g2-font-text)` switches at once. A nested `[lang]` element switches too: the
  language selector draws "Polski" and "Русский" in their own game fonts inside any page. The families are only
  referenced under `:lang(pl|ru)`, so English and German pages download none of them (14–17 KB woff2 each).
- The localised atlases contain ASCII, so a Polish or Russian word never mixes two fonts. Behind them sits the
  English game font, for `×` (missing from cp1251) and the Latin-1 letters cp1250 lacks (Ñ, Æ, ...), then Alegreya.
- The Russian `FONT_OLD_20_WHITE` atlas is 35 px tall where the English and Polish ones are 32 px, and the web font
  maps the atlas height to 1 em. `size-adjust: 109.375%` (35 / 32) on `Gothic Old RU` restores the game's pixel size,
  so Russian headings are as large as English ones; `ascent-override: 68.57%` / `descent-override: 22.86%` (scaled
  by size-adjust to 75 % / 25 %) keep the same 1 em line box as `Gothic Old`. `FONT_DEFAULT` is 18 px in all three
  languages and needs no adjustment.
- The Russian release redrew both fonts in its own, heavier design (the Akella localisation), and its space is
  narrower (8 of 35 px in the old font, 5 of 18 px in the default one, against 17/32 and 10/18 in English). The UI
  keeps that as the game look. The Polish atlases are the English design plus the Polish letters, with the same
  metrics, so Polish screens look exactly like English and German ones.
- Everything the Alegreya period needed is gone: no `lnum` on pl/ru pages (the game fonts have lining digits), the
  `.g2-digit` fixed-width countdown digits apply in every language again, and tables use `line-height: 1`
  everywhere (pl/ru had 1.15).
- Nicknames (`src/ui/dom.ts` `nicknameEl`): a name gets `.g2-ext-script` (whole name in Alegreya) only when it has
  a character the active language's game font lacks: outside Latin-1 for en/de, outside Latin-1 + the cp1250 Polish
  letters for pl, outside ASCII + Cyrillic for ru (Latin-1 letters such as é would otherwise come from the lighter
  English font). So "Безымянный герой 0570" is drawn in Gothic Default RU on a Russian page and in Alegreya on an
  English or Polish one, and "Łucja Wróbel" the other way round.
- `src/i18n/ru.ts` uses the Russian low-high quotes „…“ instead of guillemets: the cp1251 atlases have „ and “ but
  no « ».
- Layout at 1280×720 was checked with Playwright in ru, pl and en on the menu, quick play setup with its rules panel,
  daily page, round HUD, result, summary with leaderboard, normal and duel lobby, report and legal dialogs
  (`docs/stage3-polish-screens/fonts-*.jpg`). The only fix needed: the collapsed map widget's hint ("Отметьте ответ
  на карте") was 4 px too wide next to "Закрепить", so the map bar gap and the Pin button's padding went from 8 px
  to 6 px.

What still falls back to Alegreya, checked against the cmaps with fontTools (the same characters fall back on
English and German pages, which is accepted; no glyphs are invented):

| Character | ru (cp1251) | pl (cp1250) | Where the UI uses it |
|---|---|---|---|
| `…` U+2026 | falls back | falls back | "Загрузка…", "Ждём игроков…", the leaderboard gap row, the duel multiplier rule |
| `·` U+00B7 | falls back | falls back | "Сегодня · 8 октября", "Дуэль · Лобби", the settings line separators |
| `*` | falls back | falls back | not used in ru/pl strings |
| `×` U+00D7 | from `Gothic Default` / `Gothic Old` | in the font | duel multiplier "×1,5" |
| `«` `»` | not used any more | not used | (ru now uses „ “) |
| `[` `]` `^` `` ` `` `°` `€` `№` | missing | missing | not used in ru/pl strings |

The share text's coloured squares are emoji (system emoji font) and the map's `+` / `−` zoom buttons use the
Leaflet control font; neither was meant to use the game fonts.
