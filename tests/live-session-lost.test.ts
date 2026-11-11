import { expect, test } from 'bun:test';
import { SessionNotFoundError } from '../src/live/contract.ts';
import { isSessionLoss, questionsBlock, reconstructPrompt, SessionLostExhaustedError, SessionMismatchError, SessionStore, supersede } from '../src/admission/sessions.ts';
import { claimed } from './helpers/live.ts';

const meta = { backend: 'claude', cwd: '/w/a' };

test('solo SessionNotFound y Mismatch son sesión perdida; un error transitorio nunca abre sesión nueva', () => {
  expect(isSessionLoss(new SessionNotFoundError('s'))).toBe(true);
  expect(isSessionLoss(new SessionMismatchError('s', 'cwd'))).toBe(true);
  for (const e of [new Error('429 rate limit'), new Error('timeout'), new Error('ECONNRESET'), 'No conversation found']) expect(isSessionLoss(e)).toBe(false);
});

test('supersede marca la perdida, abre la generación siguiente con evento y la sesión nueva empieza de cero', () => {
  const { store, adm, change, claim } = claimed(), s = new SessionStore(adm), a = claim();
  const first = s.begin(change.id, a.kind, meta).session; s.markLaunched(first.sessionId);
  const next = supersede(store, adm, a, 'No conversation found', meta);
  expect(next).toMatchObject({ generation: 2, status: 'open', launched: false });
  expect(next.sessionId).not.toBe(first.sessionId);
  expect(adm.db.query('SELECT status, lost_reason FROM adm_sessions WHERE session_id = ?').get(first.sessionId)).toEqual({ status: 'lost', lost_reason: 'No conversation found' });
  expect(s.begin(change.id, a.kind, meta).turn).toEqual({ newSessionId: next.sessionId });
  expect(store.listEvents('ws').some(e => /perdida.*generación 2/.test(String(e.message)) && e.severity === 'warning')).toBe(true);
});

test('cuenta para el tope: a la tercera generación perdida la activity falla en vez de abrir otra', () => {
  const { store, adm, change, claim } = claimed(), s = new SessionStore(adm), a = claim();
  s.begin(change.id, a.kind, meta);
  supersede(store, adm, a, 'x', meta); supersede(store, adm, a, 'x', meta); // generaciones 2 y 3
  expect(() => supersede(store, adm, a, 'x', meta)).toThrow(SessionLostExhaustedError);
  expect(s.current(change.id, a.kind)?.generation).toBe(3);
  expect(store.listEvents('ws').some(e => e.severity === 'error' && /tope/.test(String(e.message)))).toBe(true);
});

test('el prompt se reconstruye desde estado durable: change, historial y preguntas con sus respuestas', () => {
  const { store, adm, change, claim } = claimed(), a = claim();
  adm.db.query("INSERT INTO adm_questions(id, activity_id, change_id, text, status, asked_at, answered_at, answer, answered_by) VALUES ('q1',?,?,'¿qué color?','answered','2026-01-01T00:00:00Z','2026-01-01T01:00:00Z','rojo','maint')").run(a.id, change.id);
  adm.db.query("INSERT INTO adm_questions(id, activity_id, change_id, text, status, asked_at) VALUES ('q2',?,?,'¿y el tamaño?','expired','2026-01-02T00:00:00Z')").run('otra', change.id);
  const prompt = reconstructPrompt(store, adm, a.id, { worktree: '/w/a', branch: 'fab/x' });
  expect(prompt).toContain('descripción');
  expect(prompt).toContain('Question: ¿qué color?');
  expect(prompt).toContain('Answer (maint): rojo');
  expect(prompt).toContain('(expired, no answer)');
  expect(prompt).toContain('do not start over');
  expect(questionsBlock(adm, 'otro-change')).toBe('');
});
