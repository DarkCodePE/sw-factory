import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automationMain, scheduleExpr } from '../src/automation-cli.ts';
import { Store } from '../src/store.ts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function fixture(now = new Date('2026-11-19T10:00:00Z')) {
  const root = mkdtempSync(join(tmpdir(), 'fab-automation-cli-'));
  roots.push(root);
  const clock = { now };
  const store = new Store(join(root, 'fabrica.db'), { clock: () => clock.now });
  store.createWorkstream({ slug: 'ws', goal: 'g', repo: root, agent: 'fake' });
  store.setWorkstreamState('ws', 'active');
  writeFileSync(join(root, 'body.md'), 'texto fijo');
  return { root, store, clock };
}
async function run(store: Store, args: string[], opts = {}) {
  const out: string[] = [], err: string[] = [];
  const l = spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  const e = spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  try { return { code: await automationMain(args, store, opts), out: out.join('\n'), err: err.join('\n') }; }
  finally { l.mockRestore(); e.mockRestore(); }
}

test('cada atajo produce su expresión', () => {
  expect(scheduleExpr({ every: 'hour', at: ':15' })).toBe('15 * * * *');
  expect(scheduleExpr({ every: 'day', at: '07:30' })).toBe('30 7 * * *');
  expect(scheduleExpr({ every: 'week', weekday: '1', at: '07:30' })).toBe('30 7 * * 1');
  expect(scheduleExpr({ cron: '5 4 * * *' })).toBe('5 4 * * *');
  for (const bad of [{}, { every: 'day' }, { every: 'hour', at: '07:30' }, { every: 'week', at: '07:30' }, { every: 'day', at: '25:00' }, { cron: '* * * * *', every: 'day' }]) {
    expect(() => scheduleExpr(bad)).toThrow();
  }
});

test('add con cada atajo guarda la expresión; --cron inválida se rechaza', async () => {
  const { root, store } = fixture();
  const body = join(root, 'body.md');
  const add = (name: string, ...extra: string[]) => run(store, ['add', 'ws', '--name', name, '--title', 'T', '--body-file', body, ...extra]);
  expect((await add('a', '--every', 'hour', '--at', ':15')).code).toBe(0);
  expect((await add('b', '--every', 'day', '--at', '07:30')).code).toBe(0);
  expect((await add('c', '--every', 'week', '--weekday', '1', '--at', '07:30')).code).toBe(0);
  expect((await add('d', '--cron', '0 9 * * *')).code).toBe(0);
  expect(store.listAutomations('ws').map(a => a.cron)).toEqual(['15 * * * *', '30 7 * * *', '30 7 * * 1', '0 9 * * *']);
  const bad = await add('e', '--cron', '*/5 * * * *');
  expect(bad.code).toBe(1);
  expect(bad.err).toContain('minuto');
  store.close();
});

test('add sin --body-file o con fichero de más de 8 KiB falla diciéndolo', async () => {
  const { root, store } = fixture();
  const base = ['add', 'ws', '--name', 'a', '--title', 'T', '--every', 'day', '--at', '07:30'];
  const sin = await run(store, base);
  expect([sin.code, sin.err]).toEqual([1, expect.stringContaining('--body-file')]);
  writeFileSync(join(root, 'big.md'), 'x'.repeat(8193));
  const big = await run(store, [...base, '--body-file', join(root, 'big.md')]);
  expect([big.code, big.err]).toEqual([1, expect.stringContaining('8192')]);
  const falta = await run(store, [...base, '--body-file', join(root, 'nope.md')]);
  expect(falta.code).toBe(1);
  expect(store.listAutomations()).toEqual([]);
  store.close();
});

test('tick sale con 0 sin automations y con ellas; crea la señal vencida', async () => {
  const { root, store, clock } = fixture();
  expect((await run(store, ['tick'])).code).toBe(0);
  await run(store, ['add', 'ws', '--name', 'a', '--title', 'T', '--every', 'day', '--at', '11:00', '--body-file', join(root, 'body.md')]);
  clock.now = new Date('2026-11-19T11:30:00Z');
  const r = await run(store, ['tick']);
  expect(r.code).toBe(0);
  expect(r.out).toContain('created');
  expect(store.listSignals('ws')[0]!.title).toBe('T (2026-11-19)');
  expect((await run(store, ['tick'])).out).toBe('');
  store.close();
});

test('list muestra la próxima fecha en UTC, y --json', async () => {
  const { root, store } = fixture();
  await run(store, ['add', 'ws', '--name', 'a', '--title', 'T', '--every', 'day', '--at', '07:30', '--body-file', join(root, 'body.md')]);
  const r = await run(store, ['list', 'ws']);
  expect(r.out).toContain('próxima=2026-11-20T07:30:00.000Z');
  expect(r.out).toContain('activa');
  expect(JSON.parse((await run(store, ['list', '--json'])).out)[0].nextDue).toBe('2026-11-20T07:30:00.000Z');
  store.close();
});

test('enable, disable, run-now y rm por prefijo de id', async () => {
  const { root, store } = fixture();
  await run(store, ['add', 'ws', '--name', 'a', '--title', 'T', '--every', 'day', '--at', '07:30', '--body-file', join(root, 'body.md')]);
  const id = store.listAutomations()[0]!.id;
  await run(store, ['disable', id.slice(0, 8)]);
  expect(store.listAutomations()[0]!.enabled).toBe(false);
  await run(store, ['enable', id.slice(0, 8)]);
  expect(store.listAutomations()[0]!.enabled).toBe(true);
  expect((await run(store, ['run-now', id.slice(0, 8)])).out).toContain('created');
  expect((await run(store, ['run-now', id.slice(0, 8)])).out).toContain('skipped_open');
  expect((await run(store, ['rm', 'zzzz'])).code).toBe(1);
  expect((await run(store, ['rm', id.slice(0, 8)])).code).toBe(0);
  expect(store.listAutomations()).toEqual([]);
  expect(store.listSignals('ws')).toHaveLength(1);
  store.close();
});

test('run itera hasta abortar y sobrevive a un fallo del tick', async () => {
  const { store } = fixture();
  const ac = new AbortController();
  let calls = 0;
  const orig = store.fireDueAutomations.bind(store);
  store.fireDueAutomations = () => { if (++calls === 1) throw new Error('SQLITE_BUSY'); if (calls === 3) ac.abort(); return orig(); };
  const r = await run(store, ['run'], { intervalMs: 0, signal: ac.signal });
  expect(r.code).toBe(0);
  expect(calls).toBe(3);
  expect(r.err).toContain('SQLITE_BUSY');
  store.close();
});

test('subcomando desconocido: uso y código 1', async () => {
  const { store } = fixture();
  expect((await run(store, ['nada'])).code).toBe(1);
  store.close();
});

test('la próxima fecha es estrictamente posterior a ahora', async () => {
  const { root, store } = fixture(new Date('2026-11-19T07:30:00Z'));
  await run(store, ['add', 'ws', '--name', 'a', '--title', 'T', '--every', 'day', '--at', '07:30', '--body-file', join(root, 'body.md')]);
  expect((await run(store, ['list'])).out).toContain('próxima=2026-11-20T07:30:00.000Z');
  store.close();
});
