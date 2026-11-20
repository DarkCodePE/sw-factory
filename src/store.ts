// SQLite-backed store for workstreams, signals, changes, activities and events.
// Every lifecycle transition goes through a compare-and-set UPDATE so concurrent workers
// cannot double-claim or overwrite each other's results.
import { DEFAULT_DIGEST, resolveProfile } from './profile.ts';
import { isForbiddenEnvName } from './mcp-registry.ts';
import { Database } from 'bun:sqlite';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { userInfo } from 'node:os';
import { closeSync, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gitEvidence, writeManifest } from './manifest.ts';
import { lastDue, parseCron } from './cron.ts';

import {
  type ActivityKind as BaseActivityKind,
  type ActivityStatus as BaseActivityStatus,
  type ChangeStatus as BaseChangeStatus,
  type ReviewDecision,
  type SignalStatus,
  type WorkstreamState,
  MAX_ACTIVITY_RETRIES,
  REVIEW_FOLLOW_UP,
  REVIEWABLE_KINDS,
  TERMINAL_ACTIVITY,
  WORKSTREAM_TRANSITIONS,
} from './enums.ts';
import {
  VALIDATOR_KINDS,
  type ValidatorKind,
  type ValidationResult,
  type ValidationSummary,
  type ValidationVerdict,
} from './connectors/types.ts';
import { DEFAULT_PROTECTED_PATHS, validateProtectedPatterns, type GateSnapshot } from './validators/integrity.ts';
import { verifierArgv } from './agent/mission-evidence.ts';
import { parseVerdict } from './validators/verdict.ts';

// Local extensions keep this task within the store ownership boundary.
export type ActivityKind = BaseActivityKind | 'gates';
/** `waiting_reply`: un turno vivo preguntó a una persona y espera su respuesta (no ocupa slot ni worktree activo). */
export type ActivityStatus = BaseActivityStatus | 'blocked' | 'quarantined' | 'waiting_reply';
export type ChangeStatus = BaseChangeStatus | 'blocked' | 'quarantined';

export const LEASE_TTL_MS = process.env.FABRICA_LEASE_TTL_MS ? Number(process.env.FABRICA_LEASE_TTL_MS) : 90_000;
export const HEARTBEAT_INTERVAL_MS = process.env.FABRICA_HEARTBEAT_MS ? Number(process.env.FABRICA_HEARTBEAT_MS) : 30_000;

export const TERMINAL_CHANGE_STATUSES: readonly string[] = [
  'completed',
  'failed',
  'canceled',
  'declined',
  'blocked',
  'quarantined',
];

export function isTerminalChange(status: string): boolean {
  return TERMINAL_CHANGE_STATUSES.includes(status);
}

export function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Real bun:sqlite contention: SQLITE_BUSY[_*] ("database is locked") and SQLITE_LOCKED ("database table is locked").
  // Never match a bare "busy": git/fs errors (EBUSY, paths) are not transient DB contention.
  return /^SQLITE_(BUSY|LOCKED)/.test((err as any).code ?? '') || /^database (table )?is locked$/i.test(err.message);
}

export interface Workstream {
  id: string;
  slug: string;
  goal: string;
  repo: string;
  state: WorkstreamState;
  agent: string;
  workerConcurrency: number;
  taskLimit: number;
  requireChangeApproval: boolean;
  requireApproval: boolean;
  createdAt: string;
  protectedPaths: string[];
  verify?: string[][];
  verifySetup?: string[][];
  /** Hash of the setup argv that last succeeded; setup reruns only when it differs. */
  verifySetupHash?: string | null;
  /** Digest del perfil de instrucciones fijado; null = perfil por defecto. */
  profile: string | null;
  /** Variables de entorno que el workstream permite a sus agentes (solo nombres); null = modo anterior. */
  envAllow: string[] | null;
  /** Servidores MCP que el workstream permite a sus agentes; null = modo anterior. */
  mcpAllow: string[] | null;
  /** Nombre del runner que ejecuta sus agentes; null = comportamiento anterior (local, sin runner). */
  runner: string | null;
}

export interface Runner {
  name: string;
  kind: 'local' | 'ssh';
  /** ssh: alias de ~/.ssh/config del dueño; local: null. La fab no guarda host, usuario ni claves (D-K). */
  target: string | null;
  options: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  createdBy: string;
}

export interface Signal {
  id: string;
  workstreamId: string;
  title: string;
  body: string;
  status: SignalStatus;
  changeId: string | null;
  source: string | null;
  createdAt: string;
}

type AutomationResult = 'created' | 'skipped_open' | 'skipped_inactive';

export interface Automation {
  id: string;
  workstreamId: string;
  name: string;
  cron: string;
  title: string;
  body: string;
  enabled: boolean;
  createdAt: string;
  createdBy: string;
  lastDueAt: string | null;
  lastResult: AutomationResult | null;
  lastSignalId: string | null;
}

type AutomationRun =
  | { result: 'created'; signalId: string }
  | { result: 'skipped_open' | 'skipped_inactive'; signalId?: never };

type ApiKeyScope = 'read' | 'decide';

interface ApiKeyIdentity {
  id: string;
  name: string;
  scope: ApiKeyScope;
}

interface ApiKeyMetadata extends ApiKeyIdentity {
  createdAt: string;
  createdBy: string;
  revokedAt: string | null;
}

export interface Change {
  id: string;
  workstreamId: string;
  title: string;
  description: string;
  status: ChangeStatus;
  branch: string | null;
  baseSha: string | null;
  protectedBaseline: GateSnapshot;
  createdAt: string;
  updatedAt: string;
}

export type ChangeSource = 'cli' | 'channel' | 'jira' | 'automation';
/** `agents` y `roles` salen de las activities; vacíos = «No medido». `roles` es el validador o, si no hay, el tipo. */
export interface ChangeAttribution extends Change { source: ChangeSource | null; creator: string | null }
export interface ChangeSummary extends ChangeAttribution { activityCount: number; agents: string[]; roles: string[] }
export interface ChangeLinks { source?: { system: string; key: string; url: string }; pr?: { repo: string; number: number; url: string } }

export interface WebhookDelivery {
  delivery_id: string;
  event: string;
  received_at: string;
  bytes: number;
  result: string;
}

export interface WebhookReceptorStatus {
  hasTable: boolean;
  active: boolean;
  endpoint: string;
  totalDeliveries: number;
  lastDeliveryAt: string | null;
  last24h: { result: string; count: number }[];
  rejectedCount: number;
  lastRejectedAt: string | null;
}

export interface ChangeNote {
  id: string;
  changeId: string;
  body: string;
  actor: string;
  createdAt: string;
  activityId: string | null;
  attemptId: string | null;
  deliveredAt: string | null;
}

export interface Activity {
  id: string;
  workstreamId: string;
  changeId: string;
  parentActivityId: string | null;
  kind: ActivityKind;
  status: ActivityStatus;
  reviewStatus: string | null;
  reviewComment: string | null;
  validator: ValidatorKind | null;
  verifiedHead?: string | null;
  workerId: string | null;
  result: string | null;
  error: string | null;
  retryCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  leaseExpiresAt: string | null;
  agentPgid: number | null;
  /** Perfil de instrucciones y sha de fab con los que corrió; null si aún no empezó. */
  profileDigest: string | null;
  fabSha: string | null;
  /** Adaptador y modelo pedido del último intento; null si no empezó, es anterior a T57 o se usó el modelo por defecto. */
  agent: string | null;
  model: string | null;
  /** Pregunta abierta de un turno vivo (solo en `waiting_reply`) y su plazo. */
  questionId: string | null;
  waitUntil: string | null;
  /** Runner del último intento; null si corrió local sin runner o es anterior a T74. */
  runner: string | null;
}

export class StoreError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_transition' | 'conflict' | 'limit_reached' | 'invalid_input',
    message: string
  ) {
    super(message);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workstreams (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, goal TEXT NOT NULL, repo TEXT NOT NULL,
  state TEXT NOT NULL, agent TEXT NOT NULL, worker_concurrency INTEGER NOT NULL,
  task_limit INTEGER NOT NULL, require_change_approval INTEGER NOT NULL,
  require_approval INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY, workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, change_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  last_due_at TEXT,
  last_result TEXT,
  last_signal_id TEXT,
  UNIQUE (workstream_id, name));
CREATE TABLE IF NOT EXISTS runners (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('local','ssh')),
  target TEXT,
  options TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('read','decide')),
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  revoked_at TEXT);
CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY, workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL, branch TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS change_notes (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activity_id TEXT,
  attempt_id TEXT,
  delivered_at TEXT);
CREATE INDEX IF NOT EXISTS idx_change_notes_pending ON change_notes(change_id, delivered_at);
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY, workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  change_id TEXT NOT NULL REFERENCES changes(id) ON DELETE CASCADE, parent_activity_id TEXT,
  kind TEXT NOT NULL, status TEXT NOT NULL, review_status TEXT, review_comment TEXT,
  validator TEXT, worker_id TEXT,
  result TEXT, error TEXT, retry_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  started_at TEXT, completed_at TEXT, lease_expires_at TEXT, agent_pgid INTEGER);
