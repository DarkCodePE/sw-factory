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
