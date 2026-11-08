// Experimentos de mejora de perfiles, fase 1: suite congelada con splits, corridas pareadas e informe.
// Sin cualificación estadística, rollout ni rollback (fase 2). Idea: ext/esf/internal/harnessprofile/qualification.go@d901657 (MIT).
import { assertConfinement } from './sandbox/confine.ts';
import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifierArgv } from './agent/mission-evidence.ts';
import { runDirectory } from './manifest.ts';
import { runPool } from './pool.ts';
import { DEFAULT_PROTECTED_PATHS, protectedIntegrity, purgeRegenerableCaches } from './validators/integrity.ts';
import { canonicalJson, DEFAULT_DIGEST, loadProfile, resolveProfile, saveProfile } from './profile.ts';
import { Store, StoreError } from './store.ts';

export const SPLITS = ['development', 'validation', 'qualification'] as const;
export type Split = (typeof SPLITS)[number];
export interface SuiteTask { id: string; repo: string; base: string; description: string; verify: string; split: Split; group?: string }
export interface Suite { tasks: SuiteTask[] }

const VERIFY_TIMEOUT_MS = 300_000;
const bad = (m: string) => new StoreError('invalid_input', m);

export function ensureSchema(db: Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS experiment_ids (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY, baseline TEXT NOT NULL, candidate TEXT NOT NULL, suite TEXT NOT NULL,
  suite_digest TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS experiment_runs (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT, experiment_id TEXT NOT NULL, batch TEXT NOT NULL, seed INTEGER NOT NULL,
  split TEXT NOT NULL, task_id TEXT NOT NULL, repeat INTEGER NOT NULL, arm TEXT NOT NULL, position INTEGER NOT NULL,
  profile_digest TEXT NOT NULL, agent TEXT NOT NULL, success INTEGER NOT NULL, diff_lines INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL, change_id TEXT, error TEXT, created_at TEXT NOT NULL);`);
  const cols = db.query('PRAGMA table_info(experiment_runs)').all() as { name: string }[];
  for (const [col, type] of [
    ['cost_usd', 'REAL'],
    ['integrity_ok', 'INTEGER'],
    ['task_group', 'TEXT'],
    ['confined', 'INTEGER NOT NULL DEFAULT 0 CHECK (confined IN (0,1))'],
    ['worker_report', 'TEXT'],
  ] as const)
    if (!cols.some(c => c.name === col)) db.exec(`ALTER TABLE experiment_runs ADD COLUMN ${col} ${type}`);
  const expCols = db.query('PRAGMA table_info(experiments)').all() as { name: string }[];
  if (!expCols.some(c => c.name === 'repeated_baseline')) db.exec('ALTER TABLE experiments ADD COLUMN repeated_baseline INTEGER NOT NULL DEFAULT 0');
  if (!expCols.some(c => c.name === 'control')) db.exec('ALTER TABLE experiments ADD COLUMN control TEXT');
}

export function parseSuite(raw: unknown): Suite {
  const tasks = (raw as { tasks?: unknown })?.tasks;
  if (!Array.isArray(tasks) || !tasks.length) throw bad('suite inválida: "tasks" debe ser una lista no vacía');
  const seen = new Set<string>();
  const out = tasks.map((t: Record<string, unknown>, i) => {
    const where = `suite.tasks[${i}]`;
    for (const k of ['id', 'repo', 'base', 'description', 'verify', 'split']) if (typeof t?.[k] !== 'string' || !t[k]) throw bad(`suite inválida: ${where}.${k} requerido`);
    const task = t as unknown as SuiteTask;
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(task.id)) throw bad(`suite inválida: ${where}.id debe ser a-z, 0-9, -`);
    if (seen.has(task.id)) throw bad(`suite inválida: id repetido ${task.id}`);
    seen.add(task.id);
    if (!SPLITS.includes(task.split)) throw bad(`suite inválida: ${where}.split debe ser ${SPLITS.join('|')}`);
    if (!/^[0-9a-f]{7,40}$/.test(task.base)) throw bad(`suite inválida: ${where}.base debe ser un commit hex`);
    if (t.group !== undefined && (typeof t.group !== 'string' || !t.group.trim())) throw bad(`suite inválida: ${where}.group debe ser un texto no vacío`);
    try { verifierArgv(task.verify); } catch (e) { throw bad(`suite inválida: ${where}.verify: ${(e as Error).message}`); }
    return { id: task.id, repo: resolve(task.repo), base: task.base, description: task.description, verify: task.verify, split: task.split, ...(task.group !== undefined && { group: task.group }) };
  });
  return { tasks: out };
}

/** Digest de la suite: el que guarda `createExperiment` y contra el que se comprueba una suite externa. */
export const suiteDigest = (suite: Suite) => createHash('sha256').update(canonicalJson(suite)).digest('hex');

export function createExperiment(db: Database, stateDir: string, i: { id: string; baseline: string; candidate: string; suitePath: string; repeatedBaseline?: boolean; control?: string }): void {
  ensureSchema(db);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(i.id)) throw bad('experiment-id inválido (use A-Z, a-z, 0-9, _, -)');
  for (const d of [i.baseline, i.candidate, ...(i.control ? [i.control] : [])]) {
    try { resolveProfile(stateDir, d); } catch (e) { throw bad((e as Error).message); }
  }
  if (!existsSync(i.suitePath)) throw bad(`suite no encontrada: ${i.suitePath}`);
  const suite = parseSuite(JSON.parse(readFileSync(i.suitePath, 'utf8')));
  const text = canonicalJson(suite);
  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      db.query('INSERT INTO experiment_ids (id, created_at) VALUES (?, ?)').run(i.id, now);
      db.query('INSERT INTO experiments (id, baseline, candidate, suite, suite_digest, created_at, repeated_baseline, control) VALUES (?,?,?,?,?,?,?,?)')
        .run(i.id, i.baseline, i.candidate, text, suiteDigest(suite), now, i.repeatedBaseline ? 1 : 0, i.control ?? null);
    }).immediate();
  } catch (e) {
    if (/UNIQUE|constraint/i.test((e as Error).message)) throw new StoreError('conflict', `el id de experimento ${i.id} ya se usó y no se reutiliza`);
    throw e;
  }
}

/** Borra experimento y corridas; el id queda quemado en experiment_ids. */
export function deleteExperiment(db: Database, id: string): void {
  ensureSchema(db);
  db.transaction(() => {
    db.query('DELETE FROM experiment_runs WHERE experiment_id = ?').run(id);
    if (db.query('DELETE FROM experiments WHERE id = ?').run(id).changes !== 1) throw new StoreError('not_found', `experimento ${id} no existe`);
  }).immediate();
}

function getExperiment(db: Database, id: string) {
  ensureSchema(db);
  const r = db.query('SELECT * FROM experiments WHERE id = ?').get(id) as Record<string, any> | null;
  if (!r) throw new StoreError('not_found', `experimento ${id} no existe`);
  return { id, baseline: r.baseline!, candidate: r.candidate!, suite: JSON.parse(r.suite!) as Suite, suiteDigest: r.suite_digest!, repeatedBaseline: r.repeated_baseline === 1, control: (r.control ?? null) as string | null };
}

/** PRNG mulberry32: misma semilla, mismo orden. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296);
  };
}

async function sh(cwd: string, argv: string[], timeoutMs = 60_000): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs, killSignal: 'SIGKILL' });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: o + e };
}

export interface ArmResult { integrityOk: boolean | null; success: boolean; diffLines: number; durationMs: number; costUsd: number | null; changeId: string | null; error: string | null; workerReport: string | null }

// Regla: propuestas/necesidad explícitas de tests por cláusula sin negación; bajo encabezados de tests también cuentan casos en viñetas.
export function describesTests(report: string): boolean {
  if (!report || typeof report !== 'string') return false;
  const noun = String.raw`\b(?:tests?|pytest|unittest|pruebas?|casos?\s+de\s+prueba)\b`;
  const testNoun = new RegExp(noun, 'i');
  const action = String.raw`(?:add(?:ed|ing)?|writ(?:e|ing|ten)|creat(?:e|ed|ing)|implement(?:ed|ing)?|propos(?:e|ed|ing)|anad\w*|agreg\w*|escrib\w*|crear|needs?|requires?|requieren?|necesitan?|(?:harian?\s+)?falta)`;
  const target = String.raw`(?:${noun}|\b(?:cases?|casos?|uno|una)\b)`;
  const proposal = new RegExp(String.raw`\b${action}\s+(?:(?:new|unit|integration|additional|a|an|some|the|nuev[oa]s?|un[oa]?s?|los|las)\s+){0,3}${target}|${noun}\s+(?:(?:that|que)\s+)?(?:to\s+(?:add|write|create|implement)|a\s+(?:anadir|agregar|escribir|crear)|(?:(?:would|should)\s+be\s+(?:needed|required|added|written|created)|(?:are\s+)?(?:needed|required))|necesari[oa]s?|harian?\s+falta)\b`, 'i');
  const negation = /\b(?:no|not|never|without|sin|ningun[oa]?|don't|doesn't|didn't|shouldn't|wouldn't)\b/i;
  let testsSection = false;
  for (const raw of report.normalize('NFD').replace(/\p{Diacritic}/gu, '').split('\n')) {
    const line = raw.trim().replace(/\*\*/g, '');
    const heading = /^#{1,6}\s+(.+)$/.exec(line)?.[1] ?? (/^[^\n:]+:$/.test(line) && !/^[-*]\s/.test(line) ? line : null);
    if (heading !== null) testsSection = testNoun.test(heading) && !negation.test(heading);
    const testContext = testNoun.test(line) || (testsSection && /^(?:[-*]|\d+[.)])\s/.test(line));
    if (testContext && line.split(/;|[.!?]|\b(?:but|pero)\b/i).some(clause => !negation.test(clause) && proposal.test(clause))) return true;
  }
  return false;
}

/** Informe final de la última actividad worker; la evidencia se reinicia por intento antes de ejecutar el agente. */
export function armWorkerReport(store: Store, stateDir: string, changeId: string): string | null {
  const acts = store.listActivities({ changeId });
  const workerActs = acts.filter(a => a.kind === 'implementation' || a.kind === 'investigation');
  const act = workerActs.at(-1);
  if (!act) return null;
  const meta = join(runDirectory(stateDir, changeId), `${act.id}.json`);
  if (existsSync(meta)) {
    const evidence = JSON.parse(readFileSync(meta, 'utf8'));
    if ('workerReport' in evidence) return typeof evidence.workerReport === 'string' ? evidence.workerReport : null;
  }
  return act.result || null;
}

/**
 * Coste del brazo: suma de `usage.costUsd` que el pool registra por activity. null si alguna activity no lo reporta
 * (agente sin coste) o se reintentó (el reintento sobrescribe la evidencia del intento anterior): un coste parcial subestimaría.
 */
export function armCost(store: Store, stateDir: string, changeId: string): number | null {
  const acts = store.listActivities({ changeId });
  if (!acts.length) return null;
  let total = 0;
  for (const a of acts) {
    if (a.retryCount > 0) return null;
    const meta = join(runDirectory(stateDir, changeId), `${a.id}.json`);
    if (!existsSync(meta)) return null;
    const cost = JSON.parse(readFileSync(meta, 'utf8'))?.usage?.costUsd;
    if (typeof cost !== 'number' || !Number.isFinite(cost)) return null;
    total += cost;
  }
  return total;
}

/** Devuelve cada ruta protegida al estado del commit base (la borra si es nueva). null si todo salió bien, o el primer error. */
export async function restoreProtected(worktree: string, base: string, paths: string[]): Promise<string | null> {
  const git = ['git', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null'];
  for (const p of paths) {
    const inBase = (await sh(worktree, [...git, 'cat-file', '-e', `${base}:${p}`])).code === 0;
    const r = inBase ? await sh(worktree, [...git, 'checkout', base, '--', p]) : await sh(worktree, [...git, 'rm', '-rfq', '--cached', '--ignore-unmatch', '--', p]);
    if (r.code !== 0) return `${p}: ${r.out.trim()}`;
    if (!inBase) rmSync(join(worktree, p), { recursive: true, force: true });
  }
  return null;
}

/** Un brazo: clon desechable en el commit base, store y workstream propios, agente, y comando de verificación. */
async function runArm(stateDir: string, root: string, task: SuiteTask, digest: string, agent: string, acceptBinaries: boolean, confine: boolean): Promise<ArmResult> {
  const started = Date.now();
  const fail = (error: string): ArmResult => ({ integrityOk: null, success: false, diffLines: 0, durationMs: Date.now() - started, costUsd: null, changeId: null, error, workerReport: null });
  mkdirSync(root, { recursive: true });
  const clone = join(root, 'repo');
  const git = ['git', '-c', 'core.hooksPath=/dev/null'];
  if ((await sh(root, [...git, 'clone', '-q', task.repo, clone])).code !== 0) return fail('git clone falló');
  const co = await sh(clone, [...git, 'checkout', '-q', task.base]);
  if (co.code !== 0) return fail(`checkout ${task.base} falló: ${co.out.trim()}`);
  const base = (await sh(clone, [...git, 'rev-parse', 'HEAD'])).out.trim();
  const state = join(root, 'state');
  mkdirSync(state, { recursive: true });
  if (digest !== DEFAULT_DIGEST) saveProfile(state, loadProfile(stateDir, digest));
  const store = new Store(join(state, 'fabrica.db'));
  let changeId: string | null = null;
  let error: string | null = null;
  try {
    const ws = store.createWorkstream({ slug: 'improve', goal: task.description, repo: clone, agent, workerConcurrency: 1,
      requireChangeApproval: false, requireApproval: false, profile: digest });
    store.setWorkstreamState(ws.id, 'active');
    changeId = store.createChange(ws.id, task.id, task.description).id;
    try { await runPool(store, { workstream: ws.id, stateDir: state, untilIdle: true, acceptAgentBinaries: acceptBinaries, confine, log: () => {} }); }
    catch (e) { error = (e as Error).message; }
    const status = store.getChange(changeId).status;
    const costUsd = armCost(store, state, changeId);
    const workerReport = armWorkerReport(store, state, changeId);
    const confinementError = confine ? store.listActivities({ changeId }).find(a => a.error?.includes('--confine:'))?.error : null;
    if (confinementError) return { ...fail(confinementError), costUsd, changeId, workerReport };
    const worktree = join(state, 'worktrees', changeId.slice(0, 8));
    if (!existsSync(worktree)) return { ...fail(error ?? `sin worktree (change ${status})`), costUsd, changeId, workerReport };
    // Duración = agente completo (investigación + implementación); la integridad y la verificación no cuentan.
    const durationMs = Date.now() - started;
    // Integridad: dato informativo. Las rutas protegidas tocadas se restauran al commit base antes de verificar, para que el agente no influya en el verificador.
    let tampered: string[];
    try { purgeRegenerableCaches(worktree); tampered = (await protectedIntegrity(worktree, base, DEFAULT_PROTECTED_PATHS)).tampered; }
    catch (e) { return { ...fail(`integridad: no verificable (${(e as Error).message})`), costUsd, changeId, workerReport }; }
    const restoreError = tampered.length ? await restoreProtected(worktree, base, tampered) : null;
    if (restoreError) return { ...fail(`restauración de rutas protegidas falló: ${restoreError}`), integrityOk: false, costUsd, changeId, workerReport };
    await sh(worktree, [...git, 'add', '-A']);
    const numstat = (await sh(worktree, [...git, 'diff', '--cached', '--numstat', base])).out.trim();
    const diffLines = numstat ? numstat.split('\n').reduce((n, l) => { const [a, d] = l.split('\t'); return n + (Number(a) || 0) + (Number(d) || 0); }, 0) : 0;
    const v = await sh(worktree, verifierArgv(task.verify), VERIFY_TIMEOUT_MS).catch(e => ({ code: 127, out: String(e) }));
    if (v.code !== 0 && !error) error = `verify exit ${v.code} (change ${status})`;
    return { integrityOk: !tampered.length, success: v.code === 0, diffLines, durationMs, costUsd, changeId, error: v.code === 0 ? null : error, workerReport };
  } finally { store.close(); }
}

export type Arm = 'baseline' | 'candidate' | 'baseline_rep' | 'control';
const ARM_ORDER: Arm[] = ['baseline', 'candidate', 'baseline_rep', 'control'];

/** Orden de los brazos de una repetición. Con dos brazos conserva el sorteo original (misma semilla, mismo orden); con más, Fisher-Yates sobre los brazos del experimento. */
function armOrder(next: () => number, repeatedBaseline: boolean, control: boolean): Arm[] {
  if (!repeatedBaseline && !control) return next() < 0.5 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
  const a = ARM_ORDER.filter(x => (x !== 'baseline_rep' || repeatedBaseline) && (x !== 'control' || control));
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
}

export interface RunOptions { split: Split; repeats: number; agent: string; seed?: number; acceptBinaries?: boolean; confine?: boolean; concurrency?: number; log?: (m: string) => void }

export async function runExperiment(db: Database, stateDir: string, id: string, o: RunOptions): Promise<{ seed: number; runs: number }> {
  const exp = getExperiment(db, id);
  if (!SPLITS.includes(o.split)) throw bad(`split debe ser ${SPLITS.join('|')}`);
  if (!Number.isInteger(o.repeats) || o.repeats < 1) throw bad('--repeats debe ser un entero ≥ 1');
  const concurrency = o.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw bad('--concurrency debe ser un entero ≥ 1');
  if (o.confine) assertConfinement(o.agent);
  const tasks = exp.suite.tasks.filter(t => t.split === o.split);
  if (!tasks.length) throw bad(`la suite no tiene tareas en el split ${o.split}`);
  const seed = o.seed ?? Math.floor(Math.random() * 2 ** 31);
  const batch = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const next = rng(seed);
  const log = o.log ?? (() => {});
  const arms: Record<Arm, string> = { baseline: exp.baseline, candidate: exp.candidate, baseline_rep: exp.baseline, control: exp.control ?? '' };
  const jobs: { task: SuiteTask; repeat: number; position: number; arm: Arm; count: number }[] = [];
  for (const task of tasks) for (let repeat = 1; repeat <= o.repeats; repeat++) {
    const order = armOrder(next, exp.repeatedBaseline, !!exp.control);
    for (const [position, arm] of order.entries()) jobs.push({ task, repeat, position, arm, count: order.length });
  }
  let cursor = 0;
  // Allocate PRNG decisions before awaiting; persist results in planned order too.
  const results: ArmResult[] = [];
  let persisted = 0;
  const flush = () => {
    while (results[persisted]) {
      const { task, repeat, position, arm } = jobs[persisted]!;
      const r = results[persisted++]!;
      db.query(`INSERT INTO experiment_runs (experiment_id, batch, seed, split, task_id, repeat, arm, position, profile_digest, agent,
        success, diff_lines, duration_ms, cost_usd, change_id, error, created_at, integrity_ok, task_group, confined, worker_report) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, batch, seed, o.split, task.id, repeat, arm, position, arms[arm], o.agent, r.success ? 1 : 0, r.diffLines, r.durationMs, r.costUsd, r.changeId, r.error, new Date().toISOString(),
          r.integrityOk === null ? null : r.integrityOk ? 1 : 0, task.group ?? null, o.confine ? 1 : 0, r.workerReport ?? null);
    }
  };
  let stopped = false;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (!stopped && cursor < jobs.length) {
      const index = cursor++;
      const { task, repeat, position, arm, count } = jobs[index]!;
      const root = join(stateDir, 'improve', id, `${batch}-${task.id}-r${repeat}-${arm}`);
      log(`[improve ${id}] ${task.id} r${repeat} ${arm} (${position + 1}/${count})`);
      try {
        results[index] = await runArm(stateDir, root, task, arms[arm], o.agent, !!o.acceptBinaries, !!o.confine);
        flush();
      } catch (e) { stopped = true; throw e; }
    }
  }));
  const failure = workers.find(w => w.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  const runs = jobs.length;
  if (o.confine && results.some(r => r.error?.includes('--confine:'))) throw bad(results.find(r => r.error?.includes('--confine:'))!.error!);
  return { seed, runs };
}

