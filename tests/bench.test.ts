import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cancelBenchmark, createBenchmark, runBenchmark, type Variant } from '../src/bench.ts';
import { createExperiment, deleteExperiment, parseSuite, suiteDigest } from '../src/improve.ts';
import { defaultProfile, DEFAULT_DIGEST, saveProfile } from '../src/profile.ts';

let dir: string, repo: string, suitePath: string, db: Database, variants: Variant[];
const options = { split: 'development', repeats: 2, seed: 7 } as const;

function git(...args: string[]): string {
  const p = Bun.spawnSync(['git', '-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args]);
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fabrica-bench-'));
  repo = join(dir, 'repo');
  git('init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'a.txt'), 'original\n');
  git('-C', repo, 'add', '.');
  git('-C', repo, 'commit', '-qm', 'init');
  const base = git('-C', repo, 'rev-parse', 'HEAD');
  suitePath = join(dir, 'suite.json');
  writeFileSync(suitePath, JSON.stringify({ tasks: ['t1', 't2', 't3', 'held-out'].map(id => ({
    id, repo, base, split: id === 'held-out' ? 'validation' : 'development',
    description: id, verify: id === 'held-out' ? 'test -f missing.txt' : 'test -f a.txt', group: 'g',
  })) }));
  db = new Database(join(dir, 'fabrica.db'));
  const challenger = saveProfile(dir, {
    ...defaultProfile(), schemaVersion: 2, harness: 'fake', roles: { implement: { model: 'fake-v2' } },
  }).digest;
  variants = [{ name: 'base', profile: DEFAULT_DIGEST, agent: 'fake' }, { name: 'challenger', profile: challenger, agent: 'fake' }];
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function create(id: string, overrides: Partial<Parameters<typeof createBenchmark>[2]> = {}): void {
  createBenchmark(db, dir, { id, suitePath, variants, ...overrides });
}

function benchmark(id: string) {
  return db.query<{ suite: string; suite_digest: string; variants: string; status: string; finished_at: string | null; judge_profile: string | null; error: string | null }, [string]>(
    'SELECT * FROM benchmarks WHERE id = ?',
  ).get(id)!;
}

function rows(id: string) {
  return db.query<{
    batch: string; task_id: string; arm: string; repeat: number; position: number; seed: number;
    split: string; agent: string; profile_digest: string; success: number; change_id: string; error: string | null;
    cost_usd: number | null; task_group: string; integrity_ok: number | null; worker_report: string;
  }, [string]>('SELECT * FROM experiment_runs WHERE experiment_id = ? ORDER BY rowid').all(id);
}

test('ejecuta la matriz del split sobre una suite congelada y conserva el perfil v2 por variante', async () => {
  const original = readFileSync(suitePath, 'utf8');
  create('matrix', { judgeProfile: DEFAULT_DIGEST });
  expect(readFileSync(suitePath, 'utf8')).toBe(original);
  expect(benchmark('matrix')).toMatchObject({
    suite_digest: suiteDigest(parseSuite(JSON.parse(original))),
    status: 'pending', finished_at: null, judge_profile: DEFAULT_DIGEST,
  });
  expect(JSON.parse(benchmark('matrix').variants)).toEqual(variants);
  writeFileSync(suitePath, '{}');

  expect(await runBenchmark(db, dir, 'matrix', options)).toEqual({ seed: 7, runs: 12 });
  const recorded = rows('matrix');
  expect(recorded).toHaveLength(12);
  for (const task of ['t1', 't2', 't3']) for (const repeat of [1, 2]) {
    const group = recorded.filter(r => r.task_id === task && r.repeat === repeat);
    expect(group.map(r => r.arm).sort()).toEqual(['base', 'challenger']);
    expect(group.map(r => r.position)).toEqual([0, 1]);
  }
  for (const row of recorded) {
    expect(row).toMatchObject({
      seed: 7, split: 'development', agent: 'fake', success: 1, cost_usd: null,
      integrity_ok: 1, task_group: 'g', change_id: expect.any(String),
      profile_digest: variants.find(v => v.name === row.arm)!.profile,
    });
    if (row.arm === 'challenger') expect(row.worker_report).toContain('model=fake-v2');
  }
  expect(benchmark('matrix')).toMatchObject({ status: 'complete', finished_at: expect.any(String), error: null });
}, 30_000);

test('la misma semilla conserva el orden de brazos con distinta concurrencia', async () => {
  create('sequential');
  create('parallel');
  await runBenchmark(db, dir, 'sequential', options);
  await runBenchmark(db, dir, 'parallel', { ...options, concurrency: 3 });
  const order = (id: string) => rows(id).map(r => [r.task_id, r.repeat, r.position, r.arm]);
  expect(order('parallel')).toEqual(order('sequential'));
  expect(rows('sequential').filter(r => r.position === 0).map(r => r.arm)).toEqual([
    'challenger', 'challenger', 'base', 'base', 'base', 'challenger',
  ]);
}, 60_000);

test('las raíces de los brazos son distintas incluso con nombres de tarea y variante ambiguos', async () => {
  const tasks = JSON.parse(readFileSync(suitePath, 'utf8')).tasks;
  writeFileSync(suitePath, JSON.stringify({ tasks: [
    { ...tasks[0], id: 'x' }, { ...tasks[0], id: 'x-r1-y' },
  ] }));
  variants[0]!.name = 'y-r1-z';
  variants[1]!.name = 'z';
  create('roots');
  expect((await runBenchmark(db, dir, 'roots', { ...options, repeats: 1, concurrency: 2 })).runs).toBe(4);
  expect(readdirSync(join(dir, 'improve', 'roots'))).toHaveLength(4);
  expect(rows('roots').every(r => r.success === 1)).toBe(true);
}, 30_000);

test('cancelar tras la tercera fila conserva las tres y no arranca otro brazo', async () => {
  create('stop');
  const writer = new Database(join(dir, 'fabrica.db'));
  // La transición ocurre al persistir la tercera fila, sin depender de la velocidad del brazo.
  db.exec(`CREATE TEMP TRIGGER cancel_after_three AFTER INSERT ON experiment_runs
    WHEN NEW.experiment_id = 'stop' AND (SELECT count(*) FROM experiment_runs WHERE experiment_id = 'stop') = 3
    BEGIN UPDATE benchmarks SET status = 'canceled', finished_at = 'at-third-row' WHERE id = 'stop'; END`);
  try {
    let launches = 0;
    const result = await runBenchmark(db, dir, 'stop', { ...options, log: () => {
      if (launches++ === 0) expect(benchmark('stop').status).toBe('running');
    } });
    expect(result).toEqual({ seed: 7, runs: 3 });
    expect(launches).toBe(3);
    expect(readdirSync(join(dir, 'improve', 'stop'))).toHaveLength(3);
    cancelBenchmark(writer, 'stop');
    expect(benchmark('stop')).toMatchObject({ status: 'canceled', finished_at: 'at-third-row' });
    expect(rows('stop')).toHaveLength(3);
  } finally { writer.close(); }
}, 30_000);

test('la cancelación desde otra conexión deja terminar el brazo en marcha', async () => {
  create('in-flight');
  const writer = new Database(join(dir, 'fabrica.db'));
  try {
    let announced = 0;
    const result = await runBenchmark(db, dir, 'in-flight', { ...options, concurrency: 2, log: () => {
      if (++announced === 2) cancelBenchmark(writer, 'in-flight');
    } });
    expect(result.runs).toBe(1);
    expect(rows('in-flight')).toHaveLength(1);
    expect(readdirSync(join(dir, 'improve', 'in-flight'))).toHaveLength(1);
    expect(benchmark('in-flight')).toMatchObject({ status: 'canceled', finished_at: expect.any(String) });
  } finally { writer.close(); }
}, 30_000);

test('solo una llamada puede reclamar el benchmark y no se reinician estados terminales', async () => {
  create('once');
  const first = runBenchmark(db, dir, 'once', { ...options, split: 'validation', repeats: 1 });
  await expect(runBenchmark(db, dir, 'once', options)).rejects.toMatchObject({ code: 'invalid_transition' });
  expect(await first).toEqual({ seed: 7, runs: 2 });
  expect(rows('once').every(row => row.success === 0 && row.error?.startsWith('verify exit'))).toBe(true);
  expect(benchmark('once')).toMatchObject({ status: 'complete', error: null });
  expect(() => cancelBenchmark(db, 'once')).toThrow(expect.objectContaining({ code: 'invalid_transition' }));

  create('pending');
  cancelBenchmark(db, 'pending');
  await expect(runBenchmark(db, dir, 'pending', options)).rejects.toMatchObject({ code: 'invalid_transition' });
  expect(rows('pending')).toEqual([]);
}, 30_000);

test('comparte la reserva irreversible de ids con improve en ambos sentidos', () => {
  const experiment = (id: string) => createExperiment(db, dir, { id, baseline: DEFAULT_DIGEST, candidate: variants[1]!.profile, suitePath });
  experiment('used');
  expect(() => create('used')).toThrow(expect.objectContaining({ code: 'conflict' }));
  deleteExperiment(db, 'used');
  expect(() => create('used')).toThrow(expect.objectContaining({ code: 'conflict' }));
  create('bench');
  cancelBenchmark(db, 'bench');
  expect(() => create('bench')).toThrow(expect.objectContaining({ code: 'conflict' }));
  expect(() => experiment('bench')).toThrow(expect.objectContaining({ code: 'conflict' }));
});

test('rechaza entradas inválidas sin consumir el id ni reclamar una corrida', async () => {
  const [one, two] = variants as [Variant, Variant];
  for (const [given, field] of [
    [[one], 'variants'], [Array(9).fill(one), 'variants'],
    [[one, { ...two, name: '../bad' }], 'name'], [[one, { ...two, name: one.name }], 'name'],
    [[one, { ...two, agent: 'unknown' }], 'agent'],
    [[one, { ...two, profile: '' }], 'profile'], [[one, { ...two, profile: 'f'.repeat(64) }], 'profile'],
  ] as const) expect(() => create('valid', { variants: given })).toThrow(new RegExp(field));
  expect(() => create('../bad')).toThrow(/id/);
  expect(() => create('valid', { judgeProfile: '' })).toThrow(/judgeProfile/);
  create('valid');
  for (const [override, field] of [
    [{ repeats: 0 }, 'repeats'], [{ concurrency: -1 }, 'concurrency'], [{ seed: NaN }, 'seed'], [{ split: 'qualification' }, 'split'],
  ] as const) await expect(runBenchmark(db, dir, 'valid', { ...options, ...override })).rejects.toThrow(new RegExp(field));
  expect(benchmark('valid').status).toBe('pending');
  expect(rows('valid')).toEqual([]);
});

test('un clon fallido deja filas diagnósticas y un benchmark fallido', async () => {
  create('no-clone');
  rmSync(repo, { recursive: true });
  await expect(runBenchmark(db, dir, 'no-clone', { ...options, repeats: 1, concurrency: 2 })).rejects.toThrow(/git clone falló/);
  expect(rows('no-clone')).toHaveLength(6);
  expect(rows('no-clone').every(r => r.success === 0 && r.integrity_ok === null && r.error === 'git clone falló')).toBe(true);
  expect(benchmark('no-clone')).toMatchObject({ status: 'failed', error: 'git clone falló', finished_at: expect.any(String) });
});

test('un adaptador no confinable falla antes de lanzar brazos', async () => {
  variants[0]!.agent = 'native';
  create('unconfined');
  await expect(runBenchmark(db, dir, 'unconfined', { ...options, confine: true })).rejects.toThrow(/adaptador native no soportado/);
  expect(benchmark('unconfined')).toMatchObject({ status: 'failed', error: expect.any(String), finished_at: expect.any(String) });
  expect(rows('unconfined')).toEqual([]);
});
