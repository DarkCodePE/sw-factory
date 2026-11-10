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
  scope_max TEXT NOT NULL, reasons TEXT NOT NULL, policy TEXT NOT NULL, decided_at TEXT NOT NULL);`;

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
