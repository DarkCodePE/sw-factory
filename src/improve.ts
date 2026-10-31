// Experimentos de mejora de perfiles, fase 1: suite congelada con splits, corridas pareadas e informe.
// Sin cualificación estadística, rollout ni rollback (fase 2). Idea: ext/esf/internal/harnessprofile/qualification.go@d901657 (MIT).
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifierArgv } from './agent/mission-evidence.ts';
import { runPool } from './pool.ts';
import { canonicalJson, DEFAULT_DIGEST, loadProfile, resolveProfile, saveProfile } from './profile.ts';
import { Store, StoreError } from './store.ts';

export const SPLITS = ['development', 'validation', 'qualification'] as const;
export type Split = (typeof SPLITS)[number];
export interface SuiteTask { id: string; repo: string; base: string; description: string; verify: string; split: Split }
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
    try { verifierArgv(task.verify); } catch (e) { throw bad(`suite inválida: ${where}.verify: ${(e as Error).message}`); }
    return { id: task.id, repo: resolve(task.repo), base: task.base, description: task.description, verify: task.verify, split: task.split };
  });
  return { tasks: out };
}

export function createExperiment(db: Database, stateDir: string, i: { id: string; baseline: string; candidate: string; suitePath: string }): void {
  ensureSchema(db);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(i.id)) throw bad('experiment-id inválido (use A-Z, a-z, 0-9, _, -)');
  for (const d of [i.baseline, i.candidate]) {
    try { resolveProfile(stateDir, d); } catch (e) { throw bad((e as Error).message); }
  }
  if (!existsSync(i.suitePath)) throw bad(`suite no encontrada: ${i.suitePath}`);
  const suite = parseSuite(JSON.parse(readFileSync(i.suitePath, 'utf8')));
  const text = canonicalJson(suite);
  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      db.query('INSERT INTO experiment_ids (id, created_at) VALUES (?, ?)').run(i.id, now);
      db.query('INSERT INTO experiments (id, baseline, candidate, suite, suite_digest, created_at) VALUES (?,?,?,?,?,?)')
        .run(i.id, i.baseline, i.candidate, text, createHash('sha256').update(text).digest('hex'), now);
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
  const r = db.query('SELECT * FROM experiments WHERE id = ?').get(id) as Record<string, string> | null;
  if (!r) throw new StoreError('not_found', `experimento ${id} no existe`);
  return { id, baseline: r.baseline!, candidate: r.candidate!, suite: JSON.parse(r.suite!) as Suite, suiteDigest: r.suite_digest! };
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

export interface ArmResult { success: boolean; diffLines: number; durationMs: number; changeId: string | null; error: string | null }

/** Un brazo: clon desechable en el commit base, store y workstream propios, agente, y comando de verificación. */
async function runArm(stateDir: string, root: string, task: SuiteTask, digest: string, agent: string, acceptBinaries: boolean): Promise<ArmResult> {
  const started = Date.now();
  const fail = (error: string): ArmResult => ({ success: false, diffLines: 0, durationMs: Date.now() - started, changeId: null, error });
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
    try { await runPool(store, { workstream: ws.id, stateDir: state, untilIdle: true, acceptAgentBinaries: acceptBinaries, log: () => {} }); }
    catch (e) { error = (e as Error).message; }
    const status = store.getChange(changeId).status;
    const worktree = join(state, 'worktrees', changeId.slice(0, 8));
    if (!existsSync(worktree)) return { ...fail(error ?? `sin worktree (change ${status})`), changeId };
    // Duración = agente completo (investigación + implementación); la verificación no cuenta.
    const durationMs = Date.now() - started;
    await sh(worktree, [...git, 'add', '-A']);
    const numstat = (await sh(worktree, [...git, 'diff', '--cached', '--numstat', base])).out.trim();
    const diffLines = numstat ? numstat.split('\n').reduce((n, l) => { const [a, d] = l.split('\t'); return n + (Number(a) || 0) + (Number(d) || 0); }, 0) : 0;
    const v = await sh(worktree, verifierArgv(task.verify), VERIFY_TIMEOUT_MS).catch(e => ({ code: 127, out: String(e) }));
    if (v.code !== 0 && !error) error = `verify exit ${v.code} (change ${status})`;
    return { success: v.code === 0, diffLines, durationMs, changeId, error: v.code === 0 ? null : error };
  } finally { store.close(); }
}

export interface RunOptions { split: Split; repeats: number; agent: string; seed?: number; acceptBinaries?: boolean; log?: (m: string) => void }

export async function runExperiment(db: Database, stateDir: string, id: string, o: RunOptions): Promise<{ seed: number; runs: number }> {
  const exp = getExperiment(db, id);
  if (!SPLITS.includes(o.split)) throw bad(`split debe ser ${SPLITS.join('|')}`);
  if (!Number.isInteger(o.repeats) || o.repeats < 1) throw bad('--repeats debe ser un entero ≥ 1');
  const tasks = exp.suite.tasks.filter(t => t.split === o.split);
  if (!tasks.length) throw bad(`la suite no tiene tareas en el split ${o.split}`);
  const seed = o.seed ?? Math.floor(Math.random() * 2 ** 31);
  const batch = `${Date.now().toString(36)}`;
  const next = rng(seed);
  const log = o.log ?? (() => {});
  const arms = { baseline: exp.baseline, candidate: exp.candidate } as const;
  let runs = 0;
  for (const task of tasks) {
    for (let repeat = 1; repeat <= o.repeats; repeat++) {
      const order: ('baseline' | 'candidate')[] = next() < 0.5 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      for (const [position, arm] of order.entries()) {
        const root = join(stateDir, 'improve', id, `${batch}-${task.id}-r${repeat}-${arm}`);
        log(`[improve ${id}] ${task.id} r${repeat} ${arm} (${position + 1}/2)`);
        const r = await runArm(stateDir, root, task, arms[arm], o.agent, !!o.acceptBinaries);
        db.query(`INSERT INTO experiment_runs (experiment_id, batch, seed, split, task_id, repeat, arm, position, profile_digest, agent,
          success, diff_lines, duration_ms, change_id, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, batch, seed, o.split, task.id, repeat, arm, position, arms[arm], o.agent, r.success ? 1 : 0, r.diffLines, r.durationMs, r.changeId, r.error, new Date().toISOString());
        runs++;
      }
    }
  }
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
  const head = ['split', 'brazo', 'n', 'éxito', 'var(éxito)', 'var(diff)', 'diff medio', 'duración media s'];
  const table: string[][] = [head];
  for (const split of SPLITS) for (const arm of ['baseline', 'candidate']) {
    const r = rows.filter(x => x.split === split && x.arm === arm);
    if (!r.length) continue;
    const ok = r.map(x => x.success as number), diff = r.map(x => x.diff_lines as number);
    table.push([split, arm, String(r.length), f(mean(ok)), f(variance(ok)), f(variance(diff), 1), f(mean(diff), 1), f(mean(r.map(x => x.duration_ms as number)) / 1000, 1)]);
  }
  if (table.length === 1) return lines.concat('sin corridas todavía').join('\n');
  const w = head.map((_, c) => Math.max(...table.map(r => r[c]!.length)));
  lines.push(...table.map(r => r.map((x, c) => x.padEnd(w[c]!)).join('  ').trimEnd()));
  const seeds = [...new Set(rows.map(x => `${x.batch}:${x.seed}`))];
  lines.push(`semillas (lote:semilla): ${seeds.join(' ')}`);
  return lines.join('\n');
}
