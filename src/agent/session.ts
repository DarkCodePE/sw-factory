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
}
export class SessionStore {
  private lock?: Awaited<ReturnType<typeof open>>;
  private lockPath?: string;
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
    this.lockPath = this.path(id) + '.lock';
    this.lock = await open(this.lockPath, 'wx', 0o600).catch(() => {
      throw new Error('Agent session is locked; reconcile its interrupted owner before resuming');
    });
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
        !Number.isSafeInteger(s.turns) || s.turns < 0) throw new Error('Invalid agent session schema');
    return s;
  }
  async load(id: string): Promise<SessionState> {
    const s = await this.inspect(id);
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
    } catch (e) { await unlink(temp).catch(() => {}); throw e; }
  }
  async close() {
    if (this.lock) { await this.lock.close(); await unlink(this.lockPath!).catch(() => {}); this.lock = undefined; }
  }
}
