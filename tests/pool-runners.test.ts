// T74f: cableado de los runners en el pool. El transporte se inyecta hacia el runner falso (tests/helpers/fake-runner.ts).
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { processActivity, runPool, type PoolOptions } from '../src/pool.ts';
import { defaultProfile, saveProfile, validateProfile, type Profile } from '../src/profile.ts';
import type { Transport } from '../src/runners/client.ts';
import { Store } from '../src/store.ts';
import { runDirectory } from '../src/manifest.ts';
import { MAX_ACTIVITY_RETRIES } from '../src/enums.ts';

const FAKE = resolve(import.meta.dir, 'helpers/fake-runner.ts');
let dir: string, repo: string, fakeDir: string, store: Store;
const git = (cwd: string, ...a: string[]) => Bun.spawnSync(['git', ...a], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).stdout.toString().trim();
const fake = (scenario: string, report = 'STATUS: done\nhecho'): Transport => () => [process.execPath, FAKE, scenario, fakeDir, report];
const noSession = (): Transport => () => { throw new Error('se abrió una sesión'); };
const opts = (ws: string, over: Partial<PoolOptions> = {}): PoolOptions => ({ workstream: ws, stateDir: dir, untilIdle: true, pollMs: 5, log: () => {}, ...over });
const meta = (changeId: string, activityId: string) => JSON.parse(readFileSync(runDirectory(dir, changeId) + `/${activityId}.json`, 'utf8'));

