import { expect, test } from 'bun:test';
import { answerQuestion, reapQuestions } from '../src/admission/answers.ts';
import type { CrashPoint } from '../src/admission/effects.ts';
import { applyReport, ReportStore } from '../src/admission/reports.ts';
import { runPool } from '../src/pool.ts';
import { claimed } from './helpers/live.ts';

/** Activity reclamada que ya preguntó (turno `attempt`): queda en `waiting_reply` con su pregunta abierta. */
function waiting(attempt = 'att-1') {
  const t = claimed(), a = t.claim();
  new ReportStore(t.adm).recorder(a.id, attempt)({ state: 'awaiting', summary: 's', human_action: '¿color?' });
  applyReport(t.store, t.adm, t.effects, { activityId: a.id, workerId: 'w1' });
  return { ...t, a, qid: `q-${attempt}` };
}
const state = (t: ReturnType<typeof waiting>) => t.store.getActivity(t.a.id);

test('la respuesta registra y reencola en una transacción: la activity vuelve a pending sin gastar reintentos y otro worker la reclama', () => {
  const t = waiting();
  expect(state(t).status).toBe('waiting_reply');
  expect(t.store.getChange(t.change.id).status).toBe('in_progress');
  expect(answerQuestion(t.store, t.adm, { questionId: t.qid, answer: 'rojo', by: 'maint' })).toBe('answered');
  expect(state(t)).toMatchObject({ status: 'pending', questionId: null, waitUntil: null, retryCount: 0 });
  expect(t.adm.db.query('SELECT status, answer, answered_by FROM adm_questions').get()).toEqual({ status: 'answered', answer: 'rojo', answered_by: 'maint' });
  expect(t.claim('w2').id).toBe(t.a.id);
});

test('respuesta duplicada o a una pregunta anterior: no reencola dos veces', () => {
  const t = waiting();
  expect(answerQuestion(t.store, t.adm, { questionId: t.qid, answer: 'rojo', by: 'maint' })).toBe('answered');
  const again = t.claim('w2');
  new ReportStore(t.adm).recorder(again.id, 'att-2')({ state: 'awaiting', summary: 's', human_action: '¿tamaño?' });
  applyReport(t.store, t.adm, t.effects, { activityId: again.id, workerId: 'w2' });
  // llega otra vez la respuesta a la primera pregunta (duplicada y tardía): no toca la segunda espera
  expect(answerQuestion(t.store, t.adm, { questionId: t.qid, answer: 'rojo', by: 'maint' })).toBe('ignored:not-open');
  expect(state(t)).toMatchObject({ status: 'waiting_reply', questionId: 'q-att-2' });
  expect(answerQuestion(t.store, t.adm, { questionId: 'q-att-2', answer: 'grande', by: 'maint' })).toBe('answered');
  expect(answerQuestion(t.store, t.adm, { questionId: 'q-att-2', answer: 'otra', by: 'maint' })).toBe('ignored:not-open');
  expect(answerQuestion(t.store, t.adm, { questionId: 'no-existe', answer: 'x', by: 'maint' })).toBe('ignored:not-open');
});

test('caída entre registrar la respuesta y reencolar: no queda a medias', () => {
  const t = waiting(), crash = (p: CrashPoint) => { if (p === 'answer-applied') throw new Error('crash'); };
  expect(() => answerQuestion(t.store, t.adm, { questionId: t.qid, answer: 'rojo', by: 'maint', crash })).toThrow('crash');
  expect(state(t).status).toBe('waiting_reply');
  expect(t.adm.db.query('SELECT status FROM adm_questions').get()).toEqual({ status: 'open' });
  expect(answerQuestion(t.store, t.adm, { questionId: t.qid, answer: 'rojo', by: 'maint' })).toBe('answered');
});

test('change cancelado mientras espera: el barrido cancela la activity y la respuesta tardía no reencola nada ni cuelga --once', async () => {
  const t = waiting();
  t.store.closeChange(t.change.id, 'canceled');
  expect(state(t).status).toBe('canceled');
  expect(answerQuestion(t.store, t.adm, { questionId: t.qid, answer: 'rojo', by: 'maint' })).toBe('ignored:not-waiting');
  expect(state(t).status).toBe('canceled');
  expect(t.adm.db.query('SELECT status FROM adm_questions').get()).toEqual({ status: 'canceled' });
  expect(t.store.claimActivity('ws', 'w2')).toBeNull();
  await runPool(t.store, { workstream: 'ws', stateDir: '/tmp/none', untilIdle: true, pollMs: 10, log: () => {}, acceptAgentBinaries: true }); // termina
});

test('una activity en espera no se reclama, no es huérfana y no cuenta como pendiente ni en curso para --once', async () => {
  const t = waiting();
  t.store.db.query("INSERT INTO activities(id, workstream_id, change_id, kind, status, created_at) VALUES ('otra', ?, ?, 'implementation', 'pending', '2999-01-01')").run(t.ws.id, t.change.id);
  expect(t.store.claimActivity('ws', 'w2')).toBeNull(); // exclusión por change
  expect(t.store.requeueOrphans('ws', new Date(Date.now() + 9e9).toISOString())).toBe(0);
  expect(state(t).status).toBe('waiting_reply');
  expect(() => t.store.heartbeat(t.a.id, 'w1')).toThrow(/not held/); // el worker anterior ya no tiene la activity
});

test('la espera aparece en el inbox', () => {
  const t = waiting();
  expect(t.store.inbox('ws').map(a => a.id)).toContain(t.a.id);
});

test('reapQuestions cancela las preguntas que su activity ya no espera', () => {
  const t = waiting();
  expect(reapQuestions(t.adm)).toBe(0);
  t.store.closeChange(t.change.id, 'canceled');
  expect(reapQuestions(t.adm)).toBe(1);
  expect(t.adm.db.query('SELECT status FROM adm_questions').get()).toEqual({ status: 'canceled' });
});

test('T31: pasado el plazo, la espera pasa a blocked con motivo, el change a blocked y la pregunta a expired; una respuesta tardía no reencola', async () => {
  const { expireQuestions } = await import('../src/admission/answers.ts');
  let now = Date.parse('2026-01-01T00:00:00Z');
  const t = claimed({}, { clock: () => new Date(now) }), a = t.claim();
  new ReportStore(t.adm).recorder(a.id, 'att-1')({ state: 'awaiting', summary: 's', human_action: '¿?' });
  applyReport(t.store, t.adm, t.effects, { activityId: a.id, workerId: 'w1', waitMs: 3_600_000 });
  now += 3_599_000;
  expect(expireQuestions(t.store, t.adm)).toBe(0);
  now += 1_000;
  expect(expireQuestions(t.store, t.adm)).toBe(1);
  expect(t.store.getActivity(a.id)).toMatchObject({ status: 'blocked', questionId: null });
  expect(t.store.getActivity(a.id).error).toMatch(/^REPLY_TIMEOUT/);
  expect(t.store.getChange(t.change.id).status).toBe('blocked');
  expect(t.adm.db.query('SELECT status FROM adm_questions').get()).toEqual({ status: 'expired' });
  expect(answerQuestion(t.store, t.adm, { questionId: 'q-att-1', answer: 'tarde', by: 'maint' })).toBe('ignored:not-open');
  expect(t.store.claimActivity('ws', 'w2')).toBeNull();
  expect(expireQuestions(t.store, t.adm)).toBe(0);
});
