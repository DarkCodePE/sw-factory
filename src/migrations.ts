import type { Database } from 'bun:sqlite';

/** Migración con ID estable: se aplica una sola vez, bajo lock de escritura, y se registra en la misma transacción. */
export interface Migration { id: string; up(db: Database): void }

const roles = `'owner','admin','member','viewer'`;

export const MIGRATIONS: Migration[] = [
  {
    id: 't119a-001-identidad',
    up(db) {
      db.exec(`
CREATE TABLE team (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  recovery TEXT CHECK (recovery IS NULL OR recovery = 'restricted'));
CREATE TRIGGER team_id_inmutable BEFORE UPDATE OF id ON team BEGIN SELECT RAISE(ABORT, 'team.id es inmutable'); END;
CREATE TRIGGER team_sin_borrado BEFORE DELETE ON team BEGIN SELECT RAISE(ABORT, 'el equipo no se borra'); END;
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  display_name TEXT NOT NULL,
  team_id TEXT NOT NULL REFERENCES team(id),
  role TEXT NOT NULL CHECK (role IN (${roles})),
  created_at TEXT NOT NULL,
  disabled_at TEXT,
  UNIQUE (issuer, subject));
CREATE TRIGGER users_identidad_inmutable BEFORE UPDATE OF id, issuer, subject, team_id ON users
  BEGIN SELECT RAISE(ABORT, 'la identidad del usuario es inmutable'); END;
CREATE TABLE user_invitations (
  id TEXT PRIMARY KEY,
  inviter_id TEXT NOT NULL REFERENCES users(id),
  expected_issuer TEXT NOT NULL,
  expected_subject TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN (${roles})),
  code_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT);
CREATE TABLE user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  class TEXT NOT NULL CHECK (class IN ('web','cli')),
  token_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT);
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);
CREATE TABLE identity_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_user_id TEXT,
  actor_source TEXT NOT NULL,
  action TEXT NOT NULL,
  object TEXT,
  detail TEXT,
  result TEXT NOT NULL,
  exported_at TEXT);`);
    },
  },
  {
    id: 't119a-002-api-keys-por-usuario',
    up(db) {
      const before = (db.query('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number }).n;
      db.exec(`
CREATE TABLE api_keys_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read','decide')),
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  revoked_at TEXT,
  user_id TEXT REFERENCES users(id),
  expires_at TEXT);
INSERT INTO api_keys_new (id, name, scope, hash, created_at, created_by, revoked_at)
  SELECT id, name, scope, hash, created_at, created_by, revoked_at FROM api_keys;
DROP TABLE api_keys;
ALTER TABLE api_keys_new RENAME TO api_keys;
CREATE UNIQUE INDEX idx_api_keys_usuario_nombre ON api_keys(user_id, name) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_api_keys_local_nombre ON api_keys(name) WHERE user_id IS NULL;`);
      const after = (db.query('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number }).n;
      if (after !== before) throw new Error(`reconstrucción de api_keys perdió filas (${before} → ${after})`);
      if (db.query('PRAGMA foreign_key_check').all().length) throw new Error('foreign_key_check falló tras reconstruir api_keys');
    },
  },
  {
    id: 't119a-003-actor-en-eventos',
    up(db) {
      db.exec(`ALTER TABLE events ADD COLUMN actor_user_id TEXT; ALTER TABLE events ADD COLUMN actor_source TEXT;`);
    },
  },
  {
    // Solo añadir: salvo `exported_at`, un asiento no se edita ni se borra por SQL. Sin un ancla externa (la réplica del diario),
    // quien tenga el fichero puede recortar la cola; esto cierra la edición, no la truncación.
    id: 't119a-004-auditoria-solo-anadir',
    up(db) {
      db.exec(`
CREATE TRIGGER identity_audit_inmutable BEFORE UPDATE OF seq, op_id, at, actor, actor_user_id, actor_source, action, object, detail, result ON identity_audit
  BEGIN SELECT RAISE(ABORT, 'identity_audit es de solo añadir'); END;
CREATE TRIGGER identity_audit_sin_borrado BEFORE DELETE ON identity_audit
  BEGIN SELECT RAISE(ABORT, 'identity_audit es de solo añadir'); END;`);
    },
  },
  {
    // `INSERT OR REPLACE` borra la fila vieja sin disparar el trigger de borrado (sin recursive_triggers): se aborta antes, por `seq` o por `op_id`.
    id: 't119a-005-auditoria-sin-reemplazo',
    up(db) {
      db.exec(`
CREATE TRIGGER identity_audit_sin_reemplazo BEFORE INSERT ON identity_audit
  WHEN EXISTS (SELECT 1 FROM identity_audit WHERE op_id = NEW.op_id OR seq = NEW.seq)
  BEGIN SELECT RAISE(ABORT, 'identity_audit es de solo añadir'); END;`);
    },
  },
];

/** Aplica los pasos pendientes. Cada uno: BEGIN IMMEDIATE, revalida el registro bajo lock, ejecuta y registra; si falla, rollback. */
export function applyMigrations(db: Database, now: string, steps: Migration[] = MIGRATIONS): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const step of steps) {
    if (db.query('SELECT 1 FROM schema_migrations WHERE id = ?').get(step.id)) continue;
    db.transaction(() => {
      if (db.query('SELECT 1 FROM schema_migrations WHERE id = ?').get(step.id)) return;
      step.up(db);
      db.query('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(step.id, now);
    }).immediate();
  }
}
