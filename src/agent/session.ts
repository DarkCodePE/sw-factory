import { constants } from 'node:fs';
import { Journal, reconcile, syncDirectory } from './journal.ts';
import { link, mkdir, open, readFile, rename, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Message } from './types.ts';

export interface SessionState {
  version: 1;
  id: string;
  cwd: string;
  provider: string;
  messages: Message[];
  pending: string[];
  status: 'running' | 'completed' | 'failed';
  turns: number;
  tags: string[];
  title?: string;
  archived?: boolean;
  pinned?: boolean;
  parentSessionId?: string;
  updatedAt?: number;
  todos?: string | unknown[];
  mission?: import('./mission-contract.ts').MissionState;
  /** Output only: process handles never survive a session boundary. */
  backgroundScripts?: import('./script-runs.ts').PersistedScriptRun[];
  backgroundTasks?: Array<{
    taskId: string;
    pid?: number;
    command: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    exitCode?: number | null;
  }>;
}
export class SessionStore {
  private lock?: Awaited<ReturnType<typeof open>>;
  private lockPath?: string;
  private ownedId?: string;
  journal?: Journal;
  recoveredCrash = false;
  reconciled?: { uncertain: Array<{ toolCallId: string; name: string }> };
  private constructor(private readonly dir?: string) {}
  static async create(dir?: string) {
    const store = new SessionStore(dir ? resolve(dir) : undefined);
    if (store.dir) await mkdir(store.dir, { recursive: true, mode: 0o700 });
    return store;
  }
  private path(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid agent session ID');
    return join(this.dir!, id + '.json');
  }
  async acquire(id: string) {
    if (!this.dir) return;
    if (this.lock) throw new Error('Session store already owns a lock');
    const path = this.path(id) + '.lock', guardPath = path + '.recover';
    const guard = await open(guardPath, 'wx', 0o600).catch(() => { throw new Error('Session recovery is locked; inspect its interrupted recovery owner'); });
    try {
      await guard.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() })); await guard.sync();
      const create = () => open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { this.lock = await create(); }
      catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        const old = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let identity: Awaited<ReturnType<typeof old.stat>>;
        try {
          identity = await old.stat(); if (!identity.isFile() || identity.size > 1024) throw new Error('Invalid session lock');
          let owner: any; try { owner = JSON.parse(await old.readFile('utf8')); } catch { throw new Error('Invalid session lock; reconcile its interrupted owner manually'); }
          if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !Number.isFinite(owner.startedAt)) throw new Error('Invalid session lock');
          try { process.kill(owner.pid, 0); throw new Error('Agent session is locked; reconcile its interrupted owner before resuming'); }
          catch (e: any) { if (e.code !== 'ESRCH') throw e; }
        } finally { await old.close(); }
        const check = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { const current = await check.stat(); if (current.ino !== identity.ino || current.dev !== identity.dev) throw new Error('Session lock changed during recovery'); }
        finally { await check.close(); }
        await unlink(path); this.lock = await create(); this.recoveredCrash = true;
      }
      this.lockPath = path; this.ownedId = id;
      try {
        await this.lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() })); await this.lock.sync(); await syncDirectory(this.dir);
        this.journal = await Journal.open(this.path(id).replace(/\.json$/, '.journal.jsonl'));
      } catch (error) { await this.close(); throw error; }
    } finally { await guard.close(); await unlink(guardPath); }
  }
  /** Read metadata/history for local browsing. This does NOT authorize resuming effects. */
  async inspect(id: string): Promise<SessionState> {
    if (!this.dir) throw new Error('Session persistence must be configured to resume');
    const file = this.path(id);
    if (await realpath(file) !== file) throw new Error('Session symlinks are not accepted');
    const stat = await Bun.file(file).stat();
    if (stat.size > 32 * 1024 * 1024) throw new Error('Agent session exceeds size limit');
    let s: SessionState;
    try { s = JSON.parse(await readFile(file, 'utf8')); } catch { throw new Error('Invalid agent session JSON'); }
    if (!s || s.version !== 1 || s.id !== id || typeof s.cwd !== 'string' || typeof s.provider !== 'string' ||
        !Array.isArray(s.messages) || !Array.isArray(s.pending) || !Array.isArray(s.tags) ||
        !Number.isSafeInteger(s.turns) || s.turns < 0 ||
        (s.backgroundTasks !== undefined && !Array.isArray(s.backgroundTasks)) ||
        (s.backgroundScripts !== undefined && !Array.isArray(s.backgroundScripts))) throw new Error('Invalid agent session schema');
    return s;
  }
  async load(id: string): Promise<SessionState> {
    const s = await this.inspect(id);
    if (this.recoveredCrash) await this.reconcileInterrupted(id, s);
    const waiting = new Set<string>();
    for (const m of s.messages) {
      if (!m || !['system', 'user', 'assistant', 'tool'].includes(m.role) ||
          !(m.content === null || typeof m.content === 'string' || Array.isArray(m.content))) throw new Error('Invalid saved message');
      if (m.role === 'assistant') {
        if (waiting.size) throw new Error('Unresolved saved tool calls');
        for (const c of m.tool_calls ?? []) {
          if (!c?.id || waiting.has(c.id) || !c.function || typeof c.function.name !== 'string' ||
              typeof c.function.arguments !== 'string') throw new Error('Invalid saved tool call');
          waiting.add(c.id);
        }
      } else if (m.role === 'tool') {
        if (!m.tool_call_id || !waiting.delete(m.tool_call_id)) throw new Error('Orphan saved tool result');
      } else if (waiting.size) throw new Error('Unresolved saved tool calls');
    }
    if (waiting.size || s.pending.length) throw new Error('Interrupted tool execution requires reconciliation; tools will not be replayed');
    return s;
  }
  /** Caller must own this session, and prove the previous invocation drained or died. */
  async reconcileInterrupted(id: string, existing?: SessionState) {
    if (id !== this.ownedId || !this.journal?.entries.some(r => r.type === 'session_start')) return;
    const s = existing ?? await this.inspect(id), result = reconcile(s, this.journal.entries);
    if (result.changed) { await this.save(s); this.reconciled = { uncertain: result.uncertain }; }
  }
  async save(state: SessionState, createOnly = false) {
    if (!this.dir) return;
    state.updatedAt = Date.now();
    const target = this.path(state.id), temp = target + '.' + crypto.randomUUID() + '.tmp';
    const data = JSON.stringify(state);
    if (Buffer.byteLength(data) > 32 * 1024 * 1024) throw new Error('Agent session exceeds size limit');
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    try {
      if (createOnly) { await link(temp, target); await unlink(temp); }
      else await rename(temp, target);
      await syncDirectory(this.dir);
    } catch (e) { await unlink(temp).catch(() => {}); throw e; }
  }
  async close() {
    try { if (this.journal) { const journal = this.journal; this.journal = undefined; await journal.close(); } }
    finally {
      if (this.lock) {
        const lock = this.lock; this.lock = undefined;
        try {
          const held = await lock.stat(), current = await open(this.lockPath!, constants.O_RDONLY | constants.O_NOFOLLOW);
          try { const st = await current.stat(); if (st.ino === held.ino && st.dev === held.dev) await unlink(this.lockPath!); }
          finally { await current.close(); }
        } finally { await lock.close(); }
      }
    }
  }
}
