// Respuesta humana a una pregunta abierta (T27). Registrar la respuesta y reencolar la activity van en UNA transacción
// (06:L146): la admisión no escribe en `activities`, solo llama al comando del Store (`answerAwaiting`).
import type { Store } from '../store.ts';
import type { AdmissionDb } from './db.ts';
import type { CrashPoint } from './effects.ts';

export type AnswerResult = 'answered' | 'ignored:not-open' | 'ignored:not-waiting';

/**
 * Entrega `answer` a la pregunta. `ignored:not-open`: duplicada, tardía (a una pregunta ya respondida/vencida/cancelada) o inexistente.
 * `ignored:not-waiting`: la pregunta seguía abierta pero la activity ya no espera esa pregunta (change cancelado o cerrado);
 * la pregunta se cancela y no se reencola nada. Una caída a mitad deja todo como estaba.
 */
export function answerQuestion(store: Store, adm: AdmissionDb, p: { questionId: string; answer: string; by: string; crash?: (point: CrashPoint) => void }): AnswerResult {
  return adm.tx(() => {
    const q = adm.db.query('SELECT activity_id, status FROM adm_questions WHERE id = ?').get(p.questionId) as { activity_id: string; status: string } | null;
    if (!q || q.status !== 'open') return 'ignored:not-open';
    if (!store.answerAwaiting(q.activity_id, p.questionId)) {
      adm.db.query("UPDATE adm_questions SET status = 'canceled' WHERE id = ?").run(p.questionId);
      return 'ignored:not-waiting';
    }
    adm.db.query("UPDATE adm_questions SET status = 'answered', answer = ?, answered_by = ?, answered_at = ? WHERE id = ?").run(p.answer, p.by, adm.iso(), p.questionId);
    p.crash?.('answer-applied');
    return 'answered';
  });
}

/** Cancela las preguntas abiertas cuya activity ya no las espera (change cerrado, activity cancelada). Devuelve cuántas. */
export function reapQuestions(adm: AdmissionDb): number {
  return adm.tx(() => adm.db.query(`UPDATE adm_questions SET status = 'canceled' WHERE status = 'open' AND NOT EXISTS (
    SELECT 1 FROM activities a WHERE a.id = adm_questions.activity_id AND a.status = 'waiting_reply' AND a.question_id = adm_questions.id)`).run().changes);
}
