// Reports de un turno vivo (T16, H-01). El handler MCP los persiste por `attemptId` SIN tocar la activity (cambiar su
// estado a mitad de turno haría fallar el latido y abortaría al agente); el pool los aplica al acabar el turno, en una
// transacción con el efecto `reply`, y la recuperación de un turno huérfano los aplica en vez de reejecutar (T19).
// Precedencia (T26): en modo vivo manda el report; gana el último válido; sin report, el turno falla como hoy.
import type { LiveReport } from '../live/contract.ts';
import type { Store } from '../store.ts';
import type { AdmissionDb } from './db.ts';
import type { CrashPoint, Effects } from './effects.ts';

/** Plazo por defecto de una pregunta sin respuesta (T31). */
export const DEFAULT_WAIT_MS = 7 * 86_400_000;

type ReportRow = { id: number; attempt_id: string; state: LiveReport['state']; summary: string; human_action: string | null };
const toReport = (r: ReportRow): LiveReport => ({ state: r.state, summary: r.summary, ...(r.human_action ? { human_action: r.human_action } : {}) });

export class ReportStore {
  constructor(private readonly adm: AdmissionDb) {}

  /** El `onReport` de un turno: valida y persiste. Si lanza, el agente recibe el error y el report no se acepta. */
  recorder(activityId: string, attemptId: string, crash?: (point: CrashPoint) => void): (report: LiveReport) => void {
    return report => {
      if (report.state === 'awaiting' && !report.human_action?.trim()) throw new Error('human_action is required when state is awaiting');
      this.adm.tx(() => this.adm.db.query('INSERT INTO adm_reports(attempt_id, activity_id, state, summary, human_action, created_at) VALUES (?,?,?,?,?,?)')
        .run(attemptId, activityId, report.state, report.summary, report.human_action?.trim() || null, this.adm.iso()));
      crash?.('report-recorded');
    };
  }

  /** El último report válido aún sin aplicar de la activity (de cualquier intento: lo usa la recuperación). */
  pending(activityId: string): (LiveReport & { attemptId: string; id: number }) | undefined {
    const row = this.adm.db.query('SELECT * FROM adm_reports WHERE activity_id = ? AND applied_at IS NULL ORDER BY id DESC LIMIT 1').get(activityId) as ReportRow | null;
    return row ? { ...toReport(row), attemptId: row.attempt_id, id: row.id } : undefined;
  }
}

export type AppliedReport = { state: 'none' } | { state: 'done' | 'blocked'; report: LiveReport } | { state: 'awaiting'; questionId: string };

/**
 * Aplica el último report pendiente de la activity (la tiene `workerId`). `awaiting`: en UNA transacción pregunta
 * abierta + activity a `waiting_reply` + efecto `reply` + report aplicado; una caída deja todo o nada.
 * `done` y `blocked` solo se marcan aplicados: el pool sigue con completeActivity / blockActivity como hoy.
 */
export function applyReport(store: Store, adm: AdmissionDb, effects: Effects, p: { activityId: string; workerId: string; waitMs?: number; crash?: (point: CrashPoint) => void }): AppliedReport {
  const reports = new ReportStore(adm), pending = reports.pending(p.activityId);
  if (!pending) return { state: 'none' };
  const done = (): void => { adm.db.query('UPDATE adm_reports SET applied_at = ? WHERE activity_id = ? AND applied_at IS NULL').run(adm.iso(), p.activityId); };
  if (pending.state !== 'awaiting') {
    adm.tx(done);
    return { state: pending.state, report: { state: pending.state, summary: pending.summary, ...(pending.human_action ? { human_action: pending.human_action } : {}) } };
  }
  // Id determinista por intento: aplicar dos veces el mismo report no abre dos preguntas.
  const questionId = `q-${pending.attemptId}`;
  const result = adm.tx(() => {
    const a = store.getActivity(p.activityId);
    if (a.status === 'waiting_reply' && a.questionId === questionId) { done(); return questionId; } // ya aplicado
    store.awaitHuman(p.activityId, p.workerId, { questionId, waitUntil: new Date(adm.now() + (p.waitMs ?? DEFAULT_WAIT_MS)).toISOString() });
    adm.db.query('INSERT INTO adm_questions(id, activity_id, change_id, text, asked_at) VALUES (?,?,?,?,?)')
      .run(questionId, a.id, a.changeId, pending.human_action ?? '', adm.iso());
    effects.enqueue('reply', `reply:${questionId}`, { questionId });
    done();
    return questionId;
  });
  p.crash?.('report-applied');
  return { state: 'awaiting', questionId: result };
}

export type LiveOutcome = { kind: LiveReport['state']; report: LiveReport };

/**
 * Precedencia entre los dos canales de estado de un turno vivo (T26, H-11): manda el `report`; gana el último válido
 * (un `awaiting` sin `human_action` no lo es); la línea `STATUS:` del texto se ignora si hay report. Sin report válido
 * devuelve undefined y el pool decide por `run.status`, es decir, falla como hoy (`missing`).
 */
export function liveOutcome(reports: readonly LiveReport[]): LiveOutcome | undefined {
  const last = [...reports].reverse().find(r => (r.state === 'done' || r.state === 'blocked' || r.state === 'awaiting') && typeof r.summary === 'string'
    && (r.state !== 'awaiting' || !!r.human_action?.trim()));
  return last ? { kind: last.state, report: last } : undefined;
}
