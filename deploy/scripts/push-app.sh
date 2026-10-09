#!/bin/bash
# Build the app locally and roll it out as a new release on the server.
#
#   deploy/scripts/push-app.sh              npm test + npm run build, upload, npm ci --omit=dev, switch, restart
#   deploy/scripts/push-app.sh --no-test    skip npm test
#   deploy/scripts/push-app.sh --no-build   upload the existing dist/ and dist-server/ as they are
#   deploy/scripts/push-app.sh --rollback   point app/ back to the previous release and restart
#
# Only build output goes to the server: dist/ (client), dist-server/main.js (server bundle made by `npm run
# build:server`: esbuild, npm packages left external), package.json and package-lock.json. The server then installs
# the runtime dependencies with `npm ci --omit=dev` (or hard-links node_modules from the live release when the lock
# file did not change). better-sqlite3 13 carries a prebuilt linux-x64 binary, nothing is compiled.
# Releases live in /opt/gothic-guessr/releases/<UTC stamp>; /opt/gothic-guessr/app is a symlink to the live one; the
# three newest are kept. If the new release does not answer /api/health within 20 s the symlink goes back and the
# previous release is restarted.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

TEST=1 BUILD=1 ROLLBACK=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --no-test) TEST=0 ;;
    --no-build) BUILD=0 ;;
    --rollback) ROLLBACK=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

g2_check_ssh

read -r -d '' HEALTH <<'EOF' || true
health() {
  local i
  for i in $(seq 1 40); do
    if curl -fsS -m 2 http://127.0.0.1:8787/api/health >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}
EOF

if [[ $ROLLBACK == 1 ]]; then
  read -r -d '' REMOTE <<'EOF' || true
cd /opt/gothic-guessr
cur=$(readlink app | sed 's#^releases/##')
prev=$(ls -1 releases | sort | awk -v c="$cur" '$0 < c' | tail -1)
[[ -n $prev ]] || die "no release older than $cur"
ln -sfn "releases/$prev" app.new && mv -T app.new app
systemctl restart gothic-guessr
health || die "previous release $prev does not answer either: journalctl -u gothic-guessr -n 50"
say "rolled back: $cur -> $prev"
EOF
  g2_remote "$HEALTH"$'\n'"$REMOTE" </dev/null
  exit 0
fi

cd "$G2_REPO"
if [[ $BUILD == 1 ]]; then
  if [[ $TEST == 1 ]]; then say "npm test"; npm test --silent; fi
  say "npm run build"
  npm run build --silent
fi
[[ -f dist/index.html && -f dist/admin.html && -f dist-server/main.js ]] || die "dist/ or dist-server/main.js missing: run npm run build"
grep -q '"better-sqlite3"' package-lock.json || die "package-lock.json looks wrong"

REL=$(date -u +%Y%m%dT%H%M%SZ)
say "release $REL -> $DEPLOY_HOST"

read -r -d '' REMOTE <<'EOF' || true
REL=$1
base=/opt/gothic-guessr
[[ -d $base/releases ]] || die "$base/releases missing: run bootstrap.sh --yes first"
command -v node >/dev/null || die "node missing: run bootstrap.sh --yes first"
dir=$base/releases/$REL
mkdir -p "$dir"
tar -xzf - -C "$dir" --no-same-owner --no-same-permissions
chown -R root:root "$dir"
chmod -R u=rwX,go=rX "$dir"

cd "$dir"
live=""
[[ -L $base/app ]] && live=$(readlink -f "$base/app")
if [[ -n $live && -d $live/node_modules ]] && cmp -s "$live/package-lock.json" package-lock.json; then
  say "dependencies unchanged: hard-linking node_modules from $(basename "$live")"
  cp -al "$live/node_modules" node_modules
else
  say "npm ci --omit=dev"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error </dev/null
fi
runuser -u g2 -- node -e "const D=require('better-sqlite3'); new D(':memory:').prepare('select 1').get()" \
  || die "better-sqlite3 does not load for user g2 (rerun bootstrap.sh --yes --build-tools, then push again)"

if [[ ! -f /etc/gothic-guessr/env ]]; then
  ln -sfn "releases/$REL" "$base/app.new" && mv -T "$base/app.new" "$base/app"
  say "release $REL installed but not started: /etc/gothic-guessr/env is missing (run secrets.sh)"
  exit 0
fi

prev=$live
ln -sfn "releases/$REL" "$base/app.new" && mv -T "$base/app.new" "$base/app"
systemctl restart gothic-guessr
if ! health; then
  echo "---- journal of the failed start:"
  journalctl -u gothic-guessr -n 30 --no-pager || true
  if [[ -n $prev ]]; then
    ln -sfn "releases/$(basename "$prev")" "$base/app.new" && mv -T "$base/app.new" "$base/app"
    systemctl restart gothic-guessr
    die "release $REL did not come up; rolled back to $(basename "$prev")"
  fi
  die "release $REL did not come up"
fi
say "live: $REL - $(curl -fsS http://127.0.0.1:8787/api/health)"

# Keep the three newest releases (the live one always stays).
cd "$base/releases"
for old in $(ls -1 | sort -r | tail -n +4); do
  [[ $base/releases/$old == "$(readlink -f "$base/app")" ]] && continue
  rm -rf -- "$old"
  echo "    removed old release $old"
done
EOF

g2_tar dist dist-server package.json package-lock.json \
  | g2_remote "$HEALTH"$'\n'"$REMOTE" "$REL"
