#!/bin/bash
# Let's Encrypt certificate + the real nginx site for DOMAIN. Run locally once DNS points at the server; idempotent
# (a later run re-renders the site from deploy/nginx/*.template and reloads nginx; the certificate is kept).
#
#   deploy/scripts/tls.sh DOMAIN EMAIL
#   --staging          use Let's Encrypt staging (test certificates, no rate limits)
#   --skip-dns-check   do not compare the A/AAAA records with this server's addresses
#   --renew-dry-run    run `certbot renew --dry-run` at the end
#   --self-signed-test only for a test container: a self-signed certificate instead of ACME
#
# ACME uses the webroot method (/var/www/letsencrypt, served on port 80 for every host name), so certbot never edits
# the nginx config. Renewal: Debian's certbot.timer (twice a day) + a deploy hook that reloads nginx.
# The site's admin login rate limit sits on /api/<ADMIN_PATH>/login: ADMIN_PATH is read from /etc/gothic-guessr/env
# on the server (run secrets.sh first; after changing ADMIN_PATH run this script again). It is never printed.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

DOMAIN="" EMAIL="" STAGING=0 SKIPDNS=0 RENEWTEST=0 SELFSIGNED=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --staging) STAGING=1 ;;
    --skip-dns-check) SKIPDNS=1 ;;
    --renew-dry-run) RENEWTEST=1 ;;
    --self-signed-test) SELFSIGNED=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    -*) die "unknown option $1 (see --help)" ;;
    *) if [[ -z $DOMAIN ]]; then DOMAIN=$1; elif [[ -z $EMAIL ]]; then EMAIL=$1; else die "extra argument $1"; fi ;;
  esac
  shift
