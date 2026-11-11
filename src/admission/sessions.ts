// Sesiones vivas (T17, H-02). Una fila por (change, tipo de activity, generación), escrita antes de lanzar el proceso.
// La clave NO es la activity: retryChange crea otra activity y la sesión no debe perderse. Cambiar de backend, de cwd o
// de modelo no reanuda: es una sesión perdida (T18), nunca una sesión nueva en silencio.
import { randomUUID } from 'node:crypto';
import { MAX_ACTIVITY_RETRIES } from '../enums.ts';
import { SessionNotFoundError } from '../live/contract.ts';
import { buildWorkerPrompt, type WorkerTemplates } from '../prompts.ts';
import type { Activity, Store } from '../store.ts';
import { isChannelChange } from './channel.ts';
import type { AdmissionDb } from './db.ts';

export type SessionMeta = { backend: string; cwd: string; model?: string | null; profileDigest?: string | null };
export type SessionRow = { sessionId: string; generation: number; status: 'open' | 'lost' | 'closed'; launched: boolean } & SessionMeta & { changeId: string; kind: string };
type Raw = { change_id: string; kind: string; generation: number; session_id: string; backend: string; cwd: string; model: string | null; profile_digest: string | null; status: SessionRow['status']; launched_at: string | null };
const toRow = (r: Raw): SessionRow => ({ changeId: r.change_id, kind: r.kind, generation: r.generation, sessionId: r.session_id, backend: r.backend, cwd: r.cwd,
  model: r.model, profileDigest: r.profile_digest, status: r.status, launched: r.launched_at !== null });

/** La sesión abierta no coincide con lo que se pide (backend, cwd o modelo distintos): no se puede reanudar. */
export class SessionMismatchError extends Error {
  constructor(readonly sessionId: string, detail: string) { super(`session ${sessionId} cannot be resumed: ${detail}`); this.name = 'SessionMismatchError'; }
}

export class SessionStore {
  constructor(private readonly adm: AdmissionDb) {}

  current(changeId: string, kind: string): SessionRow | undefined {
    const r = this.adm.db.query('SELECT * FROM adm_sessions WHERE change_id = ? AND kind = ? ORDER BY generation DESC LIMIT 1').get(changeId, kind) as Raw | null;
    return r ? toRow(r) : undefined;
  }

