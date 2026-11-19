import { expect, test } from 'bun:test';
import { changeTimeline } from '../src/admission/timeline.ts';
import { Store } from '../src/store.ts';
import { claimed } from './helpers/live.ts';

const T_SCHEMA = `CREATE TABLE adm_turns (attempt_id TEXT PRIMARY KEY, activity_id TEXT NOT NULL, change_id TEXT NOT NULL, session_id TEXT NOT NULL,
  generation INTEGER NOT NULL, plan TEXT NOT NULL, question_id TEXT, started_at TEXT NOT NULL, ended_at TEXT, outcome TEXT, exit_code INTEGER,
  duration_ms INTEGER, cost_usd REAL, log TEXT)`; // esquema §2.1 del diseño; la tabla real es de T54a
const d = (hm: string) => `2026-11-19T${hm}:00.000Z`;
const NOW = d('23:00');

function setup() {
  const c = claimed(), a = c.claim();
  c.adm.db.exec(T_SCHEMA);
  const sess = (gen: number, status = 'open', lost: string | null = null) => c.adm.db.query(
    "INSERT INTO adm_sessions(change_id, kind, generation, session_id, backend, cwd, status, lost_reason, created_at, model) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(c.change.id, a.kind, gen, `s${gen}`, 'claude', '/w', status, lost, d('09:00'), gen === 1 ? 'sonnet' : null);
  const turn = (id: string, gen: number, plan: string, from: string, to: string | null, outcome: string | null, act = a.id) => c.adm.db.query(
    'INSERT INTO adm_turns(attempt_id, activity_id, change_id, session_id, generation, plan, started_at, ended_at, outcome, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, act, c.change.id, `s${gen}`, gen, plan, d(from), to ? d(to) : null, outcome, to ? 1000 : null);
  const question = (id: string, asked: string, status: string, answeredAt: string | null) => c.adm.db.query(
    "INSERT INTO adm_questions(id, activity_id, change_id, text, status, asked_at, answered_at, answer, answered_by) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, a.id, c.change.id, `¿${id}?`, status, d(asked), answeredAt ? d(answeredAt) : null, answeredAt ? 'rojo' : null, answeredAt ? 'maint' : null);
  return { ...c, a, sess, turn, question };
}

test('dos generaciones, una pregunta respondida y otra vencida: orden de turnos y los cinco tipos de tramo', () => {
  const s = setup();
  s.sess(1, 'lost', 'boom'); s.sess(2);
  s.turn('t1', 1, 'fresh', '10:00', '10:10', 'awaiting'); s.question('q1', '10:10', 'answered', '11:00');
  s.turn('t2', 1, 'answer', '11:05', '11:20', 'blocked');
  s.turn('t3', 2, 'reconstructed', '12:00', '12:10', 'awaiting'); s.question('q2', '12:10', 'expired', null);
  s.adm.db.query('UPDATE activities SET completed_at = ?, status = ? WHERE id = ?').run(d('13:00'), 'failed', s.a.id);
  s.turn('t4', 2, 'retry', '13:30', null, null);
  s.adm.db.query("INSERT INTO adm_reports(attempt_id, activity_id, state, summary, created_at) VALUES ('t1',?,'awaiting','resumen <b>',?)").run(s.a.id, d('10:10'));

  const t = changeTimeline(s.store.db, s.change.id, NOW);
  expect(t.state).toBe('ok');
  expect(t.turns.map(x => x.attemptId)).toEqual(['t1', 't2', 't3', 't4']);
  expect(t.turns.map(x => x.generation)).toEqual([1, 1, 2, 2]);
  expect(t.turns[0]).toMatchObject({ kind: s.a.kind, model: 'sonnet', report: { state: 'awaiting', summary: 'resumen <b>' }, question: { id: 'q1', answer: 'rojo', answeredBy: 'maint' } });
  expect(t.turns[2]!.question).toMatchObject({ id: 'q2', status: 'expired', answer: null });
  expect(t.turns[3]).toMatchObject({ endedAt: null, outcome: null, costUsd: null });
  expect(t.sessions).toEqual([{ generation: 1, status: 'lost', lostReason: 'boom' }, { generation: 2, status: 'open', lostReason: null }]);
  expect(t.segments.map(x => [x.kind, x.from.slice(11, 16), x.to?.slice(11, 16) ?? null])).toEqual([
    ['trabajo', '10:00', '10:10'],
    ['espera_persona', '10:10', '11:00'],
    ['cola', '11:00', '11:05'],
    ['trabajo', '11:05', '11:20'],
    ['bloqueo', '11:20', '12:00'],
    ['trabajo', '12:00', '12:10'],
    ['espera_persona', '12:10', '13:00'],
    ['cola', '13:00', '13:30'],
    ['interrumpido', '13:30', null]]);
});

test('turno sin fin con la activity en curso: trabajo abierto, no interrumpido; pregunta abierta: espera abierta sin cola', () => {
  const s = setup();
  s.sess(1); s.turn('t1', 1, 'fresh', '10:00', '10:10', 'awaiting'); s.question('q1', '10:10', 'open', null); s.turn('t2', 1, 'answer', '11:00', null, null);
  const t = changeTimeline(s.store.db, s.change.id, NOW);
  expect(t.segments.map(x => [x.kind, x.to])).toEqual([['trabajo', d('10:10')], ['espera_persona', null], ['trabajo', null]]);
});

test('base sin tablas adm_*: sin_tablas, y la lectura no las crea', () => {
  const store = new Store(':memory:'), before = store.db.query('SELECT name FROM sqlite_master ORDER BY name').all();
  expect(changeTimeline(store.db, 'c', NOW)).toEqual({ state: 'sin_tablas', turns: [], segments: [], sessions: [], omitted: 0 });
  expect(store.db.query('SELECT name FROM sqlite_master ORDER BY name').all()).toEqual(before);
});

test('adm_sessions sin adm_turns (base anterior a T54): sesiones y preguntas presentes, sin turnos, sin crear la tabla', () => {
  const s = setup(); s.adm.db.exec('DROP TABLE adm_turns'); s.sess(1); s.question('q1', '10:10', 'answered', '11:00');
  const t = changeTimeline(s.store.db, s.change.id, NOW);
  expect(t).toMatchObject({ state: 'sin_turnos', turns: [], sessions: [{ generation: 1 }], segments: [{ kind: 'espera_persona' }] });
  expect(s.store.db.query("SELECT 1 FROM sqlite_master WHERE name = 'adm_turns'").get()).toBeNull();
});

test('500 turnos: devuelve los 200 más recientes y omitted = 300', () => {
  const s = setup(); s.sess(1);
  const ins = s.adm.db.query('INSERT INTO adm_turns(attempt_id, activity_id, change_id, session_id, generation, plan, started_at, ended_at, outcome) VALUES (?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 500; i++) { const at = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(); ins.run(`t${i}`, s.a.id, s.change.id, 's1', 1, 'retry', at, at, 'done'); }
  const t = changeTimeline(s.store.db, s.change.id, NOW);
  expect(t.turns).toHaveLength(200); expect(t.omitted).toBe(300);
  expect(t.turns[0]!.attemptId).toBe('t300'); expect(t.turns[199]!.attemptId).toBe('t499');
});
