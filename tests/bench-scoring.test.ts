import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRun } from '../src/agents.ts';
import { benchmarkSummary, reportBenchmarkText } from '../src/bench-cli.ts';
import { cancelBenchmark, createBenchmark, runBenchmark, type Variant } from '../src/bench.ts';
import { DEFAULT_DIGEST, defaultProfile, saveProfile, type ScorerDef } from '../src/profile.ts';

let dir: string, db: Database, suitePath: string, variants: Variant[];
const classes = [{ label: 'ok', score: 1 }, { label: 'mal', score: 0 }];
const def = (extra: Partial<ScorerDef> = {}): ScorerDef => ({ scope: 'implement', rubric: 'Evalúa.', classes, passing: 0.5, sampling: 0, ...extra });
const options = { split: 'development', repeats: 2, seed: 7 } as const;

function git(...args: string[]): string {
  const p = Bun.spawnSync(['git', '-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args]);
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}
const judges = (scorers: Record<string, ScorerDef>) => saveProfile(dir, { ...defaultProfile(), schemaVersion: 2, harness: 'fake', scorers } as any).digest;
const reply = (label: string) => (p: string): AgentRun => ({ ok: true, output: `CLASS ${/CLASS (\S+):/.exec(p)![1]}: ${label}\n\nporque sí`, exitCode: 0, durationMs: 5, usage: { costUsd: 0.01 } as any, status: { kind: 'done', reason: '' } });
const status = (id: string) => (db.query('SELECT status FROM benchmarks WHERE id = ?').get(id) as { status: string }).status;
const scores = (id: string) => db.query('SELECT * FROM benchmark_scores WHERE benchmark_id = ? ORDER BY run_rowid, scorer').all(id) as any[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-bench-scoring-'));
  const repo = join(dir, 'repo');
  git('init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  git('-C', repo, 'add', '.'); git('-C', repo, 'commit', '-qm', 'init');
  const base = git('-C', repo, 'rev-parse', 'HEAD');
  suitePath = join(dir, 'suite.json');
  writeFileSync(suitePath, JSON.stringify({ tasks: ['t1', 't2', 't3'].map(id => ({ id, repo, base, split: 'development', description: id, verify: 'test -f a.txt', group: 'g' })) }));
  db = new Database(join(dir, 'fabrica.db'));
  // Cada variante trae sus propios jueces: no deben usarse (B3).
  const own = judges({ propio: def() });
  variants = [{ name: 'base', profile: DEFAULT_DIGEST, agent: 'fake' }, { name: 'challenger', profile: own, agent: 'fake' }];
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const create = (id: string, judgeProfile?: string) => createBenchmark(db, dir, { id, suitePath, variants, judgeProfile });

test('puntúa cada brazo con los jueces de judge_profile (B3) y recorre pending, running, scoring y complete', async () => {
  create('s1', judges({ calidad: def(), global: def({ scope: 'change' }), spec: def({ scope: 'investigate' }) }));
  const seen = new Set<string>([status('s1')]);
  const prompts: string[] = [];
  const r = await runBenchmark(db, dir, 's1', { ...options, log: () => seen.add(status('s1')),
    launch: async (_a, prompt) => { seen.add(status('s1')); prompts.push(prompt); return reply('ok')(prompt); } });
  expect(r.runs).toBe(12);
  expect([...seen]).toEqual(['pending', 'running', 'scoring']);
  expect(status('s1')).toBe('complete');
  const s = scores('s1');
  expect(s).toHaveLength(24); // 12 filas × 2 jueces; `investigate` no aplica y `propio` de la variante tampoco
  expect(new Set(s.map(x => x.scorer))).toEqual(new Set(['calidad', 'global']));
  expect(s.every(x => x.label === 'ok' && x.score === 1 && x.passed === 1 && x.cost_usd === 0.01 && x.error === null)).toBe(true);
  expect(prompts.every(p => p.includes('a.txt') || p.includes('# Material'))).toBe(true);
  expect(existsSync(join(dir, 'scores'))).toBe(false);
}, 60_000);

test('un juez que falla o no devuelve clase deja score nulo, no cero, y el benchmark termina', async () => {
  create('s2', judges({ j: def() }));
  let n = 0;
  await runBenchmark(db, dir, 's2', { ...options, repeats: 1, launch: async (_a, p) => {
    n++;
    if (n % 3 === 0) return { ok: false, output: '', exitCode: 2, durationMs: 1, status: { kind: 'blocked', reason: '' } } as AgentRun;
    if (n % 3 === 1) return { ok: true, output: 'sin clase', exitCode: 0, durationMs: 1, status: { kind: 'done', reason: '' } } as AgentRun;
    return reply('mal')(p);
  } });
  expect(status('s2')).toBe('complete');
  const s = scores('s2');
  expect(s).toHaveLength(6);
  const nulls = s.filter(x => x.score === null);
  expect(nulls).toHaveLength(4);
  expect(nulls.every(x => x.label === null && x.passed === null && x.error)).toBe(true);
  expect(s.filter(x => x.score === 0 && x.label === 'mal' && x.passed === 0)).toHaveLength(2);
});

test('sin judge_profile no hay fase scoring ni filas', async () => {
  create('s3');
  const seen = new Set<string>();
  await runBenchmark(db, dir, 's3', { ...options, repeats: 1, log: () => seen.add(status('s3')) });
  expect([...seen]).toEqual(['running']);
  expect(status('s3')).toBe('complete');
  expect(scores('s3')).toHaveLength(0);
});

test('cancelar durante scoring no lanza más jueces y conserva lo puntuado', async () => {
  create('s4', judges({ j: def() }));
  let n = 0;
  await runBenchmark(db, dir, 's4', { ...options, launch: async (_a, p) => { if (++n === 3) cancelBenchmark(db, 's4'); return reply('ok')(p); } });
  expect(n).toBe(3);
  expect(status('s4')).toBe('canceled');
  expect(scores('s4')).toHaveLength(3);
});

test('el informe da tasa de aprobado por juez y por variante; fallos cuentan como sin puntuar', async () => {
  create('s5', judges({ j: def() }));
  let n = 0;
  await runBenchmark(db, dir, 's5', { ...options, repeats: 1, launch: async (_a, p) => {
    n++;
    return n === 1 ? ({ ok: false, output: '', exitCode: 1, durationMs: 1, status: { kind: 'blocked', reason: '' } } as AgentRun) : reply(n % 2 ? 'ok' : 'mal')(p);
  } });
  const s = benchmarkSummary(db, 's5');
  const all = s.variants.flatMap(v => v.judges);
  expect(all.length).toBe(2);
  expect(all.reduce((a, j) => a + j.scored, 0)).toBe(5);
  expect(all.reduce((a, j) => a + j.unscored, 0)).toBe(1);
  for (const v of s.variants) for (const j of v.judges) expect(j.pass_rate).toBe(j.scored ? j.passed / j.scored : null);
  const text = reportBenchmarkText(db, 's5');
  expect(text).toContain('j');
  expect(text).toContain('sin puntuar');
  expect(text).toContain('activities.agent');
});

test('el juez deja el Store del brazo intacto y borra su directorio temporal', async () => {
  create('s6', judges({ j: def() }));
  await runBenchmark(db, dir, 's6', { ...options, repeats: 1, launch: async (_a, p) => reply('ok')(p) });
  const arms = readdirSync(join(dir, 'improve', 's6'));
  expect(arms).toHaveLength(6);
  for (const a of arms) expect(readdirSync(join(dir, 'improve', 's6', a, 'state', 'scores'))).toEqual([]);
});
