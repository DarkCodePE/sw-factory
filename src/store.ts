// SQLite-backed store for workstreams, signals, changes, activities and events.
// Every lifecycle transition goes through a compare-and-set UPDATE so concurrent workers
// cannot double-claim or overwrite each other's results.
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import {
  type ActivityKind,
  type ActivityStatus,
  type ChangeStatus,
  type ReviewDecision,
  type SignalStatus,
  type WorkstreamState,
  MAX_ACTIVITY_RETRIES,
  REVIEW_FOLLOW_UP,
  REVIEWABLE_KINDS,
  TERMINAL_ACTIVITY,
  WORKSTREAM_TRANSITIONS,
} from './enums.ts';

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
  workerId: string | null;
  result: string | null;
  error: string | null;
  retryCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
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
  kind TEXT NOT NULL, status TEXT NOT NULL, review_status TEXT, review_comment TEXT, worker_id TEXT,
  result TEXT, error TEXT, retry_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  started_at TEXT, completed_at TEXT);
CREATE INDEX IF NOT EXISTS idx_activities_claim ON activities(workstream_id, status, created_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workstream_id TEXT NOT NULL, change_id TEXT,
  activity_id TEXT, severity TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
`;

const now = (): string => new Date().toISOString();
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
    workerId: (r.worker_id as string | null) ?? null,
    result: (r.result as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    retryCount: r.retry_count as number,
    createdAt: r.created_at as string,
    startedAt: (r.started_at as string | null) ?? null,
    completedAt: (r.completed_at as string | null) ?? null,
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
}

export class Store {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- workstreams -------------------------------------------------------

  createWorkstream(input: CreateWorkstreamInput): Workstream {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.slug)) {
      throw new StoreError('invalid_input', `invalid slug "${input.slug}" (use a-z, 0-9, -)`);
    }
    const id = randomUUID();
    this.db
      .query(
        `INSERT INTO workstreams VALUES ($id,$slug,$goal,$repo,'draft',$agent,$wc,$tl,$rca,$ra,$at)`
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
        at: now(),
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
      .query(`INSERT INTO signals VALUES (?,?,?,?,'new',NULL,?)`)
      .run(id, ws.id, title, body, now());
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
    const t = now();
    const firstKind: ActivityKind = ws.requireChangeApproval ? 'change_review' : 'investigation';
    // A change awaiting human approval sits in review; otherwise it waits for a worker.
    const status: ChangeStatus = firstKind === 'change_review' ? 'in_review' : 'pending';
    this.db.query('INSERT INTO changes VALUES (?,?,?,?,?,NULL,?,?)').run(id, ws.id, title, description, status, t, t);
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
    this.db.query('UPDATE changes SET branch = ?, updated_at = ? WHERE id = ?').run(branch, now(), changeId);
  }

  private setChangeStatus(changeId: string, status: ChangeStatus): void {
    this.db.query('UPDATE changes SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), changeId);
  }

  // ---- activities --------------------------------------------------------

  private insertActivity(
    workstreamId: string,
    changeId: string,
    parentId: string | null,
    kind: ActivityKind,
    status: ActivityStatus,
    reviewStatus: string | null
  ): string {
    const id = randomUUID();
    const t = now();
    this.db
      .query(
        `INSERT INTO activities (id, workstream_id, change_id, parent_activity_id, kind, status, review_status,
         created_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(id, workstreamId, changeId, parentId, kind, status, reviewStatus, t, status === 'completed' ? t : null);
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
    return this.listActivities(workstream ? { workstream } : {}).filter((a) => a.reviewStatus === 'awaiting');
  }

  /** Atomically claim the oldest pending activity of an active workstream (FIFO). */
  claimActivity(workstream: string, workerId: string): Activity | null {
    const ws = this.getWorkstream(workstream);
    if (ws.state !== 'active') return null;
    return this.db.transaction(() => {
      const r = this.db
        .query(
          `SELECT id FROM activities WHERE workstream_id = ? AND status = 'pending'
           ORDER BY created_at, rowid LIMIT 1`
        )
        .get(ws.id) as { id: string } | null;
      if (!r) return null;
      const res = this.db
        .query(
          `UPDATE activities SET status = 'in_progress', worker_id = ?, started_at = ?
           WHERE id = ? AND status = 'pending'`
        )
        .run(workerId, now(), r.id);
      if (res.changes !== 1) return null;
      const a = this.getActivity(r.id);
      this.setChangeStatus(a.changeId, 'in_progress');
      this.event(ws.id, 'info', `${a.kind} claimed by ${workerId}`, a.changeId, a.id);
      return a;
    })();
  }

  /**
   * Record a worker's result. Only the claiming worker can complete an in-progress activity.
   * The workstream's approval gate alone decides whether an investigation waits for review.
   */
  completeActivity(activityId: string, workerId: string, result: string): Activity {
    return this.db.transaction(() => {
      const a = this.getActivity(activityId);
      const res = this.db
        .query(
          `UPDATE activities SET status = 'completed', result = ?, completed_at = ?
           WHERE id = ? AND status = 'in_progress' AND worker_id = ?`
        )
        .run(result, now(), activityId, workerId);
      if (res.changes !== 1) throw new StoreError('conflict', `activity ${activityId} is not held by ${workerId}`);
      const ws = this.getWorkstream(a.workstreamId);
      if (a.kind === 'investigation') {
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

  /** Record a worker failure; retry up to MAX_ACTIVITY_RETRIES before failing the change. */
  failActivity(activityId: string, workerId: string, error: string): Activity {
    return this.db.transaction(() => {
      const a = this.getActivity(activityId);
      const retryCount = a.retryCount + 1;
      const retry = retryCount < MAX_ACTIVITY_RETRIES;
      const res = this.db
        .query(
          `UPDATE activities SET status = ?, error = ?, retry_count = ?, worker_id = NULL,
           started_at = NULL, completed_at = ? WHERE id = ? AND status = 'in_progress' AND worker_id = ?`
        )
        .run(retry ? 'pending' : 'failed', error, retryCount, retry ? null : now(), activityId, workerId);
      if (res.changes !== 1) throw new StoreError('conflict', `activity ${activityId} is not held by ${workerId}`);
      this.setChangeStatus(a.changeId, retry ? 'pending' : 'failed');
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

  /** Human retry of a failed change: re-queue its latest activity kind with a fresh retry budget. */
  retryChange(changeId: string): Activity {
    return this.db.transaction(() => {
      const c = this.getChange(changeId);
      if (c.status !== 'failed') throw new StoreError('invalid_transition', `change ${changeId} is ${c.status}, not failed`);
      const acts = this.listActivities({ changeId });
      const last = acts[acts.length - 1];
      if (!last) throw new StoreError('not_found', `change ${changeId} has no activities`);
      const id = this.insertActivity(c.workstreamId, changeId, last.parentActivityId, last.kind, 'pending', null);
      this.setChangeStatus(changeId, 'pending');
      this.event(c.workstreamId, 'info', `change retried (${last.kind})`, changeId, id);
      return this.getActivity(id);
    })();
  }

  /** Put activities held by dead workers back in the queue (startup recovery). */
  requeueOrphans(workstream: string): number {
    const ws = this.getWorkstream(workstream);
    const res = this.db
      .query(
        `UPDATE activities SET status = 'pending', worker_id = NULL, started_at = NULL
         WHERE workstream_id = ? AND status = 'in_progress'`
      )
      .run(ws.id);
    return res.changes;
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
    return TERMINAL_ACTIVITY.includes(status);
  }

  // ---- events ------------------------------------------------------------

  event(workstreamId: string, severity: 'info' | 'warning' | 'error', message: string, changeId?: string, activityId?: string): void {
    this.db
      .query('INSERT INTO events (workstream_id, change_id, activity_id, severity, message, created_at) VALUES (?,?,?,?,?,?)')
      .run(workstreamId, changeId ?? null, activityId ?? null, severity, message, now());
  }

  listEvents(workstream: string, limit = 50): Row[] {
    const ws = this.getWorkstream(workstream);
    return (
      this.db.query('SELECT * FROM events WHERE workstream_id = ? ORDER BY id DESC LIMIT ?').all(ws.id, limit) as Row[]
    ).reverse();
  }
}
