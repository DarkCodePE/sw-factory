// SQLite-backed store for workstreams, signals, changes, activities and events.
// Every lifecycle transition goes through a compare-and-set UPDATE so concurrent workers
// cannot double-claim or overwrite each other's results.
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';

import {
  type ActivityKind,
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
import { parseVerdict } from './validators/verdict.ts';

// Local extensions keep this task within the store ownership boundary.
export type ActivityStatus = BaseActivityStatus | 'blocked';
export type ChangeStatus = BaseChangeStatus | 'blocked';

export const LEASE_TTL_MS = process.env.FABRICA_LEASE_TTL_MS ? Number(process.env.FABRICA_LEASE_TTL_MS) : 90_000;
export const HEARTBEAT_INTERVAL_MS = process.env.FABRICA_HEARTBEAT_MS ? Number(process.env.FABRICA_HEARTBEAT_MS) : 30_000;

export const TERMINAL_CHANGE_STATUSES: readonly string[] = [
  'completed',
  'failed',
  'canceled',
  'declined',
  'blocked',
];

export function isTerminalChange(status: string): boolean {
  return TERMINAL_CHANGE_STATUSES.includes(status);
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
}

export interface Signal {
  id: string;
  workstreamId: string;
  title: string;
  body: string;
  status: SignalStatus;
  changeId: string | null;
  createdAt: string;
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
  workerId: string | null;
  result: string | null;
  error: string | null;
  retryCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  leaseExpiresAt: string | null;
  agentPgid: number | null;
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
CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY, workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL, branch TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
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
    createdAt: r.created_at as string,
  };
}

