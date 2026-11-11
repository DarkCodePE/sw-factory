import { expect, test } from 'bun:test';
import { applyReport, ReportStore } from '../src/admission/reports.ts';
import { CONTINUE_PROMPT, markAnswerDelivered, planTurn } from '../src/admission/recovery.ts';
import { SessionStore } from '../src/admission/sessions.ts';
import { claimed } from './helpers/live.ts';

const meta = { backend: 'claude', cwd: '/w/a' };
const future = () => new Date(Date.now() + 3_600_000).toISOString();

test('primer turno: sin sesión lanzada se arranca con el prompt completo', () => {
  const { adm, claim } = claimed();
  expect(planTurn(adm, claim())).toEqual({ action: 'fresh' });
});

test('turno huérfano con sesión lanzada: nunca vuelve a empezar; reanuda con «continúa» y el estado del worktree', () => {
  const { store, adm, change, claim } = claimed(), a = claim();
  new SessionStore(adm).markLaunched(new SessionStore(adm).begin(change.id, a.kind, meta).session.sessionId);
  store.requeueOrphans('ws', future()); // el pool murió a mitad de turno
  const again = claim('w2');
  const plan = planTurn(adm, again, { worktreeNote: ' M calc.txt' });
  expect(plan).toMatchObject({ action: 'resume', reason: 'orphan' });
  expect((plan as { prompt: string }).prompt).toContain(CONTINUE_PROMPT);
  expect((plan as { prompt: string }).prompt).toContain(' M calc.txt');
});

test('turno terminado con report persistido antes de morir el pool: se aplica en vez de reejecutar', () => {
  const { store, adm, effects, change, claim } = claimed(), a = claim();
  new SessionStore(adm).markLaunched(new SessionStore(adm).begin(change.id, a.kind, meta).session.sessionId);
  new ReportStore(adm).recorder(a.id, 'att-1')({ state: 'awaiting', summary: 's', human_action: '¿color?' });
  store.requeueOrphans('ws', future());
  const again = claim('w2'), plan = planTurn(adm, again);
  expect(plan).toMatchObject({ action: 'apply-report', report: { state: 'awaiting', attemptId: 'att-1' } });
  expect(applyReport(store, adm, effects, { activityId: again.id, workerId: 'w2' })).toMatchObject({ state: 'awaiting' });
  expect(planTurn(adm, store.getActivity(again.id))).not.toMatchObject({ action: 'apply-report' });
});

test('respuesta humana aún no entregada: es el mensaje del turno; tras entregarla, una caída vuelve a «continúa»', () => {
  const { store, adm, change, claim } = claimed(), a = claim();
  new SessionStore(adm).markLaunched(new SessionStore(adm).begin(change.id, a.kind, meta).session.sessionId);
  adm.db.query("INSERT INTO adm_questions(id, activity_id, change_id, text, status, asked_at, answered_at, answer, answered_by) VALUES ('q1',?,?,'¿?','answered','2026-01-01T00:00:00Z','2026-01-01T01:00:00Z','rojo','maint')").run(a.id, change.id);
  expect(planTurn(adm, a)).toEqual({ action: 'resume', reason: 'answer', questionId: 'q1', prompt: 'rojo' });
  markAnswerDelivered(adm, 'q1');
  expect(planTurn(adm, a)).toMatchObject({ action: 'resume', reason: 'orphan' });
  void store;
});
