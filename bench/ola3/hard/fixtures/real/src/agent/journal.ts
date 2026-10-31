import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SessionState } from './session.ts';

export interface JournalRecord {
  seq: number; at: number; pid: number;
  type: 'session_start' | 'turn_start' | 'tool_start' | 'tool_end' | 'turn_end' | 'session_end';
  toolCallId?: string; name?: string; effect?: string; ok?: boolean;
}
export async function syncDirectory(path: string) { const f = await open(path, 'r'); try { await f.sync(); } finally { await f.close(); } }
/** Only committed records are append-only. A torn final record is removed before appending. */
export class Journal {
  private records: JournalRecord[] = [];
  private queue = Promise.resolve();
  private bytes = 0;
  private constructor(private file: Awaited<ReturnType<typeof open>>) {}
  static async open(path: string) {
    const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('Invalid or oversized session journal');
      const journal = new Journal(file), data = await file.readFile(), lines = data.toString('utf8').split('\n');
      let good = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!; if (!line && i === lines.length - 1) break;
        try {
          const r = JSON.parse(line) as JournalRecord;
          if (!r || !Number.isSafeInteger(r.seq) || r.seq !== journal.records.length + 1 || !Number.isFinite(r.at) ||
              !Number.isSafeInteger(r.pid) || r.pid < 1 || !['session_start', 'turn_start', 'tool_start', 'tool_end', 'turn_end', 'session_end'].includes(r.type) ||
              ['toolCallId', 'name', 'effect'].some(k => (r as any)[k] !== undefined && typeof (r as any)[k] !== 'string')) throw new Error('Invalid journal record');
          journal.records.push(r); good += Buffer.byteLength(line) + (i < lines.length - 1 ? 1 : 0);
        } catch {
          if (lines.slice(i + 1).some(s => s.trim())) throw new Error('Corrupt session journal before final record');
          await file.truncate(good); await file.sync(); break;
        }
      }
      if (good && data[good - 1] !== 10 && (await file.stat()).size === good) { await file.writeFile('\n'); await file.sync(); }
      journal.bytes = (await file.stat()).size;
      await syncDirectory(dirname(path)); return journal;
    } catch (error) { await file.close(); throw error; }
  }
  get entries(): readonly JournalRecord[] { return this.records; }
  append(type: JournalRecord['type'], fields: Pick<JournalRecord, 'toolCallId' | 'name' | 'effect' | 'ok'> = {}) {
    const job = this.queue.then(async () => {
      const r: JournalRecord = { ...fields, type, seq: this.records.length + 1, at: Date.now(), pid: process.pid };
      if (r.seq > 100000) throw new Error('Session journal record limit reached');
      const line = JSON.stringify(r) + '\n', size = Buffer.byteLength(line);
      if (size > 16384 || this.bytes + size > 64 * 1024 * 1024) throw new Error('Session journal size limit reached');
      await this.file.writeFile(line); await this.file.sync(); this.bytes += size; this.records.push(r);
    });
    this.queue = job; return job;
  }
  async close() { try { await this.queue; } finally { await this.file.close(); } }
}

export function reconcile(state: SessionState, records: readonly JournalRecord[]) {
  const starts = new Map<string, JournalRecord>(), ended = new Set<string>();
  for (const r of records) {
    if (r.type === 'tool_start' && r.toolCallId) { starts.set(r.toolCallId, r); ended.delete(r.toolCallId); }
    if (r.type === 'tool_end' && r.toolCallId) ended.add(r.toolCallId);
  }
  const uncertain = [...starts.values()].filter(r => !ended.has(r.toolCallId!) && r.effect !== 'read').map(r => ({ toolCallId: r.toolCallId!, name: r.name ?? 'unknown' }));
  const pending = new Set(state.pending);
  let changed = false;
  for (let index = 0; index < state.messages.length; index++) {
    const message = state.messages[index]!;
    if (message.role !== 'assistant') continue;
    // Tool IDs may repeat across turns. Only results belonging to this batch resolve it.
    const resolved = new Set<string | undefined>();
    for (let next = index + 1; state.messages[next]?.role === 'tool'; next++) resolved.add(state.messages[next]!.tool_call_id);
    const retained = [];
    for (const call of message.tool_calls ?? []) {
      if (resolved.has(call.id)) { retained.push(call); continue; }
      if (!pending.has(call.id)) throw new Error('Unresolved saved tool call missing pending ownership');
      const r = starts.get(call.id); changed = true;
      if (!r || r.effect === 'read') continue;
      retained.push(call);
      state.messages.push({ role: 'tool', tool_call_id: call.id,
        content: ended.has(call.id) ? 'interrupted; tool finished but result unavailable, verify before repeating' : 'interrupted; effect uncertain, verify before repeating' });
      resolved.add(call.id);
    }
    if (message.tool_calls) {
      if (retained.length) message.tool_calls = retained;
      else { delete message.tool_calls; if (message.content === null) message.content = 'Interrupted read-only or unstarted calls discarded; not replayed.'; }
    }
  }
  if (uncertain.length && (changed || state.status === 'running')) {
    state.messages.push({ role: 'user', content: 'Interrupted effects (data; inspect before retrying, no automatic replay): ' + JSON.stringify(uncertain) }); changed = true;
  }
  if (changed) { state.pending = []; state.status = 'failed'; }
  return { changed, uncertain };
}
