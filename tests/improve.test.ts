import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createExperiment, deleteExperiment, reportExperiment, rng, runExperiment, variance } from '../src/improve.ts';
import { defaultProfile, DEFAULT_DIGEST, saveProfile } from '../src/profile.ts';
import { Store } from '../src/store.ts';

let dir: string, repo: string, base: string, suite: string, cand: string, store: Store;
const git = (...a: string[]) => Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdout: 'pipe' }).stdout.toString().trim();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fabrica-improve-'));
  repo = join(dir, 'repo');
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'init');
  base = git('rev-parse', 'HEAD');
  const p = defaultProfile();
  p.worker.implement = p.worker.implement.replace('3. Run the test suite', '3. Run the test suite BEFORE finishing');
  cand = saveProfile(dir, p).digest;
  suite = join(dir, 'suite.json');
  writeFileSync(suite, JSON.stringify({ tasks: [
    { id: 't1', repo, base, description: 'tarea uno', verify: 'test -f a.txt', split: 'development' },
    { id: 't2', repo, base, description: 'tarea dos', verify: 'test -f missing.txt', split: 'validation' },
  ] }));
  store = new Store(join(dir, 'f.db'));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const create = (id: string) => createExperiment(store.db, dir, { id, baseline: DEFAULT_DIGEST, candidate: cand, suitePath: suite });

test('el id de experimento no se reutiliza, ni borrándolo', () => {
  create('e1');
  expect(() => create('e1')).toThrow(/no se reutiliza/);
  deleteExperiment(store.db, 'e1');
  expect(() => create('e1')).toThrow(/no se reutiliza/);
  expect(() => createExperiment(store.db, dir, { id: 'e2', baseline: 'f'.repeat(64), candidate: cand, suitePath: suite })).toThrow(/perfil desconocido/);
  writeFileSync(suite, JSON.stringify({ tasks: [{ id: 'x', repo, base, description: 'd', verify: 'true', split: 'nope' }] }));
  expect(() => create('e3')).toThrow(/split/);
});

test('improve run con agente fake produce corridas pareadas con la semilla registrada', async () => {
  create('e1');
  const r = await runExperiment(store.db, dir, 'e1', { split: 'development', repeats: 3, agent: 'fake', seed: 7 });
  expect(r).toEqual({ seed: 7, runs: 6 });
  const rows = store.db.query('SELECT * FROM experiment_runs ORDER BY rowid').all() as any[];
  expect(rows.every(x => x.seed === 7 && x.agent === 'fake' && x.success === 1 && x.change_id)).toBe(true);
  for (let i = 0; i < rows.length; i += 2) {
    expect(rows[i].repeat).toBe(rows[i + 1].repeat);
    expect([rows[i].arm, rows[i + 1].arm].sort()).toEqual(['baseline', 'candidate']);
    expect([rows[i].position, rows[i + 1].position]).toEqual([0, 1]);
  }
  // Mismo orden con la misma semilla.
  const order = (seed: number) => { const n = rng(seed); return Array.from({ length: 6 }, () => n() < 0.5); };
  expect(order(7)).toEqual(order(7));
  expect(rows.filter((_, i) => i % 2 === 0).map(x => x.arm === 'baseline')).toEqual(order(7).slice(0, 3));
  // El split validation falla su comando de verificación.
  await runExperiment(store.db, dir, 'e1', { split: 'validation', repeats: 1, agent: 'fake', seed: 1 });
  const rep = reportExperiment(store.db, 'e1');
  expect(rep).toMatch(/development\s+baseline\s+3\s+1\.000\s+0\.000/);
  expect(rep).toMatch(/validation\s+candidate\s+1\s+0\.000/);
  expect(rep).toContain('semillas');
}, 60_000);

test('varianza muestral', () => {
  expect(variance([1])).toBe(0);
  expect(variance([0, 1, 1, 0])).toBeCloseTo(1 / 3);
});
