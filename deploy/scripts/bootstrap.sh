#!/bin/bash
# Prepare the server for Gothic II Guessr. Run locally; idempotent (safe to repeat).
#
#   deploy/scripts/bootstrap.sh                 dry run: show what is installed and what would change, change nothing
#   deploy/scripts/bootstrap.sh --yes           apply
#
# Options:
#   --node-major N    Node.js major from NodeSource (default 24, LTS). Debian 13 ships Node 20, but
#                     better-sqlite3 13 needs Node >= 22.
#   --build-tools     also install build-essential + python3 (only needed if better-sqlite3 ever has to compile;
#                     version 13 ships a linux-x64 prebuilt binary inside the npm package)
#   --journal-cap S   cap the systemd journal at S (e.g. 300M) via a journald.conf.d drop-in
#
# What --yes does on the server:
#   apt: nginx, libnginx-mod-http-brotli-filter, certbot, sqlite3, rsync, curl, ca-certificates; nodejs from
#        deb.nodesource.com (key checked against a pinned SHA-256, apt pin so Debian's nodejs 20 never wins)
#   user g2 (system, no shell, no home); dirs of deploy/scripts/lib.sh with their owners and modes
#   systemd: gothic-guessr.service (enabled, started later by push-app.sh), backup service + timer (enabled)
#   nginx: worker_connections 768 → 4096 and worker_rlimit_nofile 16384 in nginx.conf (original kept as
#          nginx.conf.g2-orig), Debian's default site disabled, an HTTP-only site that answers ACME challenges and
#          drops everything else (tls.sh replaces it with the real site), snippets for brotli and headers
#   firewall: TCP 80/443 opened ONLY if some INPUT filter blocks them (see below)
#
# The host may run other services (VPN, DNS, mail, ...), so the kit never touches anything it did not create: no
# sshd, fail2ban, routing, NAT/FORWARD rules or /etc/nftables.conf, no other nginx sites besides Debian's default one,
# no restart of foreign units (only systemd-journald, with --journal-cap). The summary lists the services that were
# running before and checks that they still are.
# Firewall: when nothing filters INPUT, nothing is added. When something does, the script inserts one accept rule for
# TCP 80/443 into whatever blocks (ufw, iptables INPUT, or a native nft input chain with policy drop) and says so; it
# never flushes existing rules and never enables nftables.service (a stock /etc/nftables.conf starts with
# `flush ruleset` and would wipe rules other software installed at runtime).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

APPLY=0 NODE_MAJOR=24 BUILD_TOOLS=0 JOURNAL_CAP=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --yes) APPLY=1 ;;
    --node-major) NODE_MAJOR=$2; shift ;;
    --build-tools) BUILD_TOOLS=1 ;;
    --journal-cap) JOURNAL_CAP=$2; shift ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done
[[ $NODE_MAJOR =~ ^[0-9]+$ ]] || die "--node-major must be a number"
[[ -z $JOURNAL_CAP || $JOURNAL_CAP =~ ^[0-9]+[KMG]$ ]] || die "--journal-cap like 300M"

g2_check_ssh

# SHA-256 of https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key (fetched 2026-10-07 from two networks).
NODESOURCE_KEY_SHA256=b42e0321dabdc24e892115da705cf061167eac12a317f23d329862d0aa0a271d

read -r -d '' REMOTE <<'EOF' || true
APPLY=$1 NODE_MAJOR=$2 BUILD_TOOLS=$3 JOURNAL_CAP=$4 KEY_SHA=$5
KIT=""
plan=()
# Units running before this run: the summary checks that none of them stopped.
running_before=$(systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | awk '{print $1}')
note() { plan+=("$*"); }
run() { if [[ $APPLY == 1 ]]; then say "$*"; eval "$*"; else note "$*"; fi; }

. /etc/os-release
[[ ${ID:-} == debian ]] || die "expected Debian, found ${PRETTY_NAME:-unknown}"
ARCH=$(dpkg --print-architecture)
[[ $ARCH == amd64 || $ARCH == arm64 ]] || die "unsupported architecture $ARCH"

