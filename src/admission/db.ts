// Admisión (fase 1, modo observe): tablas con prefijo `adm_` en la misma fabrica.db, fuera de `Store`.
// Mismo patrón que ChangeLinkStore (src/connectors/links.ts): crea su esquema y nunca toca las tablas de la fab.
import type { Database } from 'bun:sqlite';
import type { Store } from '../store.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS adm_effects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','dead','unknown')),
  attempts INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  attempt_id TEXT,
  last_error TEXT);
CREATE INDEX IF NOT EXISTS adm_effects_due ON adm_effects(status, due_at);
CREATE TABLE IF NOT EXISTS adm_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL, heartbeat_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS adm_cursors (source TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS adm_threads (id TEXT PRIMARY KEY, source TEXT NOT NULL, first_seen TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS adm_triggers (
  key TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES adm_threads(id), event TEXT NOT NULL, observed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS adm_decisions (
  trigger_key TEXT PRIMARY KEY REFERENCES adm_triggers(key), would_admit INTEGER NOT NULL, strength TEXT NOT NULL,
  scope_max TEXT NOT NULL, reasons TEXT NOT NULL, policy TEXT NOT NULL, decided_at TEXT NOT NULL);
-- Contenido admitido de un hilo (T20): la copia que vio quien etiquetó. El prompt usa solo esta copia, nunca una relectura.
CREATE TABLE IF NOT EXISTS adm_content (
  thread_id TEXT PRIMARY KEY REFERENCES adm_threads(id), title TEXT NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL,
  labeled_at TEXT NOT NULL, edited_at TEXT, captured_at TEXT NOT NULL);
-- Reports de un turno vivo, durables por intento (T16): el handler los guarda sin tocar la activity; se aplican al acabar el turno.
CREATE TABLE IF NOT EXISTS adm_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL, activity_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('done','blocked','awaiting')),
  summary TEXT NOT NULL, human_action TEXT, created_at TEXT NOT NULL, applied_at TEXT);
CREATE INDEX IF NOT EXISTS adm_reports_activity ON adm_reports(activity_id, id);
-- Preguntas a una persona: una abierta por activity.
CREATE TABLE IF NOT EXISTS adm_questions (
  id TEXT PRIMARY KEY, activity_id TEXT NOT NULL, change_id TEXT NOT NULL, text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','expired','canceled')),
  asked_at TEXT NOT NULL, answered_at TEXT, answer TEXT, answered_by TEXT, delivered_at TEXT);
-- Sesión de harness por (change, tipo de activity, generación), escrita ANTES de lanzar (T17): sobrevive a la caída del pool,
-- a requeueOrphans y a retryChange (que crea otra activity pero no otro change).
CREATE TABLE IF NOT EXISTS adm_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, change_id TEXT NOT NULL, kind TEXT NOT NULL, generation INTEGER NOT NULL,
  session_id TEXT NOT NULL UNIQUE, backend TEXT NOT NULL, cwd TEXT NOT NULL, model TEXT, profile_digest TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','lost','closed')), launched_at TEXT, lost_reason TEXT, created_at TEXT NOT NULL,
  UNIQUE (change_id, kind, generation));
CREATE UNIQUE INDEX IF NOT EXISTS adm_questions_open ON adm_questions(activity_id) WHERE status = 'open';`;

export class AdmissionDb {
  readonly db: Database;
  constructor(private readonly store: Store) {
    this.db = store.db;
    this.db.exec(SCHEMA);
  }
  /** Reloj de la fab (inyectable en tests), en ms. */
  now(): number { return this.store.clock().getTime(); }
  iso(): string { return this.store.now(); }
  /** Transacción IMMEDIATE con reintento, como el resto de escrituras de la base (Store.withRetry). */
  tx<T>(fn: () => T): T { return this.store.withRetry(fn); }
}
