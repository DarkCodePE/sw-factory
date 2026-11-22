// T74f: cableado de los runners en el pool. El transporte se inyecta hacia el runner falso (tests/helpers/fake-runner.ts).
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { processActivity, runPool, type PoolOptions } from '../src/pool.ts';
import { defaultProfile, roleRunner, ROLES, saveProfile, validateProfile, type Profile } from '../src/profile.ts';
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
    expect(m.runner.jobId).toBe(store.listCostAttempts([c.id]).find(attempt => attempt.activityId === a.id)?.id);
    expect(m.runner.jobId).toMatch(/^[a-f0-9-]{36}$/);
    expect(m.inferenceAttempts).toMatchObject([{ remoteDeclared: true }]);
    expect(m.isolation).toContain('no verificado');
  }
  const branch = store.getChange(c.id).branch!;
  expect(git(repo, 'show', `${branch}:nuevo.txt`)).toBe('hola desde el runner');
  const events = store.listEvents(ws.id).map(e => String(e.message));
  expect(events.some(m => m.startsWith('encargo enviado al runner torre ('))).toBe(true);
  expect(events.some(m => /^resultado del runner torre importado \([0-9a-f]{8}\)$/.test(m))).toBe(true);
});

test.each([
  ['timed', 3500, 123_000],
  ['lost-after-execution', 3500, null],
  ['lost-accepted', null, null],
  ['no-change', null, null],
] as const)('T109: SSH usa el intervalo de casa (%s)', async (scenario, compute, inference) => {
  const ws = workstream();
  store.setWorkstreamRunner(ws.id, 'torre');
  const c = store.createChange(ws.id, 'fix', 'desc');
  writeFileSync(join(dir, 'cost-rates.json'), JSON.stringify([{
    version: 'ssh-v1', effectiveFrom: '2020-01-01T00:00:00.000Z',
    localHourlyMicroUsd: 0, runnerHourlyMicroUsd: { torre: 3_600_000 }, platformMicroUsd: 400,
  }]));
  let tick = 0;
  const a = store.claimActivity(ws.id, 'cost-worker')!;
  await processActivity(store, a, 'cost-worker', opts(ws.id, {
    runnerTransport: fake(scenario), runnerDeps: { monotonicNow: () => 200 + tick++ * 3500 },
  }));
  expect(store.listCostAttempts([c.id])).toMatchObject([{
    computeDurationMs: compute, computeMicroUsd: compute, inferenceMicroUsd: inference,
    inferenceBasis: inference === null ? null : 'runner_declared', platformMicroUsd: 400, totalMicroUsd: null,
  }]);
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
  ['refuse:result_rejected', 'blocked', 'RUNNER_RESULT_REJECTED'], // H1: el sellado del runner rechazó el árbol; determinista, no se reintenta
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

test('A14/T102: runner solo se admite como nombre en un rol v2', () => {
  const base = defaultProfile();
  for (const bad of [{ ...base, schemaVersion: 2, runner: 'torre' }, { ...base, schemaVersion: 2, roles: { implement: { runner: 'user@host' } } }, { ...base, roles: { implement: { runner: 'torre' } } }, { ...base, runner: 'torre' }]) {
    expect(() => validateProfile(bad)).toThrow(/runner|roles/);
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

test('el prompt que viaja al runner no lleva rutas de casa (el agente trabaja en el cwd del runner)', async () => {
  const ws = workstream();
  store.setWorkstreamRunner(ws.id, 'torre');
  const c = store.createChange(ws.id, 'fix', 'desc');
  await runPool(store, opts(ws.id, { runnerTransport: fake('auto') }));
  expect(store.listActivities({ changeId: c.id }).every(a => a.status === 'completed')).toBe(true);
  const sent = readFileSync(join(fakeDir, 'transcript'), 'latin1');
  expect(sent).toContain('Working directory:'); // el prompt sí viaja
  expect(sent).not.toContain(dir);               // pero sin ninguna ruta de la máquina de casa (T74 §3.3)
});

// A10 en el camino de error: ningún fallo del runner hace correr el agente en local. El adaptador `fake` deja un testigo en el cwd si corre aquí.
for (const [scenario, code] of [['lost-accepted', 'RUNNER_LOST'], ['refuse:not_confinable', 'RUNNER_REFUSED'], ['evil-extra', 'RUNNER_RESULT_REJECTED'], ['refuse:result_rejected', 'RUNNER_RESULT_REJECTED']] as const) {
  test(`A10: tras ${code} (${scenario}) el agente no corre en casa`, async () => {
    const ws = workstream();
    store.setWorkstreamRunner(ws.id, 'torre');
    const c = store.createChange(ws.id, 'x', 'd');
    const saved = process.env.FABRICA_FAKE_TOUCH;
    process.env.FABRICA_FAKE_TOUCH = 'testigo-local';
    try {
      store.claimActivity(ws.id, 'w1');
      const act = store.listActivities({ changeId: c.id, status: 'in_progress' })[0]!;
      await processActivity(store, act, 'w1', { ...opts(ws.id), runnerTransport: fake(scenario) });
      expect(store.getActivity(act.id).error ?? '').toContain(code);
    } finally { if (saved === undefined) delete process.env.FABRICA_FAKE_TOUCH; else process.env.FABRICA_FAKE_TOUCH = saved; }
    const wt = join(dir, 'worktrees', c.id.slice(0, 8));
    expect(Bun.spawnSync(['sh', '-c', 'ls testigo-local-* 2>/dev/null'], { cwd: wt }).stdout.toString()).toBe('');
    expect(Bun.spawnSync(['sh', '-c', 'ls testigo-local-* 2>/dev/null'], { cwd: repo }).stdout.toString()).toBe('');
  });
}

test('control de A10: sin runner el mismo adaptador sí deja el testigo (el test de arriba mide algo)', async () => {
  const ws = workstream();
  const c = store.createChange(ws.id, 'x', 'd');
  process.env.FABRICA_FAKE_TOUCH = 'testigo-local';
  try { await runPool(store, opts(ws.id)); } finally { delete process.env.FABRICA_FAKE_TOUCH; }
  const wt = join(dir, 'worktrees', c.id.slice(0, 8));
  expect(Bun.spawnSync(['sh', '-c', 'ls testigo-local-*'], { cwd: wt }).stdout.toString()).toContain('testigo-local-');
});

test('O3: un rol con servidores MCP con runner ssh se bloquea con MCP_NOT_REMOTE sin abrir sesión', async () => {
  const profile: Profile = { ...defaultProfile(), schemaVersion: 2, harness: 'claude', roles: { investigate: { mcp: ['algo'] } } };
  const ws = workstream({ agent: 'claude', profile: saveProfile(dir, profile).digest });
  store.setWorkstreamRunner(ws.id, 'torre');
  const c = store.createChange(ws.id, 'x', 'd');
  await runPool(store, opts(ws.id, { runnerTransport: noSession() }));
  const [a] = store.listActivities({ changeId: c.id });
  expect(a).toMatchObject({ status: 'blocked' });
  expect(a!.error).toContain('MCP_NOT_REMOTE');
});

test('H5: el maxBundleMb del runner llega al encargo: un bundle mayor no sale de casa', async () => {
  writeFileSync(join(repo, 'grande.bin'), randomBytes(1.5 * 1024 * 1024));
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'grande');
  store.createRunner({ name: 'chico', kind: 'ssh', target: 'chico', options: { maxBundleMb: 1 } });
  const ws = workstream();
  store.setWorkstreamRunner(ws.id, 'chico');
  const c = store.createChange(ws.id, 'x', 'd');
  await runPool(store, opts(ws.id, { runnerTransport: fake('auto') }));
  const [a] = store.listActivities({ changeId: c.id });
  expect(a).toMatchObject({ status: 'blocked' });
  expect(a!.error).toContain('RUNNER_REFUSED');
  expect(readFileSync(join(fakeDir, 'transcript'), 'latin1')).not.toContain('"type":"job"'); // el job no salió
});

test('T102: un rol abre el transporte remoto propio y el resto hereda el runner del workstream', async () => {
  store.createRunner({ name: 'casa', kind: 'local' });
  const profile = saveProfile(dir, { ...defaultProfile(), schemaVersion: 2, roles: { implement: { runner: 'torre' } } }).digest;
  const ws = workstream({ profile });
  store.setWorkstreamRunner(ws.id, 'casa');
  const change = store.createChange(ws.id, 'x', 'd');
  const targets: string[] = [];
  await runPool(store, opts(ws.id, { runnerTransport: r => {
    targets.push(r.target);
    return fake('auto')(r);
  } }));
  expect(targets).toEqual(['torre']);
  expect(store.listActivities({ changeId: change.id }).map(a => [a.kind, a.status, a.runner])).toEqual([
    ['investigation', 'completed', 'casa'], ['implementation', 'completed', 'torre'],
  ]);
});

for (const state of ['disabled', 'missing', 'live'] as const) {
  test(`T102: runner ${state} bloquea solo la activity que lo selecciona y nunca abre transporte`, async () => {
    store.createRunner({ name: 'casa', kind: 'local' });
    const profile = saveProfile(dir, { ...defaultProfile(), schemaVersion: 2, roles: { implement: { runner: 'torre' } } }).digest;
    const ws = workstream({ profile });
    store.setWorkstreamRunner(ws.id, 'casa');
    const change = store.createChange(ws.id, 'x', 'd');
    if (state === 'disabled') store.setRunnerEnabled('torre', false);
    if (state === 'missing') store.db.query("DELETE FROM runners WHERE name = 'torre'").run();
    let sessions = 0;
    const options = opts(ws.id, { live: state === 'live', runnerTransport: r => {
      sessions++;
      return fake('auto')(r);
    } });
    if (state === 'live') {
      // El pool que ya arrancó mantiene la barrera por activity si después cambia la configuración.
      await processActivity(store, store.claimActivity(ws.id, 'worker')!, 'worker', options);
      await processActivity(store, store.claimActivity(ws.id, 'worker')!, 'worker', options);
    } else await runPool(store, options);
    expect(sessions).toBe(0);
    const [first, second] = store.listActivities({ changeId: change.id });
    expect(first).toMatchObject({ kind: 'investigation', status: 'completed', runner: 'casa' });
    expect(second).toMatchObject({ kind: 'implementation', status: 'blocked',
      error: expect.stringContaining(({ disabled: 'RUNNER_DISABLED', missing: 'RUNNER_NOT_FOUND', live: 'LIVE_NOT_REMOTE' })[state]) });
  });
}

test('T102-H2: --live rechaza en el arranque si un rol efectivo usa SSH', async () => {
  store.createRunner({ name: 'casa', kind: 'local' });
  const base = { ...defaultProfile(), schemaVersion: 2 as const };
  const inherited = saveProfile(dir, { ...base, roles: { investigate: { runner: 'casa' } } }).digest;
  const explicit = saveProfile(dir, { ...base, roles: { qa: { runner: 'torre' } } }).digest;
  for (const [slug, fallback, profile] of [['hereda', 'torre', inherited], ['explicito', 'casa', explicit]] as const) {
    const ws = workstream({ slug, profile });
    store.setWorkstreamRunner(ws.id, fallback);
    const change = store.createChange(ws.id, 'x', 'd');
    const before = store.listActivities({ changeId: change.id });
    await expect(runPool(store, opts(ws.id, { live: true, runnerTransport: noSession() }))).rejects.toThrow('LIVE_NOT_REMOTE');
    expect(store.listActivities({ changeId: change.id })).toEqual(before);
    expect(store.getChange(change.id).status).toBe(change.status);
  }
});

test('T102-H2/P7: --live permite SSH del workstream si todos los roles efectivos son locales', async () => {
  store.createRunner({ name: 'casa', kind: 'local' });
  const profile = saveProfile(dir, {
    ...defaultProfile(), schemaVersion: 2,
    roles: Object.fromEntries(ROLES.map(role => [role, { runner: 'casa' }])),
  }).digest;
  const ws = workstream({ profile });
  store.setWorkstreamRunner(ws.id, 'torre');
  const change = store.createChange(ws.id, 'x', 'd');
  await runPool(store, opts(ws.id, { live: true, runnerTransport: noSession() }));
  expect(store.listActivities({ changeId: change.id }).map(a => [a.status, a.runner])).toEqual([
    ['completed', 'casa'], ['completed', 'casa'],
  ]);
});

test('T101-H3/P9: un perfil ilegible se diagnostica al reclamar antes de comprobar el pin del fallback', async () => {
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'home'));
  const binary = join(dir, 'bin', 'claude');
  writeFileSync(binary, '#!/bin/sh\nexit 77\n');
  chmodSync(binary, 0o755);
  writeFileSync(join(dir, 'home', 'agents.json'), JSON.stringify({ agentBinaries: { claude: 'a'.repeat(64) } }));
  const saved = { PATH: process.env.PATH, FABRICA_HOME: process.env.FABRICA_HOME };
  process.env.PATH = `${join(dir, 'bin')}:${saved.PATH}`;
  process.env.FABRICA_HOME = join(dir, 'home');
  try {
    const ws = workstream({ agent: 'claude' });
    const change = store.createChange(ws.id, 'x', 'd');
    store.db.query('UPDATE workstreams SET profile = ? WHERE id = ?').run('c'.repeat(64), ws.id);
    await runPool(store, opts(ws.id, { runnerTransport: noSession() }));
    expect(store.listActivities({ changeId: change.id })[0]?.error).toContain('perfil desconocido');
  } finally { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test('T101-H3/F2: el resolver ignora runners en un perfil histórico incluso en memoria', () => {
  expect(roleRunner({ ...defaultProfile(), roles: { qa: { runner: 'casa' } } }, 'qa')).toBeUndefined();
});

test('T102-H5: una pausa después de la reserva y durante la preparación evita abrir SSH', async () => {
  const ws = workstream();
  store.setWorkstreamRunner(ws.id, 'torre');
  const change = store.createChange(ws.id, 'x', 'd');
  const a = store.claimActivity(ws.id, 'worker')!;
  const other = new Store(store.dbPath);
  const provenance = store.setActivityProvenance.bind(store);
  const pause = spyOn(store, 'setActivityProvenance').mockImplementation((id, digest, sha, run) => {
    provenance(id, digest, sha, run);
    if (run?.runner === 'torre') other.setRunnerEnabled('torre', false);
  });
  let sessions = 0;
  try {
    await processActivity(store, a, 'worker', opts(ws.id, { runnerTransport: r => {
      sessions++;
      return fake('auto')(r);
    } }));
    expect(store.getRunner('torre').enabled).toBe(false);
    expect(sessions).toBe(0);
    expect(store.getActivity(a.id)).toMatchObject({ status: 'blocked', error: 'RUNNER_DISABLED: torre' });
    expect(store.listEvents(ws.id, undefined, change.id).some(e => String(e.message).includes('encargo enviado'))).toBe(false);
  } finally { pause.mockRestore(); other.close(); }
});
