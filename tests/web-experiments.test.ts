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