const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
/** Varianza muestral (n-1); 0 con menos de dos observaciones. */
export const variance = (xs: number[]) => xs.length < 2 ? 0 : xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1);

export function reportExperiment(db: Database, id: string): string {
  const exp = getExperiment(db, id);
  const rows = db.query('SELECT * FROM experiment_runs WHERE experiment_id = ? ORDER BY rowid').all(id) as Record<string, any>[];
  const f = (n: number, d = 3) => n.toFixed(d);
  const lines = [`experimento ${id}  suite ${exp.suiteDigest.slice(0, 12)}  baseline ${exp.baseline.slice(0, 12)}  candidate ${exp.candidate.slice(0, 12)}`];
  const head = ['split', 'brazo', 'n', 'éxito', 'var(éxito)', 'var(diff)', 'diff medio', 'duración media s', 'coste medio USD'];
  const table: string[][] = [head];
  for (const split of SPLITS) for (const arm of ARM_ORDER) {
    const r = rows.filter(x => x.split === split && x.arm === arm);
    if (!r.length) continue;
    const ok = r.map(x => x.success as number), diff = r.map(x => x.diff_lines as number);
    // Media solo de corridas con coste conocido; "(k/n)" deja visible cuántas lo reportaron.
    const cost = r.map(x => x.cost_usd as number | null).filter((c): c is number => c !== null);
    const costCell = !cost.length ? '—' : f(mean(cost), 4) + (cost.length < r.length ? ` (${cost.length}/${r.length})` : '');
    table.push([split, arm, String(r.length), f(mean(ok)), f(variance(ok)), f(variance(diff), 1), f(mean(diff), 1), f(mean(r.map(x => x.duration_ms as number)) / 1000, 1), costCell]);
  }
  if (table.length === 1) return lines.concat('sin corridas todavía').join('\n');
  const w = head.map((_, c) => Math.max(...table.map(r => r[c]!.length)));
  lines.push(...table.map(r => r.map((x, c) => x.padEnd(w[c]!)).join('  ').trimEnd()));
  const seeds = [...new Set(rows.map(x => `${x.batch}:${x.seed}`))];
  lines.push(`semillas (lote:semilla): ${seeds.join(' ')}`);
  return lines.join('\n');
}

