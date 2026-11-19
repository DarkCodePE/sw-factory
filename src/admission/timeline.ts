// Línea de tiempo por turnos de un change (T54b). Solo lectura: recibe la conexión y NUNCA construye `AdmissionDb`,
// cuyo constructor crearía el esquema `adm_*` (invariante I1 del diseño T54).
import type { Database } from 'bun:sqlite';

export const TURN_LIMIT = 200;

export type SegmentKind = 'trabajo' | 'espera_persona' | 'cola' | 'bloqueo' | 'interrumpido';
export interface Segment { kind: SegmentKind; from: string; to: string | null }
export interface TurnView {
  attemptId: string; activityId: string; kind: string; generation: number; sessionId: string; model: string | null;
  plan: string; startedAt: string; endedAt: string | null; outcome: string | null;
  durationMs: number | null; costUsd: number | null; log: string | null;
  report: { state: string; summary: string } | null;
  question: { id: string; text: string; status: string; askedAt: string; answer: string | null; answeredBy: string | null; answeredAt: string | null } | null;
  notes: { id: string; body: string; actor: string }[];
}
export interface Timeline {
  state: 'sin_tablas' | 'sin_turnos' | 'ok'; turns: TurnView[]; segments: Segment[];
  sessions: { generation: number; status: string; lostReason: string | null }[]; omitted: number;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));

export function changeTimeline(db: Database, changeId: string, _now: string): Timeline {
  const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(r => r.name));
  if (!tables.has('adm_sessions')) return { state: 'sin_tablas', turns: [], segments: [], sessions: [], omitted: 0 };

  const sessions = (db.query('SELECT generation, status, lost_reason FROM adm_sessions WHERE change_id = ? ORDER BY generation, id').all(changeId) as Row[])
    .map(r => ({ generation: Number(r.generation), status: String(r.status), lostReason: str(r.lost_reason) }));
  const questions = db.query('SELECT q.*, a.completed_at FROM adm_questions q LEFT JOIN activities a ON a.id = q.activity_id WHERE q.change_id = ? ORDER BY q.asked_at').all(changeId) as Row[];
  // Fin de la espera: respuesta; si venció o se canceló, cuando la activity se cerró; si sigue abierta, null.
  const waitEnd = (q: Row): string | null => str(q.answered_at) ?? (q.status === 'expired' || q.status === 'canceled' ? str(q.completed_at) : null);
  const waits: Segment[] = questions.map(q => ({ kind: 'espera_persona', from: String(q.asked_at), to: waitEnd(q) }));

  let rows: Row[] = [], omitted = 0;
  if (tables.has('adm_turns')) {
    const total = Number((db.query('SELECT count(*) AS n FROM adm_turns WHERE change_id = ?').get(changeId) as { n: number }).n);
    omitted = Math.max(0, total - TURN_LIMIT);
    rows = (db.query(`SELECT t.*, a.kind AS act_kind, a.status AS act_status, s.model AS model FROM adm_turns t
      LEFT JOIN activities a ON a.id = t.activity_id LEFT JOIN adm_sessions s ON s.session_id = t.session_id
      WHERE t.change_id = ? ORDER BY t.started_at DESC, t.rowid DESC LIMIT ?`).all(changeId, TURN_LIMIT) as Row[]).reverse();
  }
  if (rows.length === 0) return { state: 'sin_turnos', turns: [], segments: waits, sessions, omitted: 0 };

  const noteRows = tables.has('change_notes')
    ? db.query('SELECT id, body, actor, attempt_id FROM change_notes WHERE change_id = ? AND delivered_at IS NOT NULL ORDER BY created_at').all(changeId) as Row[] : [];
  const turns: TurnView[] = rows.map((r, i) => {
    const attemptId = String(r.attempt_id), next = rows[i + 1];
    const rep = db.query('SELECT state, summary FROM adm_reports WHERE attempt_id = ? ORDER BY id DESC LIMIT 1').get(attemptId) as Row | null;
    // La pregunta de un turno es la que se hizo desde que empezó hasta que empezó el siguiente turno de su activity.
    const q = questions.find(x => x.activity_id === r.activity_id && String(x.asked_at) >= String(r.started_at)
      && !rows.slice(i + 1).some(n => n.activity_id === r.activity_id && String(n.started_at) <= String(x.asked_at)));
    return {
      attemptId, activityId: String(r.activity_id), kind: String(r.act_kind ?? ''), generation: Number(r.generation), sessionId: String(r.session_id),
      model: str(r.model), plan: String(r.plan), startedAt: String(r.started_at), endedAt: str(r.ended_at), outcome: str(r.outcome),
      durationMs: num(r.duration_ms), costUsd: num(r.cost_usd), log: str(r.log),
      report: rep ? { state: String(rep.state), summary: String(rep.summary) } : null,
      question: q ? { id: String(q.id), text: String(q.text), status: String(q.status), askedAt: String(q.asked_at), answer: str(q.answer), answeredBy: str(q.answered_by), answeredAt: str(q.answered_at) } : null,
      notes: noteRows.filter(n => n.attempt_id === attemptId).map(n => ({ id: String(n.id), body: String(n.body), actor: String(n.actor) })),
    };
  });

  const segments: Segment[] = [];
  const firstStart = turns[0]!.startedAt;
  segments.push(...waits.filter(w => w.from >= firstStart));
  rows.forEach((r, i) => {
    const next = rows[i + 1], nextStart = next ? String(next.started_at) : null, started = String(r.started_at), ended = str(r.ended_at);
    if (ended) segments.push({ kind: 'trabajo', from: started, to: ended });
    else if (r.act_status === 'in_progress') segments.push({ kind: 'trabajo', from: started, to: null });
    else { segments.push({ kind: 'interrumpido', from: started, to: nextStart }); return; } // sin fin no hay tramo de cola ni bloqueo
    if (r.outcome === 'blocked') { segments.push({ kind: 'bloqueo', from: ended!, to: nextStart }); return; }
    const q = turns[i]!.question, qRow = q && questions.find(x => x.id === q.id);
    const from = qRow ? waitEnd(qRow) : r.outcome === 'done' || r.outcome === 'awaiting' || next ? ended : null;
    if (from && (nextStart || qRow)) segments.push({ kind: 'cola', from, to: nextStart });
  });
  segments.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return { state: 'ok', turns, segments, sessions, omitted };
}