CREATE INDEX IF NOT EXISTS idx_activities_claim ON activities(workstream_id, status, created_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workstream_id TEXT NOT NULL, change_id TEXT,
  activity_id TEXT, severity TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
`;

const bool = (v: unknown): boolean => v === 1 || v === true;

type Row = Record<string, unknown>;

function toWorkstream(r: Row): Workstream {
  return {
    id: r.id as string,
    slug: r.slug as string,
    goal: r.goal as string,
    repo: r.repo as string,
    state: r.state as WorkstreamState,
    agent: r.agent as string,
    workerConcurrency: r.worker_concurrency as number,
    taskLimit: r.task_limit as number,
    requireChangeApproval: bool(r.require_change_approval),
    requireApproval: bool(r.require_approval),
    protectedPaths: r.protected_paths == null ? [...DEFAULT_PROTECTED_PATHS] : JSON.parse(r.protected_paths as string),
    verify: r.verify == null ? [] : JSON.parse(r.verify as string),
    verifySetup: r.verify_setup == null ? [] : JSON.parse(r.verify_setup as string),
    verifySetupHash: (r.verify_setup_hash as string | null) ?? null,
    profile: (r.profile as string | null) ?? null,
    envAllow: r.env_allow == null ? null : JSON.parse(r.env_allow as string),
    mcpAllow: r.mcp_allow == null ? null : JSON.parse(r.mcp_allow as string),
    runner: (r.runner as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

const RUNNER_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const RUNNER_TARGET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function toRunner(r: Row): Runner {
  return {
    name: r.name as string,
    kind: r.kind as Runner['kind'],
    target: (r.target as string | null) ?? null,
    options: JSON.parse(r.options as string),
    enabled: bool(r.enabled),
    createdAt: r.created_at as string,
    createdBy: r.created_by as string,
  };
}

/** Opciones por tipo; cualquier otra clave se rechaza para que un runner nunca guarde secretos (D-K). */
function checkRunnerOptions(kind: Runner['kind'], options: Record<string, unknown>): void {
  const bad = (k: string, why: string) => new StoreError('invalid_input', `options.${k}: ${why}`);
  const allowed = kind === 'local' ? ['confine'] : ['maxBundleMb'];
  for (const k of Object.keys(options)) if (!allowed.includes(k)) throw bad(k, `no existe para un runner ${kind}`);
  if ('confine' in options && typeof options.confine !== 'boolean') throw bad('confine', 'debe ser booleano');
  if ('maxBundleMb' in options && !(Number.isInteger(options.maxBundleMb) && (options.maxBundleMb as number) >= 1 && (options.maxBundleMb as number) <= 4096)) {
    throw bad('maxBundleMb', 'debe ser un entero entre 1 y 4096');
  }
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MCP_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** Reglas de nombres de T71 §4.2; el valor de una variable nunca entra aquí. */
function checkAllowNames(field: 'env_allow' | 'mcp_allow', names: string[]): void {
  const env = field === 'env_allow';
  const max = env ? 16 : 8;
  if (names.length > max) throw new StoreError('invalid_input', `${field}: como máximo ${max} nombres`);
  if (new Set(names).size !== names.length) throw new StoreError('invalid_input', `${field}: nombres repetidos`);
  for (const [i, n] of names.entries()) {
    const ok = typeof n === 'string' && (env ? ENV_NAME.test(n) : MCP_NAME.test(n));
    // No se repite el texto: una línea de --import podría ser un valor.
    if (!ok) throw new StoreError('invalid_input', `${field}: el nombre nº ${i + 1} no es válido`);
    if (env && isForbiddenEnvName(n)) throw new StoreError('invalid_input', `${field}: ${n} está prohibido (controla el cargador, git o la fab)`);
    if (!env && n === 'fab') throw new StoreError('invalid_input', `${field}: "fab" está reservado`);
  }
}

function toSignal(r: Row): Signal {
  return {
    id: r.id as string,
    workstreamId: r.workstream_id as string,
    title: r.title as string,
    body: r.body as string,
    status: r.status as SignalStatus,
    changeId: (r.change_id as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function toAutomation(r: Row): Automation {
  return {
    id: r.id as string,
    workstreamId: r.workstream_id as string,
    name: r.name as string,
    cron: r.cron as string,
    title: r.title as string,
    body: r.body as string,
    enabled: bool(r.enabled),
    createdAt: r.created_at as string,
    createdBy: r.created_by as string,
    lastDueAt: r.last_due_at as string | null,
    lastResult: r.last_result as AutomationResult | null,
    lastSignalId: r.last_signal_id as string | null,
  };
}

function toChange(r: Row): Change {
  return {
    id: r.id as string,
    workstreamId: r.workstream_id as string,
    title: r.title as string,
    description: r.description as string,
    status: r.status as ChangeStatus,
    branch: (r.branch as string | null) ?? null,
    baseSha: (r.base_sha as string | null) ?? null,
    protectedBaseline: JSON.parse((r.protected_baseline as string | null) ?? '{}'),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function toChangeNote(r: Row): ChangeNote {
  return {
    id: r.id as string,
    changeId: r.change_id as string,
    body: r.body as string,
    actor: r.actor as string,
    createdAt: r.created_at as string,
    activityId: r.activity_id as string | null,
    attemptId: r.attempt_id as string | null,
    deliveredAt: r.delivered_at as string | null,
  };
}

function toActivity(r: Row): Activity {
  return {
    id: r.id as string,
    workstreamId: r.workstream_id as string,
    changeId: r.change_id as string,
    parentActivityId: (r.parent_activity_id as string | null) ?? null,
    kind: r.kind as ActivityKind,
    status: r.status as ActivityStatus,
    reviewStatus: (r.review_status as string | null) ?? null,
    reviewComment: (r.review_comment as string | null) ?? null,
    verifiedHead: (r.verified_head as string | null) ?? null,
    validator: (r.validator as ValidatorKind | null) ?? null,
    workerId: (r.worker_id as string | null) ?? null,
    result: (r.result as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    retryCount: r.retry_count as number,
    createdAt: r.created_at as string,
    startedAt: (r.started_at as string | null) ?? null,
    completedAt: (r.completed_at as string | null) ?? null,
    leaseExpiresAt: (r.lease_expires_at as string | null) ?? null,
    agentPgid: (r.agent_pgid as number | null) ?? null,
    profileDigest: (r.profile_digest as string | null) ?? null,
    fabSha: (r.fab_sha as string | null) ?? null,
    agent: (r.agent as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    questionId: (r.question_id as string | null) ?? null,
    waitUntil: (r.wait_until as string | null) ?? null,
    runner: (r.runner as string | null) ?? null,
  };
}

export interface CreateWorkstreamInput {
  slug: string;
  goal: string;
  repo: string;
  agent?: string;
  workerConcurrency?: number;
  taskLimit?: number;
  requireChangeApproval?: boolean;
  requireApproval?: boolean;
  protectedPaths?: string[];
  protectNone?: boolean;
  verify?: string[];
  verifySetup?: string[];
  /** Digest de un perfil ya importado; sin él, el por defecto. */
  profile?: string;
}

export interface StoreOptions {
  /** No crea esquema, no migra y SQLite rechaza toda escritura. */
  readonly?: boolean;
  clock?: () => Date;
}

/**
 * SQLite readonly puede crear WAL/SHM al leer una base WAL ya cerrada.
 * Sin WAL tomamos una copia estable en memoria; con WAL usamos SQLite readonly
 * y exigimos el índice existente. No se reinterpreta ni se ignora un WAL vivo.
 */
function openWalReadonly(path: string): Database {
  if (!existsSync(`${path}-shm`)) throw new Error('WAL sin índice compartido: requiere recuperación por un escritor');
  const db = new Database(path, { readonly: true, strict: true });
  try {
    // Fija el snapshot al abrir: el último escritor no puede retirar WAL/SHM
    // entre la apertura y las consultas de esta petición. BEGIN es diferido y solo lee.
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN');
    db.query('SELECT name FROM sqlite_schema LIMIT 1').get();
    return db;
  } catch (error) { db.close(); throw error; }
}

function openReadonlyDatabase(path: string): Database {
  if (existsSync(`${path}-wal`)) {
    return openWalReadonly(path);
  }
  const fd = openSync(path, 'r');
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error('La base no es un fichero regular');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    // Una escritura/checkpoint durante la copia exige otra apertura, sin reparar el estado.
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error('La base cambió durante la lectura; vuelve a intentarlo');
    }
    if (existsSync(`${path}-wal`)) {
      return openWalReadonly(path);
    }
    // deserialize necesita formato rollback en la copia: no hay WAL que reproducir.
    // Solo se cambian estos dos bytes de la copia, nunca los de la base original.
    if (bytes.length >= 100 && bytes.subarray(0, 16).toString() === 'SQLite format 3\0') {
      bytes[18] = 1; bytes[19] = 1;
    }
    const db = Database.deserialize(bytes, { readonly: true, strict: true });
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  } finally { closeSync(fd); }
}

export class Store {
  readonly db: Database;
  readonly stateDir: string | undefined;
  private readonly terminalEvidence = new Set<string>();
  readonly clock: () => Date;
  readonly dbPath: string;
  private readonly readonly: boolean;

  constructor(path: string, options?: StoreOptions) {
    this.stateDir = path === ':memory:' ? undefined : dirname(resolve(path));
    this.clock = options?.clock ?? (() => new Date());
    this.dbPath = path;
    this.readonly = !!options?.readonly;
    this.db = options?.readonly ? openReadonlyDatabase(path) : new Database(path, { create: true, strict: true });
    if (options?.readonly) return;
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  withRetry<T>(fn: () => T, maxAttempts = 4, baseDelayMs = 25): T {
    // Inside an outer transaction a retry would replay only part of it; let the outer caller retry.
    if (this.db.inTransaction) return fn();
    let attempt = 0;
    let delay = baseDelayMs;
    for (;;) {
      try {
        // IMMEDIATE takes the write lock up front, so busy_timeout waits instead of failing on upgrade,
        // and a multi-statement block is replayed whole or not at all.
        return this.db.transaction(fn).immediate();
      } catch (err: unknown) {
        attempt++;
        if (!isBusyError(err) || attempt >= maxAttempts) {
          throw err;
        }
        const jitter = Math.floor(Math.random() * 20);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay + jitter);
        delay = Math.min(delay * 2, 500);
      }
    }
  }

  now(): string {
    return this.clock().toISOString();
  }

  private migrate(): void {
    this.addColumn('activities', 'validator', 'TEXT');
    this.addColumn('workstreams', 'verify', 'TEXT');
    this.addColumn('workstreams', 'verify_setup', 'TEXT');
    this.addColumn('workstreams', 'verify_setup_hash', 'TEXT');
    this.addColumn('activities', 'verified_head', 'TEXT');
    this.addColumn('activities', 'requested_validators', 'TEXT');
    this.addColumn('events', 'actor', 'TEXT');
    this.addColumn('workstreams', 'protected_paths', 'TEXT');
    this.addColumn('changes', 'base_sha', 'TEXT');
    this.addColumn('changes', 'protected_baseline', 'TEXT');
    this.addColumn('activities', 'lease_expires_at', 'TEXT');
    this.addColumn('activities', 'agent_pgid', 'INTEGER');
    this.addColumn('workstreams', 'profile', 'TEXT');
    this.addColumn('workstreams', 'env_allow', 'TEXT');
    this.addColumn('workstreams', 'mcp_allow', 'TEXT');
    this.addColumn('workstreams', 'runner', 'TEXT');
    this.addColumn('activities', 'runner', 'TEXT');
    this.addColumn('activities', 'profile_digest', 'TEXT');
    this.addColumn('activities', 'fab_sha', 'TEXT');
    this.addColumn('activities', 'agent', 'TEXT');
    this.addColumn('activities', 'model', 'TEXT');
    this.addColumn('activities', 'question_id', 'TEXT');
    this.addColumn('activities', 'wait_until', 'TEXT');
    this.addColumn('signals', 'source', 'TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_signals_source ON signals(source, status);');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_activities_lease ON activities(status, lease_expires_at);');
    const migrationTtl = new Date(this.clock().getTime() + LEASE_TTL_MS).toISOString();
    this.db
      .query(`UPDATE activities SET lease_expires_at = ? WHERE status = 'in_progress' AND lease_expires_at IS NULL`)
      .run(migrationTtl);
  }

  private addColumn(table: string, column: string, ddl: string): void {
    const cols = this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === column)) return;
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    } catch (error) {
      // Another opener may have added it after our schema snapshot.
      if (!(error instanceof Error) || !/duplicate column name:/i.test(error.message)) throw error;
    }
  }

  close(): void {
    // Refresh cleanup observations after callers remove a terminal change worktree.
    try { for (const id of this.terminalEvidence) writeManifest(this, id); }
    finally { this.closeDatabase(); }
  }

  /**
   * Bun solo finaliza al cerrar las consultas que siguen en su caché; las expulsadas dejan la conexión viva («zombi») hasta un GC,
   * y su checkpoint reescribiría la base después de close(). Se vuelca el WAL antes y se fuerza el GC si queda rastro.
   */
  private closeDatabase(): void {
    if (this.readonly) { this.db.close(); return; }
    try { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* sin checkpoint, el cierre sigue */ }
    this.db.close();
    if (existsSync(`${this.dbPath}-wal`)) Bun.gc(true);
  }

  // ---- workstreams -------------------------------------------------------

  createWorkstream(input: CreateWorkstreamInput): Workstream {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.slug)) {
      throw new StoreError('invalid_input', `invalid slug "${input.slug}" (use a-z, 0-9, -)`);
    }
    const verify = (input.verify ?? []).map(command => verifierArgv(command));
    // $FAB_DEPS is the one expansion allowed: it is substituted by the runner, never by a shell.
    const verifySetup = (input.verifySetup ?? []).map(command => verifierArgv(command.replaceAll('$FAB_DEPS', 'FAB_DEPS_SLOT')).map(a => a.replaceAll('FAB_DEPS_SLOT', '$FAB_DEPS')));
    if (verifySetup.length && !verify.length) throw new StoreError('invalid_input', '--verify-setup exige --verify');
    const additions = input.protectedPaths ?? [];
    validateProtectedPatterns(additions);
    if (input.protectedPaths?.length === 0 && !input.protectNone) {
      throw new StoreError('invalid_input', 'vaciar protected_paths exige --protect-none');
    }
    const protectedPaths = input.protectNone ? additions : [...new Set([...DEFAULT_PROTECTED_PATHS, ...additions])];
    if (input.profile) {
      try { resolveProfile(this.stateDir, input.profile); } catch (e) { throw new StoreError('invalid_input', (e as Error).message); }
    }
    const id = randomUUID();
    this.withRetry(() => {
      this.db
        .query(
          `INSERT INTO workstreams (id, slug, goal, repo, state, agent, worker_concurrency,
           task_limit, require_change_approval, require_approval, created_at, protected_paths, verify, verify_setup, profile)
           VALUES ($id,$slug,$goal,$repo,'draft',$agent,$wc,$tl,$rca,$ra,$at,$protected,$verify,$setup,$profile)`
        )
        .run({
          id,
          slug: input.slug,
          goal: input.goal,
          repo: input.repo,
          agent: input.agent ?? 'native',
          wc: input.workerConcurrency ?? 2,
          tl: input.taskLimit ?? 20,
          rca: input.requireChangeApproval ?? true ? 1 : 0,
          ra: input.requireApproval ?? true ? 1 : 0,
          at: this.now(),
          protected: JSON.stringify(protectedPaths),
          verify: JSON.stringify(verify),
          setup: JSON.stringify(verifySetup),
          profile: input.profile && input.profile !== DEFAULT_DIGEST ? input.profile : null,
        });
      this.event(id, 'info', `workstream ${input.slug} created (draft)`);
    });
    return this.getWorkstream(id);
  }

  /** Asigna un perfil al workstream (T58). `expected` es el digest vigente que vio quien pide el cambio; el evento guarda anterior y nuevo. */
  assignProfile(idOrSlug: string, digest: string, expected: string): void {
    try { resolveProfile(this.stateDir, digest); } catch (e) { throw new StoreError('invalid_input', (e as Error).message); }
    this.withRetry(() => {
      const ws = this.getWorkstream(idOrSlug);
      const current = ws.profile ?? DEFAULT_DIGEST;
      if (current !== expected || current === digest) throw new StoreError('conflict', 'el perfil vigente cambió o ya es ese');
      const r = this.db.query('UPDATE workstreams SET profile = ? WHERE id = ? AND COALESCE(profile, ?) = ?').run(digest === DEFAULT_DIGEST ? null : digest, ws.id, DEFAULT_DIGEST, expected);
      if (r.changes !== 1) throw new StoreError('conflict', 'el perfil vigente cambió');
      this.event(ws.id, 'info', `perfil asignado: ${current} → ${digest}`);
    });
  }

  setVerifySetupHash(id: string, hash: string): void {
    this.withRetry(() => this.db.query('UPDATE workstreams SET verify_setup_hash = ? WHERE id = ?').run(hash, id));
  }

  getWorkstream(idOrSlug: string): Workstream {
    const r = this.db
      .query('SELECT * FROM workstreams WHERE id = ? OR slug = ?')
      .get(idOrSlug, idOrSlug) as Row | null;
    if (!r) throw new StoreError('not_found', `workstream ${idOrSlug} not found`);
    return toWorkstream(r);
  }

  listWorkstreams(): Workstream[] {
    return (this.db.query('SELECT * FROM workstreams ORDER BY created_at').all() as Row[]).map(toWorkstream);
  }

  setWorkstreamState(idOrSlug: string, next: WorkstreamState): Workstream {
    const ws = this.getWorkstream(idOrSlug);
    if (!WORKSTREAM_TRANSITIONS[ws.state].includes(next)) {
      throw new StoreError('invalid_transition', `workstream ${ws.slug}: ${ws.state} -> ${next} not allowed`);
    }
    this.withRetry(() => {
      const res = this.db
        .query('UPDATE workstreams SET state = ? WHERE id = ? AND state = ?')
        .run(next, ws.id, ws.state);
      if (res.changes !== 1) throw new StoreError('conflict', `workstream ${ws.slug} changed concurrently`);
      this.event(ws.id, 'info', `workstream ${ws.state} -> ${next}`);
    });
    return this.getWorkstream(ws.id);
  }

  /** Ajustes editables desde la web (D-F): objetivo, concurrencia y tope. Un evento por valor con el anterior. */
  updateWorkstreamSettings(idOrSlug: string, input: { goal?: string; workerConcurrency?: number; taskLimit?: number }): Workstream {
    const ws = this.getWorkstream(idOrSlug);
    const goal = input.goal?.trim();
    if (goal !== undefined && (!goal || goal.length > 2000)) throw new StoreError('invalid_input', 'goal: 1-2000 caracteres');
    for (const [name, v, max] of [['worker_concurrency', input.workerConcurrency, 16], ['task_limit', input.taskLimit, 1000]] as const) {
      if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > max)) throw new StoreError('invalid_input', `${name}: entero entre 1 y ${max}`);
    }
    const changes: [string, string, string | number, string | number][] = [];
    if (goal !== undefined && goal !== ws.goal) changes.push(['goal', 'goal', ws.goal, goal]);
    if (input.workerConcurrency !== undefined && input.workerConcurrency !== ws.workerConcurrency) changes.push(['worker_concurrency', 'worker_concurrency', ws.workerConcurrency, input.workerConcurrency]);
    if (input.taskLimit !== undefined && input.taskLimit !== ws.taskLimit) changes.push(['task_limit', 'task_limit', ws.taskLimit, input.taskLimit]);
    this.withRetry(() => {
      for (const [column, label, before, after] of changes) {
        const res = this.db.query(`UPDATE workstreams SET ${column} = ? WHERE id = ? AND ${column} = ?`).run(after, ws.id, before);
        if (res.changes !== 1) throw new StoreError('conflict', `workstream ${ws.slug} changed concurrently`);
        const show = (v: string | number) => typeof v === 'string' ? JSON.stringify(v.length > 200 ? `${v.slice(0, 200)}…` : v) : v;
        this.event(ws.id, 'info', `workstream ${ws.slug}: ${label} ${show(before)} -> ${show(after)}`);
      }
    });
    return this.getWorkstream(ws.id);
  }

  setWorkstreamEnvAllow(idOrSlug: string, names: string[] | null): Workstream {
    return this.#setAllow(idOrSlug, 'env_allow', names);
  }

  setWorkstreamMcpAllow(idOrSlug: string, names: string[] | null): Workstream {
    return this.#setAllow(idOrSlug, 'mcp_allow', names);
  }

  #setAllow(idOrSlug: string, field: 'env_allow' | 'mcp_allow', names: string[] | null): Workstream {
    if (names !== null) checkAllowNames(field, names);
    const next = names === null ? null : JSON.stringify(names);
    this.withRetry(() => {
      this.db.transaction(() => {
        const ws = this.getWorkstream(idOrSlug);
        const prev = (field === 'env_allow' ? ws.envAllow : ws.mcpAllow);
        this.db.query(`UPDATE workstreams SET ${field} = ? WHERE id = ?`).run(next, ws.id);
        this.event(ws.id, 'info', `${field}: ${prev === null ? 'legacy' : JSON.stringify(prev)} -> ${next ?? 'legacy'}`);
      }).immediate();
    });
    return this.getWorkstream(idOrSlug);
  }

  // ---- runners -----------------------------------------------------------

  createRunner(i: { name: string; kind: Runner['kind']; target?: string | null; options?: Record<string, unknown> }): Runner {
    if (typeof i.name !== 'string' || !RUNNER_NAME.test(i.name)) throw new StoreError('invalid_input', 'name: use a-z, 0-9 y guiones (1-41 caracteres)');
    if (i.kind !== 'local' && i.kind !== 'ssh') throw new StoreError('invalid_input', 'kind: debe ser local o ssh');
    if (i.kind === 'ssh' && !(typeof i.target === 'string' && RUNNER_TARGET.test(i.target))) {
      throw new StoreError('invalid_input', 'target: alias de ~/.ssh/config (sin usuario@host ni espacios)');
    }
    if (i.kind === 'local' && i.target != null) throw new StoreError('invalid_input', 'target: un runner local no lo lleva');
    const options = i.options ?? {};
    checkRunnerOptions(i.kind, options);
    return this.withRetry(() => this.db.transaction(() => {
      if (this.db.query('SELECT 1 FROM runners WHERE name = ?').get(i.name)) throw new StoreError('conflict', `ya existe el runner ${i.name}`);
      const row = this.db.query(
        `INSERT INTO runners (name, kind, target, options, enabled, created_at, created_by) VALUES (?,?,?,?,1,?,?) RETURNING *`,
      ).get(i.name, i.kind, i.kind === 'ssh' ? i.target! : null, JSON.stringify(options), this.now(), process.env.FAB_ACTOR ?? userInfo().username) as Row;
      return toRunner(row);
    }).immediate());
  }

  listRunners(): Runner[] {
    return (this.db.query('SELECT * FROM runners ORDER BY name').all() as Row[]).map(toRunner);
  }

  getRunner(name: string): Runner {
    const row = this.db.query('SELECT * FROM runners WHERE name = ?').get(name) as Row | null;
    if (!row) throw new StoreError('not_found', `runner ${name} no encontrado`);
    return toRunner(row);
  }

  setRunnerEnabled(name: string, enabled: boolean): Runner {
    return this.withRetry(() => {
      const row = this.db.query('UPDATE runners SET enabled = ? WHERE name = ? RETURNING *').get(Number(enabled), name) as Row | null;
      if (!row) throw new StoreError('not_found', `runner ${name} no encontrado`);
      // Un evento exige un workstream: alta y borrado (un runner en uso no se borra) no tienen dónde anotarse; pausa y activación, en cada workstream que lo usa.
      for (const w of this.db.query('SELECT id FROM workstreams WHERE runner = ?').all(name) as { id: string }[]) {
        this.event(w.id, 'warning', `runner ${name} ${enabled ? 'activado' : 'pausado'}`);
      }
      return toRunner(row);
    });
  }

  deleteRunner(name: string): void {
    this.withRetry(() => this.db.transaction(() => {
      this.getRunner(name);
      const users = this.db.query('SELECT slug FROM workstreams WHERE runner = ?').all(name) as { slug: string }[];
      if (users.length) throw new StoreError('conflict', `el runner ${name} lo usa ${users.map(u => u.slug).join(', ')}`);
      this.db.query('DELETE FROM runners WHERE name = ?').run(name);
    }).immediate());
  }

  setWorkstreamRunner(idOrSlug: string, name: string | null): Workstream {
    this.withRetry(() => this.db.transaction(() => {
      const ws = this.getWorkstream(idOrSlug);
      const runner = name === null ? null : this.getRunner(name);
      this.db.query('UPDATE workstreams SET runner = ? WHERE id = ?').run(name, ws.id);
      const warn = runner?.kind === 'ssh' ? `; el código de este workstream se enviará a ${runner.target}` : '';
      this.event(ws.id, 'info', `runner: ${ws.runner ?? 'ninguno'} -> ${name ?? 'ninguno'}${warn}`);
    }).immediate());
    return this.getWorkstream(idOrSlug);
  }

  // ---- signals -----------------------------------------------------------

  addSignal(workstream: string, title: string, body: string, opts?: { source?: 'web' }): Signal {
    const source = opts?.source;
    if (source !== undefined && source !== 'web') {
      throw new StoreError('invalid_input', 'origen de señal inválido');
    }
    return this.withRetry(() => this.#insertSignal(this.getWorkstream(workstream).id, title, body, source ?? null));
  }

  #insertSignal(workstreamId: string, title: string, body: string, source: string | null): Signal {
    const row = this.db.query<Row, [string, string, string, string, string, string | null]>(
      `INSERT INTO signals (id, workstream_id, title, body, status, change_id, created_at, source)
       VALUES (?,?,?,?,'new',NULL,?,?) RETURNING *`,
    ).get(randomUUID(), workstreamId, title, body, this.now(), source)!;
    return toSignal(row);
  }

  listSignals(workstream: string, status?: SignalStatus): Signal[] {
    const ws = this.getWorkstream(workstream);
    const rows = status
      ? this.db.query('SELECT * FROM signals WHERE workstream_id = ? AND status = ? ORDER BY created_at').all(ws.id, status)
      : this.db.query('SELECT * FROM signals WHERE workstream_id = ? ORDER BY created_at').all(ws.id);
    return (rows as Row[]).map(toSignal);
  }

  /** Triage: turn a new signal into a change and queue its first activity. */
  triageSignal(signalId: string, opts: { title?: string; description?: string } = {}): Change {
    return this.withRetry(() => {
      return this.db.transaction(() => {
        const s = this.db.query('SELECT * FROM signals WHERE id = ?').get(signalId) as Row | null;
        if (!s) throw new StoreError('not_found', `signal ${signalId} not found`);
        const signal = toSignal(s);
        if (signal.status !== 'new') {
          throw new StoreError('invalid_transition', `signal ${signalId} is ${signal.status}, not new`);
        }
        const change = this.createChange(signal.workstreamId, opts.title ?? signal.title, opts.description ?? signal.body);
        this.db
          .query(`UPDATE signals SET status = 'triaged', change_id = ? WHERE id = ? AND status = 'new'`)
          .run(change.id, signalId);
        return change;
      }).immediate();
    });
  }

  ignoreSignal(signalId: string, status: 'ignored' | 'duplicate' = 'ignored'): void {
    this.withRetry(() => {
      const res = this.db.query(`UPDATE signals SET status = ? WHERE id = ? AND status = 'new'`).run(status, signalId);
      if (res.changes !== 1) throw new StoreError('invalid_transition', `signal ${signalId} is not new`);
    });
  }

  // ---- automations -------------------------------------------------------

  createAutomation(input: { workstream: string; name: string; cron: string; title: string; body: string }): Automation {
    const { workstream, name, cron, title, body } = input;
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) {
      throw new StoreError('invalid_input', 'nombre de automation inválido');
    }
    if (!title || [...title].length > 200) {
      throw new StoreError('invalid_input', 'el título debe tener entre 1 y 200 caracteres');
    }
    if (!body || Buffer.byteLength(body, 'utf8') > 8192) {
      throw new StoreError('invalid_input', 'el cuerpo debe ocupar entre 1 y 8192 bytes');
    }
    try {
      parseCron(cron);
    } catch (error) {
      throw new StoreError('invalid_input', (error as Error).message);
    }
    return this.withRetry(() => {
      const ws = this.getWorkstream(workstream);
      const existing = this.db.query<{ name: string }, [string]>(
        'SELECT name FROM automations WHERE workstream_id = ?',
      ).all(ws.id);
      if (existing.some(a => a.name === name)) {
        throw new StoreError('conflict', `ya existe la automation ${name} en ${ws.slug}`);
      }
      if (existing.length >= 20) {
        throw new StoreError('limit_reached', `el workstream ${ws.slug} tiene 20 automations`);
      }
      const row = this.db.query(
        `INSERT INTO automations (id, workstream_id, name, cron, title, body, created_at, created_by)
         VALUES (?,?,?,?,?,?,?,?) RETURNING *`,
      ).get(randomUUID(), ws.id, name, cron, title, body, this.now(), process.env.FAB_ACTOR ?? userInfo().username) as Row;
      this.event(ws.id, 'info', `automation ${name} creada (${cron})`);
      return toAutomation(row);
    });
  }

  listAutomations(workstream?: string): Automation[] {
    const workstreamId = workstream === undefined ? undefined : this.getWorkstream(workstream).id;
    // El lector puede abrir una base anterior a la migración.
    if (!this.db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'automations'").get()) return [];
    const rows = workstreamId === undefined
      ? this.db.query('SELECT * FROM automations ORDER BY created_at, name').all()
      : this.db.query('SELECT * FROM automations WHERE workstream_id = ? ORDER BY created_at, name').all(workstreamId);
    return (rows as Row[]).map(toAutomation);
  }

  private requireAutomation(id: string, row: Row | null): Automation {
    if (!row) throw new StoreError('not_found', `automation ${id} no encontrada`);
    return toAutomation(row);
  }

  setAutomationEnabled(id: string, enabled: boolean): Automation {
    return this.withRetry(() => {
      const row = this.db.query<Row, [number, string, number, string]>(
        // Al reactivar, el suelo pasa a ahora: lo que venció durante la pausa no se recupera.
        'UPDATE automations SET last_due_at = CASE WHEN ? = 1 AND enabled = 0 THEN ? ELSE last_due_at END, enabled = ? WHERE id = ? RETURNING *',
      ).get(Number(enabled), this.now(), Number(enabled), id);
      const automation = this.requireAutomation(id, row);
      this.event(automation.workstreamId, 'info', `automation ${automation.name} ${enabled ? 'activada' : 'pausada'}`);
      return automation;
    });
  }

  deleteAutomation(id: string): void {
    this.withRetry(() => {
      const row = this.db.query<Row, [string]>('DELETE FROM automations WHERE id = ? RETURNING *').get(id);
      const automation = this.requireAutomation(id, row);
      this.event(automation.workstreamId, 'info', `automation ${automation.name} borrada`);
    });
  }

  fireDueAutomations(workstream?: string): ({ id: string } & AutomationRun)[] {
    const now = this.clock();
    const candidates = workstream === undefined
      ? this.db.query<{ id: string }, []>('SELECT id FROM automations WHERE enabled = 1').all()
      : this.db.query<{ id: string }, [string]>('SELECT id FROM automations WHERE enabled = 1 AND workstream_id = ?')
        .all(this.getWorkstream(workstream).id);
    const results: ({ id: string } & AutomationRun)[] = [];
    const dueOf = (row: Row) => {
      const a = toAutomation(row);
      const floor = new Date(a.lastDueAt ?? a.createdAt);
      if (Number.isNaN(floor.getTime())) throw new Error('last_due_at ilegible');
      return lastDue(parseCron(a.cron), floor, now);
    };
    for (const { id } of candidates) {
      let peek: Row | null = null;
      try {
        peek = this.db.query<Row, [string]>('SELECT * FROM automations WHERE id = ? AND enabled = 1').get(id);
        // Sin vencimiento no se abre transacción de escritura.
        if (!peek || !dueOf(peek)) continue;
        const result = this.withRetry(() => {
          // Releer la fila con el lock de escritura: otro proceso pudo dispararla, pausarla o borrarla.
          const row = this.db.query<Row, [string]>('SELECT * FROM automations WHERE id = ? AND enabled = 1').get(id);
          const due = row && dueOf(row);
          return due ? this.fireAutomation(toAutomation(row), due.toISOString(), true) : null;
        });
        if (result) results.push({ id, ...result });
      } catch (error) {
        // Una fila rara no para a las demás; el aviso sale una vez por mensaje.
        if (!peek) throw error;
        const message = `automation ${String(peek.name)}: no se puede procesar (${(error as Error).message}), se salta`;
        const seen = this.db.query('SELECT 1 FROM events WHERE workstream_id = ? AND message = ? LIMIT 1')
          .get(String(peek.workstream_id), message);
        if (!seen) this.event(String(peek.workstream_id), 'warning', message);
      }
    }
    return results;
  }

  runAutomationNow(id: string): AutomationRun {
    return this.withRetry(() => {
      const row = this.db.query<Row, [string]>('SELECT * FROM automations WHERE id = ?').get(id);
      const automation = this.requireAutomation(id, row);
      return this.fireAutomation(automation, this.now(), false);
    });
  }

  // El llamador mantiene el lock desde la lectura de la automation hasta el evento.
  private fireAutomation(automation: Automation, at: string, scheduled: boolean): AutomationRun {
    const { id, workstreamId, name, title, body } = automation;
    const source = `automation:${id}`;
    let run: AutomationRun;
    let message: string;
    if (this.getWorkstream(workstreamId).state !== 'active') {
      run = { result: 'skipped_inactive' };
      message = 'vez saltada, workstream no activo';
    } else if (this.db.query(
      `SELECT 1 FROM signals s LEFT JOIN changes c ON c.id = s.change_id
       WHERE s.source = ? AND (s.status = 'new' OR (
         s.status = 'triaged' AND c.status NOT IN (${TERMINAL_CHANGE_STATUSES.map(() => '?').join(',')}
       ))) LIMIT 1`,
    ).get(source, ...TERMINAL_CHANGE_STATUSES)) {
      run = { result: 'skipped_open' };
      message = 'vez saltada, hay una señal o un change abierto';
    } else {
      const signal = this.#insertSignal(workstreamId, `${title} (${at.slice(0, 10)})`, body, source);
      run = { result: 'created', signalId: signal.id };
      message = `señal ${signal.id.slice(0, 8)} creada${scheduled ? ` (vencía ${at})` : ''}`;
    }
    this.db.query(
      `UPDATE automations SET last_due_at = COALESCE(?, last_due_at), last_result = ?,
       last_signal_id = COALESCE(?, last_signal_id) WHERE id = ?`,
    ).run(scheduled ? at : null, run.result, run.signalId ?? null, id);
    this.event(workstreamId, 'info', `automation ${name}: ${message}`);
    return run;
  }

  // ---- changes -----------------------------------------------------------

  createChange(workstream: string, title: string, description: string): Change {
    const ws = this.getWorkstream(workstream);
    const id = randomUUID();
    this.withRetry(() => {
      const open = this.db
        .query(
          `SELECT COUNT(*) AS n FROM changes WHERE workstream_id = ?
           AND status NOT IN ('completed','failed','canceled','declined')`
        )
        .get(ws.id) as { n: number };
      if (open.n >= ws.taskLimit) {
        throw new StoreError('limit_reached', `workstream ${ws.slug} reached task limit ${ws.taskLimit}`);
      }
      const t = this.now();
      const firstKind: ActivityKind = ws.requireChangeApproval ? 'change_review' : 'investigation';
      // A change awaiting human approval sits in review; otherwise it waits for a worker.
      const status: ChangeStatus = firstKind === 'change_review' ? 'in_review' : 'pending';
      this.db
        .query(`INSERT INTO changes (id, workstream_id, title, description, status, branch, created_at, updated_at)
                VALUES (?,?,?,?,?,NULL,?,?)`)
        .run(id, ws.id, title, description, status, t, t);
      if (firstKind === 'change_review') {
        this.insertActivity(ws.id, id, null, 'change_review', 'completed', 'awaiting');
      } else {
        this.insertActivity(ws.id, id, null, 'investigation', 'pending', null);
      }
      this.event(ws.id, 'info', `change created: ${title}`, id);
    });
    return this.getChange(id);
  }

  getChange(id: string): Change {
    const r = this.db.query('SELECT * FROM changes WHERE id = ?').get(id) as Row | null;
    if (!r) throw new StoreError('not_found', `change ${id} not found`);
    return toChange(r);
  }

  listChanges(workstream: string): Change[] {
    const ws = this.getWorkstream(workstream);
    return (this.db.query('SELECT * FROM changes WHERE workstream_id = ? ORDER BY created_at').all(ws.id) as Row[]).map(
      toChange
    );
  }

  /**
   * Changes con su fuente y su creador, en consultas de conjunto (sin N+1) y sin crear tablas: sirve a un Store readonly.
   * Fuente: `jira`, `channel` (GitHub/admisión) o `cli` (signal triada a mano); `null` si no se puede saber.
   * Creador: actor del primer evento del change; `null` si no hay eventos.
   */
  changeIndex(workstream?: string): ChangeSummary[] {
    const ws = workstream ? this.getWorkstream(workstream) : undefined;
    const rows = (ws ? this.db.query('SELECT * FROM changes WHERE workstream_id = ? ORDER BY created_at').all(ws.id) : this.db.query('SELECT * FROM changes ORDER BY created_at').all()) as Row[];
    const { source, creator } = this.resolveChangeAttribution();
    const cols = (t: string) => new Set((this.db.query(`PRAGMA table_info(${t})`).all() as Row[]).map(r => r.name as string));
    const count = new Map<string, number>(); const agents = new Map<string, Set<string>>(); const roles = new Map<string, Set<string>>();
    const add = (m: Map<string, Set<string>>, id: string, v: unknown) => { if (typeof v === 'string' && v) m.set(id, (m.get(id) ?? new Set()).add(v)); };
    const hasAgent = cols('activities').has('agent');
    for (const r of this.db.query('SELECT change_id, COUNT(*) AS n FROM activities GROUP BY change_id').all() as Row[]) count.set(r.change_id as string, r.n as number);
    // Sin agregar con GROUP_CONCAT: un adaptador con coma en el nombre se partiría.
    for (const r of this.db.query(`SELECT DISTINCT change_id, ${hasAgent ? 'agent' : 'NULL'} AS agent, COALESCE(validator, kind) AS role FROM activities`).all() as Row[]) {
      add(agents, r.change_id as string, r.agent); add(roles, r.change_id as string, r.role);
    }
    return rows.map(r => ({ ...toChange(r), source: source.get(r.id as string) ?? null, creator: creator.get(r.id as string) ?? null,
      activityCount: count.get(r.id as string) ?? 0, agents: [...(agents.get(r.id as string) ?? [])].sort(), roles: [...(roles.get(r.id as string) ?? [])].sort() }));
  }

  /** Fuente y PR del change, sin crear tablas (sirve a un Store readonly). Los valores son datos no confiables. */
  changeLinks(changeId: string): ChangeLinks {
    const has = (t: string) => this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== null;
    const out: ChangeLinks = {};
    const row = has('change_links') ? this.db.query('SELECT * FROM change_links WHERE change_id = ?').get(changeId) as Row | null : null;
    if (row?.source_system && row.source_key && row.source_url) out.source = { system: String(row.source_system), key: String(row.source_key), url: String(row.source_url) };
    // Una base anterior a T49 puede tener `jira_imports` sin `source_url`; el Store de solo lectura no la migra.
    else if (has('jira_imports') && (this.db.query('PRAGMA table_info(jira_imports)').all() as Row[]).some(c => c.name === 'source_url')) {
      const i = this.db.query('SELECT i.issue_key, i.source_url FROM jira_imports i JOIN signals s ON s.id = i.signal_id WHERE s.change_id = ?').get(changeId) as Row | null;
      if (i?.source_url) out.source = { system: 'jira', key: String(i.issue_key), url: String(i.source_url) };
    }
    try {
      const pr = row?.pr_json ? JSON.parse(String(row.pr_json)) as Record<string, unknown> : null;
      if (pr && typeof pr.url === 'string' && typeof pr.number === 'number') out.pr = { repo: String(pr.repo ?? ''), number: pr.number, url: pr.url };
    } catch { /* pr_json corrupto: el bloque no se muestra */ }
    return out;
  }

  /** Resuelve fuente y creador para un conjunto de changes acotado (o todos si se omite). */
  resolveChangeAttribution(changeIds?: string[]): { source: Map<string, ChangeSource>; creator: Map<string, string | null> } {
    if (changeIds && !changeIds.length) return { source: new Map(), creator: new Map() };
    const has = (t: string) => this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== null;
    const filter = changeIds ? ` WHERE change_id IN (${changeIds.map(() => '?').join(',')})` : '';
    const filterAnd = changeIds ? ` AND change_id IN (${changeIds.map(() => '?').join(',')})` : '';
    const params = changeIds ?? [];

    const source = new Map<string, ChangeSource>();
    const mark = (sql: string, sqlParams: string[], map: (r: Row) => ChangeSource) => {
      for (const r of this.db.query(sql).all(...sqlParams) as Row[]) source.set(r.change_id as string, map(r));
    };
    mark(`SELECT change_id FROM signals WHERE change_id IS NOT NULL${filterAnd}`, params, () => 'cli');
    // Las bases anteriores a T68 no tienen `signals.source`: un Store de solo lectura no puede migrarlas.
    if ((this.db.query('PRAGMA table_info(signals)').all() as Row[]).some(r => r.name === 'source')) mark(`SELECT change_id FROM signals WHERE change_id IS NOT NULL AND source LIKE 'automation:%'${filterAnd}`, params, () => 'automation');
    if (has('adm_thread_changes')) mark(`SELECT change_id FROM adm_thread_changes${filter}`, params, () => 'channel');
    if (has('change_links')) mark(`SELECT change_id, source_system FROM change_links WHERE source_system IS NOT NULL${filterAnd}`, params, r => r.source_system === 'jira' ? 'jira' : 'channel');
    if (has('jira_imports')) {
      const jiraFilter = changeIds ? ` AND s.change_id IN (${changeIds.map(() => '?').join(',')})` : '';
      mark(`SELECT s.change_id FROM jira_imports i JOIN signals s ON s.id = i.signal_id WHERE s.change_id IS NOT NULL${jiraFilter}`, params, () => 'jira');
    }

    const creatorFilter = changeIds ? ` AND change_id IN (${changeIds.map(() => '?').join(',')})` : '';
    const creator = new Map((this.db.query(`SELECT change_id, actor FROM events WHERE id IN (SELECT MIN(id) FROM events WHERE change_id IS NOT NULL${creatorFilter} GROUP BY change_id)`).all(...params) as Row[])
      .map(r => [r.change_id as string, (r.actor as string | null) ?? null]));

    return { source, creator };
  }

  setChangeBranch(changeId: string, branch: string): void {
    this.withRetry(() => {
      this.db.query('UPDATE changes SET branch = ?, updated_at = ? WHERE id = ?').run(branch, this.now(), changeId);
    });
  }

  /** Persist once, before the first worker runs; retries never move the base. */
  setChangeBase(changeId: string, baseSha: string): void {
    this.withRetry(() => {
      this.db.query('UPDATE changes SET base_sha = ? WHERE id = ? AND base_sha IS NULL').run(baseSha, changeId);
    });
  }

  /** Rebase only the explicitly reviewed paths, invalidate old verdicts and retry atomically. */
  allowGate(changeId: string, snapshot: GateSnapshot, comment: string): Activity {
    if (!comment.trim() || !Object.keys(snapshot).length) throw new StoreError('invalid_input', 'gate allow exige rutas y --comment con motivo');
    return this.withRetry(() => {
      return this.db.transaction(() => {
        const c = this.getChange(changeId);
        const acts = this.listActivities({changeId});
        if (c.status !== 'blocked' || !acts.some(a => a.status === 'blocked' && a.error?.startsWith('GATE_TAMPERED:'))) {
          throw new StoreError('invalid_transition', 'gate allow exige un bloqueo GATE_TAMPERED');
        }
        if (acts.some(a => a.status === 'in_progress')) throw new StoreError('conflict', 'change tiene workers en curso');
        const retry = this.retryChange(changeId);
        this.db.query('UPDATE changes SET protected_baseline = ? WHERE id = ?')
          .run(JSON.stringify({...c.protectedBaseline, ...snapshot}), changeId);
        this.db.query(`UPDATE activities SET status = 'failed', review_status = NULL,
          review_comment = NULL, error = 'gate allow: validación invalidada'
          WHERE change_id = ? AND validator IS NOT NULL AND id != ?`).run(changeId, retry.id);
        this.event(c.workstreamId, 'warning', `gate allow: ${JSON.stringify(Object.keys(snapshot))}: ${comment.trim()}`, changeId, retry.id);
        return retry;
      }).immediate();
    });
  }

  private setChangeStatus(changeId: string, status: ChangeStatus): void {
    this.withRetry(() => {
      this.db.query('UPDATE changes SET status = ?, updated_at = ? WHERE id = ?').run(status, this.now(), changeId);
      // Claims skip terminal changes, so pending work left behind would never run and keep `--once` from going idle.
      // A `waiting_reply` activity has no worker to notice the change closed: it is swept too (T27).
      if (isTerminalChange(status)) {
        this.db.query(`UPDATE activities SET status = 'canceled', completed_at = ?, question_id = NULL, wait_until = NULL WHERE change_id = ? AND status IN ('pending', 'waiting_reply')`)
          .run(this.now(), changeId);
        this.terminalEvidence.add(changeId);
        writeManifest(this, changeId);
      }
    });
  }

  // ---- notas del dueño ---------------------------------------------------

  addChangeNote(changeId: string, body: string): ChangeNote {
    return this.withRetry(() => {
      const change = this.getChange(changeId);
      if (isTerminalChange(change.status)) {
        throw new StoreError('invalid_transition', `change ${changeId} terminal (${change.status})`);
      }
      const bytes = Buffer.byteLength(body, 'utf8');
      if (bytes > 8192 || !body.trim()) {
        throw new StoreError('invalid_input', 'la nota debe contener texto y ocupar como máximo 8192 bytes');
      }
      const { n } = this.db.query<{ n: number }, [string]>(
        'SELECT COUNT(*) AS n FROM change_notes WHERE change_id = ? AND delivered_at IS NULL'
      ).get(changeId)!;
      if (n >= 20) throw new StoreError('limit_reached', 'el change tiene 20 notas sin entregar');

      const id = randomUUID();
      const actor = process.env.FAB_ACTOR ?? userInfo().username;
      const createdAt = this.now();
      this.db.query('INSERT INTO change_notes (id, change_id, body, actor, created_at) VALUES (?,?,?,?,?)')
        .run(id, changeId, body, actor, createdAt);
      this.event(change.workstreamId, 'info', `nota del dueño registrada (${id.slice(0, 8)}, ${bytes} bytes)`, changeId);
      return { id, changeId, body, actor, createdAt, activityId: null, attemptId: null, deliveredAt: null };
    });
  }

  listChangeNotes(changeId: string): ChangeNote[] {
    // Una apertura de solo lectura puede encontrar una base anterior a las notas.
    if (!this.db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'change_notes'").get()) return [];
    const rows = this.db.query<Row, [string]>(
      'SELECT * FROM change_notes WHERE change_id = ? ORDER BY created_at, rowid'
    ).all(changeId);
    return rows.map(toChangeNote);
  }

  reserveNotes(changeId: string, activityId: string, attemptId: string): ChangeNote[] {
    return this.withRetry(() => {
      // Una reserva sin confirmar puede pertenecer a un intento interrumpido.
      this.db.query(`UPDATE change_notes SET activity_id = ?, attempt_id = ?
        WHERE change_id = ? AND delivered_at IS NULL`).run(activityId, attemptId, changeId);
      const rows = this.db.query<Row, [string]>(`SELECT * FROM change_notes
        WHERE change_id = ? AND delivered_at IS NULL ORDER BY created_at, rowid`).all(changeId);
      return rows.map(toChangeNote);
    });
  }

  confirmNotes(attemptId: string): number {
    return this.withRetry(() => {
      const notes = this.db.query<{ id: string; change_id: string; actor: string }, [string, string]>(
        `UPDATE change_notes SET delivered_at = ? WHERE attempt_id = ? AND delivered_at IS NULL
         RETURNING id, change_id, actor`
      ).all(this.now(), attemptId);
      for (const note of notes) {
        const change = this.getChange(note.change_id);
        this.event(change.workstreamId, 'info',
          `nota ${note.id.slice(0, 8)} de ${note.actor} entregada (turno ${attemptId.slice(0, 8)})`, change.id);
      }
      return notes.length;
    });
  }

  // ---- claves de API -----------------------------------------------------

  createApiKey(name: string, scope: ApiKeyScope): { id: string; key: string } {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) {
      throw new StoreError('invalid_input', 'nombre de clave API inválido');
    }
    if (scope !== 'read' && scope !== 'decide') {
      throw new StoreError('invalid_input', 'ámbito de clave API inválido');
    }
    return this.withRetry(() => {
      if (this.db.query('SELECT 1 FROM api_keys WHERE name = ?').get(name)) {
        throw new StoreError('conflict', 'ya existe una clave API con ese nombre');
      }
      const { count } = this.db.query<{ count: number }, []>(
        'SELECT COUNT(*) AS count FROM api_keys WHERE revoked_at IS NULL',
      ).get()!;
      if (count >= 20) {
        throw new StoreError('limit_reached', 'ya hay 20 claves API activas');
      }
      const id = randomBytes(6).toString('hex');
      const secret = randomBytes(32).toString('base64url');
      const hash = createHash('sha256').update(secret).digest('hex');
      this.db.query(
        `INSERT INTO api_keys (id, name, scope, hash, created_at, created_by) VALUES (?,?,?,?,?,?)`,
      ).run(id, name, scope, hash, this.now(), process.env.FAB_ACTOR ?? userInfo().username);
      return { id, key: `fabk_${id}_${secret}` };
    });
  }

  listApiKeys(): ApiKeyMetadata[] {
    if (!this.hasApiKeysTable()) return [];
    return this.db.query<ApiKeyMetadata, []>(
      `SELECT id, name, scope, created_at AS createdAt, created_by AS createdBy, revoked_at AS revokedAt
       FROM api_keys ORDER BY created_at, name`,
    ).all();
  }

  revokeApiKey(idOrName: string): void {
    this.withRetry(() => {
      // Si un nombre coincide con el id de otra clave, el id tiene prioridad.
      const { changes } = this.db.query(
        `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?)
         WHERE id = (SELECT id FROM api_keys WHERE id = ? OR name = ? ORDER BY (id = ?) DESC LIMIT 1)`,
      ).run(this.now(), idOrName, idOrName, idOrName);
      if (changes === 0) throw new StoreError('not_found', 'clave API no encontrada');
    });
  }

  verifyApiKey(key: string): ApiKeyIdentity | null {
    const match = /^fabk_([a-f0-9]{12})_([A-Za-z0-9_-]{43})$/.exec(key);
    if (!match || !this.hasApiKeysTable()) return null;
    const [, id, secret] = match;
    const row = this.db.query<ApiKeyIdentity & { hash: string }, [string]>(
      'SELECT id, name, scope, hash FROM api_keys WHERE id = ? AND revoked_at IS NULL',
    ).get(id!);
    if (!row) return null;
    const stored = Buffer.from(row.hash);
    const candidate = Buffer.from(createHash('sha256').update(secret!).digest('hex'));
    if (stored.length !== candidate.length || !timingSafeEqual(stored, candidate)) return null;
    return { id: row.id, name: row.name, scope: row.scope };
  }

  private hasApiKeysTable(): boolean {
    // Un lector puede abrir una base anterior a esta tabla sin migrarla.
    return this.db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'api_keys'").get() !== null;
  }

  // ---- activities --------------------------------------------------------

  private insertActivity(
    workstreamId: string,
    changeId: string,
    parentId: string | null,
    kind: ActivityKind,
    status: ActivityStatus,
    reviewStatus: string | null,
    validator: ValidatorKind | null = null
  ): string {
    const id = randomUUID();
    const t = this.now();
    this.withRetry(() => {
      this.db
        .query(
          `INSERT INTO activities (id, workstream_id, change_id, parent_activity_id, kind, status, review_status,
           validator, created_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`
        )
        .run(id, workstreamId, changeId, parentId, kind, status, reviewStatus, validator, t, status === 'completed' ? t : null);
    });
    return id;
  }

  getActivity(id: string): Activity {
    const r = this.db.query('SELECT * FROM activities WHERE id = ?').get(id) as Row | null;
    if (!r) throw new StoreError('not_found', `activity ${id} not found`);
    return toActivity(r);
  }

  listActivities(filter: { workstream?: string; changeId?: string; status?: ActivityStatus } = {}): Activity[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.workstream) {
      where.push('workstream_id = ?');
      params.push(this.getWorkstream(filter.workstream).id);
    }
    if (filter.changeId) {
      where.push('change_id = ?');
      params.push(filter.changeId);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    const sql = `SELECT * FROM activities ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at`;
    return (this.db.query(sql).all(...params) as Row[]).map(toActivity);
  }

  /** Activities waiting on a human decision (the inbox). */
  inbox(workstream?: string): Activity[] {
    const acts = this.listActivities(workstream ? { workstream } : {});
    const latest = new Map<string, string>();
    for (const a of acts) if (a.status === 'blocked' || a.status === 'quarantined') latest.set(a.changeId, a.id);
    return acts.filter(a => a.reviewStatus === 'awaiting' || a.status === 'waiting_reply' ||
      (latest.get(a.changeId) === a.id && (this.getChange(a.changeId).status === 'blocked' || this.getChange(a.changeId).status === 'quarantined')));
  }

  /** Atomically claim the oldest pending activity of an active workstream (FIFO), with exclusion by change and lease. */
  claimActivity(workstream: string, workerId: string, ttlMs = LEASE_TTL_MS): Activity | null {
    const ws = this.getWorkstream(workstream);
    if (ws.state !== 'active') return null;
    return this.withRetry(() => {
      return this.db.transaction(() => {
        const r = this.db
          .query(
            `SELECT a.id, a.change_id FROM activities a
             JOIN changes c ON a.change_id = c.id
             WHERE a.workstream_id = ?
               AND a.status = 'pending'
               AND c.status NOT IN ('completed', 'failed', 'canceled', 'declined', 'blocked', 'quarantined')
               AND NOT EXISTS (
                 SELECT 1 FROM activities other
                 WHERE other.change_id = a.change_id
                   AND other.status IN ('in_progress', 'waiting_reply')
               )
             ORDER BY a.created_at, a.rowid LIMIT 1`
          )
          .get(ws.id) as { id: string; change_id: string } | null;
        if (!r) return null;
        const nowIso = this.now();
        const leaseExpires = new Date(this.clock().getTime() + ttlMs).toISOString();
        const res = this.db
          .query(
            `UPDATE activities
             SET status = 'in_progress', worker_id = ?, started_at = ?, lease_expires_at = ?
             WHERE id = ? AND status = 'pending'
               AND NOT EXISTS (
                 SELECT 1 FROM activities other
                 WHERE other.change_id = ? AND other.status IN ('in_progress', 'waiting_reply') AND other.id != ?
               )`
          )
          .run(workerId, nowIso, leaseExpires, r.id, r.change_id, r.id);
        if (res.changes !== 1) return null;
        const a = this.getActivity(r.id);
        if (!a.validator && a.kind !== 'gates') {
          this.setChangeStatus(a.changeId, 'in_progress');
        }
        this.event(ws.id, 'info', `${a.validator ? `validator ${a.validator}` : a.kind} claimed by ${workerId}`, a.changeId, a.id);
        return a;
      }).immediate();
    });
  }

  /** Extend an active activity lease held by workerId (heartbeat). Rejects if change is terminal. */
  heartbeat(activityId: string, workerId: string, ttlMs = LEASE_TTL_MS): void {
    this.withRetry(() => {
      const a = this.getActivity(activityId);
      const c = this.getChange(a.changeId);
      if (isTerminalChange(c.status)) {
        throw new StoreError('invalid_transition', `change ${c.id} is terminal (${c.status}); heartbeat rejected`);
      }
      const leaseExpires = new Date(this.clock().getTime() + ttlMs).toISOString();
      const res = this.db
        .query(
          `UPDATE activities SET lease_expires_at = ?
           WHERE id = ? AND status = 'in_progress' AND worker_id = ?`
        )
        .run(leaseExpires, activityId, workerId);
      if (res.changes !== 1) {
        throw new StoreError('conflict', `activity ${activityId} is not held by ${workerId} in_progress`);
      }
    });
  }

  /**
   * Request validation on an implemented change. Queues a pending change_review activity
   * for each requested validator (no duplicates if already pending or in progress).
   * The change remains in implemented status.
   */
  requestValidation(changeId: string, validators: ValidatorKind[]): Activity[] {
    for (const validator of validators) {
      if (!VALIDATOR_KINDS.includes(validator)) throw new StoreError('invalid_input', `unknown validator "${validator}"`);
    }
    const change = this.getChange(changeId);
    if (change.status !== 'implemented') {
      throw new StoreError('invalid_transition', `change ${changeId} is ${change.status}, not implemented`);
    }
    const ws = this.getWorkstream(change.workstreamId);
    if (ws.verify?.length) {
      return this.withRetry(() => this.db.transaction(() => {
        // A manual request cannot bypass a pending/failed gate or reuse evidence from another HEAD.
        const acts = this.listActivities({ changeId });
        const gate = acts.filter(a => a.kind === 'gates').at(-1);
        const head = gitEvidence(ws.repo, 'rev-parse', change.branch ?? 'HEAD');
        if (gate?.status === 'completed' && gate.reviewStatus === 'approved' && gate.verifiedHead === head) {
          return this.enqueueValidators(changeId, validators, head!);
        }
        if (gate && (gate.status === 'pending' || gate.status === 'in_progress')) return [];
        const id = this.insertActivity(ws.id, changeId, null, 'gates', 'pending', null);
        this.db.query('UPDATE activities SET requested_validators = ? WHERE id = ?').run(JSON.stringify(validators), id);
        return [this.getActivity(id)];
      }).immediate());
    }
    return this.enqueueValidators(changeId, validators);
  }

  private enqueueValidators(changeId: string, validators: ValidatorKind[], head?: string): Activity[] {
    const change = this.getChange(changeId);
    return this.withRetry(() => {
      return this.db.transaction(() => {
        const existing = this.listActivities({ changeId });
        const created: Activity[] = [];
        for (const v of validators) {
          if (!VALIDATOR_KINDS.includes(v)) {
            throw new StoreError('invalid_input', `unknown validator "${v}"`);
          }
          const alreadyQueued =
            existing.some((a) => a.validator === v && (a.status === 'pending' || a.status === 'in_progress')) ||
            created.some((a) => a.validator === v);
          if (alreadyQueued) continue;
          const id = this.insertActivity(change.workstreamId, change.id, null, 'change_review', 'pending', null, v);
          if (head) this.db.query('UPDATE activities SET verified_head = ? WHERE id = ?').run(head, id);
          this.event(change.workstreamId, 'info', `validation requested: ${v}`, change.id, id);
          created.push(this.getActivity(id));
        }
        return created;
      }).immediate();
    });
  }

  /**
   * Summarizes the latest validation results for a change.
   */
  validationSummary(changeId: string): ValidationSummary & { gatePassed?: boolean } {
    this.getChange(changeId);
    const acts = this.listActivities({ changeId }).filter((a) => a.validator !== null);
    const lastByValidator = new Map<ValidatorKind, Activity>();
    for (const a of acts) {
      if (a.validator) {
        lastByValidator.set(a.validator, a);
      }
    }
    const results: ValidationResult[] = [];
    for (const [v, a] of lastByValidator.entries()) {
      let verdict: ValidationVerdict | undefined = undefined;
      if (a.status === 'completed') {
        if (a.reviewStatus === 'approved') verdict = 'pass';
        else if (a.reviewStatus === 'declined') verdict = 'fail';
        else if (a.reviewStatus === 'commented') verdict = 'needs_human';
      }
      results.push({
        validator: v,
        activityId: a.id,
        verdict,
        ...(a.status === 'failed' || a.status === 'blocked' || a.status === 'quarantined' ? { failed: true } : {}),
        summary: a.reviewComment ?? '',
      });
    }
    const gate = this.listActivities({ changeId }).filter(a => a.kind === 'gates').at(-1);
    const pending = (gate?.status === 'pending' || gate?.status === 'in_progress') || Array.from(lastByValidator.values()).some(
      (a) => a.status === 'pending' || a.status === 'in_progress'
    );
    const c = this.getChange(changeId);
    const ws = this.getWorkstream(c.workstreamId);
    const gatePassed = ws.verify?.length ? gate?.status === 'completed' && gate.reviewStatus === 'approved' &&
      !!gate.verifiedHead && gate.verifiedHead === gitEvidence(ws.repo, 'rev-parse', c.branch ?? 'HEAD') : undefined;
    const passed = results.length > 0 && !pending && gatePassed !== false && results.every((r) => r.verdict === 'pass');
    return {
      changeId,
      results,
      passed,
      pending,
      ...(gatePassed !== undefined ? { gatePassed } : {}),
      quarantined: c.status === 'quarantined',
    };
  }

  /**
   * Record a worker's result. Only the claiming worker can complete an in-progress activity.
   * The workstream's approval gate alone decides whether an investigation waits for review.
   */
  completeActivity(
    activityId: string,
    workerId: string,
    result: string,
    reviewOpts?: { reviewStatus?: string; reviewComment?: string; verifiedHead?: string }
  ): Activity {
    return this.withRetry(() => {
      return this.db.transaction(() => {
        const a = this.getActivity(activityId);
        const c = this.getChange(a.changeId);
        if (isTerminalChange(c.status)) {
          throw new StoreError('invalid_transition', `change ${c.id} is terminal (${c.status}); activity completion rejected`);
        }
        const res = this.db
          .query(
            `UPDATE activities SET status = 'completed', result = ?, completed_at = ?, lease_expires_at = NULL, agent_pgid = NULL
             WHERE id = ? AND status = 'in_progress' AND worker_id = ?`
          )
          .run(result, this.now(), activityId, workerId);
        if (res.changes !== 1) throw new StoreError('conflict', `activity ${activityId} is not held by ${workerId}`);
        const ws = this.getWorkstream(a.workstreamId);
        if (a.kind === 'gates') {
          if (!reviewOpts?.verifiedHead || parseVerdict(result)?.verdict !== 'pass') {
            throw new StoreError('invalid_input', 'gates completion requires pass and verified HEAD');
          }
          this.db.query("UPDATE activities SET review_status = 'approved', verified_head = ? WHERE id = ?").run(reviewOpts.verifiedHead, a.id);
          const requested = this.db.query('SELECT requested_validators FROM activities WHERE id = ?').get(a.id) as { requested_validators: string | null };
          this.enqueueValidators(a.changeId, requested.requested_validators ? JSON.parse(requested.requested_validators) : [...VALIDATOR_KINDS], reviewOpts.verifiedHead);
          this.event(ws.id, 'info', `gates pass: ${reviewOpts.verifiedHead}`, a.changeId, a.id);
        } else if (a.validator) {
          // A validator change_review activity does NOT close the change; change stays implemented.
          let reviewStatus = reviewOpts?.reviewStatus;
          let reviewComment = reviewOpts?.reviewComment;
          if (!reviewStatus) {
            const parsed = parseVerdict(result);
            if (parsed) {
              reviewStatus = parsed.verdict === 'pass' ? 'approved' : parsed.verdict === 'fail' ? 'declined' : 'commented';
              reviewComment = parsed.summary;
            }
          }
          if (reviewStatus !== undefined) {
            this.db
              .query(`UPDATE activities SET review_status = ?, review_comment = ? WHERE id = ?`)
              .run(reviewStatus, reviewComment ?? null, activityId);
          }
          this.event(ws.id, 'info', `validator ${a.validator} completed: ${reviewStatus ?? 'no verdict'}`, a.changeId, a.id);
        } else if (a.kind === 'investigation') {
          if (ws.requireApproval) {
            this.db.query(`UPDATE activities SET review_status = 'awaiting' WHERE id = ?`).run(activityId);
            this.setChangeStatus(a.changeId, 'in_review');
            this.event(ws.id, 'info', 'investigation awaiting spec review', a.changeId, a.id);
          } else {
            this.insertActivity(ws.id, a.changeId, a.id, 'implementation', 'pending', null);
            this.setChangeStatus(a.changeId, 'pending');
          }
        } else if (a.kind === 'implementation') {
          this.setChangeStatus(a.changeId, 'implemented');
          this.event(ws.id, 'info', 'implementation done; change implemented', a.changeId, a.id);
          if (ws.verify?.length) this.insertActivity(ws.id, a.changeId, a.id, 'gates', 'pending', null);
        } else {
          this.setChangeStatus(a.changeId, 'completed');
        }
        writeManifest(this, a.changeId);
        return this.getActivity(activityId);
      }).immediate();
    });
  }

  /** A declared block stops automatic retries and retains the full reason for human action. */
  blockActivity(activityId: string, workerId: string, reason: string): Activity {
    return this.withRetry(() => {
      return this.db.transaction(() => {
        const a = this.getActivity(activityId);
        const res = this.db.query(`UPDATE activities SET status = 'blocked', error = ?, completed_at = ?, lease_expires_at = NULL, agent_pgid = NULL
          WHERE id = ? AND status = 'in_progress' AND worker_id = ?
          AND EXISTS (SELECT 1 FROM changes c WHERE c.id = activities.change_id
            AND c.status NOT IN ('completed','failed','canceled','declined','blocked','quarantined'))`).run(reason, this.now(), activityId, workerId);
        if (res.changes !== 1) throw new StoreError('conflict', `activity ${activityId} is not held by ${workerId}`);
        this.db.query(`UPDATE activities SET status = 'canceled', completed_at = ?
          WHERE change_id = ? AND status = 'pending'`).run(this.now(), a.changeId);
        if (a.kind === 'gates') this.db.query("UPDATE activities SET review_status = 'declined' WHERE id = ?").run(a.id);
        this.setChangeStatus(a.changeId, 'blocked');
        this.event(a.workstreamId, 'warning', `blocked: ${reason}`, a.changeId, a.id);
        return this.getActivity(activityId);
      }).immediate();
    });
  }

  /** A quarantined activity stops automatic retries, puts change in quarantine, and records threatmon report. */
  quarantineActivity(activityId: string, workerId: string, reason: string): Activity {
    return this.withRetry(() => {
      return this.db.transaction(() => {
        const a = this.getActivity(activityId);
        const res = this.db.query(`UPDATE activities SET status = 'quarantined', error = ?, completed_at = ?, lease_expires_at = NULL, agent_pgid = NULL
          WHERE id = ? AND status = 'in_progress' AND worker_id = ?
          AND EXISTS (SELECT 1 FROM changes c WHERE c.id = activities.change_id
            AND c.status NOT IN ('completed','failed','canceled','declined','blocked','quarantined'))`).run(reason, this.now(), activityId, workerId);
        if (res.changes !== 1) throw new StoreError('conflict', `activity ${activityId} is not held by ${workerId}`);
        this.db.query(`UPDATE activities SET status = 'canceled', completed_at = ?
          WHERE change_id = ? AND status = 'pending'`).run(this.now(), a.changeId);
        this.setChangeStatus(a.changeId, 'quarantined');
        this.event(a.workstreamId, 'warning', `quarantined: ${reason.slice(0, 500)}`, a.changeId, a.id);
        return this.getActivity(activityId);
      }).immediate();
    });
  }

  /** Record a worker failure; retry up to MAX_ACTIVITY_RETRIES before failing the change. */
  failActivity(activityId: string, workerId: string, error: string): Activity {
    return this.withRetry(() => {
      return this.db.transaction(() => {
        return this.recordActivityFailure(this.getActivity(activityId), workerId, error);
      }).immediate();
    });
  }

  /** Shared failure policy; callers hold an IMMEDIATE transaction (including orphan recovery). */
  private recordActivityFailure(a: Activity, workerId: string | null, error: string): Activity {
    const c = this.getChange(a.changeId);
    if (isTerminalChange(c.status)) {
      throw new StoreError('invalid_transition', `change ${c.id} is terminal (${c.status}); failActivity rejected`);
    }
    const retryCount = a.retryCount + 1;
    const retry = retryCount < MAX_ACTIVITY_RETRIES;
    const res = this.db
      .query(
        `UPDATE activities SET status = ?, error = ?, retry_count = ?, worker_id = NULL,
         started_at = NULL, completed_at = ?, lease_expires_at = NULL, agent_pgid = NULL WHERE id = ? AND status = 'in_progress' AND worker_id IS ?
         AND EXISTS (SELECT 1 FROM changes c WHERE c.id = activities.change_id
           AND c.status NOT IN ('completed','failed','canceled','declined','blocked','quarantined'))`
      )
      .run(retry ? 'pending' : 'failed', error, retryCount, retry ? null : this.now(), a.id, workerId);
    if (res.changes !== 1) throw new StoreError('conflict', `activity ${a.id} is not held by ${workerId}`);
    // Only an in-progress change goes back to pending: `gates` runs on an `implemented` change, which must stay closable.
    if (!a.validator && (!retry || c.status === 'in_progress')) {
      this.setChangeStatus(a.changeId, retry ? 'pending' : 'failed');
    }
    this.event(
      a.workstreamId,
      retry ? 'warning' : 'error',
      `${a.kind} ${retry ? `failed (retry ${retryCount}/${MAX_ACTIVITY_RETRIES})` : 'failed permanently'}: ${error.slice(0, 300)}`,
      a.changeId,
      a.id
    );
    return this.getActivity(a.id);
  }

  /**
   * Un turno vivo pasa a esperar a una persona (T16/T27). Cercado por el worker que lo tiene y por un change no terminal;
   * no cuenta como fallo ni consume reintentos, y libera el lease. El worktree y la rama quedan como están.
   */
  awaitHuman(activityId: string, workerId: string, q: { questionId: string; waitUntil: string }): Activity {
    return this.withRetry(() => {
      const res = this.db.query(`UPDATE activities SET status = 'waiting_reply', question_id = ?, wait_until = ?, worker_id = NULL,
        lease_expires_at = NULL, agent_pgid = NULL WHERE id = ? AND status = 'in_progress' AND worker_id = ?
        AND EXISTS (SELECT 1 FROM changes c WHERE c.id = activities.change_id
          AND c.status NOT IN ('completed','failed','canceled','declined','blocked','quarantined'))`)
        .run(q.questionId, q.waitUntil, activityId, workerId);
      if (res.changes !== 1) throw new StoreError('conflict', `activity ${activityId} is not held by ${workerId}`);
      const a = this.getActivity(activityId);
      this.event(a.workstreamId, 'info', `waiting for a human reply (question ${q.questionId})`, a.changeId, a.id);
      return a;
    });
  }

  /**
   * Llega la respuesta a la pregunta abierta: la activity vuelve a `pending` (T27). Condicionado al id de la pregunta, así una
   * respuesta duplicada, tardía (a una pregunta anterior) o a un change ya cerrado no reencola nada: devuelve false.
   * Va en la misma transacción que registra la respuesta (la llama `answerQuestion`, que la envuelve).
   */
  answerAwaiting(activityId: string, questionId: string): boolean {
    return this.withRetry(() => {
      const res = this.db.query(`UPDATE activities SET status = 'pending', question_id = NULL, wait_until = NULL
        WHERE id = ? AND status = 'waiting_reply' AND question_id = ?
        AND EXISTS (SELECT 1 FROM changes c WHERE c.id = activities.change_id
          AND c.status NOT IN ('completed','failed','canceled','declined','blocked','quarantined'))`).run(activityId, questionId);
      if (res.changes !== 1) return false;
      const a = this.getActivity(activityId);
      this.setChangeStatus(a.changeId, 'pending');
      this.event(a.workstreamId, 'info', `human reply received (question ${questionId}); re-queued`, a.changeId, a.id);
      return true;
    });
  }

  /**
   * Plazo de la espera (T31, H-16): las activities `waiting_reply` cuyo `wait_until` venció pasan a `blocked` con motivo y su
   * change a `blocked` (visible en el inbox; libera el worktree y el cupo de taskLimit al cerrarse). Devuelve (activity, pregunta).
   */
  expireWaiting(nowIso = this.now()): { activityId: string; questionId: string }[] {
    return this.withRetry(() => {
      const due = this.db.query(`SELECT id, question_id FROM activities WHERE status = 'waiting_reply' AND wait_until IS NOT NULL AND wait_until <= ?`).all(nowIso) as { id: string; question_id: string }[];
      for (const d of due) this.blockWaiting(d.id, `REPLY_TIMEOUT: sin respuesta a la pregunta ${d.question_id} antes de ${nowIso}`, nowIso);
      return due.map(d => ({ activityId: d.id, questionId: d.question_id }));
    });
  }

  /** M2: una persona abandona la espera de una activity `waiting_reply` (no quiere esperar más): queda `blocked`, lista para `fab retry`. */
  abandonWait(activityId: string): void {
    this.withRetry(() => {
      const a = this.getActivity(activityId);
      if (a.status !== 'waiting_reply') throw new StoreError('invalid_transition', `activity ${activityId} no espera respuesta`);
      this.blockWaiting(activityId, `REPLY_ABANDONED: espera de la pregunta ${a.questionId} abandonada por una persona`, this.now());
    });
  }

  private blockWaiting(activityId: string, reason: string, nowIso: string): void {
    this.db.query(`UPDATE activities SET status = 'blocked', error = ?, completed_at = ?, question_id = NULL, wait_until = NULL WHERE id = ? AND status = 'waiting_reply'`).run(reason, nowIso, activityId);
    const a = this.getActivity(activityId);
    this.setChangeStatus(a.changeId, 'blocked');
    this.event(a.workstreamId, 'warning', `blocked: ${reason}`, a.changeId, a.id);
  }

  /** Human decision on an activity in the inbox. */
  resolveReview(activityId: string, decision: ReviewDecision, comment = ''): Activity {
    if (decision === 'decline' && !comment.trim()) {
      throw new StoreError('invalid_input', 'decline exige --comment con un motivo');
    }
    return this.withRetry(() => {
      return this.db.transaction(() => {
        const a = this.getActivity(activityId);
        if (!REVIEWABLE_KINDS.some(kind => kind === a.kind)) {
          throw new StoreError('invalid_transition', `${a.kind} activities are not reviewable`);
        }
        const status = decision === 'approve' ? 'approved' : decision === 'decline' ? 'declined' : 'commented';
        const res = this.db
          .query(`UPDATE activities SET review_status = ?, review_comment = ? WHERE id = ? AND review_status = 'awaiting'`)
          .run(status, comment || null, activityId);
        if (res.changes !== 1) throw new StoreError('invalid_transition', `activity ${activityId} is not awaiting review`);
        const followUp = REVIEW_FOLLOW_UP[a.kind];
        if (!followUp) throw new StoreError('invalid_transition', `no follow-up for ${a.kind}`);
        if (decision === 'decline') {
          this.setChangeStatus(a.changeId, 'declined');
        } else {
          const next = decision === 'approve' ? followUp.approve : followUp.comment;
          if (next === 'change_review') {
            // Re-review of the change itself goes back to the inbox, not to a worker.
            this.insertActivity(a.workstreamId, a.changeId, a.id, next, 'completed', 'awaiting');
            this.setChangeStatus(a.changeId, 'in_review');
          } else {
            this.insertActivity(a.workstreamId, a.changeId, a.id, next, 'pending', null);
            this.setChangeStatus(a.changeId, 'pending');
          }
        }
        this.event(a.workstreamId, 'info', `${a.kind} ${status}${comment ? `: ${comment}` : ''}`, a.changeId, a.id);
        return this.getActivity(activityId);
      }).immediate();
    });
  }

  /** Close an implemented change after its branch was merged (or reject it). */
  closeChange(changeId: string, outcome: 'completed' | 'canceled'): Change {
    return this.withRetry(() => this.db.transaction(() => {
      const c = this.getChange(changeId);
      if (this.listActivities({ changeId }).some(a => a.status === 'in_progress' && a.workerId?.startsWith('merge:') &&
          (outcome === 'canceled' || a.workerId !== `merge:${process.pid}`))) {
        throw new StoreError('conflict', 'change tiene un merge en curso; reanuda fab merge primero');
      }
      if (outcome === 'completed' && c.status !== 'implemented') {
        throw new StoreError('invalid_transition', `change ${changeId} is ${c.status}, not implemented`);
      }
      this.setChangeStatus(changeId, outcome);
      this.event(c.workstreamId, 'info', `change ${outcome}`, changeId);
      return this.getChange(changeId);
    }).immediate());
  }

  /** Cambia el título; el evento conserva el anterior. Título de 1 a 200 caracteres. */
  renameChange(changeId: string, title: string): Change {
    const next = title.trim();
    if (!next || next.length > 200) throw new StoreError('invalid_input', 'el título debe tener entre 1 y 200 caracteres');
    return this.withRetry(() => this.db.transaction(() => {
      const c = this.getChange(changeId);
      if (c.title === next) return c;
      this.db.query('UPDATE changes SET title = ?, updated_at = ? WHERE id = ?').run(next, this.now(), changeId);
      this.event(c.workstreamId, 'info', `título cambiado: "${c.title}" -> "${next}"`, changeId);
      return this.getChange(changeId);
    }).immediate());
  }

  /** Human retry of the latest failed activity, preserving validator context and resetting its budget. */
  retryChange(changeId: string): Activity {
    return this.withRetry(() => {
      return this.db.transaction(() => {
        const c = this.getChange(changeId);
        if (c.status !== 'failed' && c.status !== 'implemented' && c.status !== 'blocked' && c.status !== 'quarantined') {
          throw new StoreError('invalid_transition', `change ${changeId} is ${c.status}, not failed, blocked, quarantined or implemented`);
        }
        const row = this.db
          .query(`SELECT * FROM activities WHERE change_id = ? AND status IN ('failed','blocked','quarantined')
                  ORDER BY created_at DESC, rowid DESC LIMIT 1`)
          .get(changeId) as Row | null;
        if (!row) throw new StoreError('not_found', `change ${changeId} has no failed activities`);
        const last = toActivity(row);
        if (c.status === 'implemented' && !last.validator) {
          throw new StoreError('invalid_transition', `implemented change ${changeId} can only retry a validator`);
        }
        if (last.validator) {
          const latest = this.db
            .query(`SELECT id FROM activities WHERE change_id = ? AND validator = ?
                    ORDER BY created_at DESC, rowid DESC LIMIT 1`)
            .get(changeId, last.validator) as { id: string };
          if (latest.id !== last.id) {
            throw new StoreError('invalid_transition', `validator ${last.validator} already retried`);
          }
        }
        const gateRetry = last.kind === 'gates' || (last.validator !== null && !!this.getWorkstream(c.workstreamId).verify?.length);
        if (gateRetry) this.db.query("UPDATE activities SET status = 'canceled', review_status = NULL WHERE change_id = ? AND validator IS NOT NULL").run(changeId);
        const id = this.insertActivity(c.workstreamId, changeId, last.parentActivityId, gateRetry ? 'implementation' : last.kind, 'pending', null, gateRetry ? null : last.validator);
        this.setChangeStatus(changeId, !gateRetry && last.validator ? 'implemented' : 'pending');
        this.event(c.workstreamId, 'info', `change retried (${last.kind})`, changeId, id);
        return this.getActivity(id);
      }).immediate();
    });
  }

  /** Registra con qué perfil y qué sha de fab corre la activity (va al run.json). */
  setActivityProvenance(activityId: string, profileDigest: string, fabSha: string | null, run?: { agent: string; model: string | null; runner?: string | null }): void {
    this.withRetry(() => {
      if (run) this.db.query('UPDATE activities SET profile_digest = ?, fab_sha = ?, agent = ?, model = ?, runner = ? WHERE id = ?').run(profileDigest, fabSha, run.agent, run.model, run.runner ?? null, activityId);
      else this.db.query('UPDATE activities SET profile_digest = ?, fab_sha = ? WHERE id = ?').run(profileDigest, fabSha, activityId);
    });
  }

  /** Record the spawned agent's process group id for cleanup on ungraceful worker termination. */
  setActivityAgentPgid(activityId: string, pgid: number | null): void {
    this.withRetry(() => {
      this.db.query('UPDATE activities SET agent_pgid = ? WHERE id = ?').run(pgid, activityId);
    });
  }

  /** Recover activities held by dead workers (lease expired): requeued, or failed once retries run out. Returns how many. */
  requeueOrphans(workstream: string, nowIso = this.now(), keep?: (activityId: string) => boolean): number {
    const ws = this.getWorkstream(workstream);
    return this.withRetry(() => {
      return this.db.transaction(() => {
        const expired = this.db
          .query(
            `SELECT a.id, a.change_id, a.kind, a.validator, a.agent_pgid, c.status AS change_status
             FROM activities a
             JOIN changes c ON a.change_id = c.id
             WHERE a.workstream_id = ?
               AND a.status = 'in_progress'
               AND (a.lease_expires_at IS NULL OR a.lease_expires_at <= ?)`
          )
          .all(ws.id, nowIso) as Array<{
            id: string;
            change_id: string;
            kind: ActivityKind;
            validator: ValidatorKind | null;
            agent_pgid: number | null;
            change_status: string;
          }>;

        let count = 0;
        for (const act of expired) {
          if (act.agent_pgid) {
            // shortcut: asume pools en la misma máquina, revisar si hay pools remotos
            let isAlive = false;
            try {
              process.kill(-act.agent_pgid, 0);
              isAlive = true;
            } catch {
              isAlive = false;
            }
            if (isAlive) {
              try {
                process.kill(-act.agent_pgid, 'SIGKILL');
              } catch {}
              continue;
            }
          }

          // M2: un huérfano con un report guardado por aplicar no es un fallo: vuelve a pending sin gastar un reintento y el
          // siguiente claim lo aplica. El error queda marcado como de orfandad para que no se confunda con un fallo con motivo.
          if (keep?.(act.id) && !isTerminalChange(this.getChange(act.change_id).status)) {
            this.db.query(`UPDATE activities SET status = 'pending', error = 'lease expired (orphaned activity; report pending)', worker_id = NULL, started_at = NULL,
              lease_expires_at = NULL, agent_pgid = NULL WHERE id = ? AND status = 'in_progress'`).run(act.id);
            continue;
          }
          if (isTerminalChange(this.getChange(act.change_id).status)) {
            this.db
              .query(
                `UPDATE activities SET status = 'canceled', worker_id = NULL, lease_expires_at = NULL, agent_pgid = NULL
                 WHERE id = ? AND status = 'in_progress'`
              )
              .run(act.id);
          } else {
            const claimed = this.getActivity(act.id);
            this.recordActivityFailure(claimed, claimed.workerId, 'lease expired (orphaned activity)');
            count++;
          }
        }
        return count;
      }).immediate();
    });
  }

  /** Release an activity held by workerId when worker aborts or cancels. */
  releaseActivity(activityId: string, workerId: string): void {
    this.withRetry(() => {
      this.db
        .query(
          `UPDATE activities SET status = 'canceled', worker_id = NULL, lease_expires_at = NULL, agent_pgid = NULL
           WHERE id = ? AND worker_id = ? AND status = 'in_progress'`
        )
        .run(activityId, workerId);
    });
    writeManifest(this, this.getActivity(activityId).changeId);
  }

  /** Re-queue an activity back to pending without incrementing its retry count (e.g. on infrastructure lock). */
  requeueActivity(activityId: string, workerId: string): void {
    this.withRetry(() => {
      this.db
        .query(
          `UPDATE activities
           SET status = 'pending', worker_id = NULL, started_at = NULL, lease_expires_at = NULL, agent_pgid = NULL
           WHERE id = ? AND worker_id = ? AND status = 'in_progress'`
        )
        .run(activityId, workerId);
    });
  }

  /** Wait for all active workers on a change to release their activity before worktree removal. */
  async waitForRelease(changeId: string, timeoutMs = 30_000, pollMs = 50): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const inProgress = this.db
        .query(`SELECT id, lease_expires_at FROM activities WHERE change_id = ? AND status = 'in_progress'`)
        .all(changeId) as Array<{ id: string; lease_expires_at: string | null }>;
      if (inProgress.length === 0) return;

      const nowIso = this.now();
      const allExpired = inProgress.every((a) => a.lease_expires_at !== null && a.lease_expires_at <= nowIso);
      if (allExpired) {
        this.withRetry(() => {
          this.db
            .query(
              `UPDATE activities SET status = 'canceled', worker_id = NULL, lease_expires_at = NULL, agent_pgid = NULL
               WHERE change_id = ? AND status = 'in_progress'`
            )
            .run(changeId);
        });
        return;
      }

      await Bun.sleep(pollMs);
    }
    throw new StoreError('conflict', `timeout waiting for change ${changeId} activities to release`);
  }

  isTerminalChange(status: string): boolean {
    return isTerminalChange(status);
  }

  /** Context a worker needs: the change, its signals and every earlier result in the chain. */
  activityContext(activityId: string): { activity: Activity; change: Change; history: Activity[] } {
    const activity = this.getActivity(activityId);
    const change = this.getChange(activity.changeId);
    const history = this.listActivities({ changeId: change.id }).filter(
      (h) => h.id !== activity.id && (h.result !== null || h.reviewComment !== null)
    );
    return { activity, change, history };
  }

  isTerminal(status: ActivityStatus): boolean {
    return status === 'blocked' || status === 'quarantined' || (TERMINAL_ACTIVITY as readonly string[]).includes(status);
  }

  // ---- events ------------------------------------------------------------

  event(workstreamId: string, severity: 'info' | 'warning' | 'error', message: string, changeId?: string, activityId?: string): void {
    this.withRetry(() => {
      this.db
        .query('INSERT INTO events (workstream_id, change_id, activity_id, severity, message, created_at, actor) VALUES (?,?,?,?,?,?,?)')
        .run(workstreamId, changeId ?? null, activityId ?? null, severity, message, this.now(), process.env.FAB_ACTOR ?? userInfo().username);
    });
    if (changeId && (isTerminalChange(this.getChange(changeId).status) ||
        activityId && this.isTerminal(this.getActivity(activityId).status))) writeManifest(this, changeId);
  }

  listEvents(workstream: string, limit = 50, changeId?: string): Row[] {
    const ws = this.getWorkstream(workstream);
    const changeFilter = changeId === undefined ? '' : ' AND change_id = ?';
    const params = changeId === undefined ? [ws.id, limit] : [ws.id, changeId, limit];
    return (this.db.query(`SELECT * FROM events WHERE workstream_id = ?${changeFilter} ORDER BY id DESC LIMIT ?`)
      .all(...params) as Row[]).reverse();
  }

  /** Cohorte acotada para métricas; solo SELECT, sin cargar cuerpos de eventos. */
  metricsCohort(workstream: string | undefined, since: string | null, until: string, limit: number): { changes: ChangeAttribution[]; total: number } {
    const wsId = workstream ? this.getWorkstream(workstream).id : null;
    const where = '(? IS NULL OR workstream_id = ?) AND (? IS NULL OR julianday(created_at) >= julianday(?)) AND julianday(created_at) <= julianday(?)';
    const params = [wsId, wsId, since, since, until];
    const total = (this.db.query(`SELECT COUNT(*) AS n FROM changes WHERE ${where}`).get(...params) as { n: number }).n;
    const rows = this.db.query(`SELECT * FROM changes WHERE ${where} ORDER BY julianday(created_at) DESC, id LIMIT ?`)
      .all(...params, limit) as Row[];
    const { source, creator } = this.resolveChangeAttribution(rows.map(r => r.id as string));
    const changes: ChangeAttribution[] = rows.map(r => ({ ...toChange(r), source: source.get(r.id as string) ?? null, creator: creator.get(r.id as string) ?? null }));
    return { changes, total };
  }

  /** Registra el PR abierto como evento de change. La URL debe comenzar por https:// y tener host válido. */
  recordPrOpened(changeId: string, url: string): void {
    let cleanUrl: string;
    try {
      const trimmed = url.trim();
      if (trimmed.includes('\\')) throw new Error();
      const u = new URL(trimmed);
      if (u.protocol !== 'https:' || !u.hostname || trimmed.startsWith('https:///') || trimmed.startsWith('HTTPS:///')) throw new Error();
      cleanUrl = u.href;
    } catch {
      throw new StoreError('invalid_input', 'la URL del PR debe comenzar por https:// y tener un host válido');
    }
    const c = this.getChange(changeId);
    const existing = this.db.query("SELECT 1 FROM events WHERE change_id = ? AND message = ?").get(changeId, `pr_opened: ${cleanUrl}`);
    if (existing) return;
    this.event(c.workstreamId, 'info', `pr_opened: ${cleanUrl}`, changeId);
  }

  /** Obtiene la URL del PR asociada a un change, si existe y es https://. Solo lectura local. */
  getChangePrUrl(changeId: string): string | null {
    const ev = this.db.query("SELECT message FROM events WHERE change_id = ? AND message GLOB 'pr_opened: https://*' ORDER BY id DESC LIMIT 1").get(changeId) as { message: string } | null;
    if (ev) {
      const match = /^pr_opened:\s*(https:\/\/\S+)/i.exec(ev.message);
      if (match && match[1]) return match[1];
    }
    const hasLinks = this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'change_links'").get();
    if (hasLinks) {
      const row = this.db.query('SELECT pr_json FROM change_links WHERE change_id = ?').get(changeId) as { pr_json: string | null } | null;
      if (row?.pr_json) {
        try {
          const pr = JSON.parse(row.pr_json) as { url?: string };
          if (pr.url && typeof pr.url === 'string' && pr.url.startsWith('https://')) return pr.url;
        } catch {}
      }
    }
    return null;
  }

  /** Intervenciones humanas agrupadas por día para series temporales. */
  metricsDailyInterventions(changeIds: string[], until: string): Map<string, number> {
    if (!changeIds.length) return new Map();
    const review = "(message = 'change_review approved' OR message LIKE 'change_review approved:%' OR message = 'change_review commented' OR message LIKE 'change_review commented:%' OR message = 'change_review declined' OR message LIKE 'change_review declined:%' OR message = 'investigation approved' OR message LIKE 'investigation approved:%' OR message = 'investigation commented' OR message LIKE 'investigation commented:%' OR message = 'investigation declined' OR message LIKE 'investigation declined:%')";
    const rows = this.db.query(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
      FROM events WHERE change_id IN (${changeIds.map(() => '?').join(',')}) AND julianday(created_at) <= julianday(?)
      AND (${review} OR message GLOB 'human reply received (question *); re-queued' OR message GLOB 'change retried (*)')
      AND (message NOT GLOB '* failed permanently:*' OR activity_id NOT IN (SELECT id FROM activities WHERE validator IS NOT NULL))
      GROUP BY substr(created_at, 1, 10)`).all(...changeIds, until) as Array<{ day: string; n: number }>;
    return new Map(rows.map(r => [r.day, r.n]));
  }

  /** PRs abiertos y fusionados agrupados por día para series temporales. */
  metricsDailyPrs(changeIds: string[], until: string): { opened: Map<string, number>; merged: Map<string, number> } {
    if (!changeIds.length) return { opened: new Map(), merged: new Map() };
    const prOpen = "message GLOB 'pr_opened: https://*'";
    const merge = "message = 'merge_completed'";
    const openedRows = this.db.query(`SELECT substr(created_at, 1, 10) AS day, COUNT(DISTINCT change_id) AS n
      FROM events WHERE change_id IN (${changeIds.map(() => '?').join(',')}) AND julianday(created_at) <= julianday(?)
      AND ${prOpen} GROUP BY substr(created_at, 1, 10)`).all(...changeIds, until) as Array<{ day: string; n: number }>;
    const mergedRows = this.db.query(`SELECT substr(created_at, 1, 10) AS day, COUNT(DISTINCT change_id) AS n
      FROM events WHERE change_id IN (${changeIds.map(() => '?').join(',')}) AND julianday(created_at) <= julianday(?)
      AND ${merge} GROUP BY substr(created_at, 1, 10)`).all(...changeIds, until) as Array<{ day: string; n: number }>;
    return { opened: new Map(openedRows.map(r => [r.day, r.n])), merged: new Map(mergedRows.map(r => [r.day, r.n])) };
  }

  /** Hitos y acciones humanas registrados. No interpreta texto de issues; ignora el agotamiento de reintentos de un validador (su cuarentena, bloqueo y reintento humano sí cuentan). */
  metricsEvents(changeIds: string[], until: string): Array<{ changeId: string; reviewAt: string | null; decisionAt: string | null; terminalAt: string | null; reviews: number; answers: number; retries: number; prOpenedAt: string | null; mergedAt: string | null }> {
    if (!changeIds.length) return [];
    const review = "(message = 'change_review approved' OR message LIKE 'change_review approved:%' OR message = 'change_review commented' OR message LIKE 'change_review commented:%' OR message = 'change_review declined' OR message LIKE 'change_review declined:%' OR message = 'investigation approved' OR message LIKE 'investigation approved:%' OR message = 'investigation commented' OR message LIKE 'investigation commented:%' OR message = 'investigation declined' OR message LIKE 'investigation declined:%')";
    const terminal = "(message IN ('change completed','change canceled','change_review declined','investigation declined') OR message LIKE 'change_review declined:%' OR message LIKE 'investigation declined:%' OR message LIKE 'blocked:%' OR message LIKE 'quarantined:%' OR message GLOB 'change_review failed permanently:*' OR message GLOB 'investigation failed permanently:*' OR message GLOB 'implementation failed permanently:*' OR message GLOB 'steward failed permanently:*' OR message GLOB 'gates failed permanently:*')";
    const prOpen = "message GLOB 'pr_opened: https://*'";
    const merge = "message = 'merge_completed'";
    return this.db.query(`SELECT change_id AS changeId,
      MIN(CASE WHEN message = 'investigation awaiting spec review' THEN created_at END) AS reviewAt,
      MIN(CASE WHEN ${review} THEN created_at END) AS decisionAt,
      MIN(CASE WHEN ${terminal} THEN created_at END) AS terminalAt,
      MIN(CASE WHEN ${prOpen} THEN created_at END) AS prOpenedAt,
      MIN(CASE WHEN ${merge} THEN created_at END) AS mergedAt,
      SUM(CASE WHEN ${review} THEN 1 ELSE 0 END) AS reviews,
      SUM(CASE WHEN message GLOB 'human reply received (question *); re-queued' THEN 1 ELSE 0 END) AS answers,
      SUM(CASE WHEN message GLOB 'change retried (*)' THEN 1 ELSE 0 END) AS retries
      FROM events WHERE change_id IN (${changeIds.map(() => '?').join(',')}) AND julianday(created_at) <= julianday(?)
      AND (message NOT GLOB '* failed permanently:*' OR activity_id NOT IN (SELECT id FROM activities WHERE validator IS NOT NULL)) GROUP BY change_id`)
      .all(...changeIds, until) as ReturnType<Store['metricsEvents']>;
  }

  /** Cuenta sin cargar cuerpos; acompaña la página acotada de la timeline. */
  countEvents(workstream: string, changeId: string): number {
    const ws = this.getWorkstream(workstream);
    return (this.db.query('SELECT COUNT(*) AS n FROM events WHERE workstream_id = ? AND change_id = ?')
      .get(ws.id, changeId) as { n: number }).n;
  }

  /** ¿Existen las tablas de webhooks (adm_hook_deliveries)? */
  hasWebhookTables(): boolean {
    return this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'adm_hook_deliveries'").get() !== null;
  }

  /** Lista de entregas de webhooks (metadatos, nunca cuerpos ni secretos). */
  listWebhookDeliveries(limit = 100): WebhookDelivery[] {
    if (!this.hasWebhookTables()) return [];
    return this.db.query('SELECT delivery_id, event, received_at, bytes, result FROM adm_hook_deliveries ORDER BY rowid DESC LIMIT ?')
      .all(limit) as WebhookDelivery[];
  }

  /** Estado del receptor de webhooks y recuento de entregas recientes. */
  webhookReceptorStatus(): WebhookReceptorStatus {
    const hasTable = this.hasWebhookTables();
    if (!hasTable) {
      return {
        hasTable: false,
        active: false,
        endpoint: '/github',
        totalDeliveries: 0,
        lastDeliveryAt: null,
        last24h: [],
        rejectedCount: 0,
        lastRejectedAt: null,
      };
    }
    let active = false;
    const hasLock = this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'adm_lock'").get() !== null;
    if (hasLock) {
      const lock = this.db.query('SELECT heartbeat_at FROM adm_lock WHERE id = 1').get() as { heartbeat_at: number } | null;
      if (lock && this.clock().getTime() - lock.heartbeat_at <= 30_000) active = true;
    }
    const total = (this.db.query('SELECT COUNT(*) AS count FROM adm_hook_deliveries').get() as { count: number }).count;
    const last = (this.db.query('SELECT MAX(received_at) AS at FROM adm_hook_deliveries').get() as { at: string | null }).at;
    const since24h = new Date(this.clock().getTime() - 86_400_000).toISOString();
    const last24h = this.db.query('SELECT result, COUNT(*) AS count FROM adm_hook_deliveries WHERE received_at >= ? GROUP BY result ORDER BY result')
      .all(since24h) as { result: string; count: number }[];

    let rejectedCount = 0;
    let lastRejectedAt: string | null = null;
    const hasRejections = this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'adm_hook_rejections'").get() !== null;
    if (hasRejections) {
      try {
        const rej = this.db.query('SELECT count, last_rejected_at FROM adm_hook_rejections WHERE id = 1').get() as { count: number; last_rejected_at: string } | null;
        if (rej) {
          rejectedCount = rej.count;
          lastRejectedAt = rej.last_rejected_at;
        }
      } catch {
        rejectedCount = 0;
        lastRejectedAt = null;
      }
    }

    return {
      hasTable: true,
      active,
      endpoint: '/github',
      totalDeliveries: total,
      lastDeliveryAt: last,
      last24h,
      rejectedCount,
      lastRejectedAt,
    };
  }
}
