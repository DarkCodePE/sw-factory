import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { ensureSchema, experimentRunsJson, reportExperiment, suiteDigest } from '../src/improve.ts';
import { startWeb } from '../src/web.ts';

let dir: string, store: Store, server: ReturnType<typeof startWeb> | undefined;
const suite = { tasks: [
  { id: 'a', repo: '/r', base: 'abc1234', description: '<b>desc</b>', verify: 'true', split: 'development' },
  { id: 'b', repo: '/r', base: 'abc1234', description: 'd', verify: 'true', split: 'validation' }] };
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fab-web-exp-')); store = new Store(join(dir, 'fabrica.db')); });
afterEach(() => { server?.stop(true); server = undefined; store.close(); rmSync(dir, { recursive: true, force: true }); });
const get = (p: string) => fetch(`http://127.0.0.1:${server!.port}${p}`);

function seed() {
  ensureSchema(store.db);
  store.db.query('INSERT INTO experiments (id,baseline,candidate,suite,suite_digest,created_at) VALUES (?,?,?,?,?,?)').run('e1', 'base'.repeat(20), 'cand'.repeat(20), JSON.stringify(suite), suiteDigest(suite as any), '2026-01-01T00:00:00Z');
  const ins = store.db.query(`INSERT INTO experiment_runs (experiment_id,batch,seed,split,task_id,repeat,arm,position,profile_digest,agent,success,diff_lines,duration_ms,cost_usd,created_at) VALUES ('e1','b1',7,'development',?,?,?,0,'d','native',?,?,1000,?,'t')`);
  ins.run('a', 0, 'baseline', 1, 10, 0.5); ins.run('a', 0, 'candidate', 0, 30, null); ins.run('a', 1, 'candidate', 1, 20, 0.25);
}

test('lista y detalle coinciden con improve report --json y escapan texto', async () => {
  seed(); server = startWeb(dir, 0);
  const list = await (await get('/experimentos')).text();
  expect(list).toContain('e1');
  expect(list).toContain('&lt;b&gt;desc&lt;/b&gt;'); expect(list).toContain('Validación');
  const r = await get('/experimentos/' + 'e1'); expect(r.status).toBe(200);
  const html = await r.text();
  const json = experimentRunsJson(store.db, 'e1');
  expect(html).toContain(reportExperiment(store.db, 'e1').split('\n')[1]!.replace(/&/g, '&amp;'));
  expect(json.runs.length).toBe(3);
  expect(html).toContain('0.50 USD'); expect(html).toContain('0.25 USD'); expect(html).toContain('No medido');
  expect(html).toContain('<td>30</td>');
});
test('base sin tablas de experimentos: no las crea', async () => {
  const before = readdirSync(dir).sort();
  server = startWeb(dir, 0);
  for (const p of ['/experimentos', '/experimentos/x']) { const r = await get(p); expect([200, 404]).toContain(r.status); }
  expect(await (await get('/experimentos')).text()).toContain('No hay experimentos');
  expect(store.db.query("SELECT name FROM sqlite_schema WHERE name LIKE 'experiment%'").all()).toEqual([]);
  expect(readdirSync(dir).sort()).toEqual(before);
});
test('experimento inexistente y id inválido', async () => {
  seed(); server = startWeb(dir, 0);
  expect((await get('/experimentos/nada')).status).toBe(404);
  expect((await get('/experimentos/a%2Fb')).status).toBe(400);
});
test('esquema antiguo sin columnas nuevas no se migra', async () => {
  store.db.exec('CREATE TABLE experiments (id TEXT PRIMARY KEY, baseline TEXT, candidate TEXT, suite TEXT, suite_digest TEXT, created_at TEXT)');
  server = startWeb(dir, 0);
  const r = await get('/experimentos'); expect(r.status).toBe(200); expect(await r.text()).toContain('incompleto');
  expect(store.db.query("PRAGMA table_info(experiments)").all().length).toBe(6);
});
test('brazo sin ningún coste medido muestra «No medido», no cero', async () => {
  seed(); store.db.query("UPDATE experiment_runs SET cost_usd=NULL").run(); server = startWeb(dir, 0);
  const html = await (await get('/experimentos/e1')).text();
  expect(html).not.toContain('0.00 USD'); expect(html).toContain('<td>No medido</td>');
});
test('esquema al que solo le falta la columna control se declara incompleto', async () => {
  seed(); store.db.exec('ALTER TABLE experiments DROP COLUMN control'); server = startWeb(dir, 0);
  expect(await (await get('/experimentos')).text()).toContain('incompleto');
});

const insExp = (id: string, st: unknown, base = 'base'.repeat(20), digest = suiteDigest(st as any)) =>
  store.db.query('INSERT INTO experiments (id,baseline,candidate,suite,suite_digest,created_at) VALUES (?,?,?,?,?,?)').run(id, base, 'cand'.repeat(20), JSON.stringify(st), digest, '2026-01-01T00:00:00Z');
const row = (html: string, split: string, arm: string) => new RegExp(`<tr><td>${split}</td><td>${arm}</td>(<td>[^<]*</td>){3}</tr>`).exec(html)?.[0];

