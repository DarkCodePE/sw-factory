import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_NAMES } from './agents.ts';
import { ensureSchema as ensureImproveSchema, parseSuite, rng, runArm, SPLITS, suiteDigest, type ArmResult, type RunOptions, type Suite, type SuiteTask } from './improve.ts';
import { canonicalJson, resolveProfile } from './profile.ts';
import { assertConfinement } from './sandbox/confine.ts';
import { StoreError } from './store.ts';

export interface Variant { name: string; profile: string; agent: string }

const bad = (message: string) => new StoreError('invalid_input', message);
const notFound = (id: string) => new StoreError('not_found', `benchmark ${id} no existe`);
const invalidState = (id: string, status: string, action: string) =>
  new StoreError('invalid_transition', `no se puede ${action} el benchmark ${id} en estado ${status}`);
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

function ensureSchema(db: Database): void {
  ensureImproveSchema(db);
  db.exec(`
CREATE TABLE IF NOT EXISTS benchmarks (
  id TEXT PRIMARY KEY, suite TEXT NOT NULL, suite_digest TEXT NOT NULL, variants TEXT NOT NULL, judge_profile TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','running','scoring','complete','failed','canceled')),
  created_at TEXT NOT NULL, finished_at TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS benchmark_scores (
  benchmark_id TEXT NOT NULL, run_rowid INTEGER NOT NULL, scorer TEXT NOT NULL,
  label TEXT, score REAL, passed INTEGER, cost_usd REAL, error TEXT,
  PRIMARY KEY (benchmark_id, run_rowid, scorer));`);
}

function checkProfile(stateDir: string, digest: string, field: string): void {
  if (!digest) throw bad(`${field}: se requiere un digest de perfil`);
  try { resolveProfile(stateDir, digest); }
  catch (error) { throw bad(`${field}: ${messageOf(error)}`); }
}

export function createBenchmark(db: Database, stateDir: string, i: { id: string; suitePath: string; variants: readonly Variant[]; judgeProfile?: string }): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(i.id)) throw bad('benchmark-id inválido (use A-Z, a-z, 0-9, _, -)');
  if (!Array.isArray(i.variants) || i.variants.length < 2 || i.variants.length > 8) throw bad('variants debe tener de 2 a 8 variantes');

  const names = new Set<string>();
  const variants = i.variants.map(({ name, profile, agent }, index) => {
    const field = `variants[${index}]`;
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,24}$/.test(name)) throw bad(`${field}.name inválido (use a-z, 0-9, -)`);
    if (names.has(name)) throw bad(`${field}.name repetido: ${name}`);
    names.add(name);
    checkProfile(stateDir, profile, `${field}.profile`);
    if (!AGENT_NAMES.includes(agent)) throw bad(`${field}.agent debe ser uno de ${AGENT_NAMES.join(', ')}`);
    return { name, profile, agent };
  });
  if (i.judgeProfile !== undefined) checkProfile(stateDir, i.judgeProfile, 'judgeProfile');

  let raw: unknown;
  try { raw = JSON.parse(readFileSync(i.suitePath, 'utf8')); }
  catch (error) { throw bad(`suite: ${messageOf(error)}`); }
  const suite = parseSuite(raw);
  const now = new Date().toISOString();
  db.transaction(() => {
    ensureSchema(db);
    const reserved = db.query('INSERT INTO experiment_ids (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING').run(i.id, now);
    if (reserved.changes !== 1) throw new StoreError('conflict', `el id ${i.id} ya se usó y no se reutiliza`);
    db.query(`INSERT INTO benchmarks (id, suite, suite_digest, variants, judge_profile, status, created_at)
      VALUES (?,?,?,?,?,'pending',?)`).run(i.id, canonicalJson(suite), suiteDigest(suite), canonicalJson(variants), i.judgeProfile ?? null, now);
  }).immediate();
}

