import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdmissionDb } from '../src/admission/db.ts';
import { SessionStore } from '../src/admission/sessions.ts';
import { processActivity, runPool } from '../src/pool.ts';
import { Store } from '../src/store.ts';
import { fakeLive } from './helpers/live.ts';

let dir: string, repo: string, store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-live-'));
  repo = join(dir, 'repo');
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  for (const args of [['add', '.'], ['commit', '-qm', 'init']]) Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);
  store = new Store(join(dir, 'f.db'));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const setup = () => {
  const ws = store.createWorkstream({ slug: 'p', goal: 'g', repo, agent: 'fake', requireChangeApproval: false });
  store.setWorkstreamState(ws.id, 'active');
  return { ws, c: store.createChange(ws.id, 'fix it', 'desc') };
};
const pool = (ws: string, liveBackends: Record<string, ReturnType<typeof fakeLive>> | undefined, extra: object = {}) =>
  runPool(store, { workstream: ws, stateDir: dir, untilIdle: true, log: () => {}, live: !!liveBackends, liveBackends, ...extra });

test('rama viva: la sesión se escribe antes de lanzar, el report manda y la activity se cierra con el report aplicado', async () => {
  const { ws, c } = setup(), backend = fakeLive([{ reports: [{ state: 'done', summary: 'spec lista' }], output: 'texto final' }]);
  await pool(ws.id, { fake: backend });
  const [inv] = store.listActivities({ changeId: c.id });
  expect(inv).toMatchObject({ status: 'completed', result: 'texto final' });
  expect(backend.turns).toHaveLength(1);
  const adm = new AdmissionDb(store), s = new SessionStore(adm).current(c.id, 'investigation')!;
  expect(s).toMatchObject({ launched: true, generation: 1, backend: 'fake', sessionId: backend.turns[0]!.newSessionId });
  expect(backend.turns[0]!.prompt).toContain('mcp__fab__report'); // el agente sabe que existe la tool
  expect(adm.db.query('SELECT applied_at FROM adm_reports').all()).toEqual([{ applied_at: expect.any(String) }]);
});

test('sin --live (o con un adaptador sin backend vivo) el camino de un disparo sigue intacto', async () => {
  const { ws, c } = setup(), backend = fakeLive([{ reports: [{ state: 'blocked', summary: 'no' }] }]);
  await runPool(store, { workstream: ws.id, stateDir: dir, untilIdle: true, log: () => {}, liveBackends: { fake: backend } }); // live: undefined
  expect(backend.turns).toHaveLength(0);
  expect(store.listActivities({ changeId: c.id })[0]).toMatchObject({ status: 'completed' });
  expect(store.db.query("SELECT name FROM sqlite_master WHERE name = 'adm_sessions'").get()).toBeNull(); // ni siquiera se crean las tablas
});

test('awaiting: la activity espera con su pregunta, libera el slot y encola el efecto reply', async () => {
  const { ws, c } = setup(), backend = fakeLive([{ reports: [{ state: 'awaiting', summary: 'sin datos', human_action: '¿qué color?' }] }]);
  await pool(ws.id, { fake: backend });
  const [inv] = store.listActivities({ changeId: c.id });
  expect(inv).toMatchObject({ status: 'waiting_reply', questionId: expect.stringMatching(/^q-/) });
  expect(store.getChange(c.id).status).toBe('in_progress');
  const adm = new AdmissionDb(store);
  expect(adm.db.query('SELECT text, status FROM adm_questions').all()).toEqual([{ text: '¿qué color?', status: 'open' }]);
  expect(adm.db.query('SELECT kind, status FROM adm_effects').all()).toEqual([{ kind: 'reply', status: 'pending' }]);
});

test('sin report el turno vivo falla como hoy (missing), y un report blocked bloquea', async () => {
  const { ws, c } = setup();
  await pool(ws.id, { fake: fakeLive([{ output: 'sin STATUS' }]) });
  expect(store.listActivities({ changeId: c.id })[0]?.status).not.toBe('completed');
  const second = setup2();
  await pool(second.ws.id, { fake: fakeLive([{ reports: [{ state: 'blocked', summary: 'falta acceso' }] }]) });
  expect(store.listActivities({ changeId: second.c.id })[0]).toMatchObject({ status: 'blocked', error: 'falta acceso' });
  function setup2() {
    const ws2 = store.createWorkstream({ slug: 'q', goal: 'g', repo, agent: 'fake', requireChangeApproval: false });
    store.setWorkstreamState(ws2.id, 'active');
    return { ws: ws2, c: store.createChange(ws2.id, 't', 'd') };
  }
});