done
[[ $DOMAIN =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "usage: tls.sh DOMAIN EMAIL (bad domain '$DOMAIN')"
[[ $EMAIL =~ ^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$ ]] || die "usage: tls.sh DOMAIN EMAIL (bad email '$EMAIL')"
DOMAIN=$(echo "$DOMAIN" | tr 'A-Z' 'a-z')

g2_check_ssh

read -r -d '' REMOTE <<'EOF' || true
DOMAIN=$1 EMAIL=$2 STAGING=$3 SKIPDNS=$4 RENEWTEST=$5 SELFSIGNED=$6
command -v nginx >/dev/null && command -v certbot >/dev/null || die "nginx/certbot missing: run bootstrap.sh --yes first"
# ADMIN_PATH for the site template (read, never echoed); the app refuses to start without a valid one as well.
admin_path=$(sed -n 's/^ADMIN_PATH=//p' /etc/gothic-guessr/env 2>/dev/null | tail -1 || true)
[[ $admin_path =~ ^[A-Za-z0-9_-]{4,64}$ && $admin_path != admin ]] \
  || die "no valid ADMIN_PATH in /etc/gothic-guessr/env: run deploy/scripts/secrets.sh first"
KIT=$(mktemp -d /tmp/g2-tls.XXXXXX)
trap 'rm -rf "$KIT"' EXIT
tar -xzf - -C "$KIT" --no-same-owner

# ---- DNS ------------------------------------------------------------------------------------------------------
mine=$(ip -o addr show scope global | awk '$2 !~ /^wg/ {split($4, a, "/"); print a[1]}' | sort -u)
a4=$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u || true)
a6=$(getent ahostsv6 "$DOMAIN" | awk '$1 !~ /^::ffff:/ {print $1}' | sort -u || true)
echo "--- $DOMAIN: A ${a4:-none}; AAAA ${a6:-none}; this server: $(echo $mine)"
if [[ $SKIPDNS == 0 && $SELFSIGNED == 0 ]]; then
  [[ -n $a4 ]] || die "$DOMAIN has no A record yet"
  for ip in $a4 $a6; do
    grep -qxF "$ip" <<<"$mine" || die "$DOMAIN resolves to $ip, which is not this server (Let's Encrypt would fail; an AAAA record must point here too or be removed)"
  done
fi

# ---- certificate ----------------------------------------------------------------------------------------------
install -d -m 0755 /var/www/letsencrypt /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx <<'HOOK'
#!/bin/sh
# Installed by Gothic II Guessr deploy/scripts/tls.sh: pick up renewed certificates.
systemctl reload nginx
HOOK
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx

live=/etc/letsencrypt/live/$DOMAIN
# A test certificate from a --staging rehearsal (or a self-signed one) must not survive a real run.
if [[ $STAGING == 0 && $SELFSIGNED == 0 && -f $live/fullchain.pem ]] &&
   openssl x509 -issuer -noout -in "$live/fullchain.pem" | grep -qiE 'staging|\(STAGING\)|CN ?= ?'"$DOMAIN"'$'; then
  say "replacing the test certificate for $DOMAIN with a real one"
  if [[ -f /etc/letsencrypt/renewal/$DOMAIN.conf ]]; then
    certbot delete --cert-name "$DOMAIN" --non-interactive
  else
    rm -rf "$live"
  fi
fi
if [[ $SELFSIGNED == 1 ]]; then
  if [[ ! -f $live/fullchain.pem ]]; then
    install -d -m 0700 "$live"
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 -subj "/CN=$DOMAIN" \
      -addext "subjectAltName=DNS:$DOMAIN" -keyout "$live/privkey.pem" -out "$live/fullchain.pem" 2>/dev/null
    say "self-signed test certificate for $DOMAIN"
  fi
elif [[ ! -f $live/fullchain.pem ]]; then
  # Port 80 must answer ACME for this name: the bootstrap ACME site or the full site (both have the webroot).
  ls /etc/nginx/sites-enabled/gothic-guessr* >/dev/null 2>&1 || die "no gothic-guessr site enabled in nginx: run bootstrap.sh --yes"
  systemctl is-active --quiet nginx || systemctl start nginx
  args=(certonly --webroot -w /var/www/letsencrypt -d "$DOMAIN" -m "$EMAIL" --agree-tos --no-eff-email --non-interactive --keep-until-expiring)
  [[ $STAGING == 1 ]] && args+=(--staging)
  say "certbot ${args[*]}"
  certbot "${args[@]}"
else
  say "certificate for $DOMAIN already present (expires $(openssl x509 -enddate -noout -in "$live/fullchain.pem" | cut -d= -f2))"
fi

# ---- nginx site -----------------------------------------------------------------------------------------------
site=/etc/nginx/sites-available/gothic-guessr
hdr=/etc/nginx/snippets/gothic-guessr-headers.conf
# The site holds the secret admin path: root-only (nginx reads its config as root).
(umask 027; sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__ADMIN_PATH__/$admin_path/g" "$KIT/nginx/gothic-guessr.conf.template" > "$site.new")
chmod 0640 "$site.new"
if grep -q '__[A-Z_]*__' "$site.new"; then die "unreplaced placeholder in the rendered nginx site"; fi
sed "s/__DOMAIN__/$DOMAIN/g" "$KIT/nginx/gothic-guessr-headers.conf.template" > "$hdr.new"
if ls /etc/nginx/modules-enabled/*brotli* >/dev/null 2>&1; then
  install -m 0644 "$KIT/nginx/gothic-guessr-brotli.conf" /etc/nginx/snippets/gothic-guessr-brotli.conf
fi
had_prev=0
[[ -f $site ]] && had_prev=1
for f in "$site" "$hdr"; do
  rm -f "$f.prev"
  if [[ -f $f ]]; then cp -p "$f" "$f.prev"; fi
  mv -f "$f.new" "$f"
done
ln -sfn "$site" /etc/nginx/sites-enabled/gothic-guessr
rm -f /etc/nginx/sites-enabled/gothic-guessr-acme /etc/nginx/sites-enabled/default
if ! nginx -t 2>"$KIT/nginx-t.log"; then
  cat "$KIT/nginx-t.log" >&2
  if [[ $had_prev == 1 ]]; then
    for f in "$site" "$hdr"; do if [[ -f $f.prev ]]; then mv -f "$f.prev" "$f"; fi; done
  else
    rm -f /etc/nginx/sites-enabled/gothic-guessr
    if [[ -f /etc/nginx/sites-available/gothic-guessr-acme ]]; then
      ln -sfn /etc/nginx/sites-available/gothic-guessr-acme /etc/nginx/sites-enabled/gothic-guessr-acme
    fi
  fi
  if nginx -t >/dev/null 2>&1; then systemctl reload nginx; fi
  die "nginx -t failed; the previous config is back"
fi
systemctl reload nginx
say "nginx site for $DOMAIN active"

# ---- renewal --------------------------------------------------------------------------------------------------
if [[ $SELFSIGNED == 0 ]]; then
  systemctl enable --now certbot.timer >/dev/null 2>&1 || true
  echo "--- renewal timer: $(systemctl list-timers certbot.timer --no-pager --no-legend | awk '{print $1, $2, $3, "->", $NF}')"
  [[ $RENEWTEST == 1 ]] && certbot renew --dry-run
fi

# ---- smoke test -----------------------------------------------------------------------------------------------
code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" || true)
echo "--- https://$DOMAIN/api/health via local nginx: $code"
grep -qxF "PUBLIC_ORIGIN=https://$DOMAIN" /etc/gothic-guessr/env 2>/dev/null \
  || echo "    PUBLIC_ORIGIN is not https://$DOMAIN yet: deploy/scripts/secrets.sh --domain $DOMAIN --restart"
EOF

(cd "$G2_DEPLOY" && g2_tar nginx) \
  | g2_remote "$REMOTE" "$DOMAIN" "$EMAIL" "$STAGING" "$SKIPDNS" "$RENEWTEST" "$SELFSIGNED"