function getBenchmark(db: Database, id: string) {
  if (!db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'benchmarks'").get()) throw notFound(id);
  const row = db.query<{ suite: string; variants: string; status: string }, [string]>(
    'SELECT suite, variants, status FROM benchmarks WHERE id = ?',
  ).get(id);
  if (!row) throw notFound(id);
  return row;
}

export function cancelBenchmark(db: Database, id: string): void {
  const { status } = getBenchmark(db, id);
  if (status === 'canceled') return;
  const canceled = db.query(`UPDATE benchmarks SET status = 'canceled', finished_at = ?
    WHERE id = ? AND status IN ('pending','running','scoring')`).run(new Date().toISOString(), id);
  if (!canceled.changes) {
    const current = getBenchmark(db, id).status;
    if (current !== 'canceled') throw invalidState(id, current, 'cancelar');
  }
}

interface Job { task: SuiteTask; repeat: number; position: number; variant: Variant }

function planJobs(tasks: SuiteTask[], variants: Variant[], repeats: number, seed: number): Job[] {
  const next = rng(seed);
  const jobs: Job[] = [];
  for (const task of tasks) for (let repeat = 1; repeat <= repeats; repeat++) {
    const order = [...variants];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    for (const [position, variant] of order.entries()) jobs.push({ task, repeat, position, variant });
  }
  return jobs;
}

// resume: retoma un benchmark que quedó en `running` porque su proceso murió. No puede distinguirlo de uno vivo: lo decide quien llama.
export async function runBenchmark(db: Database, stateDir: string, id: string, o: Omit<RunOptions, 'agent'> & { resume?: boolean }): Promise<{ seed: number; runs: number }> {
  const benchmark = getBenchmark(db, id);
  const resuming = !!o.resume && benchmark.status === 'running';
  if (benchmark.status !== 'pending' && !resuming) throw invalidState(id, benchmark.status, 'ejecutar');
  if (!SPLITS.includes(o.split)) throw bad(`split debe ser ${SPLITS.join('|')}`);
  if (!Number.isSafeInteger(o.repeats) || o.repeats < 1) throw bad('--repeats debe ser un entero ≥ 1');
  const concurrency = o.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw bad('--concurrency debe ser un entero ≥ 1');
  // Las filas se escriben en el orden del plan: las ya guardadas son los primeros trabajos.
  const done = resuming
    ? db.query<{ seed: number; split: string; n: number }, [string]>('SELECT min(seed) AS seed, min(split) AS split, count(*) AS n FROM experiment_runs WHERE experiment_id = ?').get(id)!
    : { seed: null, split: o.split, n: 0 };
  if (done.n && done.split !== o.split) throw bad(`el benchmark ${id} ya corrió el split ${done.split}`);
  const seed = done.n ? done.seed! : o.seed ?? Math.floor(Math.random() * 2 ** 31);
  if (!Number.isSafeInteger(seed)) throw bad('--seed debe ser un entero seguro');

  const tasks = (JSON.parse(benchmark.suite) as Suite).tasks.filter(t => t.split === o.split);
  if (!tasks.length) throw bad(`la suite no tiene tareas en el split ${o.split}`);
  const variants = JSON.parse(benchmark.variants) as Variant[];
  const jobs = planJobs(tasks, variants, o.repeats, seed);
  if (done.n > jobs.length) throw bad(`--repeats da ${jobs.length} trabajos y el benchmark ya tiene ${done.n} filas`);
  if (!resuming) {
    const claimed = db.query("UPDATE benchmarks SET status = 'running' WHERE id = ? AND status = 'pending'").run(id);
    if (claimed.changes !== 1) throw invalidState(id, getBenchmark(db, id).status, 'ejecutar');
  }

  const finish = db.query<never, [string, string, string | null, string]>(`UPDATE benchmarks SET status = ?, finished_at = ?, error = ?
    WHERE id = ? AND status = 'running'`);
  const status = db.query<{ status: string }, [string]>('SELECT status FROM benchmarks WHERE id = ?');
  const running = () => status.get(id)?.status === 'running';
  let runs = done.n;
  try {
    if (o.confine) for (const agent of new Set(variants.map(v => v.agent))) assertConfinement(agent);
    const batch = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const insert = db.query(`INSERT INTO experiment_runs (experiment_id, batch, seed, split, task_id, repeat, arm, position, profile_digest, agent,
      success, diff_lines, duration_ms, cost_usd, change_id, error, created_at, integrity_ok, task_group, confined, worker_report)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    // Concurrencia solo en la ejecución. Los rowid conservan el orden del plan.
    const ready = new Map<number, ArmResult>();
    let infrastructureError: string | null = null;
    const flush = () => {
      for (let result = ready.get(runs); result; result = ready.get(runs)) {
        const { task, repeat, position, variant } = jobs[runs]!;
        insert.run(id, batch, seed, o.split, task.id, repeat, variant.name, position, variant.profile, variant.agent,
          result.success ? 1 : 0, result.diffLines, result.durationMs, result.costUsd, result.changeId, result.error, new Date().toISOString(),
          result.integrityOk === null ? null : Number(result.integrityOk), task.group ?? null, o.confine ? 1 : 0, result.workerReport);
        ready.delete(runs++);
        // runArm deja la integridad sin medir si falla antes de verificar (clon, checkout, confinamiento).
        if (result.integrityOk === null || result.error?.startsWith('restauración de rutas protegidas falló:')) {
          infrastructureError ??= result.error ?? 'fallo de infraestructura en un brazo';
        }
      }
    };

    let cursor = done.n;
    let stopped = false;
    const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      try {
        while (!stopped && cursor < jobs.length && running()) {
          const { task, repeat, position, variant } = jobs[cursor]!;
          // El separador no forma parte de los ids de tarea ni de variante.
          const root = join(stateDir, 'improve', id, `${batch}-${task.id}_r${repeat}_${variant.name}`);
          o.log?.(`[bench ${id}] ${task.id} r${repeat} ${variant.name} (${position + 1}/${variants.length})`);
          if (!running()) break;
          const index = cursor++;
          const started = Date.now();
          const result = await runArm(stateDir, root, task, variant.profile, variant.agent, !!o.acceptBinaries, !!o.confine)
            .catch(error => ({
              success: false, diffLines: 0, durationMs: Date.now() - started, costUsd: null, changeId: null,
              error: messageOf(error), integrityOk: null, workerReport: null,
            }));
          ready.set(index, result);
          flush();
        }
      } catch (error) {
        stopped = true;
        throw error;
      }
    }));
    const failure = workers.find(worker => worker.status === 'rejected');
    if (failure) throw failure.reason;
    if (infrastructureError !== null && running()) throw new Error(infrastructureError);
    finish.run('complete', new Date().toISOString(), null, id);
    return { seed, runs };
  } catch (error) {
    finish.run('failed', new Date().toISOString(), messageOf(error), id);
    throw error;
  }
}
