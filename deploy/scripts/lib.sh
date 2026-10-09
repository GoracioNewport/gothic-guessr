# Shared helpers of the deploy scripts (sourced, not run). The scripts run on your workstation (macOS or Linux) from
# the repository root and drive the server over ssh.
#
#   DEPLOY_HOST   ssh destination, required: an alias from ~/.ssh/config or user@host. The remote parts need root, so
#                 it has to log in as root (key-based; BatchMode, no password prompts).
#                 `docker:<container>` runs everything in a local container instead (testing the kit on Debian 13).
#
# Layout on the server (see deploy/README.md):
#   /opt/gothic-guessr/releases/<id>/   built app: dist/, dist-server/, package*.json, node_modules/
#   /opt/gothic-guessr/app              symlink to the live release
#   /opt/gothic-guessr/www/data/        public dataset, served by nginx at /data/ (root 755/644)
#   /opt/gothic-guessr/private/         private manifests <slug>/manifest.json (g2 0700/0600)
#   /var/lib/gothic-guessr/db.sqlite    database (g2 0700, systemd StateDirectory)
#   /var/backups/gothic-guessr/         daily backups (g2 0700)
#   /etc/gothic-guessr/env              environment incl. secrets (root 0600)

DEPLOY_HOST=${DEPLOY_HOST:-}
G2_SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=6)
G2_REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
G2_DEPLOY="$G2_REPO/deploy"

die() { echo "error: $*" >&2; exit 1; }
say() { echo "==> $*"; }

g2_need_host() {
  [[ -n $DEPLOY_HOST ]] || die "DEPLOY_HOST is not set: export DEPLOY_HOST=<ssh alias or root@host> (see deploy/README.md)"
}

# g2_ssh CMD...: one command on the server.
g2_ssh() {
  g2_need_host
  if [[ $DEPLOY_HOST == docker:* ]]; then docker exec -i "${DEPLOY_HOST#docker:}" bash -c "$*"; return; fi
  ssh "${G2_SSH_OPTS[@]}" "$DEPLOY_HOST" "$@"
}

# g2_remote SCRIPT ARGS...: run the bash SCRIPT on the server with ARGS as $1…; the local stdin goes to the
# remote script's stdin (pipe a tarball in, or redirect from /dev/null). The script travels as a command-line
# argument, so commands inside it never eat it from stdin. Every remote script gets the same prologue: strict mode,
# a root check and the same die/say.
G2_PROLOGUE='set -euo pipefail
export LC_ALL=C.UTF-8 DEBIAN_FRONTEND=noninteractive
die() { echo "error: $*" >&2; exit 1; }
say() { echo "==> $*"; }
[[ $EUID -eq 0 ]] || die "the remote part needs root (DEPLOY_HOST must log in as root)"
'
g2_remote() {
  local script=$1 cmd a
  shift
  cmd="bash -c $(printf '%q' "$G2_PROLOGUE$script") g2-remote"
  for a in "$@"; do cmd+=" $(printf '%q' "$a")"; done
  g2_ssh "$cmd"
}

# rsync's remote shell: ssh with the same options, or `docker exec` for a test container (host part "x").
g2_rsync_rsh() {
  if [[ $DEPLOY_HOST == docker:* ]]; then echo "$G2_DEPLOY/scripts/docker-rsh.sh ${DEPLOY_HOST#docker:}"; return; fi
  echo "ssh ${G2_SSH_OPTS[*]}"
}
g2_rsync_dest() { if [[ $DEPLOY_HOST == docker:* ]]; then echo "x:$1"; else echo "$DEPLOY_HOST:$1"; fi; }

# g2_tar PATH...: gzipped tar on stdout without macOS metadata (AppleDouble files, xattrs), for the server's GNU tar.
# bsdtar (macOS) and GNU tar (Linux) spell the metadata switches differently.
g2_tar() {
  if tar --version 2>/dev/null | grep -q bsdtar; then COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -czf - "$@"
  else tar --no-xattrs -czf - "$@"; fi
}

# Fail early with a readable message when the server is unreachable.
g2_check_ssh() {
  g2_need_host
  g2_ssh true 2>/dev/null || die "ssh $DEPLOY_HOST failed (BatchMode): check DEPLOY_HOST, the key and the network"
}