function workstream(over: Record<string, unknown> = {}) {
  const ws = store.createWorkstream({ slug: 'w', goal: 'g', repo, agent: 'fake', requireChangeApproval: false, requireApproval: false, ...over });
  store.setWorkstreamState(ws.id, 'active');
  return ws;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-poolrun-'));
  repo = join(dir, 'repo'); fakeDir = join(dir, 'fake'); mkdirSync(fakeDir);
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  store = new Store(join(dir, 'f.db'));
  store.createRunner({ name: 'torre', kind: 'ssh', target: 'torre' });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test('runner ssh: investigación e implementación completas, commit importado y metadata con el nombre y lo declarado', async () => {
  const ws = workstream();
  store.setWorkstreamRunner(ws.id, 'torre');
  const c = store.createChange(ws.id, 'fix', 'desc');
  await runPool(store, opts(ws.id, { runnerTransport: fake('auto') }));
  const acts = store.listActivities({ changeId: c.id });
  expect(acts.map(a => [a.kind, a.status])).toEqual([['investigation', 'completed'], ['implementation', 'completed']]);
  for (const a of acts) {
    expect(store.getActivity(a.id).runner).toBe('torre');
    const m = meta(c.id, a.id);
    expect(m.runner).toMatchObject({ name: 'torre', kind: 'ssh', declared: { fabSha: 'fake123', sandbox: 'bwrap' } });
    expect(m.runner.jobId).toBe(`${a.id}-1`);
    expect(m.isolation).toContain('no verificado');
  }
  const branch = store.getChange(c.id).branch!;
  expect(git(repo, 'show', `${branch}:nuevo.txt`)).toBe('hola desde el runner');
  const events = store.listEvents(ws.id).map(e => String(e.message));
  expect(events.some(m => m.startsWith('encargo enviado al runner torre ('))).toBe(true);
  expect(events.some(m => /^resultado del runner torre importado \([0-9a-f]{8}\)$/.test(m))).toBe(true);
});

test('sin runner o con runner local sin confinar: nada cambia (ni runner en la actividad ni sesión remota)', async () => {
  const a = workstream({ slug: 'a' });
  const ca = store.createChange(a.id, 'x', 'd');
  await runPool(store, opts(a.id, { runnerTransport: noSession() }));
  expect(store.getChange(ca.id).status).toBe('implemented');
  expect(store.listActivities({ changeId: ca.id }).every(x => store.getActivity(x.id).runner === null)).toBe(true);
  store.createRunner({ name: 'casa', kind: 'local' });
  const b = workstream({ slug: 'b' });
  store.setWorkstreamRunner(b.id, 'casa');
  const cb = store.createChange(b.id, 'y', 'd');
  await runPool(store, opts(b.id, { runnerTransport: noSession() }));
  expect(store.getChange(cb.id).status).toBe('implemented');
  const [first] = store.listActivities({ changeId: cb.id });
  expect(store.getActivity(first!.id).runner).toBe('casa');
  expect(meta(cb.id, first!.id).runner).toEqual({ name: 'casa', kind: 'local' });
});

test('runner local con confine: la metadata dice bwrap-allowlist; con adaptador no confinable, bloqueada', async () => {
  store.createRunner({ name: 'sellado', kind: 'local', options: { confine: true } });
  const ws = workstream();
  store.setWorkstreamRunner(ws.id, 'sellado');
  const c = store.createChange(ws.id, 'x', 'd');
  await runPool(store, opts(ws.id));
  const [inv] = store.listActivities({ changeId: c.id });
  expect(meta(c.id, inv!.id).isolation).toBe('bwrap-allowlist');
  const w2 = workstream({ slug: 'otro', agent: 'agy' });
  store.setWorkstreamRunner(w2.id, 'sellado');
  const c2 = store.createChange(w2.id, 'x', 'd');
  await runPool(store, opts(w2.id, { acceptAgentBinaries: true }));
  const [blocked] = store.listActivities({ changeId: c2.id });
  expect(blocked!.status).toBe('blocked');
  expect(blocked!.error).toContain('RUNNER_NOT_CONFINABLE');
});

test('el binario del agente de un runner ssh no se comprueba en casa: un `claude` local con pin distinto no bloquea el encargo', async () => {
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'home'));
  writeFileSync(join(dir, 'bin', 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(dir, 'home', 'agents.json'), JSON.stringify({ agentBinaries: { claude: 'a'.repeat(64) } }));
  const saved = { PATH: process.env.PATH, FABRICA_HOME: process.env.FABRICA_HOME };
  process.env.PATH = `${join(dir, 'bin')}:${saved.PATH}`; process.env.FABRICA_HOME = join(dir, 'home');
  try {
    const ws = workstream({ agent: 'claude' });
    const c = store.createChange(ws.id, 'x', 'd');
    await runPool(store, opts(ws.id)).catch(() => {}); // control: en local, el pin distinto aborta el pool
    expect(store.listActivities({ changeId: c.id })).toHaveLength(1);
    expect(store.listActivities({ changeId: c.id })[0]!.status).toBe('pending');
    store.setWorkstreamRunner(ws.id, 'torre');
    await runPool(store, opts(ws.id, { runnerTransport: fake('auto') }));
    expect(store.getChange(c.id).status).toBe('implemented');
  } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('runner desactivado: RUNNER_DISABLED sin conectar y sin caer a local (R9, A10)', async () => {
  const ws = workstream();
  store.setWorkstreamRunner(ws.id, 'torre');
  store.setRunnerEnabled('torre', false);
  const c = store.createChange(ws.id, 'x', 'd');
  await runPool(store, opts(ws.id, { runnerTransport: noSession() }));
  const [a] = store.listActivities({ changeId: c.id });
  expect(a!.status).toBe('blocked');
  expect(a!.error).toContain('RUNNER_DISABLED');
  expect(existsSync(join(dir, 'fake', 'pid'))).toBe(false);
});

const failures: Array<[string, 'blocked' | 'pending', string]> = [  // [escenario, estado, código]; lost-bundle solo existe con cambios, así que corre en la implementación
  ['die', 'blocked', 'RUNNER_UNREACHABLE'],
  ['v2', 'blocked', 'RUNNER_REFUSED'],
  ['refuse:not_confinable', 'blocked', 'RUNNER_REFUSED'],
  ['evil-extra', 'blocked', 'RUNNER_RESULT_REJECTED'],
  ['bundle-bad-hash', 'blocked', 'RUNNER_RESULT_REJECTED'],
  ['lost-accepted', 'pending', 'RUNNER_LOST'],
  ['lost-bundle', 'pending', 'RUNNER_LOST'],
];
for (const [scenario, status, code] of failures) {
  test(`§4.7 ${scenario}: ${code} deja la activity ${status}; el worktree y el sitio no cambian (A10, A11)`, async () => {
    const ws = workstream();
    store.setWorkstreamRunner(ws.id, 'torre');
    const c = store.createChange(ws.id, 'x', 'd');
    const logs: string[] = [];
    // Una sola vuelta: un fallo reintentable se reencola y no se vuelve a lanzar.
    const o = opts(ws.id, { log: m => logs.push(m) });
    const turn = async (t: Transport) => {
      store.claimActivity(ws.id, 'w1');
      const act = store.listActivities({ changeId: c.id, status: 'in_progress' })[0]!;
      await processActivity(store, act, 'w1', { ...o, runnerTransport: t });
      return act;
    };
    if (scenario === 'lost-bundle') await turn(fake('auto'));
    const first = await turn(fake(scenario));
    const a = store.getActivity(first.id);
    expect(a.status).toBe(status);
    expect(a.error ?? '').toContain(code);
    expect(a.runner).toBe('torre');
    if (status === 'pending') expect(a.retryCount).toBe(1);
    expect(git(join(dir, 'worktrees', c.id.slice(0, 8)), 'status', '--porcelain')).toBe('');
    expect(logs.join('\n')).not.toContain('hola');
  });
}

test('busy: vuelve a pending sin gastar reintento', async () => {
  const ws = workstream();
  store.setWorkstreamRunner(ws.id, 'torre');
  const c = store.createChange(ws.id, 'x', 'd');
  store.claimActivity(ws.id, 'w1');
  const [a] = store.listActivities({ changeId: c.id });
  await processActivity(store, store.getActivity(a!.id), 'w1', opts(ws.id, { runnerTransport: fake('busy') }));
  expect(store.getActivity(a!.id)).toMatchObject({ status: 'pending', retryCount: 0, runner: 'torre' });
});

test('A15: rol con env con runner ssh se bloquea con ENV_NOT_REMOTE sin abrir sesión', async () => {
  const profile: Profile = { ...defaultProfile(), schemaVersion: 2, harness: 'fake', roles: { investigate: { env: ['MI_VAR'] } } };
  const ws = workstream({ profile: saveProfile(dir, profile).digest });
  store.setWorkstreamRunner(ws.id, 'torre');
  const c = store.createChange(ws.id, 'x', 'd');
  await runPool(store, opts(ws.id, { runnerTransport: noSession() }));
  const [a] = store.listActivities({ changeId: c.id });
  expect(a).toMatchObject({ status: 'blocked' });
  expect(a!.error).toContain('ENV_NOT_REMOTE: MI_VAR');
});

test('R3: adaptador no confinable con runner ssh se bloquea sin conectar', async () => {
  const ws = workstream({ agent: 'agy' });
  store.setWorkstreamRunner(ws.id, 'torre');
  const c = store.createChange(ws.id, 'x', 'd');
  await runPool(store, opts(ws.id, { runnerTransport: noSession() }));
  expect(store.listActivities({ changeId: c.id })[0]!.error).toContain('RUNNER_REFUSED: not_confinable');
});

test('--live con runner ssh no arranca', async () => {
  const ws = workstream();
  store.setWorkstreamRunner(ws.id, 'torre');
  await expect(runPool(store, opts(ws.id, { live: true, runnerTransport: noSession() }))).rejects.toThrow('LIVE_NOT_REMOTE');
});

test('A14: el perfil no puede llevar runner en ningún nivel', () => {
  const base = defaultProfile();
  for (const bad of [{ ...base, schemaVersion: 2, runner: 'torre' }, { ...base, schemaVersion: 2, roles: { implement: { runner: 'torre' } } }, { ...base, runner: 'torre' }]) {
    expect(() => validateProfile(bad)).toThrow(/runner/);
  }
});

test('R10: la activity de gates corre en casa y no abre ninguna sesión', async () => {
  const ws = workstream({ verify: ['true'] });
  store.setWorkstreamRunner(ws.id, 'torre');
  const c = store.createChange(ws.id, 'x', 'd');
  let sessions = 0;
  const counting: Transport = r => { sessions++; return fake('auto', 'STATUS: done\nVERDICT: pass')(r); };
  await runPool(store, opts(ws.id, { runnerTransport: counting }));
  const acts = store.listActivities({ changeId: c.id });
  expect(acts.every(a => a.retryCount === 0)).toBe(true);
  expect(sessions).toBe(acts.filter(a => a.kind !== 'gates').length); // una sesión por activity de agente; gates, ninguna
  const gates = store.listActivities({ changeId: c.id }).find(a => a.kind === 'gates');
  expect(gates?.status).toBe('completed');
  expect(store.getActivity(gates!.id).runner).toBeNull();
});
