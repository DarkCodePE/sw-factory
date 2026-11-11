import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { armCost, armWorkerReport, createExperiment, deleteExperiment, describesTests, experimentRunsJson, parseSuite, reportExperiment, restoreProtected, rng, runExperiment, variance } from '../src/improve.ts';
import { getAgent } from '../src/agents.ts';
import { processActivity } from '../src/pool.ts';
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
  expect(j.runs[0]).toEqual({ batch: expect.any(String), seed: 7, split: 'development', task_id: 't1', repeat: 1, arm: expect.any(String), position: 0, success: 1, diff_lines: expect.any(Number), duration_ms: expect.any(Number), cost_usd: null, integrity_ok: 1, task_group: null, confined: false, worker_report: { present: true, describes_tests: false } });
  expect(j.worker_report_rate).toBe(0);
  expect(j.repeated_baseline).toBe(false);
  expect(new Set(j.runs.map(r => r.task_id))).toEqual(new Set(['t1', 't2']));
}, 60_000);

test('varianza muestral', () => {
  expect(variance([1])).toBe(0);
  expect(variance([0, 1, 1, 0])).toBeCloseTo(1 / 3);
});

test('armCost suma todos los intentos y es null si falta el coste de alguno', () => {
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
  expect(armCost(store, dir, ch.id)).toBeNull(); // evidencia antigua: se perdió el primer intento
  const attempts = (costs: unknown[]) => writeFileSync(join(run, `${acts[0]!.id}.json`), JSON.stringify({ attemptCosts: costs }));
  attempts([0.25, 0.5]);
  expect(armCost(store, dir, ch.id)).toBeCloseTo(0.25 * acts.length + 0.5);
  for (const costs of [[null, 0.5], [0.25, null], [0.5], [0.25, 'unknown']]) {
    attempts(costs);
    expect(armCost(store, dir, ch.id)).toBeNull();
  }
  store.db.query("UPDATE activities SET status = 'failed', retry_count = 2 WHERE id = ?").run(acts[0]!.id);
  attempts([0.25, 0.5]);
  expect(armCost(store, dir, ch.id)).toBeCloseTo(0.25 * acts.length + 0.5);
});

