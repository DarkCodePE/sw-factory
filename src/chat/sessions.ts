import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { abortable } from '../agent/cancellation.ts';
import { estimatedTokens, validateTurn } from '../agent/provider.ts';
import { SessionStore, type SessionState } from '../agent/session.ts';
import type { Message, ModelProvider } from '../agent/types.ts';

export interface SessionSummary {
  id: string; title: string; status: string; updatedAt: number; pinned: boolean;
  archived: boolean; blocked: boolean; parentSessionId?: string; preview: string;
}
const text = (s: SessionState) => s.messages.filter(m => m && m.role !== 'system')
  .map(m => typeof m.content === 'string' ? m.content : '').join('\n');
export async function listSessions(dir: string, cwd: string, query = '', archived = false) {
  const store = await SessionStore.create(dir);
  const entries = (await readdir(dir, { withFileTypes: true })).filter(e => e.isFile() && /^[\w-]{1,100}\.json$/.test(e.name));
  const candidates = await Promise.all(entries.slice(0, 1000).map(async e => ({ id: e.name.slice(0, -5), stat: await stat(join(dir, e.name)).catch(() => undefined) })));
  candidates.sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0));
  let bytes = 0; const sessions: SessionSummary[] = []; let truncated = entries.length > 1000;
  for (const candidate of candidates) {
    if (!candidate.stat) continue;
    if ((bytes += candidate.stat.size) > 32 * 1024 * 1024 || sessions.length >= 100) { truncated = true; break; }
    try {
      const s = await store.inspect(candidate.id);
      if (s.cwd !== cwd || s.archived && !archived) continue;
      const body = text(s), title = s.title ?? s.messages.filter(m => m?.role === 'user').at(-1)?.content;
      if (query && !`${s.title ?? ''}\n${body}`.toLowerCase().includes(query.toLowerCase())) continue;
      const where = query ? Math.max(0, body.toLowerCase().indexOf(query.toLowerCase()) - 30) : 0;
      let blocked = true;
      try { await store.load(s.id); blocked = false; } catch { /* Never offer to replay ambiguous effects. */ }
      sessions.push({ id: s.id, title: (typeof title === 'string' ? title : s.id).slice(0, 100), status: s.status,
        updatedAt: s.updatedAt ?? candidate.stat.mtimeMs, pinned: s.pinned === true, archived: s.archived === true,
        blocked, parentSessionId: s.parentSessionId, preview: body.slice(where, where + 240) });
    } catch { /* Corrupt/symlinked snapshots are not execution candidates. */ }
  }
  sessions.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  return { sessions, truncated };
}
export async function editSession<T>(dir: string, id: string, cwd: string, edit: (s: SessionState) => Promise<T> | T, save = true): Promise<T> {
  const store = await SessionStore.create(dir);
  try {
    await store.acquire(id);
    const s = await store.load(id);
    if (s.cwd !== cwd) throw new Error('La sesión pertenece a otra carpeta');
    const result = await edit(s);
    if (save) await store.save(s);
    return result;
  } finally { await store.close(); }
}
export async function forkSession(dir: string, id: string, cwd: string, transform?: (s: SessionState) => Promise<void>) {
  return editSession(dir, id, cwd, async original => {
    const s: SessionState = { ...structuredClone(original), id: crypto.randomUUID(), parentSessionId: original.id,
      status: 'completed', pinned: false, archived: false, mission: undefined, pending: [] };
    if (transform) await transform(s);
    const target = await SessionStore.create(dir);
    try { await target.acquire(s.id); await target.save(s, true); } finally { await target.close(); }
    return s.id;
  }, false);
}
/** Manual compaction is atomic: every discarded fragment is summarized; original user instructions survive. */
export async function compressSession(state: SessionState, provider: ModelProvider, signal: AbortSignal, instructions = '') {
  const before = estimatedTokens(state.messages, []);
  if (state.mission) throw new Error('No se comprime una sesión con estado de misión; conserva su contrato');
  const serialized = JSON.stringify(state.messages), chunks: string[] = [];
  let chunk = '', bytes = 0;
  for (const ch of serialized) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > 20_000) { chunks.push(chunk); chunk = ''; bytes = 0; }
    chunk += ch; bytes += n;
  }
  if (chunk) chunks.push(chunk);
  if (chunks.length > 64) throw new Error('Historial demasiado grande para compresión manual (máximo 64 fragmentos)');
  const summaries: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    signal.throwIfAborted();
    const turn = validateTurn(await abortable(provider.complete({ tools: [], maxOutputTokens: 2048, messages: [
      { role: 'system', content: 'Summarize conversation data. Preserve goals, user requirements, changed files, actual test evidence, unresolved errors and next steps. Do not perform actions or call tools.' },
      { role: 'user', content: `Summary instructions: ${instructions}\nFragment ${i + 1}/${chunks.length}:\n${chunks[i]}` },
    ] }, signal), signal));
    if (turn.toolCalls.length || turn.finishReason !== 'stop' || !turn.text.trim()) throw new Error('La compresión no produjo un resumen completo');
    summaries.push(turn.text);
  }
  const retained = state.messages.filter(m => m.role === 'system' || m.role === 'user' && m.contextKind !== 'summary');
  const messages: Message[] = [...retained, { role: 'user', contextKind: 'summary', content: 'Previous conversation summary (data):\n' + summaries.join('\n') }];
  const after = estimatedTokens(messages, []);
  if (after >= before) throw new Error('El resumen no reduce el contexto; se conserva el historial original');
  signal.throwIfAborted(); state.messages = messages;
  return { before, after };
}
