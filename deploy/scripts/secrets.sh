#!/bin/bash
# Write /etc/gothic-guessr/env on the server (root 0600). Run locally; idempotent.
#
#   deploy/scripts/secrets.sh                        create the file; keep existing secrets
#   deploy/scripts/secrets.sh --domain example.org   also set PUBLIC_ORIGIN=https://example.org (share texts)
#   deploy/scripts/secrets.sh --rotate-admin         new ADMIN_PASSWORD (after a restart every admin session ends:
#                                                    the session key is derived from both secrets)
#   --restart                                        restart gothic-guessr afterwards if it is running
#
# ADMIN_PASSWORD, ADMIN_PATH and SERVER_SECRET are generated ON THE SERVER from /dev/urandom and never printed or
# sent back. ADMIN_PATH (`admin-` + 16 base32 chars) is where the admin lives: https://<domain>/<ADMIN_PATH>, API under
# /api/<ADMIN_PATH>; it is kept once written (tls.sh renders it into the nginx site, so re-run tls.sh after changing
# it by hand). SERVER_SECRET is never rotated by this script: it seeds the daily challenges and signs admin sessions,
# so a new one changes every past daily seed. Read the admin password and path yourself:
#   ssh "$DEPLOY_HOST" grep ADMIN_ /etc/gothic-guessr/env
set -euo pipefail
source "$(dirname "$0")/lib.sh"

DOMAIN="" ROTATE=0 RESTART=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN=$2; shift ;;
    --rotate-admin) ROTATE=1 ;;
    --restart) RESTART=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done
[[ -z $DOMAIN || $DOMAIN =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "bad domain: $DOMAIN"

g2_check_ssh

read -r -d '' REMOTE <<'EOF' || true
DOMAIN=$1 ROTATE=$2 RESTART=$3
ENV=/etc/gothic-guessr/env
install -d -m 0700 -o root -g root /etc/gothic-guessr
umask 077

# Existing values (read into variables, never echoed).
get() { [[ -f $ENV ]] && sed -n "s/^$1=//p" "$ENV" | tail -1 || true; }
admin=$(get ADMIN_PASSWORD)
admin_path=$(get ADMIN_PATH)
secret=$(get SERVER_SECRET)
origin=$(get PUBLIC_ORIGIN)
[[ -n $DOMAIN ]] && origin="https://$DOMAIN"

gen() { head -c "$1" /dev/urandom | base64 -w0 | tr '+/' '-_' | tr -d '='; }
created=()
if [[ $ROTATE == 1 || ${#admin} -lt 8 ]]; then admin=$(gen 18); created+=(ADMIN_PASSWORD); fi
# ADMIN_PATH: `admin-` + 16 chars of the base32 alphabet (80 bits); the app refuses a missing one and `admin`.
if [[ ! $admin_path =~ ^[A-Za-z0-9_-]{4,64}$ || $admin_path == admin ]]; then
  admin_path="admin-$(head -c 10 /dev/urandom | base32 | tr '[:upper:]' '[:lower:]')"
  created+=(ADMIN_PATH)
fi
if [[ ${#secret} -lt 16 ]]; then secret=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'); created+=(SERVER_SECRET); fi

tmp=$(mktemp /etc/gothic-guessr/.env.XXXXXX)
{
  echo "# Gothic II Guessr environment. Written by deploy/scripts/secrets.sh; secrets are generated here and never printed."
  echo "NODE_ENV=production"
  echo "HOST=127.0.0.1"
  echo "PORT=8787"
  echo "DATA_DIR=/opt/gothic-guessr/www/data"
  echo "SERVER_DATA_DIR=/opt/gothic-guessr/private"
  echo "DB_PATH=/var/lib/gothic-guessr/db.sqlite"
  echo "TRUST_PROXY=1"
  [[ -n $origin ]] && echo "PUBLIC_ORIGIN=$origin"
  echo "ADMIN_PASSWORD=$admin"
  echo "ADMIN_PATH=$admin_path"
  echo "SERVER_SECRET=$secret"
} > "$tmp"
chown root:root "$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$ENV"
unset admin admin_path secret

say "$ENV written (root 0600)${created:+; generated: ${created[*]}}${origin:+; PUBLIC_ORIGIN=$origin}"
if [[ $RESTART == 1 ]] && systemctl is-active --quiet gothic-guessr; then
  systemctl restart gothic-guessr
  say "gothic-guessr restarted"
fi
EOF

g2_remote "$REMOTE" "$DOMAIN" "$ROTATE" "$RESTART" </dev/null
host=$DEPLOY_HOST; [[ $host == docker:* ]] && host="(container) ${host#docker:}"
echo
echo "Admin password and path (the admin is at https://<domain>/<ADMIN_PATH>): run it yourself, it is printed only"
echo "in your terminal:"
echo "  ssh $host grep ADMIN_ /etc/gothic-guessr/env"
echo "A new ADMIN_PATH needs the nginx site re-rendered: deploy/scripts/tls.sh DOMAIN EMAIL"
