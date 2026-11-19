import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPool } from '../src/pool.ts';
import { Store } from '../src/store.ts';

let dir: string, store: Store;
const template = { name: 'diaria', cron: '30 7 * * *', title: 'Resumen', body: 'Texto fijo' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-pool-auto-'));
  // Creada el día 18: el vencimiento de las 07:30 del 19 ya pasó.
  let now = '2026-11-18T00:00:00.000Z';
  store = new Store(join(dir, 'fab.db'), { clock: () => new Date(now) });
  (store as unknown as { setNow: (v: string) => void }).setNow = v => { now = v; };
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function active(slug: string) {
  const ws = store.createWorkstream({ slug, goal: 'g', repo: dir, agent: 'fake' });
  return store.setWorkstreamState(ws.id, 'active');
}

const advance = () => (store as unknown as { setNow: (v: string) => void }).setNow('2026-11-19T07:45:00.000Z');

test('runPool --once dispara la automation vencida de su workstream y no crea activities', async () => {
  const mine = active('mine');
  const other = active('other');
  store.createAutomation({ workstream: 'mine', ...template });
  store.createAutomation({ workstream: 'other', ...template });
  advance();
  await runPool(store, { workstream: mine.id, stateDir: dir, untilIdle: true, log: () => {} });
  expect(store.listSignals(mine.id).map(s => s.title)).toEqual(['Resumen (2026-11-19)']);
  expect(store.listSignals(other.id)).toEqual([]);
  expect(store.listActivities({ workstream: mine.id })).toEqual([]);
});

test('un SQLITE_BUSY en fireDueAutomations no tumba el pool', async () => {
  const ws = active('busy');
  const spy = spyOn(store, 'fireDueAutomations').mockImplementationOnce(() => {
    throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
  });
  await runPool(store, { workstream: ws.id, stateDir: dir, untilIdle: true, pollMs: 5, log: () => {} });
  expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
});
