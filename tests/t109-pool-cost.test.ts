// T109-H2: cableado de los intentos de coste en el pool (local, SSH y turno vivo). Cada test fija una mutación del verificador.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { processActivity, runPool, type PoolOptions } from '../src/pool.ts';
import type { Transport } from '../src/runners/client.ts';
import { Store } from '../src/store.ts';
import { fakeLive } from './helpers/live.ts';

const FAKE = resolve(import.meta.dir, 'helpers/fake-runner.ts');
let dir: string, repo: string, fakeDir: string, store: Store;
const runner = (scenario: string): Transport => () => [process.execPath, FAKE, scenario, fakeDir, 'STATUS: done\nhecho'];
const opts = (ws: string, over: Partial<PoolOptions> = {}): PoolOptions => ({ workstream: ws, stateDir: dir, untilIdle: true, pollMs: 5, log: () => {}, ...over });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-t109pool-'));
  repo = join(dir, 'repo'); fakeDir = join(dir, 'fake'); mkdirSync(fakeDir);
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  for (const args of [['add', '.'], ['commit', '-qm', 'init']]) Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);
  store = new Store(join(dir, 'f.db'));
  store.createRunner({ name: 'torre', kind: 'ssh', target: 'torre' });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function setup(ssh = false) {
  const ws = store.createWorkstream({ slug: 'w', goal: 'g', repo, agent: 'fake', requireChangeApproval: false, requireApproval: false });
  store.setWorkstreamState(ws.id, 'active');
  if (ssh) store.setWorkstreamRunner(ws.id, 'torre');
  const c = store.createChange(ws.id, 'fix', 'desc');
  const attempts = () => store.listCostAttempts([c.id]);
  const claim = () => store.claimActivity(ws.id, 'w1')!;
  return { ws, c, attempts, claim };
}

// El pool envuelve al agente local con el capturador de manifiesto: el argv trae `sh` dentro, no al principio.
const isSh = (argv: unknown) => Array.isArray(argv) && argv[0] !== 'git' && argv.includes('sh');

test('M31/M37: un disparo local deja un intento cerrado con la duración medida y el cómputo local', async () => {
  const { ws, attempts } = setup();
  await runPool(store, opts(ws.id));
  const rows = attempts().filter(a => !a.remote);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row).toMatchObject({ adapter: 'fake', remote: false, runner: null, computeMicroUsd: 0, closedAt: expect.any(String) });
  for (const row of rows) expect(row.computeDurationMs).toBeGreaterThanOrEqual(0);
});

test('M18/M31: si el agente local no llega a lanzarse, el intento se descarta', async () => {
  const { ws, attempts, claim } = setup();
  const real = Bun.spawn;
  const spy = spyOn(Bun, 'spawn').mockImplementation(((argv: unknown, o: unknown) => {
    if (isSh(argv)) throw new Error('no se pudo lanzar');
    return (real as (...a: unknown[]) => unknown)(argv, o);
  }) as never);
  try { await processActivity(store, claim(), 'w1', opts(ws.id)).catch(() => {}); } finally { spy.mockRestore(); }
  expect(attempts()).toEqual([]);
});

test('M30: si el agente local ya se lanzó y falla después, el intento se conserva cerrado', async () => {
  const { ws, attempts, claim } = setup();
  const real = Bun.spawn;
  const spy = spyOn(Bun, 'spawn').mockImplementation(((argv: unknown, o: unknown) => {
    const proc = (real as (...a: unknown[]) => { stdout: unknown })(argv, o);
    if (!isSh(argv)) return proc;
    return new Proxy(proc, { get: (t, k) => k === 'stdout'
      ? new ReadableStream({ start: c => c.error(new Error('lectura rota')) })
      : (() => { const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v; })() });
  }) as never);
  try { await processActivity(store, claim(), 'w1', opts(ws.id)).catch(() => {}); } finally { spy.mockRestore(); }
  expect(attempts()).toMatchObject([{ remote: false, closedAt: expect.any(String), inferenceMicroUsd: null, totalMicroUsd: null }]);
});

test('M29: un runner ocupado no deja intento de coste (se descarta al reencolar)', async () => {
  const { ws, attempts, claim } = setup(true);
  await processActivity(store, claim(), 'w1', opts(ws.id, { runnerTransport: runner('busy') }));
  expect(attempts()).toEqual([]);
});

test('M30: un runner que aceptó el encargo y se pierde conserva su intento cerrado', async () => {
  const { ws, attempts, claim } = setup(true);
  await processActivity(store, claim(), 'w1', opts(ws.id, { runnerTransport: runner('lost-accepted') }));
  expect(attempts()).toMatchObject([{ remote: true, runner: 'torre', closedAt: expect.any(String), totalMicroUsd: null }]);
});

test('M33: un turno vivo que lanza deja su intento cerrado, con la duración si el agente corrió', async () => {
  const { ws, attempts } = setup();
  const backend = fakeLive([{ error: new Error('429 rate limit') }]);
  await runPool(store, { workstream: ws.id, stateDir: dir, untilIdle: true, pollMs: 5, log: () => {}, live: true, liveBackends: { fake: backend } });
  const rows = attempts();
  expect(rows.length).toBeGreaterThan(0); // el error transitorio reintenta: cada turno deja su intento
  for (const row of rows) expect(row).toMatchObject({ remote: false, closedAt: expect.any(String), inferenceMicroUsd: null });
});

test('M30: descartar solo borra un intento abierto; uno ya cerrado se conserva', () => {
  const { attempts, claim } = setup();
  const a = claim();
  const rate = { version: 'c2-v1', effectiveFrom: '1970-01-01T00:00:00.000Z', hourlyMicroUsd: 0, platformMicroUsd: 0 };
  store.beginCostAttempt(a, { id: 'cerrado', rate, remote: false, runner: null, adapter: 'fake', legacyCount: 0 });
  store.finishCostAttempt('cerrado', undefined, 10);
  store.beginCostAttempt(a, { id: 'abierto', rate, remote: false, runner: null, adapter: 'fake', legacyCount: 0 });
  store.discardUnstartedCostAttempt('cerrado');
  store.discardUnstartedCostAttempt('abierto');
  expect(attempts().map(r => r.id)).toEqual(['cerrado']);
});
