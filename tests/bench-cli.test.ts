import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { benchMain, parseVariant } from '../src/bench-cli.ts';
import { defaultProfile, DEFAULT_DIGEST, saveProfile } from '../src/profile.ts';
import { Store } from '../src/store.ts';

let dir: string, repo: string, suite: string, store: Store, challenger: string;
let out: string[], err: string[];

function git(...args: string[]): string {
  const p = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args]);
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-bench-cli-'));
  repo = join(dir, 'repo');
  git('init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  git('-C', repo, 'add', '.'); git('-C', repo, 'commit', '-qm', 'init');
  const base = git('-C', repo, 'rev-parse', 'HEAD');
  suite = join(dir, 'suite.json');
  writeFileSync(suite, JSON.stringify({ tasks: ['t1', 't2'].map(id => ({ id, repo, base, split: 'development', description: id, verify: 'test -f a.txt', group: 'g' })) }));
  store = new Store(join(dir, 'fabrica.db'));
  challenger = saveProfile(dir, { ...defaultProfile(), schemaVersion: 2, harness: 'fake', roles: { implement: { model: 'fake-v2' } } }).digest;
  out = []; err = [];
  spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
});
afterEach(() => { (console.log as any).mockRestore(); (console.error as any).mockRestore(); store.close(); rmSync(dir, { recursive: true, force: true }); });

const run = (...a: string[]) => benchMain(a, store, dir);
const create = (...extra: string[]) => run('create', '--id', 'b1', '--suite', suite, '--variant', `base=${DEFAULT_DIGEST}@fake`, '--variant', `chall=${challenger}@fake`, ...extra);

test('--variant mal formado: error que nombra el formato', async () => {
  for (const v of ['sinigual', 'a=@fake', 'a=dig', 'a=dig@', '=dig@fake']) {
    err = [];
    expect(await run('create', '--id', 'b1', '--suite', suite, '--variant', v)).toBe(1);
    expect(err.join('\n')).toContain('<nombre>=<digest>@<agente>');
  }
  expect(parseVariant('a=abc@fake')).toEqual({ name: 'a', profile: 'abc', agent: 'fake' });
});

test('create, run, report: la tabla y --json dan los mismos números', async () => {
  expect(await create()).toBe(0);
  expect(await run('run', 'b1', '--split', 'development', '--repeats', '2', '--seed', '3')).toBe(0);
  expect(out.at(-1)).toContain('8 corridas registradas');
  out = [];
  expect(await run('report', 'b1')).toBe(0);
  const text = out.join('\n');
  out = [];
  expect(await run('report', 'b1', '--json')).toBe(0);
  const json = JSON.parse(out.join('\n'));
  expect(json.variants.map((v: any) => v.variant).sort()).toEqual(['base', 'chall']);
  for (const v of json.variants) {
    expect(v.n).toBe(4);
    const line = text.split('\n').find(l => l.startsWith(v.variant))!.split(/\s{2,}/);
    expect(line[2]).toBe(String(v.n));
    expect(line[3]).toBe(v.success_rate.toFixed(3));
    expect(line[4]).toBe(v.mean_diff_lines.toFixed(1));
    expect(line[5]).toBe((v.mean_duration_ms / 1000).toFixed(1));
    expect(v.mean_cost_usd).toBeNull(); // sin coste informado: null, no 0
    expect(line[6]).toBe('—');
  }
});

test('subcomando desconocido, id inexistente y --split inválido salen con error', async () => {
  expect(await run('nope')).toBe(1);
  expect(await run('report', 'ghost')).toBe(1);
  expect(err.join('\n')).toContain('no existe');
  await create();
  err = [];
  expect(await run('run', 'b1', '--split', 'x')).toBe(1);
  expect(err.join('\n')).toContain('--split debe ser');
});

test('cancel marca canceled y el informe lo muestra', async () => {
  await create();
  expect(await run('cancel', 'b1')).toBe(0);
  expect(await run('report', 'b1')).toBe(0);
  expect(out.join('\n')).toContain('estado canceled');
});

test('add-task escribe el fichero nuevo y no toca la suite; sin --out falla', async () => {
  const ws = store.createWorkstream({ slug: 'w', goal: 'g', repo, verify: ['bun test x'] });
  const c = store.createChange(ws.id, 'T', 'desc');
  store.setChangeBase(c.id, 'a'.repeat(40));
  store.db.query("UPDATE changes SET status = 'completed' WHERE id = ?").run(c.id);
  const before = readFileSync(suite, 'utf8'), o = join(dir, 'nueva.json');
  expect(await run('add-task', c.id, '--id', 'nueva', '--split', 'development', '--out', o, '--suite', suite)).toBe(0);
  expect(JSON.parse(readFileSync(o, 'utf8')).tasks.map((t: any) => t.id)).toEqual(['t1', 't2', 'nueva']);
  expect(readFileSync(suite, 'utf8')).toBe(before);
  expect(await run('add-task', c.id, '--id', 'n2', '--split', 'development', '--out', o)).toBe(1); // out existe
  expect(await run('add-task', c.id, '--id', 'n2', '--split', 'development')).toBe(1);
  expect(existsSync(o)).toBe(true);
});

test('--seed fija la semilla impresa y el orden; --confine queda guardado en las filas', async () => {
  await create();
  expect(await run('run', 'b1', '--split', 'development', '--seed', '3')).toBe(0);
  expect(out.at(-1)).toContain('semilla 3');
  const seeds = store.db.query<{ seed: number; confined: number }, []>("SELECT DISTINCT seed, confined FROM experiment_runs WHERE experiment_id = 'b1'").all();
  expect(seeds).toEqual([{ seed: 3, confined: 0 }]);
  if (!Bun.which('bwrap')) return;
  await run('create', '--id', 'b2', '--suite', suite, '--variant', `base=${DEFAULT_DIGEST}@fake`, '--variant', `chall=${challenger}@fake`);
  expect(await run('run', 'b2', '--split', 'development', '--seed', '3', '--confine')).toBe(0);
  const order = (id: string) => store.db.query("SELECT task_id, arm FROM experiment_runs WHERE experiment_id = ? ORDER BY rowid").all(id);
  expect(order('b2')).toEqual(order('b1')); // misma semilla, mismo orden
  expect(store.db.query("SELECT DISTINCT confined FROM experiment_runs WHERE experiment_id = 'b2'").all()).toEqual([{ confined: 1 }]);
}, 60_000);

test('report imprime el error en una línea y sin caracteres de control', async () => {
  await create();
  store.db.query("UPDATE benchmarks SET status = 'failed', error = ? WHERE id = 'b1'").run('uno\x1b[31mrojo\nfalso: dos\r\x07');
  out = [];
  expect(await run('report', 'b1')).toBe(0);
  const text = out.join('\n');
  expect(text).toContain('error: uno [31mrojo falso: dos');
  expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
  expect(text.split('\n')).toHaveLength(2); // cabecera + «sin corridas todavía»
});