test('H1: el resumen por brazo coincide con experimentRunsJson (éxito, repeticiones y coste por brazo)', async () => {
  seed(); server = startWeb(dir, 0);
  const html = await (await get('/experimentos/e1')).text();
  const runs = experimentRunsJson(store.db, 'e1').runs;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  for (const arm of ['baseline', 'candidate']) {
    const r = runs.filter(x => x.arm === arm), k = r.map(x => x.cost_usd).filter((c): c is number => c !== null);
    const cost = `${mean(k).toFixed(2)} USD${k.length < r.length ? ` (${k.length}/${r.length})` : ''}`;
    expect(row(html, 'Desarrollo', arm)).toBe(`<tr><td>Desarrollo</td><td>${arm}</td><td>${r.length}</td><td>${mean(r.map(x => x.success)).toFixed(3)}</td><td>${cost}</td></tr>`);
  }
  expect(row(html, 'Desarrollo', 'baseline')).toContain('<td>1.000</td>');
  expect(row(html, 'Desarrollo', 'candidate')).toContain('<td>0.500</td><td>0.25 USD (1/2)</td>');
});
test('H1/H4c: brazo sin coste medido muestra «No medido» en el resumen, no 0', async () => {
  seed(); store.db.query("UPDATE experiment_runs SET cost_usd=NULL WHERE arm='candidate'").run(); server = startWeb(dir, 0);
  expect(row(await (await get('/experimentos/e1')).text(), 'Desarrollo', 'candidate')).toContain('<td>No medido</td></tr>');
});
test('H2/H3: filas raras no se interpolan sin escapar y no dan 500', async () => {
  seed(); store.db.query("UPDATE experiment_runs SET repeat='<i>r</i>', diff_lines='<i>d</i>', duration_ms='<i>m</i>', cost_usd='<i>c</i>' WHERE arm='baseline'").run();
  server = startWeb(dir, 0);
  const r = await get('/experimentos/e1'); expect(r.status).toBe(200);
  const html = await r.text();
  expect(html).not.toContain('<i>'); expect(html).toContain('&lt;i&gt;r&lt;/i&gt;'); expect(html).toContain('&lt;i&gt;d&lt;/i&gt;'); expect(html).toContain('&lt;i&gt;m&lt;/i&gt; ms');
  expect(row(html, 'Desarrollo', 'baseline')).toContain('<td>No medido</td></tr>');
});
test('H3: suite ilegible en el detalle no da 500', async () => {
  seed(); store.db.query("UPDATE experiments SET suite='{no json'").run(); server = startWeb(dir, 0);
  expect((await get('/experimentos')).status).toBe(200);
  const r = await get('/experimentos/e1'); expect(r.status).toBe(200); expect(await r.text()).toContain('Suite ilegible');
});
test('H4a: esquema al que le falta una columna de experiment_runs se declara incompleto', async () => {
  seed(); store.db.exec('ALTER TABLE experiment_runs DROP COLUMN worker_report'); server = startWeb(dir, 0);
  expect(await (await get('/experimentos')).text()).toContain('incompleto');
});
test('H4b: escapa y redacta ids de tarea, ids de experimento e informe', async () => {
  const tok = 'ghp_' + 'a'.repeat(36);
  const st = { tasks: [{ id: '<u>t</u>', repo: '/r', base: 'b', description: 'd', verify: 'true', split: 'development' }] };
  ensureSchema(store.db); insExp('e<x>', st); insExp('e2', st, '<u>x</u>abcdefgh');
  store.db.query(`INSERT INTO experiment_runs (experiment_id,batch,seed,split,task_id,repeat,arm,position,profile_digest,agent,success,diff_lines,duration_ms,cost_usd,created_at) VALUES ('e2','b',1,'development',?,0,'baseline',0,'d','native',1,1,1,NULL,'t')`).run('<s>' + tok);
  server = startWeb(dir, 0);
  const list = await (await get('/experimentos')).text();
  expect(list).not.toContain('<u>'); expect(list).toContain('e&lt;x&gt;'); expect(list).toContain('&lt;u&gt;t&lt;/u&gt;');
  const html = await (await get('/experimentos/e2')).text();
  expect(html).not.toMatch(/<[us]>/); expect(html).not.toContain(tok); expect(html).toContain('&lt;s&gt;');
  expect(html).toContain('baseline &lt;u&gt;x&lt;/u&gt;abcd');
});
test('H4d: la suite se reparte por split y se deduplica por digest', async () => {
  seed(); insExp('e2', suite); server = startWeb(dir, 0);
  const list = await (await get('/experimentos')).text();
  expect(list.match(/<h3>Suite /g)!.length).toBe(1);
  const sec = (name: string) => new RegExp(`<h3>${name}[^]*?(?=<h3>|$)`).exec(list)![0];
  expect(sec('Desarrollo')).toContain('<code>a</code>'); expect(sec('Desarrollo')).not.toContain('<code>b</code>');
  expect(sec('Validación')).toContain('<code>b</code>'); expect(sec('Validación')).not.toContain('<code>a</code>');
});
test('H4e: la navegación enlaza a /experimentos', async () => {
  server = startWeb(dir, 0);
  expect(await (await get('/')).text()).toContain('href="/experimentos"');
});
