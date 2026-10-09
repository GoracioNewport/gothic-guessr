#!/bin/bash
# Upload the dataset from this machine to the server. Resumable: run it again after a break and rsync continues
# where it stopped (finished files are skipped by size+mtime, a half-sent file resumes from .rsync-partial/).
#
#   deploy/scripts/push-data.sh                              public/data + server-data (manifests only)
#   deploy/scripts/push-data.sh --source out/data-q70        another dataset variant (same layout as public/data)
#   deploy/scripts/push-data.sh --private other/server-data  manifests from elsewhere
#   --delete      remove server files absent locally (switching variants; done after the transfer)
#   --dry-run     list what would change, send nothing
#   --restart     restart gothic-guessr afterwards (it reads the manifests at start; rooms in memory are lost)
#   --bwlimit K   cap at K KiB/s
#
# Public files land in /opt/gothic-guessr/www/data (root, 755/644, served by nginx); only <slug>/manifest.json from
# the private dir is sent, to /opt/gothic-guessr/private (owner g2, 0700/0600). Excluded everywhere: panos-cmp/,
# backups, .DS_Store, AppleDouble files; a manifest.json under the public source aborts the run.
# macOS ships openrsync; Homebrew's rsync (`brew install rsync`) is used when present and shows overall progress.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

SRC="$G2_REPO/public/data" PRIV="$G2_REPO/server-data" DELETE=0 DRY=0 RESTART=0 BWLIMIT=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --source) SRC=$2; shift ;;
    --private) PRIV=$2; shift ;;
    --delete) DELETE=1 ;;
    --dry-run) DRY=1 ;;
    --restart) RESTART=1 ;;
    --bwlimit) BWLIMIT=$2; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done
SRC=${SRC%/}; PRIV=${PRIV%/}
[[ -f $SRC/worlds.json ]] || die "$SRC/worlds.json missing: not a published dataset"
[[ -d $SRC/panos ]] || die "$SRC/panos missing"
leak=$(find "$SRC" -name manifest.json -print -quit)
[[ -z $leak ]] || die "private manifest under the public source: $leak (re-run tools/publish_dataset.py)"
ls "$PRIV"/*/manifest.json >/dev/null 2>&1 || die "no $PRIV/<slug>/manifest.json"

RSYNC=/usr/bin/rsync
for r in /opt/homebrew/bin/rsync /usr/local/bin/rsync; do [[ -x $r ]] && { RSYNC=$r; break; }; done
gnu=0; "$RSYNC" --version 2>/dev/null | head -1 | grep -q 'rsync  version' && gnu=1

g2_check_ssh
g2_ssh 'command -v rsync >/dev/null' || die "rsync is not installed on the server: run bootstrap.sh --yes first"
g2_ssh 'test -d /opt/gothic-guessr/www/data -a -d /opt/gothic-guessr/private' || die "server dirs missing: run bootstrap.sh --yes first"

# Space: what is still to send must fit with 1.5 GB to spare.
say "checking sizes"
local_kb=$(du -sk "$SRC" | cut -f1)
read -r remote_kb free_kb < <(g2_ssh 'echo $(du -sk /opt/gothic-guessr/www/data | cut -f1) $(df -k --output=avail /opt/gothic-guessr | tail -1)')
need_kb=$(( local_kb > remote_kb ? local_kb - remote_kb : 0 ))
echo "    local $((local_kb / 1024)) MB, already on server $((remote_kb / 1024)) MB, to send ~ $((need_kb / 1024)) MB, free $((free_kb / 1024)) MB"
(( need_kb + 1536 * 1024 < free_kb )) || die "not enough disk on the server"

opts=(-rlt --partial-dir=.rsync-partial --timeout=180 -e "$(g2_rsync_rsh)" --rsync-path=rsync
  --exclude=panos-cmp/ --exclude='*backup*/' --exclude='*.bak' --exclude=.DS_Store --exclude='._*' --exclude='*.tmp')
[[ $DRY == 1 ]] && opts+=(--dry-run --itemize-changes)
[[ $DELETE == 1 ]] && opts+=(--delete-after)
[[ -n $BWLIMIT ]] && opts+=(--bwlimit="$BWLIMIT")
if [[ $gnu == 1 && $DRY == 0 ]]; then opts+=(--info=progress2 --no-inc-recursive); else opts+=(--stats); fi
[[ $gnu == 0 ]] && echo "    using $RSYNC (openrsync): no overall progress; \`brew install rsync\` for a progress bar"

# rsync with retries: a dropped connection is resumed by the next attempt.
sync() {
  local attempt=1
  while ! "$RSYNC" "${opts[@]}" "$@"; do
    (( attempt < 8 )) || die "rsync failed $attempt times; run the script again to resume"
    echo "    rsync failed (attempt $attempt), retrying in $((attempt * 10)) s"
    sleep $((attempt * 10))
    attempt=$((attempt + 1))
  done
}

say "public dataset: $SRC -> /opt/gothic-guessr/www/data"
sync --exclude=manifest.json "$SRC/" "$(g2_rsync_dest /opt/gothic-guessr/www/data/)"

say "private manifests: $PRIV -> /opt/gothic-guessr/private"
sync --include='*/' --include='manifest.json' --exclude='*' --prune-empty-dirs "$PRIV/" "$(g2_rsync_dest /opt/gothic-guessr/private/)"

[[ $DRY == 1 ]] && { say "dry run: nothing was changed"; exit 0; }

read -r -d '' REMOTE <<'EOF' || true
RESTART=$1
pub=/opt/gothic-guessr/www/data priv=/opt/gothic-guessr/private
find "$pub" ! -user root -exec chown -h root:root {} +
find "$pub" -type d ! -perm 755 -exec chmod 755 {} +
find "$pub" -type f ! -perm 644 -exec chmod 644 {} +
find "$pub" -name manifest.json -delete
chown -R g2:g2 "$priv"
find "$priv" -type d -exec chmod 700 {} +
find "$priv" -type f -exec chmod 600 {} +
say "on the server: $(find "$pub/panos" -mindepth 1 -maxdepth 1 -type d | wc -l) panos, $(find "$pub" -type f | wc -l) public files, $(du -sh "$pub" | cut -f1); manifests: $(cd "$priv" && ls -d */manifest.json | tr '\n' ' ')"
if [[ $RESTART == 1 ]]; then
  if systemctl is-active --quiet gothic-guessr; then systemctl restart gothic-guessr; say "gothic-guessr restarted"; fi
elif systemctl is-active --quiet gothic-guessr; then
  echo "    the running app keeps the manifests it loaded at start; restart when convenient: systemctl restart gothic-guessr"
fi
EOF
g2_remote "$REMOTE" "$RESTART" </dev/null
