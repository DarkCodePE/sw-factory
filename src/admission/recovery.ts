// Qué hacer con una activity viva recién reclamada (T19, H-04). Hoy un fallo o una orfandad devuelven la activity a
// `pending` y el agente se reejecuta con el prompt inicial; con una sesión viva eso reenvía el encargo a una sesión que
// quizá ya lo hizo. Regla (como sa:dsh.ts:557 y esf MaximumAttempts:1): reconciliar primero, reanudar después, y no
// empezar de cero si ya hubo un proceso lanzado. El pool consulta `planTurn` tras cada claim (cableado: T12).
import type { LiveReport } from '../live/contract.ts';
import type { Activity } from '../store.ts';
import type { AdmissionDb } from './db.ts';
import { ReportStore } from './reports.ts';
import { SessionStore } from './sessions.ts';

export const CONTINUE_PROMPT = 'Your previous turn was interrupted before it finished. Check the working tree (git status, git log) to see what is already done and continue from there; do not start over and do not repeat finished work.';

export type TurnPlan =
  | { action: 'apply-report'; report: LiveReport & { attemptId: string } }   // el turno ya había informado: aplicarlo, no reejecutar
  | { action: 'resume'; reason: 'answer' | 'orphan'; prompt: string; questionId?: string }
  | { action: 'fresh' };                                                     // primer turno: prompt completo

export function planTurn(adm: AdmissionDb, activity: Activity, opts: { worktreeNote?: string } = {}): TurnPlan {
  const pending = new ReportStore(adm).pending(activity.id);
  if (pending) return { action: 'apply-report', report: pending };
  const session = new SessionStore(adm).current(activity.changeId, activity.kind);
  if (!session?.launched) return { action: 'fresh' };
  // Una respuesta humana aún no entregada: ese es el mensaje del turno, no «continúa».
  const answered = adm.db.query("SELECT id, answer FROM adm_questions WHERE activity_id = ? AND status = 'answered' AND delivered_at IS NULL ORDER BY answered_at DESC, rowid DESC LIMIT 1")
    .get(activity.id) as { id: string; answer: string } | null;
  if (answered) return { action: 'resume', reason: 'answer', questionId: answered.id, prompt: answered.answer };
  return { action: 'resume', reason: 'orphan', prompt: opts.worktreeNote ? `${CONTINUE_PROMPT}\n\nWorking tree now:\n${opts.worktreeNote}` : CONTINUE_PROMPT };
}

/** Marca la respuesta como entregada al lanzar el turno que la lleva (`turn.onSpawn`): una caída posterior ya no la reenvía como nueva. */
export function markAnswerDelivered(adm: AdmissionDb, questionId: string): void {
  adm.tx(() => adm.db.query('UPDATE adm_questions SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ?').run(adm.iso(), questionId));
}
