import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerQuestion } from '../src/admission/answers.ts';
import { AdmissionDb } from '../src/admission/db.ts';
import { CrashInjected, type CrashPoint } from '../src/admission/effects.ts';
import { processActivity } from '../src/pool.ts';
import { Store } from '../src/store.ts';
import { fakeLive } from './helpers/live.ts';

const DONE = { state: 'done', summary: 'spec lista' } as const;
const ASK = { state: 'awaiting', summary: 'falta el color', human_action: '¿Color?' } as const;
const done = () => ({ reports: [DONE] });
let dir: string, repo: string, stateDir: string, store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-live-turns-'));
  repo = join(dir, 'repo');
  stateDir = join(dir, 'state');
  for (const args of [['init', '-q', '-b', 'main', repo], ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'init']]) {
    const result = Bun.spawnSync(['git', ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
  store = new Store(join(dir, 'fab.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup(slug = 'p') {
  const ws = store.createWorkstream({ slug, goal: 'g', repo, agent: 'fake', requireChangeApproval: false });
  store.setWorkstreamState(ws.id, 'active');
  const change = store.createChange(ws.id, 'turnos', 'prueba');
  const adm = new AdmissionDb(store);
  const run = async (backend: ReturnType<typeof fakeLive>, crash?: (point: CrashPoint) => void) => {
    const activity = store.claimActivity(ws.id, 'w1')!;
    await processActivity(store, activity, 'w1', {
      workstream: ws.id, stateDir, live: true, liveBackends: { fake: backend }, log: () => {}, crash,
    });
    return store.getActivity(activity.id);
  };
  const turns = () => store.db.query('SELECT * FROM adm_turns WHERE change_id = ? ORDER BY rowid').all(change.id);
  const recovered = () => store.requeueOrphans(ws.id, '9999-01-01T00:00:00.000Z', () => true);
  const answer = (questionId: string) => expect(answerQuestion(store, adm, { questionId, answer: 'rojo', by: 'maint' })).toBe('answered');
  return { change, run, turns, recovered, answer };
}

test('T54a registra el turno antes del backend y al terminar guarda el report, los datos del proceso y su log', async () => {
  const { change, run, turns } = setup();
  const token = 'ghp_' + 'x'.repeat(36); // marcador sintético
  let started: unknown[] = [];
  let launched: unknown;
  const backend = fakeLive([{ ...done(), before: turn => {
    started = turns();
    launched = store.db.query('SELECT launched_at FROM adm_sessions WHERE session_id = ?').get(turn.newSessionId!);
  } }]);
  const fakeRun = backend.run;
  backend.run = async turn => ({
    ...await fakeRun(turn), exitCode: 7, durationMs: 42, usage: { costUsd: 0.125, inputTokens: 1, outputTokens: 2 },
    stdout: 'salida del turno\n', stderr: `aviso ${token}\n`,
  });
  const activity = await run(backend);
  expect(store.db.query('SELECT count(*) AS n FROM adm_turns').get()).toEqual({ n: 1 });
  const turn = backend.turns[0]!;
  expect(started).toEqual([expect.objectContaining({
    attempt_id: turn.attemptId, session_id: turn.newSessionId, generation: 1, plan: 'fresh',
    started_at: expect.any(String), ended_at: null, outcome: null, log: null,
  })]);
  expect(launched).toEqual({ launched_at: expect.any(String) });
  const log = `${activity.id}.t-${turn.attemptId}.log`;
  expect(turns()).toEqual([{
    attempt_id: backend.turns[0]!.attemptId, activity_id: activity.id, change_id: change.id,
    session_id: backend.turns[0]!.newSessionId, generation: 1, plan: 'fresh', question_id: null,
    started_at: expect.any(String), ended_at: expect.any(String), outcome: 'done',
    exit_code: 7, duration_ms: 42, cost_usd: 0.125, log,
  }]);
  expect(store.db.query('SELECT attempt_id FROM adm_reports').get()).toEqual({ attempt_id: backend.turns[0]!.attemptId });
  expect(readFileSync(join(stateDir, 'runs', change.id, log), 'utf8')).toBe('salida del turno\n\n[stderr]\naviso [REDACTED]\n');
  expect(existsSync(join(stateDir, 'runs', change.id, `${activity.id}.log`))).toBe(true);
  expect(activity.status).toBe('completed');
});

test('T54a guarda no_report aunque el proceso devuelva STATUS done y deja el coste desconocido en NULL', async () => {
  const { run, turns } = setup();
  const backend = fakeLive([{}]);
  const fakeRun = backend.run;
  backend.run = async turn => ({ ...await fakeRun(turn), status: { kind: 'done', reason: '' } });
  expect((await run(backend)).status).toBe('completed');
  expect(turns()).toEqual([expect.objectContaining({ outcome: 'no_report', ended_at: expect.any(String), exit_code: 0, cost_usd: null })]);
});

test('T54a registra el último report y conserva un coste medido de cero', async () => {
  const { run, turns } = setup();
  const backend = fakeLive([{ reports: [DONE, { state: 'blocked', summary: 'falta permiso' }] }]);
  const fakeRun = backend.run;
  backend.run = async turn => ({ ...await fakeRun(turn), usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 } });
  expect((await run(backend)).status).toBe('blocked');
  expect(turns()).toEqual([expect.objectContaining({ outcome: 'blocked', cost_usd: 0 })]);
});

test('T54a conserva el resultado si falla la escritura del log de turno', async () => {
  const { change, run, turns } = setup();
  const [activity] = store.listActivities({ changeId: change.id });
  const backend = fakeLive([{ ...done(), before: turn => {
    // Una carpeta en el destino hace que falle el rename del log, sin tocar el log de la activity.
    mkdirSync(join(stateDir, 'runs', change.id, `${activity!.id}.t-${turn.attemptId}.log`));
  } }]);
  expect((await run(backend)).status).toBe('completed');
  expect(turns()).toEqual([expect.objectContaining({ outcome: 'done', ended_at: expect.any(String), log: null })]);
});

test('T54a enlaza la respuesta y mantiene la sesión de la pregunta', async () => {
  const { run, turns, answer } = setup();
  const backend = fakeLive([{ reports: [ASK] }, done()]);
  const waiting = await run(backend);
  answer(waiting.questionId!);
  await run(backend);
  const session_id = backend.turns[0]!.newSessionId;
  expect(turns()).toEqual([
    expect.objectContaining({ plan: 'fresh', outcome: 'awaiting', session_id, generation: 1, question_id: null }),
    expect.objectContaining({ plan: 'answer', outcome: 'done', session_id, generation: 1, question_id: waiting.questionId }),
  ]);
});

test('T54a cierra el intento de reanudación perdido y registra por separado la reconstrucción', async () => {
  const { run, turns, answer } = setup();
  const backend = fakeLive([{ reports: [ASK] }, done()]);
  const waiting = await run(backend);
  answer(waiting.questionId!);
  backend.known.clear();
  expect((await run(backend)).status).toBe('completed');
  const [first, lost, reconstructed] = backend.turns;
  expect(turns()).toEqual([
    expect.objectContaining({ attempt_id: first!.attemptId, outcome: 'awaiting' }),
    expect.objectContaining({
      attempt_id: lost!.attemptId, plan: 'answer', question_id: waiting.questionId, session_id: first!.newSessionId,
      generation: 1, outcome: 'session_lost', ended_at: expect.any(String), exit_code: null, duration_ms: null, cost_usd: null, log: null,
    }),
    expect.objectContaining({
      attempt_id: reconstructed!.attemptId, plan: 'reconstructed', question_id: waiting.questionId, session_id: reconstructed!.newSessionId,
      generation: 2, outcome: 'done', ended_at: expect.any(String),
    }),
  ]);
});

test('T54a registra el error transitorio y el turno de reintento con la misma sesión', async () => {
  const { run, turns } = setup();
  const backend = fakeLive([{ error: new Error('429 rate limit') }, done()]);
  expect((await run(backend)).status).toBe('pending');
  expect((await run(backend)).status).toBe('completed');
  const session_id = backend.turns[0]!.newSessionId;
  expect(turns()).toEqual([
    expect.objectContaining({ plan: 'fresh', outcome: 'error', session_id, ended_at: expect.any(String), log: null }),
    expect.objectContaining({ plan: 'retry', outcome: 'done', session_id }),
  ]);
});

test('T54a deja abierto el intento de un pool caído en session-launched y registra la recuperación como orphan', async () => {
  const { run, turns, recovered } = setup();
  const backend = fakeLive([done()]);
  await expect(run(backend, p => { if (p === 'session-launched') throw new CrashInjected(p); })).rejects.toThrow(CrashInjected);
  expect(backend.turns).toHaveLength(0);
  expect(turns()).toEqual([expect.objectContaining({ plan: 'fresh', ended_at: null, outcome: null })]);
  const interrupted = turns()[0];
  recovered();
  await run(backend);
  expect(turns()).toEqual([
    interrupted,
    expect.objectContaining({ plan: 'orphan', outcome: 'session_lost', generation: 1 }),
    expect.objectContaining({ plan: 'reconstructed', outcome: 'done', generation: 2 }),
  ]);
});

test('T54a aplica el report durable sin añadir un intento ni reescribir la fila interrumpida', async () => {
  const { run, turns, recovered } = setup();
  const backend = fakeLive([done()]);
  await expect(run(backend, p => { if (p === 'report-recorded') throw new CrashInjected(p); })).rejects.toThrow(CrashInjected);
  const before = turns();
  expect(before).toEqual([expect.objectContaining({ ended_at: null, outcome: null })]);
  recovered();
  expect((await run(backend)).status).toBe('completed');
  expect(backend.turns).toHaveLength(1);
  expect(turns()).toEqual(before);
});

for (const operation of ['INSERT INTO', 'UPDATE']) {
  test(`T54a conserva el resultado de la activity ante SQLITE_BUSY en ${operation} adm_turns`, async () => {
    const { run, turns } = setup();
    const control = await run(fakeLive([done()]));
    // Otro change en el mismo Store, con el mismo resultado pero contención solo en la sentencia de telemetría.
    const second = setup('control-busy');
    const query = store.db.query.bind(store.db);
    let attempts = 0;
    store.db.query = sql => {
      if (sql.startsWith(`${operation} adm_turns`)) {
        attempts++;
        throw Object.assign(new Error('contención inyectada'), { code: 'SQLITE_BUSY' });
      }
      return query(sql);
    };
    const backend = fakeLive([done()]);
    try {
      const result = await second.run(backend);
      expect(result).toMatchObject({ status: control.status, result: control.result, retryCount: control.retryCount });
    } finally {
      store.db.query = query;
    }
    expect(turns()).toHaveLength(1);
    expect(attempts).toBeGreaterThan(0);
    expect(backend.turns).toHaveLength(1);
    expect(second.turns()).toEqual(operation === 'UPDATE'
      ? [expect.objectContaining({ ended_at: null, outcome: null, log: null })]
      : []);
  });
}

for (const operation of ['INSERT INTO', 'UPDATE']) {
  test(`T54a H2/H3: un error de SQLite que no es de contención en ${operation} adm_turns no relanza el turno`, async () => {
    const { run, change } = setup();
    const query = store.db.query.bind(store.db);
    store.db.query = sql => {
      if (sql.startsWith(`${operation} adm_turns`)) throw Object.assign(new Error('disco lleno'), { code: 'SQLITE_FULL' });
      return query(sql);
    };
    const backend = fakeLive([done()]);
    try {
      expect((await run(backend)).status).toBe('completed');
    } finally {
      store.db.query = query;
    }
    expect(backend.turns).toHaveLength(1);
    expect(store.db.query('SELECT generation, status FROM adm_sessions WHERE change_id = ?').all(change.id)).toEqual([{ generation: 1, status: 'open' }]);
    expect(store.db.query("SELECT message FROM events WHERE change_id = ? AND message LIKE 'no se pudo registrar el turno%'").all(change.id))
      .toEqual([{ message: expect.stringContaining('disco lleno') }]);
  });
}

test('T54a abre una base de admisión anterior y añade adm_turns sin borrar sesiones', () => {
  const { change } = setup();
  store.db.exec('DROP TABLE IF EXISTS adm_turns');
  store.db.query("INSERT INTO adm_sessions(change_id, kind, generation, session_id, backend, cwd, created_at) VALUES (?, 'investigation', 1, 'legacy', 'fake', ?, ?)")
    .run(change.id, repo, store.now());
  store.close();
  store = new Store(join(dir, 'fab.db'));
  new AdmissionDb(store);
  expect(store.db.query('SELECT count(*) AS n FROM adm_turns').get()).toEqual({ n: 0 });
  expect(store.db.query('SELECT session_id FROM adm_sessions').all()).toEqual([{ session_id: 'legacy' }]);
});