test('A5: un worker ajeno no consume el report done: nada se cierra ni se marca aplicado', async () => {
  const { ws, c } = setup(), backend = fakeLive([{ reports: [{ state: 'done', summary: 'ok' }], before: () => { /* el lease pasa a otro */
    store.db.query("UPDATE activities SET worker_id = 'otro' WHERE change_id = ?").run(c.id); } }]);
  await processActivity(store, store.claimActivity(ws.id, 'w1')!, 'w1', { workstream: ws.id, stateDir: dir, log: () => {}, live: true, liveBackends: { fake: backend } });
  expect(new AdmissionDb(store).db.query('SELECT applied_at FROM adm_reports').all()).toEqual([{ applied_at: null }]);
  expect(store.listActivities({ changeId: c.id })[0]?.status).not.toBe('completed');
});

// ---- S3: sesión perdida ------------------------------------------------------------------------------------------------
import { answerQuestion } from '../src/admission/answers.ts';
import { resetSessionCap } from '../src/admission/sessions.ts';

/** Primer turno pregunta y la persona responde: la activity queda pending con la respuesta por entregar. */
async function asked(backend: ReturnType<typeof fakeLive>) {
  const { ws, c } = setup();
  await pool(ws.id, { fake: backend });
  const adm = new AdmissionDb(store), q = adm.db.query('SELECT id FROM adm_questions').get() as { id: string };
  expect(answerQuestion(store, adm, { questionId: q.id, answer: 'rojo', by: 'maint' })).toBe('answered');
  return { ws, c, adm };
}
const ASK = { reports: [{ state: 'awaiting' as const, summary: 's', human_action: '¿color?' }] };
const DONE = { reports: [{ state: 'done' as const, summary: 'listo' }], output: 'hecho' };

test('S3: la sesión no existe al reanudar → nueva generación con el prompt reconstruido, con evento y sin sesión nueva en silencio', async () => {
  const backend = fakeLive([ASK, DONE, DONE]), { ws, c, adm } = await asked(backend);
  backend.known.clear(); // el harness olvidó la sesión
  await pool(ws.id, { fake: backend });
  expect(backend.turns).toHaveLength(3);
  expect(backend.turns[1]!.sessionId).toBeDefined(); // se intentó reanudar primero
  expect(backend.turns[2]!.sessionId).toBeUndefined(); // y solo entonces, sesión nueva con id fijado por la fab
  expect(backend.turns[2]!.newSessionId).not.toBe(backend.turns[1]!.sessionId);
  expect(backend.turns[2]!.prompt).toContain('Answer (maint): rojo'); // la respuesta ya dada viaja en el prompt reconstruido
  expect(backend.turns[2]!.prompt).toContain('previous session for this activity was lost');
  expect(adm.db.query('SELECT generation, status FROM adm_sessions ORDER BY generation').all()).toEqual([{ generation: 1, status: 'lost' }, { generation: 2, status: 'open' }]);
  expect(store.listEvents('p').some(e => e.severity === 'warning' && /perdida.*generación 2/.test(String(e.message)))).toBe(true);
  expect(store.listActivities({ changeId: c.id })[0]?.status).toBe('completed');
});

test('S3: un error transitorio no abre sesión nueva: la activity reintenta con la misma', async () => {
  const backend = fakeLive([ASK, { error: new Error('429 rate limit') }, DONE]), { ws } = await asked(backend);
  await pool(ws.id, { fake: backend });
  const adm = new AdmissionDb(store);
  expect(adm.db.query('SELECT generation, status FROM adm_sessions').all()).toEqual([{ generation: 1, status: 'open' }]);
  expect(backend.turns[2]!.sessionId).toBe(backend.turns[0]!.newSessionId); // el reintento reanuda la misma sesión
});

test('S3 + A6: agotado el tope la activity falla; fab retry lo reinicia y deja un evento', async () => {
  const backend = fakeLive([ASK, { error: new SessionNotFoundErrorLike() }]), { ws, c, adm } = await asked(backend);
  for (let i = 0; i < 3; i++) await pool(ws.id, { fake: backend });
  expect(store.getChange(c.id).status).toBe('failed');
  expect(store.listActivities({ changeId: c.id })[0]?.error).toMatch(/tope/);
  const before = adm.db.query('SELECT MAX(generation) g FROM adm_sessions').get() as { g: number };
  store.retryChange(c.id);
  expect(resetSessionCap(store, adm, c.id)).toBe(1);
  expect(store.listEvents('p').some(e => /tope de generaciones de sesión reiniciado/.test(String(e.message)))).toBe(true);
  backend.steps.splice(0, backend.steps.length, DONE); backend.known.clear();
  await pool(ws.id, { fake: backend });
  expect(store.getChange(c.id).status).not.toBe('failed'); // el reintento humano pudo abrir una generación más
  expect((adm.db.query('SELECT MAX(generation) g FROM adm_sessions').get() as { g: number }).g).toBe(before.g + 1); // B8: se abrió exactamente una generación
});
class SessionNotFoundErrorLike extends (await import('../src/live/contract.ts')).SessionNotFoundError { constructor() { super('s', 'gone'); } }

