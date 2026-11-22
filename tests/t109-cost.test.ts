import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_MILLI_CREDITS_PER_USD, costRateAt, usdToMicro, microToCents } from '../src/attempt-cost.ts';
import { Store } from '../src/store.ts';

test('C2 conserva los importes de 0,1, 0,9 y 1,1 céntimos antes de presentar en céntimos', () => {
  expect(DEFAULT_MILLI_CREDITS_PER_USD).toBe(100_000);
  const micros = [0.001, 0.009, 0.011].map(usdToMicro);
  expect(micros).toEqual([1_000, 9_000, 11_000]);
  expect(micros.map(microToCents)).toEqual([0, 1, 1]);
  expect(microToCents(5_000)).toBe(1);
  expect(usdToMicro(Number.MAX_VALUE)).toBeNull();
});

test('un intento fija la versión al inicio y un cierre repetido conserva el cargo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fab-cost-'));
  let now = '2026-11-21T00:00:00.000Z';
  const path = join(dir, 'fab.db');
  const db = new Store(path, { clock: () => new Date(now) });
  try {
    const ws = db.createWorkstream({ slug: 'cost', goal: 'g', repo: dir, requireChangeApproval: false });
    const c = db.createChange(ws.id, 'c', 'd');
    const a = db.listActivities({ changeId: c.id })[0]!;
    const rates = join(dir, 'cost-rates.json');
    writeFileSync(rates, JSON.stringify([
      { version: 'v1', effectiveFrom: now, localHourlyMicroUsd: 3_600_000, platformMicroUsd: 2_000, runnerHourlyMicroUsd: { priced: 3_600_000 } },
      { version: 'v2', effectiveFrom: '2026-11-22T00:00:00.000Z', localHourlyMicroUsd: 0, platformMicroUsd: 7_000, runnerHourlyMicroUsd: {} },
    ]));
    const first = randomUUID();
    db.beginCostAttempt(a, { id: first, rate: costRateAt(dir, db.now(), null), remote: false, runner: null, adapter: 'fake', legacyCount: 0 });
    now = '2026-11-22T00:00:00.000Z';
    db.finishCostAttempt(first, { costUsd: 0.003, priceVersion: '2026-11-21-v1' }, 6000);
    db.finishCostAttempt(first, { costUsd: 9 }, 8000);
    const missing = randomUUID();
    db.beginCostAttempt(a, { id: missing, rate: costRateAt(dir, db.now(), 'unpriced'), remote: true, runner: 'unpriced', adapter: 'fake', legacyCount: 1 });
    db.finishCostAttempt(missing, { costUsd: 0 }, 3000);
    const unobserved = randomUUID();
    db.beginCostAttempt(a, { id: unobserved, rate: costRateAt(dir, db.now(), null), remote: false, runner: null, adapter: 'fake', legacyCount: 2 });
    db.finishCostAttempt(unobserved, { costUsd: 0 }, undefined);
    const ro = new Store(path, { readonly: true });
    try {
      const attempts = ro.listCostAttempts([c.id]);
      expect(attempts.find(a => a.id === first)).toMatchObject({
        rateVersion: 'v1', inferenceMicroUsd: 3000, inferenceBasis: 'catalog', inferenceVersion: '2026-11-21-v1',
        computeMicroUsd: 6000, platformMicroUsd: 2000, totalMicroUsd: 11000,
      });
      expect(attempts.find(a => a.id === missing)).toMatchObject({
        rateVersion: 'v2', inferenceMicroUsd: 0, inferenceBasis: 'runner_declared',
        computeMicroUsd: null, platformMicroUsd: 7000, totalMicroUsd: null,
      });
      expect(attempts.find(a => a.id === unobserved)).toMatchObject({ inferenceMicroUsd: 0, computeMicroUsd: null, totalMicroUsd: null });
    } finally { ro.close(); }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('C2 tiene tarifa cero explícita para local y plataforma, sin presumir tarifa SSH', () => {
  const at = '2026-11-21T00:00:00.000Z';
  expect(costRateAt(undefined, at, null)).toMatchObject({ hourlyMicroUsd: 0, platformMicroUsd: 0 });
  expect(costRateAt(undefined, at, 'other')).toMatchObject({ hourlyMicroUsd: null, platformMicroUsd: 0 });
});

test('una base anterior se lee sin escribir y aplica el registro de esquema una vez al abrir en escritura', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fab-old-cost-'));
  const path = join(dir, 'fab.db');
  try {
    const first = new Store(path);
    first.db.exec('DROP TABLE cost_attempts; DROP TABLE schema_migrations');
    first.close();
    const reader = new Store(path, { readonly: true });
    try {
      expect(reader.listCostAttempts(null)).toEqual([]);
      expect(reader.db.query("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get()).toBeNull();
    } finally { reader.close(); }
    for (let opened = 0; opened < 2; opened++) {
      const writer = new Store(path);
      try {
        expect(writer.db.query('SELECT id FROM schema_migrations').all()).toEqual([{ id: 't109-cost-attempts' }]);
      } finally { writer.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
