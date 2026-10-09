#!/bin/bash
# One-screen health report of the server (read-only). Run locally:  deploy/scripts/status.sh [--logs N]
set -euo pipefail
source "$(dirname "$0")/lib.sh"

LOGS=15
while [[ $# -gt 0 ]]; do
  case $1 in
    --logs) LOGS=$2; shift ;;
    -h|--help) sed -n '2p' "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
  shift
done
g2_check_ssh

read -r -d '' REMOTE <<'EOF' || true
LOGS=$1
set +e
st() { printf '%-28s %s\n' "$1" "$(systemctl is-active "$1" 2>/dev/null)"; }
echo "--- services"
for u in gothic-guessr nginx gothic-guessr-backup.timer certbot.timer; do st "$u"; done
echo "--- other services on the host (running / failed)"
systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null \
  | awk '$1 !~ /^(gothic-guessr|nginx)/ {print $1}' | tr '\n' ' ' | fold -s -w 110; echo
failed=$(systemctl list-units --type=service --state=failed --no-legend --plain 2>/dev/null | awk '{print $1}' | tr '\n' ' ')
echo "failed: ${failed:-none}"

echo "--- app"
printf 'release      %s\n' "$(basename "$(readlink -f /opt/gothic-guessr/app 2>/dev/null)" 2>/dev/null)"
printf 'health       %s\n' "$(curl -fsS -m 3 http://127.0.0.1:8787/api/health 2>&1)"
mem=$(systemctl show gothic-guessr -p MemoryCurrent --value 2>/dev/null)
[[ $mem =~ ^[0-9]+$ ]] && printf 'memory       %s MB of 600 MB\n' $((mem / 1048576))
printf 'restarts     %s\n' "$(systemctl show gothic-guessr -p NRestarts --value 2>/dev/null)"
printf 'listening    %s\n' "$(ss -ltnH '( sport = :80 or sport = :443 or sport = :8787 )' | awk '{print $4}' | sort -u | tr '\n' ' ')"

echo "--- tls"
for c in /etc/letsencrypt/live/*/fullchain.pem; do
  [[ -f $c ]] || { echo "no certificate yet"; break; }
  printf '%-40s expires %s\n' "$(basename "$(dirname "$c")")" "$(openssl x509 -enddate -noout -in "$c" | cut -d= -f2)"
done

echo "--- disk"
df -h / | awk 'NR==2 {print "root fs      " $3 " used, " $4 " free (" $5 ")"}'
printf 'dataset      %s\n' "$(du -sh /opt/gothic-guessr/www/data 2>/dev/null | cut -f1)"
printf 'database     %s\n' "$(du -ch /var/lib/gothic-guessr/db.sqlite* 2>/dev/null | tail -1 | cut -f1)"
printf 'backups      %s, newest: %s\n' "$(du -sh /var/backups/gothic-guessr 2>/dev/null | cut -f1)" "$(ls -1t /var/backups/gothic-guessr/db-*.sqlite.gz 2>/dev/null | head -1 | xargs -r basename)"
printf 'nginx logs   %s\n' "$(du -sh /var/log/nginx 2>/dev/null | cut -f1)"
printf 'journal      %s\n' "$(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[KMG]' | head -1)"

echo "--- load"
uptime
free -m | awk '/^Mem:/ {print "memory: " $3 " MB used, " $7 " MB available of " $2}'

echo "--- last $LOGS lines of the app journal"
journalctl -u gothic-guessr -n "$LOGS" --no-pager -o short-iso 2>/dev/null
if [[ -s /var/log/nginx/gothic-guessr.error.log ]]; then
  echo "--- nginx errors (last 5)"
  tail -5 /var/log/nginx/gothic-guessr.error.log
fi
EOF
g2_remote "$REMOTE" "$LOGS" </dev/null