for (const missing of [false, true]) test(`pool conserva coste de ambos intentos (primero sin coste: ${missing})`, async () => {
  const ws = store.createWorkstream({ slug: 'retry-cost', goal: 'g', repo, agent: 'fake', requireChangeApproval: false });
  store.setWorkstreamState(ws.id, 'active');
  const ch = store.createChange(ws.id, 'task', 'description');
  const agent = getAgent('fake'), command = agent.command, parse = agent.parse;
  const meta = join(runDirectory(dir, ch.id), `${store.listActivities({ changeId: ch.id })[0]!.id}.json`);
  const costsAtLaunch: unknown[] = [];
  let attempt = 0;
  agent.command = () => {
    costsAtLaunch.push(JSON.parse(readFileSync(meta, 'utf8')).attemptCosts.at(-1));
    const first = attempt++ === 0;
    const usage = first && missing ? undefined : { costUsd: first ? 0.25 : 0.5, inputTokens: 1, outputTokens: 1 };
    return ['sh', '-c', 'printf "%s" "$1"; exit "$2"', 'fake', JSON.stringify({ text: 'STATUS: done\n\nReport.', usage }), first ? '1' : '0'];
  };
  agent.parse = stdout => JSON.parse(stdout);
  try {
    const activity = store.claimActivity(ws.id, 'worker')!;
    const opts = { workstream: ws.id, stateDir: dir, log: () => {} };
    await processActivity(store, activity, 'worker', opts);
    expect(store.getActivity(activity.id).retryCount).toBe(1);
    const retry = store.claimActivity(ws.id, 'worker')!;
    expect(retry.id).toBe(activity.id);
    await processActivity(store, retry, 'worker', opts);
    const evidence = JSON.parse(readFileSync(join(runDirectory(dir, ch.id), `${activity.id}.json`), 'utf8'));
    expect(evidence.attemptCosts).toEqual([missing ? null : 0.25, 0.5]);
    expect(evidence.usage.costUsd).toBe(0.5);
    expect(costsAtLaunch).toEqual([null, null]);
    const others = store.listActivities({ changeId: ch.id }).filter(a => a.id !== activity.id);
    for (const a of others) writeFileSync(join(runDirectory(dir, ch.id), `${a.id}.json`), JSON.stringify({ usage: { costUsd: 0.1 } }));
    if (missing) expect(armCost(store, dir, ch.id)).toBeNull();
    else expect(armCost(store, dir, ch.id)).toBeCloseTo(0.75 + others.length * 0.1);
  } finally { agent.command = command; agent.parse = parse; }
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

test('--control añade un cuarto brazo intercalado con --repeated-baseline, en informe y --json', async () => {
  createExperiment(store.db, dir, { id: 'c1', baseline: DEFAULT_DIGEST, candidate: cand, suitePath: suite, repeatedBaseline: true, control: cand });
  await runExperiment(store.db, dir, 'c1', { split: 'development', repeats: 2, agent: 'fake', seed: 3 });
  const rows = store.db.query('SELECT * FROM experiment_runs ORDER BY rowid').all() as any[];
  expect(rows).toHaveLength(8);
  for (let i = 0; i < 8; i += 4) expect(rows.slice(i, i + 4).map(x => x.arm).sort()).toEqual(['baseline', 'baseline_rep', 'candidate', 'control']);
  expect(rows.filter(x => x.arm === 'control').every(x => x.profile_digest === cand)).toBe(true);
  expect(reportExperiment(store.db, 'c1').split('\n').filter(l => /^development\s/.test(l)).at(-1)).toMatch(/control\s+2\s/);
  const j = experimentRunsJson(store.db, 'c1');
  expect(j.control).toBe(cand);
  expect(j.runs.filter(r => r.arm === 'control')).toHaveLength(2);
}, 60_000);

test('--control con un digest inexistente falla; un experimento sin control sigue igual', () => {
  expect(() => createExperiment(store.db, dir, { id: 'c2', baseline: DEFAULT_DIGEST, candidate: cand, suitePath: suite, control: 'f'.repeat(64) })).toThrow();
  createExperiment(store.db, dir, { id: 'c3', baseline: DEFAULT_DIGEST, candidate: cand, suitePath: suite });
  expect(experimentRunsJson(store.db, 'c3').control).toBeNull();
});

test('ensureSchema migra una base sin integrity_ok, task_group ni repeated_baseline', () => {
  store.db.exec('DROP TABLE IF EXISTS experiment_runs; DROP TABLE IF EXISTS experiments');
  store.db.exec(`CREATE TABLE experiments (id TEXT PRIMARY KEY, baseline TEXT NOT NULL, candidate TEXT NOT NULL, suite TEXT NOT NULL, suite_digest TEXT NOT NULL, created_at TEXT NOT NULL)`);
  store.db.exec(`CREATE TABLE experiment_runs (rowid INTEGER PRIMARY KEY AUTOINCREMENT, experiment_id TEXT NOT NULL, batch TEXT NOT NULL, seed INTEGER NOT NULL,
    split TEXT NOT NULL, task_id TEXT NOT NULL, repeat INTEGER NOT NULL, arm TEXT NOT NULL, position INTEGER NOT NULL, profile_digest TEXT NOT NULL,
    agent TEXT NOT NULL, success INTEGER NOT NULL, diff_lines INTEGER NOT NULL, duration_ms INTEGER NOT NULL, change_id TEXT, error TEXT, created_at TEXT NOT NULL)`);
  create('m2');
  const names = (t: string) => (store.db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name);
  expect(names('experiment_runs')).toEqual(expect.arrayContaining(['cost_usd', 'integrity_ok', 'task_group', 'worker_report']));
  expect(names('experiments')).toEqual(expect.arrayContaining(['repeated_baseline', 'control']));
});

test('P3: concurrency 4 preserves seeded rows and confines each fake worker', async () => {
  createExperiment(store.db, dir, { id: 'parallel', baseline: DEFAULT_DIGEST, candidate: cand, suitePath: suite, repeatedBaseline: true, control: cand });
  process.env.FABRICA_FAKE_SLEEP = '0.05';
  try {
    await runExperiment(store.db, dir, 'parallel', { split: 'development', repeats: 2, agent: 'fake', seed: 91, concurrency: 1, confine: true });
    const first = experimentRunsJson(store.db, 'parallel').runs;
    await runExperiment(store.db, dir, 'parallel', { split: 'development', repeats: 2, agent: 'fake', seed: 91, concurrency: 4, confine: true });
    const second = experimentRunsJson(store.db, 'parallel').runs.slice(first.length);
    const stable = (rows: typeof first) => rows.map(({ batch, duration_ms, ...r }) => r);
    expect(stable(second)).toEqual(stable(first));
    expect(second.every(r => r.success === 1)).toBe(true);
    const all = store.db.query('SELECT change_id FROM experiment_runs').all() as { change_id: string }[];
    expect(new Set(all.map(r => r.change_id)).size).toBe(16);
  } finally { delete process.env.FABRICA_FAKE_SLEEP; }
}, 60_000);

test('P3/P6b: invalid concurrency and unsupported confinement reject before creating runs', async () => {
  create('invalid');
  for (const concurrency of [0, -1, 1.5, NaN, Infinity])
    await expect(runExperiment(store.db, dir, 'invalid', { split: 'development', repeats: 1, agent: 'fake', concurrency })).rejects.toThrow(/concurrency/);
  await expect(runExperiment(store.db, dir, 'invalid', { split: 'development', repeats: 1, agent: 'native', confine: true })).rejects.toThrow(/no soportado/);
  expect(experimentRunsJson(store.db, 'invalid').runs).toHaveLength(0);
});


test('confined se persiste por corrida y el agregado exige todas, con migración conservadora', async () => {
  create('confined');
  expect(experimentRunsJson(store.db, 'confined').confined).toBe(false);
  const options = { split: 'development' as const, repeats: 1, agent: 'fake', seed: 7 };
  await runExperiment(store.db, dir, 'confined', { ...options, confine: true });
  let report = experimentRunsJson(store.db, 'confined');
  expect(report.confined).toBe(true);
  expect(report.runs.map(r => r.confined)).toEqual([true, true]);
  expect(store.db.query('SELECT confined FROM experiment_runs ORDER BY rowid').all()).toEqual([{ confined: 1 }, { confined: 1 }]);

  create('plain');
  await runExperiment(store.db, dir, 'plain', options);
  report = experimentRunsJson(store.db, 'plain');
  expect(report.confined).toBe(false);
  expect(report.runs.map(r => r.confined)).toEqual([false, false]);

  await runExperiment(store.db, dir, 'confined', options);
  report = experimentRunsJson(store.db, 'confined');
  expect(report.confined).toBe(false);
  expect(report.runs.map(r => r.confined)).toEqual([true, true, false, false]);
  expect(store.db.query('SELECT confined FROM experiment_runs WHERE experiment_id = ? ORDER BY rowid').all('confined'))
    .toEqual([{ confined: 1 }, { confined: 1 }, { confined: 0 }, { confined: 0 }]);

  // Legacy rows have no proof of confinement: migration must default to false.
  store.db.exec('ALTER TABLE experiment_runs DROP COLUMN confined');
  report = experimentRunsJson(store.db, 'confined');
  expect(report.confined).toBe(false);
  expect(report.runs.map(r => r.confined)).toEqual([false, false, false, false]);
  expect(store.db.query('SELECT COUNT(*) n FROM experiment_runs WHERE confined = 0').get()).toEqual({ n: 6 });
}, 60_000);

test('describesTests regla determinista: detecta mención de tests propuestos', () => {
  // Positivos: test/tests/pytest/unittest/prueba/pruebas con verbos/requisitos de acción
  expect(describesTests('Tests to add:\n- test_calc: should verify boundary')).toBe(true);
  expect(describesTests('Tests needed:\n- test_empty: should return empty list')).toBe(true);
  expect(describesTests('Tests necesarios: caso de prueba para valor vacío')).toBe(true);
  expect(describesTests('Se deberían escribir pruebas unitarias para el nuevo método')).toBe(true);
  expect(describesTests('Tests that would be needed:\n1. test_zero_division')).toBe(true);
  expect(describesTests('Tests que harían falta:\n- test_input')).toBe(true);
  expect(describesTests('Describo los tests a añadir a continuación')).toBe(true);
  expect(describesTests('I propose new tests for the edge cases')).toBe(true);

  // Negativos: tests ejecutados o código sin proponer tests
  expect(describesTests('STATUS: done\n\nfake agent handled: tarea uno')).toBe(false);
  expect(describesTests('Run the test suite: pytest passed (10 passed)')).toBe(false);
  expect(describesTests('All tests pass without issues')).toBe(false);
  expect(describesTests('Fixed bug in foo.py and updated documentation')).toBe(false);
  expect(describesTests('')).toBe(false);
  expect(describesTests(null as any)).toBe(false);
});

test('worker_report por corrida: describe tests -> true, no describe -> false, sin informe -> present false', async () => {
  create('wr1');
  // 1. Corrida con informe que describe tests
  process.env.FABRICA_FAKE_STATUS = 'done\n\nTests to add:\n- test_bound: should verify limit';
  try {
    await runExperiment(store.db, dir, 'wr1', { split: 'development', repeats: 1, agent: 'fake', seed: 10 });
  } finally {
    delete process.env.FABRICA_FAKE_STATUS;
  }
  let rep = experimentRunsJson(store.db, 'wr1');
  expect(rep.runs).toHaveLength(2);
  for (const r of rep.runs) {
    expect(r.worker_report).toEqual({ present: true, describes_tests: true });
  }
  expect(rep.worker_report_rate).toBe(1);
  expect(rep.worker_report_rate_by_arm.baseline).toBe(1);
  expect(rep.worker_report_rate_by_arm.candidate).toBe(1);

  // 2. Corrida con informe que NO describe tests
  create('wr2');
  await runExperiment(store.db, dir, 'wr2', { split: 'development', repeats: 1, agent: 'fake', seed: 20 });
  rep = experimentRunsJson(store.db, 'wr2');
  expect(rep.runs).toHaveLength(2);
  for (const r of rep.runs) {
    expect(r.worker_report).toEqual({ present: true, describes_tests: false });
  }
  expect(rep.worker_report_rate).toBe(0);
  expect(rep.worker_report_rate_by_arm.baseline).toBe(0);
  expect(rep.worker_report_rate_by_arm.candidate).toBe(0);

  // 3. Corrida sin informe (worker_report NULL en la BD)
  store.db.query('UPDATE experiment_runs SET worker_report = NULL WHERE experiment_id = ?').run('wr2');
  rep = experimentRunsJson(store.db, 'wr2');
  for (const r of rep.runs) {
    expect(r.worker_report).toEqual({ present: false, describes_tests: false });
  }
  expect(rep.worker_report_rate).toBeNull();
  expect(rep.worker_report_rate_by_arm.baseline).toBeNull();
  expect(rep.worker_report_rate_by_arm.candidate).toBeNull();
}, 60_000);

test('worker_report_rate agregado: calcula correctamente la proporción describes / present y por brazo', () => {
  create('rate1');
  const now = new Date().toISOString();
  // Insertamos corridas sintéticas en rate1:
  // baseline: 1 describes, 1 no describes -> rate = 1/2 = 0.5
  // candidate: 1 describes, 0 no describes, 1 sin informe -> present = 1, describes = 1 -> rate = 1/1 = 1.0
  // Total: present = 3, describes = 2 -> total rate = 2/3 ≈ 0.6667
  const ins = (arm: string, report: string | null) => {
    store.db.query(`INSERT INTO experiment_runs (experiment_id, batch, seed, split, task_id, repeat, arm, position,
      profile_digest, agent, success, diff_lines, duration_ms, created_at, worker_report)
      VALUES ('rate1', 'b1', 1, 'development', 't1', 1, ?, 0, 'prof', 'fake', 1, 0, 100, ?, ?)`).run(arm, now, report);
  };
  ins('baseline', 'STATUS: done\n\nTests to add:\n- test_one: should check');
  ins('baseline', 'STATUS: done\n\nImplemented without tests');
  ins('candidate', 'STATUS: done\n\nTests needed:\n- test_two: should verify');
  ins('candidate', null); // sin informe

  const rep = experimentRunsJson(store.db, 'rate1');
  expect(rep.runs).toHaveLength(4);
  expect(rep.runs.map(r => r.worker_report)).toEqual([
    { present: true, describes_tests: true },
    { present: true, describes_tests: false },
    { present: true, describes_tests: true },
    { present: false, describes_tests: false },
  ]);
  expect(rep.worker_report_rate).toBeCloseTo(2 / 3);
  expect(rep.worker_report_rate_by_arm.baseline).toBe(0.5);
  expect(rep.worker_report_rate_by_arm.candidate).toBe(1.0);
  expect(rep.by_arm.baseline!.worker_report_rate).toBe(0.5);
  expect(rep.by_arm.candidate!.worker_report_rate).toBe(1.0);
});

test('base antigua sin columna worker_report sigue funcionando y migra con ensureSchema', () => {
  create('legacy1');
  const now = new Date().toISOString();
  store.db.query(`INSERT INTO experiment_runs (experiment_id, batch, seed, split, task_id, repeat, arm, position,
    profile_digest, agent, success, diff_lines, duration_ms, created_at, worker_report)
    VALUES ('legacy1', 'b1', 1, 'development', 't1', 1, 'baseline', 0, 'prof', 'fake', 1, 0, 100, ?, 'STATUS: done\n\nTests to add: test_x')`).run(now);

  // Simular BD antigua eliminando la columna worker_report
  store.db.exec('ALTER TABLE experiment_runs DROP COLUMN worker_report');

  // experimentRunsJson debe migrar idempotentemente vía ensureSchema y responder sin error
  const rep = experimentRunsJson(store.db, 'legacy1');
  expect(rep.runs).toHaveLength(1);
  expect(rep.runs[0]!.worker_report).toEqual({ present: false, describes_tests: false });
  expect(rep.worker_report_rate).toBeNull();
  expect(rep.worker_report_rate_by_arm.baseline).toBeNull();

  // Comprobar que la columna fue añadida por ensureSchema
  const cols = (store.db.query('PRAGMA table_info(experiment_runs)').all() as { name: string }[]).map(c => c.name);
  expect(cols).toContain('worker_report');
});


const reportExamples: [string, boolean][] = [
  ["Tests should be added for width=0.", true],
  ["Tests that should be added:", true],
  ["Tests would be written", true],
  ["Tests should pass", false],
  ["Ran the existing tests; they should pass", false],
  ["All 15 tests passed", false],
  ["Tests needed: a case for width=0", true],
  ["No añadí tests; haría falta uno que cubra X", true],
  ["STATUS: done\n## Tests to add\n- width=0 should return zero.", true],
  ["No new tests are needed.", false],
  ["No tests were added.", false],
  ["Tests:\n- Add a case for width=0.", true],
  ["Se requieren pruebas para width=0.", true],
  ["Added tests for width=0.", true],
  ["Se requiere una prueba para width=0.", true],
  ["## Tests\n- Add a case for width=0.\n## Changes\nFixed code.", true],
  ["## Tests\nAll 15 passed.\n## Changes\n- Add a case to the switch.", false],
  ["No tests were added; Tests needed: width=0 returns zero.", true],
  ["## Tests\n- No tests are needed.", false],
  ["Tests should pass after the fix.", false],
  ["Tests are not needed.", false],
];

test.each(reportExamples)('describesTests regresión: %s', (text, expected) => {
  expect(describesTests(text)).toBe(expected);
});

test('informe final bloqueado se conserva por corrida incluso con concurrencia', async () => {
  create('blocked-report');
  process.env.FABRICA_FAKE_STATUS = 'blocked: need input\n\nTests needed: width=0 returns zero';
  try {
    await runExperiment(store.db, dir, 'blocked-report', { split: 'development', repeats: 2, agent: 'fake', seed: 7, concurrency: 4 });
  } finally { delete process.env.FABRICA_FAKE_STATUS; }
  const rep = experimentRunsJson(store.db, 'blocked-report');
  expect(rep.runs).toHaveLength(4);
  expect(rep.runs.every(r => r.worker_report.present && r.worker_report.describes_tests)).toBe(true);
  expect(rep.worker_report_rate).toBe(1);
  const rows = store.db.query('SELECT * FROM experiment_runs WHERE experiment_id = ?').all('blocked-report') as any[];
  for (const r of rows) {
    const state = join(dir, 'improve', 'blocked-report', `${r.batch}-${r.task_id}-r${r.repeat}-${r.arm}`, 'state');
    const child = new Store(join(state, 'fabrica.db'));
    try {
      const [a] = child.listActivities({ changeId: r.change_id });
      expect(a!.status).toBe('blocked');
      expect(a!.result).toBeNull();
      expect(r.worker_report).toBe(armWorkerReport(child, state, r.change_id));
      expect(r.worker_report).toContain('Tests needed: width=0 returns zero');
    } finally { child.close(); }
  }
}, 60_000);

test('informe final fallido pertenece a la implementación y excluye stderr de diagnóstico', async () => {
  create('failed-report');
  const agent = getAgent('fake'), command = agent.command;
  agent.command = (_prompt, options) => ['sh', '-c', options?.readOnly
    ? 'printf "STATUS: done\n\nTests needed: investigation only\n"'
    : 'printf "STATUS: done\n\nImplementation report without proposals.\n"; printf "diagnostic: Tests needed: stderr only\n" >&2; exit 1'];
  try {
    await runExperiment(store.db, dir, 'failed-report', { split: 'development', repeats: 1, agent: 'fake', seed: 7 });
  } finally { agent.command = command; }
  const rep = experimentRunsJson(store.db, 'failed-report');
  expect(rep.runs.map(r => r.worker_report)).toEqual([
    { present: true, describes_tests: false }, { present: true, describes_tests: false },
  ]);
  const rows = store.db.query('SELECT worker_report FROM experiment_runs WHERE experiment_id = ?').all('failed-report') as { worker_report: string }[];
  for (const r of rows) expect(r.worker_report).toBe('STATUS: done\n\nImplementation report without proposals.');
}, 60_000);

test('un reintento sin informe final no reutiliza el informe anterior ni la investigación', async () => {
  create('retry-report');
  const agent = getAgent('fake'), command = agent.command;
  agent.command = (_prompt, options) => ['sh', '-c', options?.readOnly
    ? 'printf "STATUS: done\n\nTests needed: investigation only\n"'
    : 'if [ ! -f .attempt ]; then touch .attempt; printf "STATUS: done\n\nTests needed: first attempt only\n"; else printf "diagnostic only\n" >&2; fi; exit 1'];
  try {
    await runExperiment(store.db, dir, 'retry-report', { split: 'development', repeats: 1, agent: 'fake', seed: 7 });
  } finally { agent.command = command; }
  const rep = experimentRunsJson(store.db, 'retry-report');
  expect(rep.runs.map(r => r.worker_report)).toEqual([
    { present: false, describes_tests: false }, { present: false, describes_tests: false },
  ]);
  expect(rep.worker_report_rate).toBeNull();
}, 60_000);


test('un intento que falla antes de lanzar el agente descarta la evidencia anterior', async () => {
  const ws = store.createWorkstream({ slug: 'launch-failure', goal: 'g', repo, agent: 'fake', requireChangeApproval: false });
  store.setWorkstreamState(ws.id, 'active');
  const change = store.createChange(ws.id, 'task', 'description');
  const activity = store.claimActivity(ws.id, 'worker')!;
  const run = runDirectory(dir, change.id);
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, `${activity.id}.json`), JSON.stringify({ workerReport: 'STATUS: done\nTests needed: previous attempt', attemptCosts: [0.25] }));
  // Only this test's disposable repo is removed; setup fails before an agent can emit a new report.
  rmSync(repo, { recursive: true, force: true });
  await processActivity(store, activity, 'worker', { workstream: ws.id, stateDir: dir, log: () => {} });
  expect(store.getActivity(activity.id).retryCount).toBe(1);
  expect(armWorkerReport(store, dir, change.id)).toBeNull();
  expect(JSON.parse(readFileSync(join(run, `${activity.id}.json`), 'utf8')).attemptCosts).toEqual([0.25, 0]);
  expect(armCost(store, dir, change.id)).toBe(0.25);
});
