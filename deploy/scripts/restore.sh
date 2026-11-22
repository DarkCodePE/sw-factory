#!/usr/bin/env bash
# deploy/scripts/restore.sh — Restauración y verificación de integridad de SQLite para fab (T118b, §3.3)
set -euo pipefail

FORCE=false
REQUIRE_CHECKSUM=true
ARGS=()

for arg in "$@"; do
  case "$arg" in
    --force)
      FORCE=true
      ;;
    --no-checksum)
      REQUIRE_CHECKSUM=false
      ;;
    -*)
      echo "Opción desconocida: $arg" >&2
      exit 1
      ;;
    *)
      ARGS+=("$arg")
      ;;
  esac
done

if [ ${#ARGS[@]} -lt 2 ]; then
  echo "Uso: $0 [--force] [--no-checksum] <archivo-backup.db> <directorio-destino-stateDir>" >&2
  exit 1
fi

BACKUP_FILE="${ARGS[0]}"
TARGET_DIR="${ARGS[1]}"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Error: Archivo de copia de seguridad no encontrado: $BACKUP_FILE" >&2
  exit 1
fi

# 1. Comprobación de integridad SHA256
if [ -f "$BACKUP_FILE.sha256" ]; then
  EXPECTED_SHA=$(cat "$BACKUP_FILE.sha256" | awk '{print $1}')
  ACTUAL_SHA=$(sha256sum "$BACKUP_FILE" | awk '{print $1}')
  if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
    echo "Error: Fallo de verificación SHA256 en $BACKUP_FILE (esperado: $EXPECTED_SHA, actual: $ACTUAL_SHA)" >&2
    exit 1
  fi
  echo "[fab-restore] Integridad SHA256 verificada: $ACTUAL_SHA"
else
  if [ "$REQUIRE_CHECKSUM" = true ]; then
    echo "Error: No se encontró archivo de verificación SHA256 ($BACKUP_FILE.sha256). Falla cerrado por seguridad (use --no-checksum para forzar)." >&2
    exit 1
  else
    echo "Aviso: No se encontró archivo SHA256; procediendo con --no-checksum." >&2
  fi
fi

mkdir -p "$TARGET_DIR"
TARGET_DB="$TARGET_DIR/fabrica.db"

# 2. Verificación de destino libre
if [ -f "$TARGET_DB" ] && [ "$FORCE" = false ]; then
  echo "Error: El archivo de base de datos destino ya existe en $TARGET_DB. La restauración requiere un directorio nuevo o la opción --force." >&2
  exit 1
fi

START_TIME=$(date +%s%N)
TMP_DB="$TARGET_DIR/fabrica.db.tmp-$$-$(date +%s%N)"
rm -f "$TMP_DB"

trap 'rm -f "$TMP_DB"' EXIT

echo "[fab-restore] Copiando a temporal para verificación: $BACKUP_FILE -> $TMP_DB..."
cp "$BACKUP_FILE" "$TMP_DB"
chmod 0600 "$TMP_DB"

# 3. Verificación de integridad SQLite y apertura en solo lectura sobre el temporal
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
' "$TMP_DB"

# 4. Sustitución atómica final
rm -f "$TARGET_DB-wal" "$TARGET_DB-shm"
mv "$TMP_DB" "$TARGET_DB"
trap - EXIT

END_TIME=$(date +%s%N)
DURATION_MS=$(( (END_TIME - START_TIME) / 1000000 ))

echo "[fab-restore] Restauración completada exitosamente en ${DURATION_MS} ms en $TARGET_DB"
