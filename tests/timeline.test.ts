import { expect, test } from 'bun:test';
import { changeTimeline } from '../src/admission/timeline.ts';
import { Store } from '../src/store.ts';
import { claimed } from './helpers/live.ts';

const T_SCHEMA = `CREATE TABLE adm_turns (attempt_id TEXT PRIMARY KEY, activity_id TEXT NOT NULL, change_id TEXT NOT NULL, session_id TEXT NOT NULL,
  generation INTEGER NOT NULL, plan TEXT NOT NULL, question_id TEXT, started_at TEXT NOT NULL, ended_at TEXT, outcome TEXT, exit_code INTEGER,
  duration_ms INTEGER, cost_usd REAL, log TEXT)`; // esquema §2.1 del diseño; la tabla real es de T54a
const d = (hm: string) => `2026-11-19T${hm}:00.000Z`;

function setup() {
  const c = claimed(), a = c.claim();
  c.adm.db.exec(T_SCHEMA);
  const sess = (gen: number, status = 'open', lost: string | null = null) => c.adm.db.query(
    "INSERT INTO adm_sessions(change_id, kind, generation, session_id, backend, cwd, status, lost_reason, created_at, model) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(c.change.id, a.kind, gen, `s${gen}`, 'claude', '/w', status, lost, d('09:00'), gen === 1 ? 'sonnet' : null);
  const turn = (id: string, gen: number, plan: string, from: string, to: string | null, outcome: string | null, act = a.id) => c.adm.db.query(
    'INSERT INTO adm_turns(attempt_id, activity_id, change_id, session_id, generation, plan, started_at, ended_at, outcome, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, act, c.change.id, `s${gen}`, gen, plan, d(from), to ? d(to) : null, outcome, to ? 1000 : null);
  const question = (id: string, asked: string, status: string, answeredAt: string | null, act = a.id) => c.adm.db.query(
    "INSERT INTO adm_questions(id, activity_id, change_id, text, status, asked_at, answered_at, answer, answered_by) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, act, c.change.id, `¿${id}?`, status, d(asked), answeredAt ? d(answeredAt) : null, answeredAt ? 'rojo' : null, answeredAt ? 'maint' : null);
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

  const t = changeTimeline(s.store.db, s.change.id);
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
  const t = changeTimeline(s.store.db, s.change.id);
  expect(t.segments.map(x => [x.kind, x.to])).toEqual([['trabajo', d('10:10')], ['espera_persona', null], ['trabajo', null]]);
});

test('base sin tablas adm_*: sin_tablas, y la lectura no las crea', () => {
  const store = new Store(':memory:'), before = store.db.query('SELECT name FROM sqlite_master ORDER BY name').all();
  expect(changeTimeline(store.db, 'c')).toEqual({ state: 'sin_tablas', turns: [], segments: [], sessions: [], omitted: 0 });
  expect(store.db.query('SELECT name FROM sqlite_master ORDER BY name').all()).toEqual(before);
});

test('adm_sessions sin adm_turns (base anterior a T54): sesiones y preguntas presentes, sin turnos, sin crear la tabla', () => {
  const s = setup(); s.adm.db.exec('DROP TABLE adm_turns'); s.sess(1); s.question('q1', '10:10', 'answered', '11:00');
  const t = changeTimeline(s.store.db, s.change.id);
  expect(t).toMatchObject({ state: 'sin_turnos', turns: [], sessions: [{ generation: 1 }], segments: [{ kind: 'espera_persona' }] });
  expect(s.store.db.query("SELECT 1 FROM sqlite_master WHERE name = 'adm_turns'").get()).toBeNull();
});

test('500 turnos: devuelve los 200 más recientes y omitted = 300', () => {
  const s = setup(); s.sess(1);
  const ins = s.adm.db.query('INSERT INTO adm_turns(attempt_id, activity_id, change_id, session_id, generation, plan, started_at, ended_at, outcome) VALUES (?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 500; i++) { const at = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(); ins.run(`t${i}`, s.a.id, s.change.id, 's1', 1, 'retry', at, at, 'done'); }
  const t = changeTimeline(s.store.db, s.change.id);
  expect(t.turns).toHaveLength(200); expect(t.omitted).toBe(300);
  expect(t.turns[0]!.attemptId).toBe('t300'); expect(t.turns[199]!.attemptId).toBe('t499');
});

const segs = (t: ReturnType<typeof changeTimeline>) => t.segments.map(x => [x.kind, x.from.slice(11, 16), x.to?.slice(11, 16) ?? null]);
const closeAct = (s: ReturnType<typeof setup>, at: string) => s.adm.db.query('UPDATE activities SET completed_at = ?, status = ? WHERE id = ?').run(d(at), 'failed', s.a.id);

test('H1: un change no ve turnos, preguntas ni sesiones de otro', () => {
  const s = setup(); s.sess(1); s.turn('t1', 1, 'fresh', '10:00', '10:10', 'awaiting');
  s.adm.db.query("INSERT INTO adm_sessions(change_id, kind, generation, session_id, backend, cwd, status, created_at) VALUES ('otro',?,7,'sx','claude','/w','open',?)").run(s.a.kind, d('09:00'));
  s.adm.db.query("INSERT INTO adm_turns(attempt_id, activity_id, change_id, session_id, generation, plan, started_at, ended_at, outcome) VALUES ('ox',?,'otro','sx',7,'fresh',?,?,'awaiting')").run(s.a.id, d('10:30'), d('10:40'));
  s.adm.db.query("INSERT INTO adm_questions(id, activity_id, change_id, text, status, asked_at) VALUES ('qx',?,'otro','secreto','open',?)").run(s.a.id, d('10:40'));
  const t = changeTimeline(s.store.db, s.change.id);
  expect(t.turns.map(x => x.attemptId)).toEqual(['t1']); expect(t.turns[0]!.question).toBeNull();
  expect(t.sessions.map(x => x.generation)).toEqual([1]); expect(segs(t)).toEqual([['trabajo', '10:00', '10:10']]);
});

test('H2: pregunta cancelada cuya activity se cierra tras el turno siguiente: la espera acaba al empezar ese turno, sin tramos invertidos', () => {
  const s = setup(); s.sess(1);
  s.turn('t1', 1, 'fresh', '10:00', '10:10', 'awaiting'); s.question('q1', '10:10', 'canceled', null);
  s.turn('t2', 1, 'retry', '11:00', '11:30', 'done'); closeAct(s, '11:30');
  const t = changeTimeline(s.store.db, s.change.id);
  expect(segs(t)).toEqual([['trabajo', '10:00', '10:10'], ['espera_persona', '10:10', '11:00'], ['cola', '11:00', '11:00'], ['trabajo', '11:00', '11:30']]);
  expect(t.segments.every(x => x.to === null || x.to >= x.from)).toBe(true);
});

test('H7: pregunta vencida sin turno posterior: bloqueo abierto, no cola', () => {
  const s = setup(); s.sess(1); s.turn('t1', 1, 'fresh', '10:00', '10:10', 'awaiting'); s.question('q1', '10:10', 'expired', null); closeAct(s, '13:00');
  expect(segs(changeTimeline(s.store.db, s.change.id))).toEqual([['trabajo', '10:00', '10:10'], ['espera_persona', '10:10', '13:00'], ['bloqueo', '13:00', null]]);
});

test('H3: la pregunta se asigna al turno de su activity que la hizo, no a otra activity ni a un turno anterior', () => {
  const s = setup(); s.sess(1);
  s.turn('a0', 1, 'fresh', '09:00', '09:10', 'awaiting'); s.question('qa0', '09:10', 'answered', '09:50');
  s.turn('b0', 1, 'fresh', '09:05', '09:20', 'awaiting', 'act-b'); s.question('qb', '09:15', 'answered', '09:55', 'act-b');
  s.turn('a1', 1, 'answer', '10:00', '10:10', 'done');
  s.turn('a2', 1, 'retry', '11:00', '11:10', 'awaiting'); s.question('qa2', '11:10', 'open', null);
  const q = Object.fromEntries(changeTimeline(s.store.db, s.change.id).turns.map(x => [x.attemptId, x.question?.id ?? null]));
  expect(q).toEqual({ a0: 'qa0', b0: 'qb', a1: null, a2: 'qa2' });
});

test('H4: solo las notas entregadas de este change y de ese intento', () => {
  const s = setup(); s.sess(1); s.turn('t1', 1, 'fresh', '10:00', '10:10', 'done'); s.turn('t2', 1, 'retry', '11:00', '11:10', 'done');
  const other = s.store.createChange(s.change.workstreamId, 'otro', 'd').id;
  s.adm.db.exec(`INSERT INTO change_notes (id, change_id, body, actor, attempt_id, delivered_at, created_at) VALUES ('n1','${s.change.id}','uno','dueño','t1','${d('10:00')}','${d('09:00')}'),
      ('n2','${s.change.id}','sin entregar','dueño','t1',NULL,'${d('09:01')}'),
      ('n3','${s.change.id}','tres','dueño','t2','${d('11:00')}','${d('09:02')}'),
      ('n4','${other}','ajena','dueño','t1','${d('10:00')}','${d('09:03')}')`);
  const t = changeTimeline(s.store.db, s.change.id);
  expect(t.turns.map(x => x.notes.map(n => n.id))).toEqual([['n1'], ['n3']]);
});

test('H5: el report de un turno es el más reciente de su intento', () => {
  const s = setup(); s.sess(1); s.turn('t1', 1, 'fresh', '10:00', '10:10', 'done');
  const ins = s.adm.db.query("INSERT INTO adm_reports(attempt_id, activity_id, state, summary, created_at) VALUES ('t1',?,?,?,?)");
  ins.run(s.a.id, 'awaiting', 'viejo', d('10:05')); ins.run(s.a.id, 'done', 'nuevo', d('10:09'));
  expect(changeTimeline(s.store.db, s.change.id).turns[0]!.report).toEqual({ state: 'done', summary: 'nuevo' });
});

test('H6: pregunta cancelada cierra la espera con la activity', () => {
  const s = setup(); s.sess(1); s.turn('t1', 1, 'fresh', '10:00', '10:10', 'awaiting'); s.question('q1', '10:10', 'canceled', null); closeAct(s, '10:30');
  expect(segs(changeTimeline(s.store.db, s.change.id))).toContainEqual(['espera_persona', '10:10', '10:30']);
});

test('H6: turno interrumpido seguido de otro: sin cola tras el interrumpido', () => {
  const s = setup(); s.sess(1); s.turn('t1', 1, 'fresh', '10:00', null, null); s.question('q1', '10:05', 'answered', '10:50'); s.turn('t2', 1, 'orphan', '11:00', '11:10', 'done');
  s.adm.db.query('UPDATE activities SET status = ? WHERE id = ?').run('failed', s.a.id);
  expect(segs(changeTimeline(s.store.db, s.change.id))).toEqual([['interrumpido', '10:00', '11:00'], ['espera_persona', '10:05', '10:50'], ['trabajo', '11:00', '11:10']]);
});

test('H6: último turno terminado sin pregunta ni turno siguiente: sin cola', () => {
  const s = setup(); s.sess(1); s.turn('t1', 1, 'fresh', '10:00', '10:10', 'done');
  expect(segs(changeTimeline(s.store.db, s.change.id))).toEqual([['trabajo', '10:00', '10:10']]);
});

test('H6: con más de 200 turnos no se muestran esperas anteriores al primero mostrado', () => {
  const s = setup(); s.sess(1);
  const ins = s.adm.db.query('INSERT INTO adm_turns(attempt_id, activity_id, change_id, session_id, generation, plan, started_at, ended_at, outcome) VALUES (?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 201; i++) { const at = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(); ins.run(`t${i}`, s.a.id, s.change.id, 's1', 1, 'retry', at, at, 'done'); }
  s.adm.db.query("INSERT INTO adm_questions(id, activity_id, change_id, text, status, asked_at) VALUES ('viejo',?,?,'?','open','2026-01-01T00:00:30.000Z')").run(s.a.id, s.change.id);
  const t = changeTimeline(s.store.db, s.change.id);
  expect(t.omitted).toBe(1); expect(t.segments.some(x => x.kind === 'espera_persona')).toBe(false);
});

test('H6: dos turnos con el mismo started_at conservan el orden de inserción', () => {
  const s = setup(); s.sess(1); s.turn('ta', 1, 'fresh', '10:00', '10:10', 'done'); s.turn('tb', 1, 'retry', '10:00', '10:20', 'done');
  expect(changeTimeline(s.store.db, s.change.id).turns.map(x => x.attemptId)).toEqual(['ta', 'tb']);
});