// ---- S4: turno huérfano ------------------------------------------------------------------------------------------------
import { CrashInjected, type CrashPoint } from '../src/admission/effects.ts';

const once = (point: CrashPoint) => { let fired = false; return (p: CrashPoint) => { if (p === point && !fired) { fired = true; throw new CrashInjected(p); } }; };
const future = () => new Date(Date.now() + 3_600_000).toISOString();
/** Mata el pool en `point`, deja vencer el lease y devuelve lo necesario para reiniciar. */
async function killedAt(point: CrashPoint, backend: ReturnType<typeof fakeLive>) {
  const { ws, c } = setup();
  await expect(pool(ws.id, { fake: backend }, { crash: once(point) })).rejects.toThrow(CrashInjected);
  expect(store.listActivities({ changeId: c.id })[0]?.status).toBe('in_progress'); // una caída real no deja ni un fallo registrado
  store.requeueOrphans(ws.id, future());
  return { ws, c, adm: new AdmissionDb(store) };
}

test('S4: el pool muere con el report ya guardado → se aplica en vez de reejecutar (no se lanza ningún agente)', async () => {
  const backend = fakeLive([ASK]), { ws, c, adm } = await killedAt('turn-ended', backend);
  expect(backend.turns).toHaveLength(1);
  await pool(ws.id, { fake: backend });
  expect(backend.turns).toHaveLength(1); // el segundo claim no lanzó nada
  expect(store.listActivities({ changeId: c.id })[0]).toMatchObject({ status: 'waiting_reply' });
  expect(adm.db.query('SELECT status FROM adm_questions').all()).toEqual([{ status: 'open' }]);
});

test('S4: un report done guardado antes de morir cierra la activity sin relanzar', async () => {
  const backend = fakeLive([DONE]), { ws, c } = await killedAt('report-recorded', backend);
  await pool(ws.id, { fake: backend });
  expect(backend.turns).toHaveLength(1);
  expect(store.listActivities({ changeId: c.id })[0]?.status).toBe('completed');
});

test('S4: sin report, el turno huérfano reanuda con «continúa» (no con el prompt inicial); una sesión que nunca arrancó cae en sesión perdida', async () => {
  const backend = fakeLive([DONE]), { ws, c, adm } = await killedAt('session-launched', backend);
  await pool(ws.id, { fake: backend });
  expect(backend.turns).toHaveLength(2); // 1: reanudar la sesión inexistente (NotFound); 2: generación nueva reconstruida
  expect(backend.turns[0]!.prompt).toContain('interrupted before it finished');
  expect(backend.turns[0]!.prompt).not.toContain('# Workstream goal');
  expect(adm.db.query('SELECT generation, status FROM adm_sessions ORDER BY generation').all()).toEqual([{ generation: 1, status: 'lost' }, { generation: 2, status: 'open' }]);
  expect(store.listActivities({ changeId: c.id })[0]?.status).toBe('completed');
});

test('S4/M5: un report done de un intento que el pool falla (sin commits) se descarta: el reintento vuelve a lanzar en vez de reaplicarlo', async () => {
  // Con el adaptador «claude» una implementación sin commits falla (con «fake» está exenta).
  const ws = store.createWorkstream({ slug: 'cl', goal: 'g', repo, agent: 'claude', requireChangeApproval: false, requireApproval: false });
  store.setWorkstreamState(ws.id, 'active');
  const c = store.createChange(ws.id, 't', 'd'), backend = fakeLive([DONE], { name: 'claude' });
  await runPool(store, { workstream: ws.id, stateDir: dir, untilIdle: true, log: () => {}, live: true, liveBackends: { claude: backend }, acceptAgentBinaries: true });
  const impl = store.listActivities({ changeId: c.id }).find(a => a.kind === 'implementation')!;
  expect(impl.status).toBe('failed');
  expect(backend.turns.length).toBe(1 + 3); // investigación + 3 intentos que lanzaron de verdad (sin descarte serían 1 + 1: se reaplicaría el report viejo)
});

