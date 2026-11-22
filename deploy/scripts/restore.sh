#!/usr/bin/env bash
# deploy/scripts/restore.sh — Restauración y verificación de integridad de SQLite para fab (T118b, §3.3)
set -euo pipefail

BACKUP_FILE="${1:-}"
TARGET_DIR="${2:-}"

if [ -z "$BACKUP_FILE" ] || [ -z "$TARGET_DIR" ]; then
  echo "Uso: $0 <archivo-backup.db> <directorio-destino-stateDir>" >&2
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Error: Archivo de copia de seguridad no encontrado: $BACKUP_FILE" >&2
  exit 1
fi

# 1. Comprobación de integridad SHA256 si existe
if [ -f "$BACKUP_FILE.sha256" ]; then
  EXPECTED_SHA=$(cat "$BACKUP_FILE.sha256")
  ACTUAL_SHA=$(sha256sum "$BACKUP_FILE" | awk '{print $1}')
  if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
    echo "Error: Fallo de verificación SHA256 en $BACKUP_FILE" >&2
    exit 1
  fi
  echo "[fab-restore] Integridad SHA256 verificada: $ACTUAL_SHA"
fi

mkdir -p "$TARGET_DIR"
TARGET_DB="$TARGET_DIR/fabrica.db"

START_TIME=$(date +%s%N)
echo "[fab-restore] Restaurando $BACKUP_FILE -> $TARGET_DB..."

# Copia segura
cp "$BACKUP_FILE" "$TARGET_DB"
chmod 0600 "$TARGET_DB"

# Elimina cualquier residuo WAL o SHM antiguo en destino
rm -f "$TARGET_DB-wal" "$TARGET_DB-shm"

# 2. Verificación de integridad SQLite y apertura en solo lectura
bun -e '
import { Database } from "bun:sqlite";
const dbPath = process.argv[1];
const db = new Database(dbPath, { strict: true });

// Integrity check
const integrity = db.query("PRAGMA integrity_check;").get() as { integrity_check?: string };
if (integrity?.integrity_check !== "ok") {
  throw new Error(`Fallo de integridad SQLite: ${JSON.stringify(integrity)}`);
}

// Foreign key check
const fkErrors = db.query("PRAGMA foreign_key_check;").all();
if (fkErrors.length > 0) {
  throw new Error(`Fallo de claves foráneas: ${JSON.stringify(fkErrors)}`);
}

// Recuentos seguros según tablas existentes en el esquema
const tables = (db.query("SELECT name FROM sqlite_schema WHERE type=\x27table\x27;").all() as { name: string }[]).map(t => t.name);
const wsCount = tables.includes("workstreams") ? (db.query("SELECT COUNT(*) as c FROM workstreams;").get() as { c: number }).c : 0;
const chCount = tables.includes("changes") ? (db.query("SELECT COUNT(*) as c FROM changes;").get() as { c: number }).c : 0;
const actCount = tables.includes("activities") ? (db.query("SELECT COUNT(*) as c FROM activities;").get() as { c: number }).c : 0;

console.log(`[fab-restore] Verificaciones completadas: integrity_check=ok, foreign_key_check=0`);
console.log(`[fab-restore] Filas restauradas: workstreams=${wsCount}, changes=${chCount}, activities=${actCount}`);
db.close();
' "$TARGET_DB"

END_TIME=$(date +%s%N)
DURATION_MS=$(( (END_TIME - START_TIME) / 1000000 ))

echo "[fab-restore] Restauración completada exitosamente en ${DURATION_MS} ms"