/** Corridas crudas de `experiment_runs` (para `fab improve report <id> --json`): desglose por tarea y dispersión sin parsear el texto. */
export function experimentRunsJson(db: Database, id: string) {
  const exp = getExperiment(db, id);
  const rows = db.query('SELECT * FROM experiment_runs WHERE experiment_id = ? ORDER BY rowid').all(id) as Record<string, any>[];
  const runs = rows.map(x => {
    const present = typeof x.worker_report === 'string' && x.worker_report.trim().length > 0;
    const describes_tests = present && describesTests(x.worker_report);
    return {
      batch: x.batch, seed: x.seed, split: x.split, task_id: x.task_id, repeat: x.repeat, arm: x.arm, position: x.position,
      success: x.success, diff_lines: x.diff_lines, duration_ms: x.duration_ms, cost_usd: x.cost_usd ?? null,
      integrity_ok: x.integrity_ok ?? null, task_group: x.task_group ?? null, confined: x.confined === 1,
      worker_report: { present, describes_tests },
    };
  });
  const presentRuns = runs.filter(r => r.worker_report.present);
  const describesRuns = presentRuns.filter(r => r.worker_report.describes_tests);
  const worker_report_rate = presentRuns.length > 0 ? describesRuns.length / presentRuns.length : null;
  const worker_report_rate_by_arm: Record<string, number | null> = {};
  for (const arm of ARM_ORDER) {
    if (rows.some(r => r.arm === arm)) {
      const armRuns = runs.filter(r => r.arm === arm && r.worker_report.present);
      const armDescribes = armRuns.filter(r => r.worker_report.describes_tests);
      worker_report_rate_by_arm[arm] = armRuns.length > 0 ? armDescribes.length / armRuns.length : null;
    }
  }
  return {
    experiment: id, suite_digest: exp.suiteDigest, baseline: exp.baseline, candidate: exp.candidate, repeated_baseline: exp.repeatedBaseline, control: exp.control,
    confined: rows.length > 0 && rows.every(x => x.confined === 1),
    worker_report_rate,
    worker_report_rate_by_arm,
    by_arm: Object.fromEntries(Object.entries(worker_report_rate_by_arm).map(([arm, rate]) => [arm, { worker_report_rate: rate }])),
    runs,
  };
}