if [[ $APPLY == 1 ]]; then
  KIT=$(mktemp -d /tmp/g2-kit.XXXXXX)
  trap 'rm -rf "$KIT"' EXIT
  tar -xzf - -C "$KIT" --no-same-owner
fi

# ---- packages -------------------------------------------------------------------------------------------------
pkgs=(nginx libnginx-mod-http-brotli-filter certbot sqlite3 rsync curl ca-certificates)
[[ $BUILD_TOOLS == 1 ]] && pkgs+=(build-essential python3)
missing=()
for p in "${pkgs[@]}"; do
  dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || missing+=("$p")
done

node_major_now=""
command -v node >/dev/null && node_major_now=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)
need_node=0
[[ -z $node_major_now || $node_major_now -lt $NODE_MAJOR ]] && need_node=1

echo "--- server: $PRETTY_NAME, $(nproc) vCPU, $(free -m | awk '/^Mem:/{print $2}') MB RAM, free on /: $(df -h / | awk 'NR==2{print $4}')"
echo "--- packages to install: ${missing[*]:-none}"
echo "--- node: ${node_major_now:-absent} (want >= $NODE_MAJOR from NodeSource)"

if [[ $need_node == 1 ]]; then
  if [[ $APPLY == 1 ]]; then
    say "NodeSource repository for node_$NODE_MAJOR.x"
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /tmp/nodesource.asc
    echo "$KEY_SHA  /tmp/nodesource.asc" | sha256sum -c --quiet - || die "NodeSource key checksum mismatch: stop and check the key by hand"
    install -m 0644 /tmp/nodesource.asc /etc/apt/keyrings/nodesource.asc
    rm -f /tmp/nodesource.asc
    cat > /etc/apt/sources.list.d/nodesource.sources <<SRC
Types: deb
URIs: https://deb.nodesource.com/node_$NODE_MAJOR.x
Suites: nodistro
Components: main
Architectures: $ARCH
Signed-By: /etc/apt/keyrings/nodesource.asc
SRC
    cat > /etc/apt/preferences.d/nodesource <<PIN
Package: nodejs
Pin: origin deb.nodesource.com
Pin-Priority: 600
PIN
    missing+=(nodejs)
  else
    note "add apt source https://deb.nodesource.com/node_$NODE_MAJOR.x (key sha256 checked), pin nodejs to it, install nodejs"
  fi
fi

