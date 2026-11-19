import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { armCost, armWorkerReport } from '../src/improve.ts';
import { armCost as baseCost, armWorkerReport as baseReport } from './fixtures/improve-evidence-base.ts';

let dir: string, store: Store, change: string, metadata: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-web-improve-'));
  store = new Store(':memory:');
  const w = store.createWorkstream({ slug: 'p', goal: 'g', repo: '/repo', requireChangeApproval: false });
  change = store.createChange(w.id, 'T', '').id;
  const a = store.listActivities({ changeId: change })[0]!;
  store.db.query('UPDATE activities SET result=? WHERE id=?').run('resultado de respaldo', a.id);
  mkdirSync(join(dir, 'runs', change), { recursive: true });
  metadata = join(dir, 'runs', change, `${a.id}.json`);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
const outcome = (fn: () => unknown) => {
  try { return { value: fn() }; } catch (e) { return { error: (e as Error).name, message: (e as Error).message }; }
};
function same(stateDir = dir) {
  for (const [current, base] of [[armCost, baseCost], [armWorkerReport, baseReport]]) {
    expect(outcome(() => current!(store, stateDir, change))).toEqual(outcome(() => base!(store, stateDir, change)));
  }
}

test('H2: metadata de 300 KiB conserva coste e informe completos como en la base', () => {
  const report = 'r'.repeat(300 * 1024);
  writeFileSync(metadata, JSON.stringify({ attemptCosts: [0.1], workerReport: report }));
  same(); expect(armCost(store, dir, change)).toBe(0.1); expect(armWorkerReport(store, dir, change)).toBe(report);
});
test('H6: improve sigue symlinks como la base', () => {
  const target = join(dir, 'original.json');
  writeFileSync(target, JSON.stringify({ attemptCosts: [0.2], workerReport: 'informe' }));
  symlinkSync(target, metadata); same(); expect(armCost(store, dir, change)).toBe(0.2);
});
test('H6: stateDir inexistente y metadata ausente conservan el respaldo', () => {
  same(join(dir, 'inexistente')); same();
  expect(armWorkerReport(store, join(dir, 'inexistente'), change)).toBe('resultado de respaldo');
});
for (const content of ['{broken', 'null']) test(`H6: JSON ${content} mantiene las excepciones de la base`, () => {
  writeFileSync(metadata, content); same();
  expect(() => armCost(store, dir, change)).toThrow(); expect(() => armWorkerReport(store, dir, change)).toThrow();
});
test('H6: workerReport no se vuelve a redactar al evaluar improve', () => {
  writeFileSync(metadata, JSON.stringify({ attemptCosts: [0], workerReport: 'password=hunter2' }));
  same(); expect(armWorkerReport(store, dir, change)).toBe('password=hunter2');
});
