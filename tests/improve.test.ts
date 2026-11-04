import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { armCost, createExperiment, deleteExperiment, experimentRunsJson, parseSuite, reportExperiment, restoreProtected, rng, runExperiment, variance } from '../src/improve.ts';
import { runDirectory } from '../src/manifest.ts';
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
  // El agente fake no reporta coste: NULL, nunca 0.
  expect(rows.every(x => x.cost_usd === null)).toBe(true);
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
  expect(rep).toMatch(/coste medio USD/);
  expect(rep).toMatch(/development\s+baseline\s+3\s.*—$/m);
  // --json: las corridas crudas, con id de tarea y coste NULL (el agente fake no lo reporta).
  const j = experimentRunsJson(store.db, 'e1');
  expect(j.suite_digest).toBe((store.db.query('SELECT suite_digest d FROM experiments WHERE id = ?').get('e1') as { d: string }).d);
  expect([j.baseline, j.candidate]).toEqual([DEFAULT_DIGEST, cand]);
  expect(j.runs).toHaveLength(8);
  expect(j.runs[0]).toEqual({ batch: expect.any(String), seed: 7, split: 'development', task_id: 't1', repeat: 1, arm: expect.any(String), position: 0, success: 1, diff_lines: expect.any(Number), duration_ms: expect.any(Number), cost_usd: null, integrity_ok: 1, task_group: null });
  expect(j.repeated_baseline).toBe(false);
  expect(new Set(j.runs.map(r => r.task_id))).toEqual(new Set(['t1', 't2']));
}, 60_000);

test('varianza muestral', () => {
  expect(variance([1])).toBe(0);
  expect(variance([0, 1, 1, 0])).toBeCloseTo(1 / 3);
});

test('armCost suma el coste por activity y es null si falta en alguna o hubo reintento', () => {
  const ws = store.createWorkstream({ slug: 'c', goal: 'g', repo, agent: 'fake' });
  const ch = store.createChange(ws.id, 't', 'd');
  const acts = store.listActivities({ changeId: ch.id });
  expect(acts.length).toBeGreaterThan(0);
  expect(armCost(store, dir, ch.id)).toBeNull(); // sin evidencia
  const run = runDirectory(dir, ch.id);
  mkdirSync(run, { recursive: true });
  const write = (id: string, usage: unknown) => writeFileSync(join(run, `${id}.json`), JSON.stringify({ isolation: 'x', usage }));
  for (const a of acts) write(a.id, { costUsd: 0.25, inputTokens: 1, outputTokens: 1 });
  expect(armCost(store, dir, ch.id)).toBeCloseTo(0.25 * acts.length);
  write(acts[0]!.id, null);
  expect(armCost(store, dir, ch.id)).toBeNull();
  write(acts[0]!.id, { costUsd: 0.25, inputTokens: 1, outputTokens: 1 });
  store.db.query('UPDATE activities SET retry_count = 1 WHERE id = ?').run(acts[0]!.id);
  expect(armCost(store, dir, ch.id)).toBeNull();
});

test('ensureSchema migra experiment_runs sin cost_usd', () => {
  store.db.exec('DROP TABLE IF EXISTS experiment_runs');
  store.db.exec(`CREATE TABLE experiment_runs (rowid INTEGER PRIMARY KEY AUTOINCREMENT, experiment_id TEXT NOT NULL, batch TEXT NOT NULL, seed INTEGER NOT NULL,
    split TEXT NOT NULL, task_id TEXT NOT NULL, repeat INTEGER NOT NULL, arm TEXT NOT NULL, position INTEGER NOT NULL, profile_digest TEXT NOT NULL,
    agent TEXT NOT NULL, success INTEGER NOT NULL, diff_lines INTEGER NOT NULL, duration_ms INTEGER NOT NULL, change_id TEXT, error TEXT, created_at TEXT NOT NULL)`);
  create('m1');
  const cols = (store.db.query('PRAGMA table_info(experiment_runs)').all() as { name: string }[]).map(c => c.name);
  expect(cols).toContain('cost_usd');
});

test('una corrida que toca una ruta protegida registra integrity_ok=0 pero no falla: la ruta se restaura antes de verificar', async () => {
  mkdirSync(join(repo, 'tests'));
  writeFileSync(join(repo, 'tests', 'keep.txt'), 'k\n');
  git('add', '.'); git('commit', '-qm', 'tests');
  base = git('rev-parse', 'HEAD');
  // El verificador falla si la ruta nueva del agente sobrevive: debe haberse borrado antes de verificar.
  writeFileSync(suite, JSON.stringify({ tasks: [{ id: 't1', repo, base, description: 'tarea', verify: 'test -f a.txt', split: 'development' }] }));
  create('i1');
  process.env.FABRICA_FAKE_TOUCH = 'tests/tocado';
  try { await runExperiment(store.db, dir, 'i1', { split: 'development', repeats: 1, agent: 'fake', seed: 1 }); }
  finally { delete process.env.FABRICA_FAKE_TOUCH; }
  const rows = store.db.query('SELECT * FROM experiment_runs').all() as any[];
  expect(rows).toHaveLength(2);
  for (const r of rows) {
    expect(r.integrity_ok).toBe(0);
    expect(r.success).toBe(1);
    expect(r.error).toBeNull();
    expect(r.diff_lines).toBe(0); // el cambio protegido se descartó
  }
  expect(experimentRunsJson(store.db, 'i1').runs.every(r => r.integrity_ok === 0)).toBe(true);
}, 60_000);

