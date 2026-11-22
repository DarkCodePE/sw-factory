// T109-H3: el histórico y la inferencia declarada por un runner no se cuentan como medidos ni dos veces.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { costRateAt } from '../src/attempt-cost.ts';
import { calculateMetrics } from '../src/metrics.ts';
import { Store } from '../src/store.ts';

const NOW = '2026-11-21T12:00:00.000Z';

function fixture(body: (c: { store: Store; dir: string; ws: string; change: (title: string, meta?: object) => { id: string; activityId: string } }) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'fab-t109metrics-'));
  const store = new Store(join(dir, 'fab.db'), { clock: () => new Date(NOW) });
  try {
    const ws = store.createWorkstream({ slug: 'hist', goal: 'g', repo: dir, requireChangeApproval: false });
    const change = (title: string, meta?: object) => {
      const c = store.createChange(ws.id, title, 'd');
      const a = store.listActivities({ changeId: c.id })[0]!;
      if (meta) {
        mkdirSync(join(dir, 'runs', c.id), { recursive: true });
        writeFileSync(join(dir, 'runs', c.id, `${a.id}.json`), JSON.stringify(meta));
      }
      return { id: c.id, activityId: a.id };
    };
    body({ store, dir, ws: ws.slug, change });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}
const read = (store: Store, dir: string, ws: string) =>
  calculateMetrics(store, dir, { ws, from: '2026-11-21', to: '2026-11-21', now: Date.parse(NOW) }).spending;
const open = (store: Store, dir: string, changeId: string, id: string, remote: boolean, costUsd: number) => {
  const a = store.listActivities({ changeId })[0]!;
  store.beginCostAttempt(a, { id, rate: costRateAt(dir, NOW, remote ? 'torre' : null), remote, runner: remote ? 'torre' : null, adapter: 'fake', legacyCount: 0 });
  store.finishCostAttempt(id, { costUsd }, 100);
};

test('M26/M28: una activity con histórico y registros nuevos cuenta cada intento una vez', () => fixture(({ store, dir, ws, change }) => {
  const mixed = change('mixta', { costLegacyCount: 1, attemptCosts: [0.04, 0.01] });
  open(store, dir, mixed.id, 'nuevo-mixta', false, 0.01);
  const current = change('actual', { attemptCosts: [0.07] }); // sin costLegacyCount: ya la cubre su fila
  open(store, dir, current.id, 'nuevo-actual', false, 0.02);
  change('antigua', { attemptCosts: [0.03] });             // sin filas: solo el histórico
  const s = read(store, dir, ws);
  expect(s.attempts).toHaveLength(4);
  expect(s.inference.measured).toBe(40_000 + 10_000 + 20_000 + 30_000);
}));

test('M27: la inferencia remota del histórico no se da por medida', () => fixture(({ store, dir, ws, change }) => {
  change('remota', { attemptCosts: [0.05], inferenceAttempts: [{ adapter: 'fake', remoteDeclared: true, usage: { costUsd: 0.05 } }] });
  const s = read(store, dir, ws);
  expect(s.inference).toMatchObject({ measured: null, unknown: 1 });
}));

test('M23: lo declarado por el runner en un intento SSH queda desconocido en `spending`', () => fixture(({ store, dir, ws, change }) => {
  store.createRunner({ name: 'torre', kind: 'ssh', target: 'torre' });
  const c = change('ssh');
  open(store, dir, c.id, 'remoto', true, 0.02);
  const s = read(store, dir, ws);
  expect(s.attempts).toHaveLength(1);
  expect(s.inference).toMatchObject({ measured: null, unknown: 1 });
}));