if [[ ${#missing[@]} -gt 0 ]]; then
  run "apt-get update -qq"
  run "apt-get install -y -qq --no-install-recommends ${missing[*]} </dev/null >/var/log/g2-apt.log 2>&1 || { tail -30 /var/log/g2-apt.log; exit 1; }"
fi
if [[ $APPLY == 1 ]]; then
  node_major_now=$(node -p 'process.versions.node.split(".")[0]')
  [[ $node_major_now -ge $NODE_MAJOR ]] || die "node $node_major_now installed, wanted >= $NODE_MAJOR (check apt-cache policy nodejs)"
  say "node $(node -v), npm $(npm -v)"
fi

# ---- user and directories -------------------------------------------------------------------------------------
if ! getent passwd g2 >/dev/null; then
  run "useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin g2"
fi
mkdirs() { # mode owner path...
  local mode=$1 owner=$2; shift 2
  local d
  for d in "$@"; do
    if [[ ! -d $d || $(stat -c '%a %U:%G' "$d") != "$mode $owner" ]]; then
      run "install -d -m $mode -o ${owner%%:*} -g ${owner##*:} $d"
    fi
  done
}
mkdirs 755 root:root /opt/gothic-guessr /opt/gothic-guessr/www /opt/gothic-guessr/www/data /opt/gothic-guessr/releases \
  /usr/local/lib/gothic-guessr /var/www/letsencrypt
mkdirs 700 g2:g2 /opt/gothic-guessr/private /var/backups/gothic-guessr
mkdirs 700 root:root /etc/gothic-guessr

# ---- files from the kit ---------------------------------------------------------------------------------------
if [[ $APPLY == 1 ]]; then
  say "systemd units, backup script, nginx snippets"
  install -m 0644 "$KIT"/systemd/gothic-guessr.service "$KIT"/systemd/gothic-guessr-backup.service \
    "$KIT"/systemd/gothic-guessr-backup.timer /etc/systemd/system/
  install -m 0755 "$KIT"/scripts/backup-db.sh /usr/local/lib/gothic-guessr/backup-db.sh
  install -m 0644 "$KIT"/nginx/gothic-guessr.conf.template "$KIT"/nginx/gothic-guessr-headers.conf.template \
    /usr/local/lib/gothic-guessr/
  if ls /etc/nginx/modules-enabled/*brotli* >/dev/null 2>&1; then
    install -m 0644 "$KIT"/nginx/gothic-guessr-brotli.conf /etc/nginx/snippets/gothic-guessr-brotli.conf
  else
    echo "    brotli module not enabled: gzip only"
  fi
  systemctl daemon-reload
  systemctl enable gothic-guessr.service >/dev/null
  systemctl enable --now gothic-guessr-backup.timer >/dev/null
else
  note "install systemd units (gothic-guessr, gothic-guessr-backup + timer), enable them; /usr/local/lib/gothic-guessr/backup-db.sh; nginx snippets"
fi

# ---- nginx ----------------------------------------------------------------------------------------------------
if [[ -f /etc/nginx/nginx.conf ]]; then
  if grep -qE '^\s*worker_connections\s+768;' /etc/nginx/nginx.conf || ! grep -q '^worker_rlimit_nofile' /etc/nginx/nginx.conf; then
    if [[ $APPLY == 1 ]]; then
      say "nginx.conf: worker_connections 4096, worker_rlimit_nofile 16384"
      [[ -f /etc/nginx/nginx.conf.g2-orig ]] || cp -p /etc/nginx/nginx.conf /etc/nginx/nginx.conf.g2-orig
      sed -i -E 's/^(\s*worker_connections\s+)768;/\14096;/' /etc/nginx/nginx.conf
      grep -q '^worker_rlimit_nofile' /etc/nginx/nginx.conf || sed -i '/^worker_processes/a worker_rlimit_nofile 16384;' /etc/nginx/nginx.conf
    else
      note "nginx.conf: worker_connections 768 -> 4096, add worker_rlimit_nofile 16384 (backup nginx.conf.g2-orig)"
    fi
  fi
else
  note "nginx.conf tuning after nginx is installed"
fi
ACME_SITE=/etc/nginx/sites-available/gothic-guessr-acme
if [[ $APPLY == 1 ]]; then
  if [[ ! -e /etc/nginx/sites-enabled/gothic-guessr ]]; then
    cat > "$ACME_SITE" <<'SITE'
# Before TLS (deploy/scripts/tls.sh replaces this with the real site): answer ACME challenges, drop the rest.
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    server_tokens off;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
    }
    location / {
        return 444;
    }
}
SITE
    ln -sfn "$ACME_SITE" /etc/nginx/sites-enabled/gothic-guessr-acme
  fi
  rm -f /etc/nginx/sites-enabled/default
  nginx -t 2>&1 | sed 's/^/    /'
  systemctl enable nginx >/dev/null
  systemctl reload-or-restart nginx
else
  note "nginx: disable Debian's default site, enable an HTTP-only ACME site (444 for the rest), reload"
fi

# ---- firewall -------------------------------------------------------------------------------------------------
echo "--- firewall"
fw=()
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
  for p in 80 443; do
    ufw status | grep -qE "^$p/tcp +ALLOW" || fw+=("ufw allow $p/tcp")
  done
  echo "    ufw is active"
else
  for t in iptables ip6tables; do
    command -v $t >/dev/null || continue
    pol=$($t -S INPUT 2>/dev/null | awk '$1=="-P"{print $3}')
    blocks=$($t -S INPUT 2>/dev/null | grep -cE -- '-j (DROP|REJECT)' || true)
    echo "    $t INPUT: policy ${pol:-?}, drop/reject rules: $blocks"
    if [[ $pol == DROP || $blocks -gt 0 ]]; then
      $t -C INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT 2>/dev/null \
        || fw+=("$t -I INPUT 1 -p tcp -m multiport --dports 80,443 -j ACCEPT")
    fi
  done
  if command -v nft >/dev/null; then
    # Native nft input chains with policy drop; tables managed by iptables-nft were handled above, fail2ban's
    # table only rejects banned addresses on port 22.
    while read -r fam tbl chain; do
      [[ -n $fam ]] || continue
      echo "    nft $fam $tbl $chain: input hook with policy drop"
      nft list chain "$fam" "$tbl" "$chain" | grep -qE 'tcp dport \{ 80, 443 \} accept' \
        || fw+=("nft insert rule $fam $tbl $chain tcp dport '{ 80, 443 }' accept")
    done < <(nft list ruleset 2>/dev/null | awk '
      /^# Warning: table .* is managed by iptables-nft/ { managed = 1; next }
      /^table / { fam = $2; tbl = $3; skip = managed; managed = 0; next }
      /^[ \t]+chain / { chain = $2; next }
      /hook input/ && /policy drop/ { if (!skip && tbl != "f2b-table") print fam, tbl, chain }')
  fi
fi
if [[ ${#fw[@]} -eq 0 ]]; then
  echo "    TCP 80/443 are not filtered on this host: no firewall change"
else
  for c in "${fw[@]}"; do run "$c"; done
  if [[ $APPLY == 1 ]]; then
    if command -v netfilter-persistent >/dev/null; then
      netfilter-persistent save
    elif ! command -v ufw >/dev/null; then
      echo "    NOTE: the rule above is runtime only; persist it the way this host loads its firewall."
      echo "          Do NOT enable nftables.service if /etc/nftables.conf starts with 'flush ruleset': it would wipe"
      echo "          the rules other software on this host installed at runtime."
    fi
  fi
fi
echo "    (a provider-side firewall or cloud security group is not visible from here: check port 80 from outside)"

# ---- journal --------------------------------------------------------------------------------------------------
if [[ -n $JOURNAL_CAP ]]; then
  if [[ $APPLY == 1 ]]; then
    install -d -m 0755 /etc/systemd/journald.conf.d
    printf '[Journal]\nSystemMaxUse=%s\n' "$JOURNAL_CAP" > /etc/systemd/journald.conf.d/50-size-cap.conf
    systemctl restart systemd-journald
    journalctl --vacuum-size="$JOURNAL_CAP" >/dev/null 2>&1 || true
    say "journal capped at $JOURNAL_CAP ($(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[KMG]' | head -1) now)"
  else
    note "journald drop-in SystemMaxUse=$JOURNAL_CAP and vacuum"
  fi
fi

# ---- summary --------------------------------------------------------------------------------------------------
if [[ $APPLY == 1 ]]; then
  stopped=()
  for u in $running_before; do systemctl is-active --quiet "$u" || stopped+=("$u"); done
  echo "--- done. Services that were running before: $(wc -w <<<"$running_before" | tr -d ' '), stopped since: ${stopped[*]:-none}"
  printf '    %-16s %s\n' nginx "$(systemctl is-active nginx 2>/dev/null || true)"
  echo "    next: secrets.sh, push-data.sh, push-app.sh, then tls.sh DOMAIN EMAIL when DNS points here"
else
  echo "--- dry run, would do:"
  if [[ ${#plan[@]} -eq 0 ]]; then echo "    nothing"; else printf '    %s\n' "${plan[@]}"; fi
  echo "--- run again with --yes to apply"
fi
EOF

if [[ $APPLY == 1 ]]; then
  say "bootstrap on $DEPLOY_HOST (apply)"
  (cd "$G2_DEPLOY" && g2_tar systemd nginx scripts/backup-db.sh) \
    | g2_remote "$REMOTE" "$APPLY" "$NODE_MAJOR" "$BUILD_TOOLS" "$JOURNAL_CAP" "$NODESOURCE_KEY_SHA256"
else
  say "bootstrap on $DEPLOY_HOST (dry run, nothing changes)"
  g2_remote "$REMOTE" "$APPLY" "$NODE_MAJOR" "$BUILD_TOOLS" "$JOURNAL_CAP" "$NODESOURCE_KEY_SHA256" </dev/null
fi