  /**
   * La sesión para el próximo turno, creada y escrita antes de lanzar. Devuelve los campos de `LiveTurn` que le tocan:
   * `sessionId` si ya hubo un turno lanzado (reanudar exactamente esa), `newSessionId` si todavía no (empezar con ese id).
   * Lanza SessionMismatchError si la sesión abierta es de otro backend, cwd o modelo.
   */
  begin(changeId: string, kind: string, meta: SessionMeta): { session: SessionRow; turn: { sessionId: string } | { newSessionId: string } } {
    const row = this.adm.tx(() => {
      const cur = this.current(changeId, kind);
      if (cur && cur.status === 'open') return cur;
      const generation = (cur?.generation ?? 0) + 1;
      if (cur && cur.status === 'lost') throw new Error(`la sesión ${cur.sessionId} está perdida: usa supersede() antes de empezar la generación ${generation}`);
      this.adm.db.query('INSERT INTO adm_sessions(change_id, kind, generation, session_id, backend, cwd, model, profile_digest, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(changeId, kind, generation, randomUUID(), meta.backend, meta.cwd, meta.model ?? null, meta.profileDigest ?? null, this.adm.iso());
      return this.current(changeId, kind)!;
    });
    if (!row.launched) { // aún sin proceso: nada que reanudar, la fila toma los datos de este turno
      this.adm.tx(() => this.adm.db.query('UPDATE adm_sessions SET backend = ?, cwd = ?, model = ?, profile_digest = ? WHERE session_id = ? AND launched_at IS NULL')
        .run(meta.backend, meta.cwd, meta.model ?? null, meta.profileDigest ?? null, row.sessionId));
      return { session: { ...row, ...meta }, turn: { newSessionId: row.sessionId } };
    }
    // A8: el perfil también cuenta; si cambió desde que se lanzó la sesión, ya no es la misma sesión.
    for (const f of ['backend', 'cwd', 'model', 'profileDigest'] as const) {
      if (row.launched && (meta[f] ?? null) !== (row[f] ?? null)) throw new SessionMismatchError(row.sessionId, `${f} distinto (${String(row[f])} → ${String(meta[f] ?? null)})`);
    }
    return { session: row, turn: { sessionId: row.sessionId } };
  }

  /**
   * Se llama ANTES de lanzar el proceso (A8): a partir de aquí el siguiente turno reanuda en vez de empezar. Si el pool muere
   * entre esta marca y el arranque, el turno siguiente reanuda una sesión que no existe y cae en el camino de sesión perdida
   * (`SessionNotFoundError` → `supersede`), en vez de repetir `--session-id` con un id que `claude` ya conoce.
   */
  markLaunched(sessionId: string): void {
    this.adm.tx(() => this.adm.db.query('UPDATE adm_sessions SET launched_at = COALESCE(launched_at, ?) WHERE session_id = ?').run(this.adm.iso(), sessionId));
  }
}

/** Solo estas dos causas son «sesión perdida». Un fallo transitorio (red, límite de uso, timeout) NUNCA abre una sesión nueva. */
export const isSessionLoss = (error: unknown): boolean => error instanceof SessionNotFoundError || error instanceof SessionMismatchError;

/** Agotado el tope de generaciones: la activity falla de forma permanente (cuenta como los reintentos de la fab). */
export class SessionLostExhaustedError extends Error {
  constructor(readonly generations: number) { super(`sesión perdida ${generations} veces: tope de ${MAX_ACTIVITY_RETRIES} generaciones`); this.name = 'SessionLostExhaustedError'; }
}

/**
 * La sesión actual se perdió (T18, H-03). Se marca `lost` y se abre la generación siguiente, con evento visible y contando
 * para el tope. El siguiente turno parte de un prompt reconstruido (`reconstructPrompt`), no de la memoria del harness.
 * Si ya se agotó el tope lanza SessionLostExhaustedError y no abre nada.
 */
export function supersede(store: Store, adm: AdmissionDb, activity: Activity, reason: string, meta: SessionMeta): SessionRow {
  const sessions = new SessionStore(adm);
  const result = adm.tx(() => {
    const cur = sessions.current(activity.changeId, activity.kind);
    if (!cur) throw new Error(`no hay sesión que reemplazar para ${activity.changeId}/${activity.kind}`);
    // A6: el tope cuenta desde la última vez que una persona reintentó (`resetSessionCap`), no para siempre.
    const base = (adm.db.query('SELECT MAX(cap_from) AS base FROM adm_sessions WHERE change_id = ? AND kind = ?').get(activity.changeId, activity.kind) as { base: number | null }).base ?? 1;
    if (cur.generation - base + 1 >= MAX_ACTIVITY_RETRIES) return cur.generation - base + 1; // el evento se escribe fuera: un throw desharía la transacción
    adm.db.query("UPDATE adm_sessions SET status = 'lost', lost_reason = ? WHERE session_id = ? AND status = 'open'").run(reason.slice(0, 500), cur.sessionId);
    adm.db.query('INSERT INTO adm_sessions(change_id, kind, generation, session_id, backend, cwd, model, profile_digest, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(activity.changeId, activity.kind, cur.generation + 1, randomUUID(), meta.backend, meta.cwd, meta.model ?? null, meta.profileDigest ?? null, adm.iso());
    store.event(activity.workstreamId, 'warning', `sesión ${cur.sessionId} perdida (${reason.slice(0, 200)}); nueva generación ${cur.generation + 1}`, activity.changeId, activity.id);
    return sessions.current(activity.changeId, activity.kind)!;
  });
  if (typeof result === 'number') {
    store.event(activity.workstreamId, 'error', `sesión perdida (${reason.slice(0, 200)}); tope de ${MAX_ACTIVITY_RETRIES} generaciones agotado`, activity.changeId, activity.id);
    throw new SessionLostExhaustedError(result);
  }
  return result;
}

/** Preguntas hechas y respuestas recibidas en el change, en orden (estado durable de la fab, no del harness). */
export function questionsBlock(adm: AdmissionDb, changeId: string): string {
  const rows = adm.db.query('SELECT text, status, answer, answered_by FROM adm_questions WHERE change_id = ? ORDER BY asked_at, rowid').all(changeId) as
    { text: string; status: string; answer: string | null; answered_by: string | null }[];
  if (!rows.length) return '';
  return '\n\n# Questions asked to a human and their answers\n' + rows.map(r =>
    `- Question: ${r.text}\n  ${r.status === 'answered' ? `Answer (${r.answered_by ?? 'human'}): ${r.answer ?? ''}` : `(${r.status}, no answer)`}`).join('\n');
}

/** Prompt completo para una sesión nueva que sustituye a una perdida: el de la activity + preguntas y respuestas ya dadas. */
export function reconstructPrompt(store: Store, adm: AdmissionDb, activityId: string, ctx: { worktree: string; branch: string; factoryCommits?: boolean; templates?: WorkerTemplates }): string {
  const { activity, change, history } = store.activityContext(activityId);
  // B1: igual que el prompt del pool, el texto de un change de canal sale delimitado y con las plantillas del perfil.
  const prompt = buildWorkerPrompt({ workstream: store.getWorkstream(activity.workstreamId), change, activity, history, worktree: ctx.worktree, branch: ctx.branch,
    untrusted: isChannelChange(adm, change.id) }, { factoryCommits: ctx.factoryCommits }, ctx.templates);
  return `${prompt}${questionsBlock(adm, change.id)}\n\n# Resumed work\nA previous session for this activity was lost. Inspect the working tree (git status, git log) to see what is already done and continue from there; do not start over.`;
}

/**
 * A6: `fab retry` es una decisión humana nueva, así que reinicia el tope de generaciones perdidas del change (la sesión sigue
 * siendo la misma y se reanuda). Deja un evento. Devuelve cuántos tipos de activity se reiniciaron.
 */
export function resetSessionCap(store: Store, adm: AdmissionDb, changeId: string): number {
  const n = adm.tx(() => adm.db.query('UPDATE adm_sessions SET cap_from = generation WHERE id IN (SELECT MAX(id) FROM adm_sessions WHERE change_id = ? GROUP BY kind)').run(changeId).changes);
  if (n) { const c = store.getChange(changeId); store.event(c.workstreamId, 'info', 'reintento humano: tope de generaciones de sesión reiniciado', changeId); }
  return n;
}
