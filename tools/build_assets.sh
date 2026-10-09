#!/usr/bin/env bash
# Build every game-derived file of the UI (public/ui/gothic/) from your own copy of Gothic II: `npm run assets`.
#
# Nothing in public/ui/gothic/ is in the repository (the textures, fonts and icons belong to THQ Nordic / Piranha Bytes);
# this script recreates all of it from the game files. Inputs come from the environment only:
#
#   GOTHIC2_DIR         required  Gothic II Gold install root, the folder with Data/ and System/
#   GOTHIC2_RU_DIR      optional  Russian Steam language depot 39518 (or a Russian install): Gothic Old/Default RU
#   GOTHIC2_PL_DIR      optional  Polish Steam language depot 39516 (or a Polish install): Gothic Old/Default PL
#   ASSETS_OUT          optional  output directory (default public/ui/gothic); `--out DIR` does the same
#   ASSETS_FONT_LEVELS  optional  0: skip the stroke-weight variants for dev/fontweight.html (fonts-cmp/, ~10 s)
#   DATA_DIR            optional  published dataset for the link-preview image (default public/data)
#   SERVER_DATA_DIR     optional  private manifests for the link-preview image (default server-data)
#
# Steps: UI textures, painted maps + thumbnails, menu art, bitmap fonts, site icons (tools/extract_ui_assets.py) ->
# localised font atlases (--fonts, if GOTHIC2_RU_DIR / GOTHIC2_PL_DIR are set) -> web fonts and their weight variants
# (tools/build_webfont.py) -> og-image.jpg (tools/make_og_image.py, only when the dataset is published).
# Python dependencies come from uv; the whole run takes about 20 s.
# See README.md "Reproduce from your own copy of the game" and docs/FONTS.md for the language depots.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${ASSETS_OUT:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?--out needs a directory}"; shift 2 ;;
    --out=*) OUT="${1#--out=}"; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "build_assets.sh: unknown argument $1 (see --help)" >&2; exit 2 ;;
  esac
done

die() { echo "build_assets.sh: $*" >&2; exit 1; }
command -v uv >/dev/null || die "uv is required (https://docs.astral.sh/uv/): the Python tools run with 'uv run --with ...'"
[ -n "${GOTHIC2_DIR:-}" ] || die "GOTHIC2_DIR is not set: point it at your Gothic II Gold install (the folder with Data/ and System/).
  Example: GOTHIC2_DIR=\"\$HOME/.steam/steam/steamapps/common/Gothic II\" npm run assets"
[ -d "$GOTHIC2_DIR" ] || die "GOTHIC2_DIR=$GOTHIC2_DIR is not a directory"
for v in GOTHIC2_RU_DIR GOTHIC2_PL_DIR; do
  if [ -n "${!v:-}" ] && [ ! -e "${!v}" ]; then die "$v=${!v} does not exist"; fi
done

# Relative paths given by the caller are relative to where npm/the shell was started; the tools run from the root.
mkdir -p "${OUT:=$ROOT/public/ui/gothic}"
OUT="$(cd "$OUT" && pwd)"
DATA="${DATA_DIR:-public/data}"
SERVER_DATA="${SERVER_DATA_DIR:-server-data}"
cd "$ROOT"

EX=(uv run -q --with zenkit==1.3.0.4 --with pillow --with numpy python)
WF=(uv run -q --with numpy --with pillow --with potracer --with fonttools --with brotli python)
step() { printf '\n== %s\n' "$*"; }

step "UI textures, maps, menu art, fonts, icons -> $OUT"
"${EX[@]}" tools/extract_ui_assets.py "$OUT"

langs=()
for lang in ru pl; do
  up="$(echo "$lang" | tr a-z A-Z)"   # (macOS bash 3.2 has no ${lang^^})
  var="GOTHIC2_${up}_DIR"
  src="${!var:-}"
  if [ -z "$src" ]; then
    echo "($var not set: no Gothic Old/Default $up fonts; ${lang} pages fall back to Alegreya, see docs/FONTS.md)"
    continue
  fi
  step "$lang font atlases from $src"
  "${EX[@]}" tools/extract_ui_assets.py --fonts "$src" --lang "$lang" --reference "$OUT" "$OUT/$lang"
  langs+=("$lang")
done

step "web fonts -> $OUT/fonts"
"${WF[@]}" tools/build_webfont.py --atlas-dir "$OUT" --reference "$OUT" --out-dir "$OUT/fonts"
for lang in ${langs[@]+"${langs[@]}"}; do
  "${WF[@]}" tools/build_webfont.py --lang "$lang" --atlas-dir "$OUT/$lang" --reference "$OUT" --out-dir "$OUT/fonts"
done

if [ "${ASSETS_FONT_LEVELS:-1}" != 0 ]; then
  step "stroke-weight variants of Gothic Default -> $OUT/fonts-cmp (dev/fontweight.html)"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  for level in 127 159 191 223 255 287; do
    "${WF[@]}" tools/build_webfont.py --only GothicDefault --level "$level" --atlas-dir "$OUT" --reference "$OUT" \
      --out-dir "$tmp/l$level"
    for lang in ${langs[@]+"${langs[@]}"}; do
      "${WF[@]}" tools/build_webfont.py --lang "$lang" --only "GothicDefault$(echo "$lang" | tr a-z A-Z)" --level "$level" \
        --atlas-dir "$OUT/$lang" --reference "$OUT" --out-dir "$tmp/l$level"
    done
    mkdir -p "$OUT/fonts-cmp/l$level"
    cp "$tmp/l$level"/*.woff2 "$OUT/fonts-cmp/l$level/"
  done
fi

if [ -d "$DATA/panos" ] && [ -f "$SERVER_DATA/khorinis/manifest.json" ]; then
  step "link-preview image -> $OUT/og-image.jpg"
  uv run -q --with pillow python tools/make_og_image.py --assets "$OUT" --data "$DATA" --server-data "$SERVER_DATA"
else
  echo
  echo "(no published Khorinis dataset in $DATA + $SERVER_DATA: og-image.jpg skipped; run 'npm run assets' again after"
  echo " tools/publish_dataset.py, see README.md)"
fi

step "done: $OUT"
