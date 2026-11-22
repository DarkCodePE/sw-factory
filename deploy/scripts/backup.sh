#!/usr/bin/env bash
# deploy/scripts/backup.sh — Copia de seguridad atómica de SQLite con WAL para fab (T118b, §3.2)
set -euo pipefail

DB_FILE="${1:-${FABRICA_DB:-$HOME/.fabrica/fabrica.db}}"
BACKUP_DIR="${2:-${FABRICA_BACKUP_DIR:-/var/backups/fab}}"

if [ ! -f "$DB_FILE" ]; then
  echo "Error: Base de datos no encontrada en $DB_FILE" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"

TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
BACKUP_FILE="$BACKUP_DIR/fabrica-backup-$TIMESTAMP.db"
TMP_BACKUP="$BACKUP_FILE.tmp"
rm -f "$TMP_BACKUP" "$BACKUP_FILE"

echo "[fab-backup] Iniciando copia de seguridad: $DB_FILE -> $BACKUP_FILE"
START_TIME=$(date +%s%N)

# Usamos bun y Database para realizar un checkpoint y backup atómico consistente (VACUUM INTO)
bun -e '
import { Database } from "bun:sqlite";
const dbPath = process.argv[1];
const tmpPath = process.argv[2];
const db = new Database(dbPath, { strict: true });
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA wal_checkpoint(PASSIVE);");
db.exec(`VACUUM INTO \x27${tmpPath}\x27;`);
db.close();
' "$DB_FILE" "$TMP_BACKUP"

mv "$TMP_BACKUP" "$BACKUP_FILE"
chmod 0600 "$BACKUP_FILE"

# Genera digest SHA256 para verificación de integridad
sha256sum "$BACKUP_FILE" | awk '{print $1}' > "$BACKUP_FILE.sha256"

END_TIME=$(date +%s%N)
DURATION_MS=$(( (END_TIME - START_TIME) / 1000000 ))

echo "[fab-backup] Copia completada con éxito en ${DURATION_MS} ms"
echo "[fab-backup] Archivo: $BACKUP_FILE ($(stat -c%s "$BACKUP_FILE") bytes)"
echo "[fab-backup] SHA256: $(cat "$BACKUP_FILE.sha256")"
