#!/bin/bash
# SQLite backup of Gothic II Guessr. Runs ON THE SERVER as user g2 from gothic-guessr-backup.service (daily timer);
# bootstrap.sh installs it as /usr/local/lib/gothic-guessr/backup-db.sh.
#
#   DB_PATH     live database          (default /var/lib/gothic-guessr/db.sqlite)
#   BACKUP_DIR  where backups go       (default /var/backups/gothic-guessr)
#   KEEP        newest backups to keep (default 14)
#
# `.backup` is SQLite's online backup API: consistent while the app keeps writing (WAL included). The copy is
# checked with PRAGMA integrity_check before it replaces anything, then gzipped as db-<UTC stamp>.sqlite.gz.
# Manual run: `systemctl start gothic-guessr-backup`; list: `ls -lh /var/backups/gothic-guessr`.
# Restore: stop the service, `gunzip -c db-….sqlite.gz > /var/lib/gothic-guessr/db.sqlite`, remove the stale
# db.sqlite-wal / db.sqlite-shm, `chown g2:g2` the file, start the service.
set -euo pipefail

DB_PATH=${DB_PATH:-/var/lib/gothic-guessr/db.sqlite}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/gothic-guessr}
KEEP=${KEEP:-14}
umask 077

if [[ ! -f $DB_PATH ]]; then
  echo "backup-db: no database at $DB_PATH yet, nothing to do"
  exit 0
fi
mkdir -p "$BACKUP_DIR"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
tmp="$BACKUP_DIR/.db-$stamp.sqlite.tmp"
out="$BACKUP_DIR/db-$stamp.sqlite.gz"
trap 'rm -f "$tmp" "$tmp.gz"' EXIT

sqlite3 "$DB_PATH" ".timeout 15000" ".backup '$tmp'"
check=$(sqlite3 "$tmp" "PRAGMA integrity_check;")
if [[ $check != ok ]]; then
  echo "backup-db: integrity_check of the copy failed: $check" >&2
  exit 1
fi
gzip -9 "$tmp"
mv "$tmp.gz" "$out"
echo "backup-db: wrote $out ($(du -h "$out" | cut -f1))"

# Rotation: keep the newest $KEEP files.
mapfile -t old < <(find "$BACKUP_DIR" -maxdepth 1 -name 'db-*.sqlite.gz' -printf '%f\n' | sort -r | tail -n +"$((KEEP + 1))")
for f in "${old[@]}"; do
  rm -f -- "${BACKUP_DIR:?}/$f"
  echo "backup-db: removed old $f"
done