// ---- verificación de Fable (H1, H2, M1, M2, M5, B3, B4) ---------------------------------------------------------------------
import { ReportStore } from '../src/admission/reports.ts';
import { claimed } from './helpers/live.ts';

test('H1: tras fab retry el turno vivo recibe el motivo del fallo anterior, no «tu turno se interrumpió»', async () => {
  const { ws, c } = setup(), backend = fakeLive([{ reports: [{ state: 'blocked', summary: 'GATES_FAIL tests rojos' }] }, DONE]);
  await pool(ws.id, { fake: backend });
  expect(store.getChange(c.id).status).toBe('blocked');
  store.retryChange(c.id);
  await pool(ws.id, { fake: backend });
  expect(backend.turns[1]!.prompt).toContain('GATES_FAIL tests rojos');
  expect(backend.turns[1]!.prompt).not.toContain('interrupted before it finished');
});

test('H2: si el turno que lleva la respuesta falla con un error transitorio, el reintento vuelve a entregarla', async () => {
  const backend = fakeLive([ASK, { error: new Error('429 rate limit') }, DONE]), { ws } = await asked(backend);
  await pool(ws.id, { fake: backend });
  expect(backend.turns[1]!.prompt).toBe('rojo');
  expect(backend.turns[2]!.prompt).toBe('rojo'); // la sesión nunca vio la respuesta: no se da por entregada
  expect(new AdmissionDb(store).db.query('SELECT delivered_at FROM adm_questions').get()).toEqual({ delivered_at: expect.any(String) }); // sí tras el turno que acabó
});

test('M1: un pool sin --live no ejecuta de un disparo una activity con sesión viva: la bloquea con motivo', async () => {
  const backend = fakeLive([ASK, DONE]), { ws, c } = await asked(backend);
  await runPool(store, { workstream: ws.id, stateDir: dir, untilIdle: true, log: () => {} }); // sin --live
  expect(backend.turns).toHaveLength(1);
  expect(store.listActivities({ changeId: c.id })[0]).toMatchObject({ status: 'blocked' });
  expect(store.listActivities({ changeId: c.id })[0]?.error).toContain('LIVE_SESSION_REQUIRED');
});

test('M2: un huérfano con un report guardado por aplicar no gasta un reintento y se aplica después', () => {
  const t = claimed();
  let a = t.claim();
  for (let i = 0; i < 2; i++) { t.store.failActivity(a.id, 'w1', 'x'); a = t.claim(); } // retry_count = 2
  new ReportStore(t.adm).recorder(a.id, 'att-1')({ state: 'awaiting', summary: 's', human_action: '¿color?' });
  expect(t.store.requeueOrphans('ws', future(), id => new ReportStore(t.adm).pending(id) !== undefined)).toBe(0);
  expect(t.store.getActivity(a.id)).toMatchObject({ status: 'pending', retryCount: 2 });
  expect(t.claim('w2').id).toBe(a.id);
  // sin el filtro, el mismo caso agota los reintentos y pierde la pregunta
  const u = claimed(); let b = u.claim();
  for (let i = 0; i < 2; i++) { u.store.failActivity(b.id, 'w1', 'x'); b = u.claim(); }
  u.store.requeueOrphans('ws', future());
  expect(u.store.getActivity(b.id).status).toBe('failed');
});

test('B4: --live con un adaptador sin backend vivo avisa al arrancar', async () => {
  const { ws } = setup(), logs: string[] = [];
  await runPool(store, { workstream: ws.id, stateDir: dir, untilIdle: true, log: m => logs.push(m), live: true });
  expect(logs.some(m => m.includes('no tiene backend vivo'))).toBe(true);
});

test('B3: el pool crea el AdmissionDb una vez, no en cada vuelta del bucle', async () => {
  const backend = fakeLive([ASK]), { ws, c } = setup();
  await pool(ws.id, { fake: backend });
  void c;
  // un worker ajeno tiene otra activity con lease corto: el pool da varias vueltas esperando
  const c2 = store.createChange(ws.id, 'otra', 'd');
  store.claimActivity(ws.id, 'ajeno', 400); void c2;
  let schemaRuns = 0; const exec = store.db.exec.bind(store.db);
  (store.db as { exec: unknown }).exec = (sql: string) => { if (sql.includes('adm_effects')) schemaRuns++; return exec(sql); };
  await pool(ws.id, { fake: fakeLive([DONE]) }, { pollMs: 20 });
  expect(schemaRuns).toBeLessThanOrEqual(3); // 1 en runPool + 1 por activity procesada (antes: una por vuelta, decenas)
});
