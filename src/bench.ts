import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_NAMES } from './agents.ts';
import { ensureSchema as ensureImproveSchema, parseSuite, rng, runArm, SPLITS, suiteDigest, type ArmResult, type RunOptions, type Suite, type SuiteTask } from './improve.ts';
import { canonicalJson, resolveProfile } from './profile.ts';
import { assertConfinement } from './sandbox/confine.ts';
import { judge, type Launch } from './scorers.ts';
import { Store, StoreError } from './store.ts';

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

const hasBenchmarks = (db: Database) =>
  !!db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'benchmarks'").get();

type BenchmarkRow = { id: string; status: string; variants: string; created_at: string };

export function listBenchmarks(db: Database) {
  if (!hasBenchmarks(db)) return [];
  return db.query<BenchmarkRow, []>('SELECT id, status, variants, created_at FROM benchmarks ORDER BY created_at DESC, id').all()
    // T88-H1: una fila con `variants` que no es JSON no tumba la lista entera: `null` = ilegible.
    .map(row => ({ ...row, variants: (() => { try { return JSON.parse(row.variants) as Variant[]; } catch { return null; } })() }));
}

export function getBenchmark(db: Database, id: string) {
  if (!hasBenchmarks(db)) throw notFound(id);
  const row = db.query<{ suite: string; suite_digest: string; variants: string; status: string; judge_profile: string | null; error: string | null }, [string]>(
    'SELECT suite, suite_digest, variants, status, judge_profile, error FROM benchmarks WHERE id = ?',
  ).get(id);
  if (!row) throw notFound(id);
  return row;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Una sola fuente para la tabla y el JSON: los dos salen de aquí, así no pueden discrepar. */
export function benchmarkSummary(db: Database, id: string) {
  const b = getBenchmark(db, id);
  const rows = db.query('SELECT * FROM experiment_runs WHERE experiment_id = ? ORDER BY rowid').all(id) as Record<string, any>[];
  const scored = db.query(`SELECT r.arm, s.scorer, s.score, s.passed FROM benchmark_scores s JOIN experiment_runs r ON r.rowid = s.run_rowid
    WHERE s.benchmark_id = ?`).all(id) as { arm: string; scorer: string; score: number | null; passed: number | null }[];
  const variants = [...new Set(rows.map(r => r.arm as string))].map(arm => {
    const r = rows.filter(x => x.arm === arm);
    // Un juez sin puntuar (score nulo) no entra en la tasa: se cuenta aparte, nunca como suspenso.
    const judges = [...new Set(scored.filter(x => x.arm === arm).map(x => x.scorer))].sort().map(scorer => {
      const j = scored.filter(x => x.arm === arm && x.scorer === scorer), ok = j.filter(x => x.score !== null);
      const passed = ok.filter(x => x.passed === 1).length;
      return { scorer, scored: ok.length, unscored: j.length - ok.length, passed, pass_rate: ok.length ? passed / ok.length : null, mean_score: ok.length ? mean(ok.map(x => x.score!)) : null };
    });
    const cost = r.map(x => x.cost_usd as number | null).filter((c): c is number => c !== null);
    return {
      variant: arm, agent: r[0]!.agent as string, profile: r[0]!.profile_digest as string, n: r.length,
      success_rate: mean(r.map(x => x.success as number)), mean_diff_lines: mean(r.map(x => x.diff_lines as number)),
      mean_duration_ms: mean(r.map(x => x.duration_ms as number)),
      // Coste desconocido es null («—»), nunca 0; `cost_known` dice cuántas filas lo informaron.
      mean_cost_usd: cost.length ? mean(cost) : null, cost_known: cost.length, judges,
    };
  });
  return { benchmark: id, status: b.status, error: b.error, suite_digest: b.suite_digest, judge_profile: b.judge_profile, variants };
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

type Meter = { agent?: string; model?: string; cost?: number; ms?: number };

/** Fase de puntuación: los jueces de `judge_profile` (ámbito implement o change, sin muestreo) sobre la implementación de cada brazo. El resultado es un aviso: el Store del brazo se abre en solo lectura. */
async function scoreRuns(db: Database, stateDir: string, id: string, judgeProfile: string, o: { launch?: Launch; log?: (m: string) => void }, live: () => boolean): Promise<void> {
  const defs = Object.entries(resolveProfile(stateDir, judgeProfile).profile.scorers ?? {}).filter(([, d]) => d.scope === 'implement' || d.scope === 'change');
  const runs = db.query<{ rowid: number; batch: string; task_id: string; repeat: number; arm: string; change_id: string }, [string]>(
    'SELECT rowid, batch, task_id, repeat, arm, change_id FROM experiment_runs WHERE experiment_id = ? AND change_id IS NOT NULL ORDER BY rowid').all(id);
  const scored = new Set(db.query<{ run_rowid: number; scorer: string }, [string]>('SELECT run_rowid, scorer FROM benchmark_scores WHERE benchmark_id = ?').all(id).map(r => `${r.run_rowid}\0${r.scorer}`));
  const save = db.query('INSERT OR IGNORE INTO benchmark_scores (benchmark_id, run_rowid, scorer, label, score, passed, cost_usd, error) VALUES (?,?,?,?,?,?,?,?)');
  for (const run of runs) {
    if (!live()) return;
    const armState = join(stateDir, 'improve', id, `${run.batch}-${run.task_id}_r${run.repeat}_${run.arm}`, 'state');
    let arm: Store | null = null, subject: string | undefined, failure: string | null = null;
    try {
      arm = new Store(join(armState, 'fabrica.db'), { readonly: true });
      subject = arm.listActivities({ changeId: run.change_id }).filter(a => a.kind === 'implementation' && a.status === 'completed').at(-1)?.id;
      if (!subject) failure = 'el brazo no tiene implementación completada';
    } catch (error) { failure = `Store del brazo: ${messageOf(error)}`; }
    try {
      for (const [scorer, def] of defs) {
        if (!live()) return;
        if (scored.has(`${run.rowid}\0${scorer}`)) continue; // ya puntuado antes de la caída
        const meter: Meter = {};
        const out = failure || !arm ? null : await judge(arm, armState, { id: randomUUID(), scorer, profile_digest: judgeProfile, scope: def.scope,
          subject_activity_id: subject!, change_id: run.change_id, workstream_id: '', attempts: 1 }, { launch: o.launch }, meter, stateDir);
        const done = out?.status === 'done' ? out : null;
        // Un fallo deja score nulo, nunca 0 (I3).
        save.run(id, run.rowid, scorer, done?.label ?? null, done?.score ?? null, done ? Number(done.passed) : null, meter.cost ?? null,
          done ? null : failure ?? (out as { error: string }).error);
        o.log?.(`[bench ${id}] juez ${scorer} ${run.task_id} r${run.repeat} ${run.arm} → ${done?.label ?? 'sin puntuar'}`);
      }
    } finally { arm?.close(); }
  }
}

// resume: retoma un benchmark que quedó en `running` o `scoring` porque su proceso murió. No puede distinguirlo de uno vivo: lo decide quien llama.
export async function runBenchmark(db: Database, stateDir: string, id: string, o: Omit<RunOptions, 'agent'> & { launch?: Launch; resume?: boolean }): Promise<{ seed: number; runs: number }> {
  const benchmark = getBenchmark(db, id);
  const resuming = !!o.resume && (benchmark.status === 'running' || benchmark.status === 'scoring');
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
  // En `scoring` la ejecución ya terminó: solo se retoma la puntuación.
  if (benchmark.status === 'scoring' && done.n !== jobs.length) throw bad(`--repeats da ${jobs.length} trabajos y el benchmark ya tiene ${done.n} filas`);
  if (!resuming) {
    const claimed = db.query("UPDATE benchmarks SET status = 'running' WHERE id = ? AND status = 'pending'").run(id);
    if (claimed.changes !== 1) throw invalidState(id, getBenchmark(db, id).status, 'ejecutar');
  }

  const finish = db.query<never, [string, string, string | null, string]>(`UPDATE benchmarks SET status = ?, finished_at = ?, error = ?
    WHERE id = ? AND status IN ('running','scoring')`);
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
    if (benchmark.judge_profile && (benchmark.status === 'scoring' || running() && db.query("UPDATE benchmarks SET status = 'scoring' WHERE id = ? AND status = 'running'").run(id).changes)) {
      await scoreRuns(db, stateDir, id, benchmark.judge_profile, o, () => status.get(id)?.status === 'scoring');
    }
    finish.run('complete', new Date().toISOString(), null, id);
    return { seed, runs };
  } catch (error) {
    finish.run('failed', new Date().toISOString(), messageOf(error), id);
    throw error;
  }
}