function toSignal(r: Row): Signal {
  return {
    id: r.id as string,
    workstreamId: r.workstream_id as string,
    title: r.title as string,
    body: r.body as string,
    status: r.status as SignalStatus,
    changeId: (r.change_id as string | null) ?? null,
    createdAt: r.created_at as string,
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
}

export interface StoreOptions {
  clock?: () => Date;
}

export class Store {
  readonly db: Database;
  readonly clock: () => Date;

  constructor(path: string, options?: StoreOptions) {
    this.clock = options?.clock ?? (() => new Date());
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  now(): string {
    return this.clock().toISOString();
  }

  private migrate(): void {
    this.addColumn('activities', 'validator', 'TEXT');
    this.addColumn('events', 'actor', 'TEXT');
    this.addColumn('workstreams', 'protected_paths', 'TEXT');
    this.addColumn('changes', 'base_sha', 'TEXT');
    this.addColumn('changes', 'protected_baseline', 'TEXT');
    this.addColumn('activities', 'lease_expires_at', 'TEXT');
    this.addColumn('activities', 'agent_pgid', 'INTEGER');
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
    this.db.close();
  }

  // ---- workstreams -------------------------------------------------------

  createWorkstream(input: CreateWorkstreamInput): Workstream {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.slug)) {
      throw new StoreError('invalid_input', `invalid slug "${input.slug}" (use a-z, 0-9, -)`);
    }
    const additions = input.protectedPaths ?? [];
    validateProtectedPatterns(additions);
    if (input.protectedPaths?.length === 0 && !input.protectNone) {
      throw new StoreError('invalid_input', 'vaciar protected_paths exige --protect-none');
    }
    const protectedPaths = input.protectNone ? additions : [...new Set([...DEFAULT_PROTECTED_PATHS, ...additions])];
    const id = randomUUID();
    this.db
      .query(
        `INSERT INTO workstreams (id, slug, goal, repo, state, agent, worker_concurrency,
         task_limit, require_change_approval, require_approval, created_at, protected_paths)
         VALUES ($id,$slug,$goal,$repo,'draft',$agent,$wc,$tl,$rca,$ra,$at,$protected)`
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
      });
    this.event(id, 'info', `workstream ${input.slug} created (draft)`);
    return this.getWorkstream(id);
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
    const res = this.db
      .query('UPDATE workstreams SET state = ? WHERE id = ? AND state = ?')
      .run(next, ws.id, ws.state);
    if (res.changes !== 1) throw new StoreError('conflict', `workstream ${ws.slug} changed concurrently`);
    this.event(ws.id, 'info', `workstream ${ws.state} -> ${next}`);
    return this.getWorkstream(ws.id);
  }

  // ---- signals -----------------------------------------------------------

  addSignal(workstream: string, title: string, body: string): Signal {
    const ws = this.getWorkstream(workstream);
    const id = randomUUID();
    this.db
      .query(`INSERT INTO signals (id, workstream_id, title, body, status, change_id, created_at)
              VALUES (?,?,?,?,'new',NULL,?)`)
      .run(id, ws.id, title, body, this.now());
    return toSignal(this.db.query('SELECT * FROM signals WHERE id = ?').get(id) as Row);
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
    })();
  }

  ignoreSignal(signalId: string, status: 'ignored' | 'duplicate' = 'ignored'): void {
    const res = this.db.query(`UPDATE signals SET status = ? WHERE id = ? AND status = 'new'`).run(status, signalId);
    if (res.changes !== 1) throw new StoreError('invalid_transition', `signal ${signalId} is not new`);
  }

  // ---- changes -----------------------------------------------------------

  createChange(workstream: string, title: string, description: string): Change {
    const ws = this.getWorkstream(workstream);
    const open = this.db
      .query(
        `SELECT COUNT(*) AS n FROM changes WHERE workstream_id = ?
         AND status NOT IN ('completed','failed','canceled','declined')`
      )
      .get(ws.id) as { n: number };
    if (open.n >= ws.taskLimit) {
      throw new StoreError('limit_reached', `workstream ${ws.slug} reached task limit ${ws.taskLimit}`);
    }
    const id = randomUUID();
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

  setChangeBranch(changeId: string, branch: string): void {
    this.db.query('UPDATE changes SET branch = ?, updated_at = ? WHERE id = ?').run(branch, this.now(), changeId);
  }

  /** Persist once, before the first worker runs; retries never move the base. */
  setChangeBase(changeId: string, baseSha: string): void {
    this.db.query('UPDATE changes SET base_sha = ? WHERE id = ? AND base_sha IS NULL').run(baseSha, changeId);
  }

  /** Rebase only the explicitly reviewed paths, invalidate old verdicts and retry atomically. */
  allowGate(changeId: string, snapshot: GateSnapshot, comment: string): Activity {
    if (!comment.trim() || !Object.keys(snapshot).length) throw new StoreError('invalid_input', 'gate allow exige rutas y --comment con motivo');
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
    })();
  }

  private setChangeStatus(changeId: string, status: ChangeStatus): void {
    this.db.query('UPDATE changes SET status = ?, updated_at = ? WHERE id = ?').run(status, this.now(), changeId);
    // Claims skip terminal changes, so pending work left behind would never run and keep `--once` from going idle.
    if (isTerminalChange(status)) {
      this.db.query(`UPDATE activities SET status = 'canceled', completed_at = ? WHERE change_id = ? AND status = 'pending'`)
        .run(this.now(), changeId);
    }
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
    this.db
      .query(
        `INSERT INTO activities (id, workstream_id, change_id, parent_activity_id, kind, status, review_status,
         validator, created_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(id, workstreamId, changeId, parentId, kind, status, reviewStatus, validator, t, status === 'completed' ? t : null);
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
    for (const a of acts) if (a.status === 'blocked') latest.set(a.changeId, a.id);
    return acts.filter(a => a.reviewStatus === 'awaiting' ||
      (latest.get(a.changeId) === a.id && this.getChange(a.changeId).status === 'blocked'));
  }

  /** Atomically claim the oldest pending activity of an active workstream (FIFO), with exclusion by change and lease. */
  claimActivity(workstream: string, workerId: string, ttlMs = LEASE_TTL_MS): Activity | null {
    const ws = this.getWorkstream(workstream);
    if (ws.state !== 'active') return null;
    return this.db.transaction(() => {
      const r = this.db
        .query(
          `SELECT a.id, a.change_id FROM activities a
           JOIN changes c ON a.change_id = c.id
           WHERE a.workstream_id = ?
             AND a.status = 'pending'
             AND c.status NOT IN ('completed', 'failed', 'canceled', 'declined', 'blocked')
             AND NOT EXISTS (
               SELECT 1 FROM activities other
               WHERE other.change_id = a.change_id
                 AND other.status = 'in_progress'
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
               WHERE other.change_id = ? AND other.status = 'in_progress' AND other.id != ?
             )`
        )
        .run(workerId, nowIso, leaseExpires, r.id, r.change_id, r.id);
      if (res.changes !== 1) return null;
      const a = this.getActivity(r.id);
      if (!a.validator) {
        this.setChangeStatus(a.changeId, 'in_progress');
      }
      this.event(ws.id, 'info', `${a.validator ? `validator ${a.validator}` : a.kind} claimed by ${workerId}`, a.changeId, a.id);
      return a;
    }).immediate();
  }

  /** Extend an active activity lease held by workerId (heartbeat). Rejects if change is terminal. */
  heartbeat(activityId: string, workerId: string, ttlMs = LEASE_TTL_MS): void {
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
  }

  /**
   * Request validation on an implemented change. Queues a pending change_review activity
   * for each requested validator (no duplicates if already pending or in progress).
   * The change remains in implemented status.
   */
  requestValidation(changeId: string, validators: ValidatorKind[]): Activity[] {
    const change = this.getChange(changeId);
    if (change.status !== 'implemented') {
      throw new StoreError('invalid_transition', `change ${changeId} is ${change.status}, not implemented`);
    }
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
        this.event(change.workstreamId, 'info', `validation requested: ${v}`, change.id, id);
        created.push(this.getActivity(id));
      }
      return created;
    })();
  }

  /**
   * Summarizes the latest validation results for a change.
   */
  validationSummary(changeId: string): ValidationSummary {
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
        ...(a.status === 'failed' || a.status === 'blocked' ? { failed: true } : {}),
        summary: a.reviewComment ?? '',
      });
    }
    const pending = Array.from(lastByValidator.values()).some(
      (a) => a.status === 'pending' || a.status === 'in_progress'
    );
    const passed = results.length > 0 && !pending && results.every((r) => r.verdict === 'pass');
    return {
      changeId,
      results,
      passed,
      pending,
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
    reviewOpts?: { reviewStatus?: string; reviewComment?: string }
  ): Activity {
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
      if (a.validator) {
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
      } else {
        this.setChangeStatus(a.changeId, 'completed');
      }
      return this.getActivity(activityId);
    })();
  }

  /** A declared block stops automatic retries and retains the full reason for human action. */
  blockActivity(activityId: string, workerId: string, reason: string): Activity {
    return this.db.transaction(() => {
      const a = this.getActivity(activityId);
      const res = this.db.query(`UPDATE activities SET status = 'blocked', error = ?, completed_at = ?, lease_expires_at = NULL, agent_pgid = NULL
        WHERE id = ? AND status = 'in_progress' AND worker_id = ?
        AND EXISTS (SELECT 1 FROM changes c WHERE c.id = activities.change_id
          AND c.status NOT IN ('completed','failed','canceled','declined','blocked'))`).run(reason, this.now(), activityId, workerId);
      if (res.changes !== 1) throw new StoreError('conflict', `activity ${activityId} is not held by ${workerId}`);
      this.db.query(`UPDATE activities SET status = 'canceled', completed_at = ?
        WHERE change_id = ? AND status = 'pending'`).run(this.now(), a.changeId);
      this.setChangeStatus(a.changeId, 'blocked');
      this.event(a.workstreamId, 'warning', `blocked: ${reason}`, a.changeId, a.id);
      return this.getActivity(activityId);
    })();
  }

  /** Record a worker failure; retry up to MAX_ACTIVITY_RETRIES before failing the change. */
  failActivity(activityId: string, workerId: string, error: string): Activity {
    return this.db.transaction(() => {
      const a = this.getActivity(activityId);
      const c = this.getChange(a.changeId);
      if (isTerminalChange(c.status)) {
        throw new StoreError('invalid_transition', `change ${c.id} is terminal (${c.status}); failActivity rejected`);
      }
      const retryCount = a.retryCount + 1;
      const retry = retryCount < MAX_ACTIVITY_RETRIES;
      const res = this.db
        .query(
          `UPDATE activities SET status = ?, error = ?, retry_count = ?, worker_id = NULL,
           started_at = NULL, completed_at = ?, lease_expires_at = NULL, agent_pgid = NULL WHERE id = ? AND status = 'in_progress' AND worker_id = ?
           AND EXISTS (SELECT 1 FROM changes c WHERE c.id = activities.change_id
             AND c.status NOT IN ('completed','failed','canceled','declined','blocked'))`
        )
        .run(retry ? 'pending' : 'failed', error, retryCount, retry ? null : this.now(), activityId, workerId);
      if (res.changes !== 1) throw new StoreError('conflict', `activity ${activityId} is not held by ${workerId}`);
      if (!a.validator) {
        this.setChangeStatus(a.changeId, retry ? 'pending' : 'failed');
      }
      this.event(
        a.workstreamId,
        retry ? 'warning' : 'error',
        `${a.kind} ${retry ? `failed (retry ${retryCount}/${MAX_ACTIVITY_RETRIES})` : 'failed permanently'}: ${error.slice(0, 300)}`,
        a.changeId,
        a.id
      );
      return this.getActivity(activityId);
    })();
  }

  /** Human decision on an activity in the inbox. */
  resolveReview(activityId: string, decision: ReviewDecision, comment = ''): Activity {
    if (decision === 'decline' && !comment.trim()) {
      throw new StoreError('invalid_input', 'decline exige --comment con un motivo');
    }
    return this.db.transaction(() => {
      const a = this.getActivity(activityId);
      if (!REVIEWABLE_KINDS.includes(a.kind)) {
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
    })();
  }

  /** Close an implemented change after its branch was merged (or reject it). */
  closeChange(changeId: string, outcome: 'completed' | 'canceled'): Change {
    const c = this.getChange(changeId);
    if (outcome === 'completed' && c.status !== 'implemented') {
      throw new StoreError('invalid_transition', `change ${changeId} is ${c.status}, not implemented`);
    }
    this.setChangeStatus(changeId, outcome);
    this.event(c.workstreamId, 'info', `change ${outcome}`, changeId);
    return this.getChange(changeId);
  }

  /** Human retry of the latest failed activity, preserving validator context and resetting its budget. */
  retryChange(changeId: string): Activity {
    return this.db.transaction(() => {
      const c = this.getChange(changeId);
      if (c.status !== 'failed' && c.status !== 'implemented' && c.status !== 'blocked') {
        throw new StoreError('invalid_transition', `change ${changeId} is ${c.status}, not failed, blocked or implemented`);
      }
      const row = this.db
        .query(`SELECT * FROM activities WHERE change_id = ? AND status IN ('failed','blocked')
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
      const id = this.insertActivity(c.workstreamId, changeId, last.parentActivityId, last.kind, 'pending', null, last.validator);
      this.setChangeStatus(changeId, last.validator ? 'implemented' : 'pending');
      this.event(c.workstreamId, 'info', `change retried (${last.kind})`, changeId, id);
      return this.getActivity(id);
    })();
  }

  /** Record the spawned agent's process group id for cleanup on ungraceful worker termination. */
  setActivityAgentPgid(activityId: string, pgid: number | null): void {
    this.db.query('UPDATE activities SET agent_pgid = ? WHERE id = ?').run(pgid, activityId);
  }

  /** Put activities held by dead workers back in the queue (lease expired). */
  requeueOrphans(workstream: string, nowIso = this.now()): number {
    const ws = this.getWorkstream(workstream);
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

        if (isTerminalChange(act.change_status)) {
          this.db
            .query(
              `UPDATE activities SET status = 'canceled', worker_id = NULL, lease_expires_at = NULL, agent_pgid = NULL
               WHERE id = ? AND status = 'in_progress'`
            )
            .run(act.id);
        } else {
          const res = this.db
            .query(
              `UPDATE activities
               SET status = 'pending', worker_id = NULL, started_at = NULL, lease_expires_at = NULL, agent_pgid = NULL
               WHERE id = ? AND status = 'in_progress'`
            )
            .run(act.id);
          if (res.changes === 1) {
            count++;
            if (!act.validator && act.change_status === 'in_progress') {
              this.setChangeStatus(act.change_id, 'pending');
            }
            this.event(
              ws.id,
              'warning',
              `orphaned activity ${act.id} (${act.kind}) requeued (lease expired)`,
              act.change_id,
              act.id
            );
          }
        }
      }
      return count;
    }).immediate();
  }

  /** Release an activity held by workerId when worker aborts or cancels. */
  releaseActivity(activityId: string, workerId: string): void {
    this.db
      .query(
        `UPDATE activities SET status = 'canceled', worker_id = NULL, lease_expires_at = NULL, agent_pgid = NULL
         WHERE id = ? AND worker_id = ? AND status = 'in_progress'`
      )
      .run(activityId, workerId);
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
        this.db
          .query(
            `UPDATE activities SET status = 'canceled', worker_id = NULL, lease_expires_at = NULL, agent_pgid = NULL
             WHERE change_id = ? AND status = 'in_progress'`
          )
          .run(changeId);
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
    return status === 'blocked' || TERMINAL_ACTIVITY.includes(status);
  }

  // ---- events ------------------------------------------------------------

  event(workstreamId: string, severity: 'info' | 'warning' | 'error', message: string, changeId?: string, activityId?: string): void {
    this.db
      .query('INSERT INTO events (workstream_id, change_id, activity_id, severity, message, created_at, actor) VALUES (?,?,?,?,?,?,?)')
      .run(workstreamId, changeId ?? null, activityId ?? null, severity, message, this.now(), process.env.FAB_ACTOR ?? userInfo().username);
  }

  listEvents(workstream: string, limit = 50): Row[] {
    const ws = this.getWorkstream(workstream);
    return (
      this.db.query('SELECT * FROM events WHERE workstream_id = ? ORDER BY id DESC LIMIT ?').all(ws.id, limit) as Row[]
    ).reverse();
  }
}