test('restoreProtected: un test debilitado se restaura y verify ya no pasa con código malo; el archivo nuevo se borra', async () => {
  mkdirSync(join(repo, 'tests'));
  writeFileSync(join(repo, 'tests', 'check.sh'), 'grep -q good a.txt\n'); // a.txt ("x") es el código malo
  git('add', '.'); git('commit', '-qm', 'test');
  const b = git('rev-parse', 'HEAD');
  const wt = join(dir, 'wt');
  Bun.spawnSync(['git', 'clone', '-q', repo, wt]);
  const verify = () => Bun.spawnSync(['sh', 'tests/check.sh'], { cwd: wt }).exitCode;
  expect(verify()).not.toBe(0);
  writeFileSync(join(wt, 'tests', 'check.sh'), 'exit 0\n'); // el agente debilita el test
  writeFileSync(join(wt, 'tests', 'nuevo.sh'), 'exit 0\n');
  expect(verify()).toBe(0); // sin restaurar, el código malo pasaría
  const { protectedIntegrity, DEFAULT_PROTECTED_PATHS } = await import('../src/validators/integrity.ts');
  const { tampered } = await protectedIntegrity(wt, b, DEFAULT_PROTECTED_PATHS);
  expect(tampered.sort()).toEqual(['tests/check.sh', 'tests/nuevo.sh']);
  expect(await restoreProtected(wt, b, tampered)).toBeNull();
  expect(verify()).not.toBe(0);
  expect(existsSync(join(wt, 'tests', 'nuevo.sh'))).toBe(false);
  expect((await protectedIntegrity(wt, b, DEFAULT_PROTECTED_PATHS)).tampered).toEqual([]);
});

test('group es opcional, no vacío, y se guarda por corrida', async () => {
  const t = { id: 'x', repo, base, description: 'd', verify: 'true', split: 'development' };
  expect(parseSuite({ tasks: [t] }).tasks[0]).not.toHaveProperty('group');
  expect(parseSuite({ tasks: [{ ...t, group: 'g1' }] }).tasks[0]!.group).toBe('g1');
  for (const g of ['', '  ', 3]) expect(() => parseSuite({ tasks: [{ ...t, group: g }] })).toThrow(/group/);
  writeFileSync(suite, JSON.stringify({ tasks: [{ ...t, id: 't1', verify: 'test -f a.txt', group: 'g1' }] }));
  create('g1');
  await runExperiment(store.db, dir, 'g1', { split: 'development', repeats: 1, agent: 'fake', seed: 1 });
  expect(experimentRunsJson(store.db, 'g1').runs.map(r => r.task_group)).toEqual(['g1', 'g1']);
}, 60_000);

test('--repeated-baseline añade el brazo baseline_rep intercalado, en informe y --json', async () => {
  createExperiment(store.db, dir, { id: 'r1', baseline: DEFAULT_DIGEST, candidate: cand, suitePath: suite, repeatedBaseline: true });
  await runExperiment(store.db, dir, 'r1', { split: 'development', repeats: 2, agent: 'fake', seed: 3 });
  const rows = store.db.query('SELECT * FROM experiment_runs ORDER BY rowid').all() as any[];
  expect(rows).toHaveLength(6);
  for (let i = 0; i < 6; i += 3) expect(rows.slice(i, i + 3).map(x => x.arm).sort()).toEqual(['baseline', 'baseline_rep', 'candidate']);
  expect(rows.filter(x => x.arm === 'baseline_rep').every(x => x.profile_digest === DEFAULT_DIGEST)).toBe(true);
  expect(reportExperiment(store.db, 'r1')).toMatch(/development\s+baseline_rep\s+2\s/);
  const j = experimentRunsJson(store.db, 'r1');
  expect(j.repeated_baseline).toBe(true);
  expect(j.runs.filter(r => r.arm === 'baseline_rep')).toHaveLength(2);
}, 60_000);

test('ensureSchema migra una base sin integrity_ok, task_group ni repeated_baseline', () => {
  store.db.exec('DROP TABLE IF EXISTS experiment_runs; DROP TABLE IF EXISTS experiments');
  store.db.exec(`CREATE TABLE experiments (id TEXT PRIMARY KEY, baseline TEXT NOT NULL, candidate TEXT NOT NULL, suite TEXT NOT NULL, suite_digest TEXT NOT NULL, created_at TEXT NOT NULL)`);
  store.db.exec(`CREATE TABLE experiment_runs (rowid INTEGER PRIMARY KEY AUTOINCREMENT, experiment_id TEXT NOT NULL, batch TEXT NOT NULL, seed INTEGER NOT NULL,
    split TEXT NOT NULL, task_id TEXT NOT NULL, repeat INTEGER NOT NULL, arm TEXT NOT NULL, position INTEGER NOT NULL, profile_digest TEXT NOT NULL,
    agent TEXT NOT NULL, success INTEGER NOT NULL, diff_lines INTEGER NOT NULL, duration_ms INTEGER NOT NULL, change_id TEXT, error TEXT, created_at TEXT NOT NULL)`);
  create('m2');
  const names = (t: string) => (store.db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name);
  expect(names('experiment_runs')).toEqual(expect.arrayContaining(['cost_usd', 'integrity_ok', 'task_group']));
  expect(names('experiments')).toContain('repeated_baseline');
});
