import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdmissionDb } from '../src/admission/db.ts';
import { ThreadLinks } from '../src/admission/links.ts';
import { createBenchmark, runBenchmark } from '../src/bench.ts';
import { parseSuite, suiteDigest } from '../src/improve.ts';
import { DEFAULT_DIGEST } from '../src/profile.ts';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';

let dir: string, store: Store, server: ReturnType<typeof startWeb>, suitePath: string, cookie: string;
const sha = 'a'.repeat(40);
const task = { id: 'original', repo: '/repo', base: sha, description: 'Caso original', verify: 'bun test', split: 'development' };
const base = () => `http://${server.host ?? '127.0.0.1'}:${server.port}`;
const req = (path: string, init?: RequestInit) => fetch(base() + path, { redirect: 'manual', ...init });
const html = async (path: string) => (await req(path, { headers: { cookie } })).text();
const post = (path: string, csrf: string, fields: Record<string, string>, headers: Record<string, string> = {}) => req(path, {
  method: 'POST', headers: { cookie, origin: base(), 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams({ csrf, ...fields }),
});
async function login() {
  const r = await fetch(server.loginUrl!, { redirect: 'manual' });
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
}
async function csrfAt(path: string) {
  return /name="csrf" value="([^"]+)"/.exec(await html(path))![1]!;
}
function benchmark(id: string, agent = 'fake') {
  createBenchmark(store.db, dir, { id, suitePath, variants: ['base', 'candidata'].map(name => ({ name, profile: DEFAULT_DIGEST, agent })) });
}
function change(status = 'completed') {
  const ws = store.createWorkstream({ slug: 'prueba', goal: 'g', repo: '/repo', verify: ['bun test'] });
  const c = store.createChange(ws.id, 'Cambio', 'Descripción para la candidata');
  store.setChangeBase(c.id, sha);
  store.db.query('UPDATE changes SET status=? WHERE id=?').run(status, c.id);
  return c.id;
}

beforeEach(() => {
  dir = mkdtempSync('/tmp/fab-web-bench-');
  suitePath = join(dir, 'suite.json');
  writeFileSync(suitePath, JSON.stringify({ tasks: [task] }));
  store = new Store(join(dir, 'fabrica.db'));
  server = startWeb(dir, 0, { write: true });
  cookie = '';
});
afterEach(() => { server.stop(true); store.close(); rmSync(dir, { recursive: true, force: true }); });

test('lista de solo lectura en esquema anterior y filtros por adaptador, estado y nombre', async () => {
  const schema = () => store.db.query('SELECT name FROM sqlite_schema ORDER BY name').all();
  const before = schema();
  expect(await html('/benchmarks')).toContain('No hay benchmarks');
  expect(schema()).toEqual(before);
  expect((await req('/benchmarks/ausente')).status).toBe(404);
  const states = ['pending', 'running', 'scoring', 'complete', 'failed', 'canceled'];
  const labels = ['Pendiente', 'En curso', 'Puntuando', 'Completo', 'Fallido', 'Cancelado'];
  states.forEach((status, i) => {
    benchmark(`matriz-${status}`, i === 0 ? 'claude' : 'fake');
    store.db.query('UPDATE benchmarks SET status=? WHERE id=?').run(status, `matriz-${status}`);
  });
  const list = await html('/benchmarks');
  for (const label of labels) expect(list).toContain(`>${label}<`);
  const filtered = await html('/benchmarks?agent=claude&status=pending&q=MATRIZ');
  expect(filtered).toContain('href="/benchmarks/matriz-pending"');
  expect(filtered).not.toContain('href="/benchmarks/matriz-running"');
  expect(await html('/benchmarks?agent=claude&status=pending&q=ausente')).not.toContain('href="/benchmarks/matriz-pending"');
  const detail = await html('/benchmarks/matriz-pending');
  expect(detail).toContain('candidata');
  expect(detail).toContain(DEFAULT_DIGEST);
  expect(detail).toContain('Sin corridas todavía');
  expect(detail).not.toContain('/benchmarks/matriz-pending/cancel');
});

test('el informe HTTP coincide con el JSON de fab bench report y conserva el coste desconocido', async () => {
  benchmark('informe');
  store.db.exec(`INSERT INTO experiment_runs (experiment_id,batch,seed,split,task_id,repeat,arm,position,profile_digest,agent,success,diff_lines,duration_ms,cost_usd,created_at)
    VALUES ('informe','b',1,'development','original',1,'base',0,'${DEFAULT_DIGEST}','fake',1,6,800,0.125,'x'),
           ('informe','b',1,'development','original',2,'base',0,'${DEFAULT_DIGEST}','fake',0,2,200,NULL,'x'),
           ('informe','b',1,'development','original',1,'candidata',1,'${DEFAULT_DIGEST}','fake',1,7,750,NULL,'x');
    INSERT INTO benchmark_scores (benchmark_id,run_rowid,scorer,score,passed)
    SELECT 'informe',rowid,'<juez>',CASE WHEN repeat=1 THEN 0.7 END,CASE WHEN repeat=1 THEN 1 END FROM experiment_runs WHERE arm='base';`);
  store.db.query("UPDATE benchmarks SET status='failed',error=? WHERE id='informe'").run('<script>mensaje</script>');
  const cli = Bun.spawnSync(['bun', 'src/cli.ts', 'bench', 'report', 'informe', '--json'], { env: { ...process.env, FABRICA_HOME: dir } });
  expect(cli.exitCode).toBe(0);
  const [v, unknown] = JSON.parse(cli.stdout.toString()).variants;
  const detail = await html('/benchmarks/informe');
  expect(detail).toContain(`<td>${v.n}</td><td>${v.success_rate.toFixed(3)}</td><td>${v.mean_diff_lines.toFixed(1)}</td><td>${(v.mean_duration_ms / 1000).toFixed(1)}</td><td>${v.mean_cost_usd.toFixed(4)} USD (${v.cost_known}/${v.n})</td>`);
  expect(unknown.mean_cost_usd).toBeNull();
  expect(detail).toContain('<td>No medido</td>');
  expect(detail).toContain('&lt;juez&gt;');
  expect(detail).toContain('<td>100% (1/1)</td><td>0.70</td><td>1</td>');
  expect(detail).toContain('&lt;script&gt;mensaje&lt;/script&gt;');
  expect(detail).not.toContain('<script>mensaje</script>');
});

test('cancelar por HTTP exige sesión, origen, CSRF y confirmación e impide que el motor arranque filas', async () => {
  benchmark('stop');
  const path = '/benchmarks/stop/cancel';
  expect((await post(path, '', { confirm: 'yes' })).status).toBe(401);
  await login();
  const csrf = await csrfAt('/benchmarks/stop');
  expect((await post(path, 'mal', { confirm: 'yes' })).status).toBe(403);
  expect((await post(path, csrf, { confirm: 'yes' }, { origin: 'http://127.0.0.1' })).status).toBe(403);
  expect((await post(path, csrf, {})).status).toBe(400);
  expect(await html('/benchmarks/stop')).toContain('Pendiente');
  expect((await post(path, csrf, { confirm: 'yes' })).headers.get('location')).toBe('/benchmarks/stop');
  expect(await html('/benchmarks/stop')).toContain('Cancelado');
  await expect(runBenchmark(store.db, dir, 'stop', { split: 'development', repeats: 2 })).rejects.toMatchObject({ code: 'invalid_transition' });
  expect(store.db.query('SELECT count(*) AS n FROM experiment_runs').get()).toEqual({ n: 0 });
});

test('las claves de API no pueden cancelar ni escribir ficheros de candidatas', async () => {
  benchmark('stop');
  const id = change();
  const { key } = store.createApiKey('prueba', 'decide');
  for (const path of ['/benchmarks/stop/cancel', `/changes/${id}/suite-task`]) {
    const r = await req(`/api/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`,
      'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'yes', task: 'api', split: 'development' }) });
    expect(r.status).toBe(404);
  }
  expect(store.db.query("SELECT status FROM benchmarks WHERE id='stop'").get()).toEqual({ status: 'pending' });
  expect(readdirSync(dir).some(f => f.startsWith('suite-candidata-'))).toBe(false);
});

test('Añadir a suite crea un fichero nuevo válido sin cambiar la suite del benchmark', async () => {
  benchmark('matriz');
  const id = change(), url = `/changes/${id}`, path = `${url}/suite-task`;
  const original = readFileSync(suitePath, 'utf8');
  const digest = suiteDigest(parseSuite(JSON.parse(original)));
  expect(await html(url)).not.toContain('Añadir a suite');
  await login();
  expect(await html(url)).toContain('Añadir a suite');
  const csrf = await csrfAt(url);
  const fields = { task: 'candidata', split: 'validation', out: suitePath };
  const saved = await post(path, csrf, fields);
  expect(saved.status).toBe(303);
  const output = readdirSync(dir).find(f => f.startsWith('suite-candidata-'))!;
  expect(await html(saved.headers.get('location')!)).toContain(output);
  const candidate = parseSuite(JSON.parse(readFileSync(join(dir, output), 'utf8')));
  expect(candidate.tasks).toEqual([{ ...task, id: 'candidata', description: 'Descripción para la candidata', split: 'validation' }]);
  expect(readFileSync(suitePath, 'utf8')).toBe(original);
  expect(store.db.query("SELECT suite_digest FROM benchmarks WHERE id='matriz'").get()).toEqual({ suite_digest: digest });
  const adm = new AdmissionDb(store);
  adm.db.query('INSERT INTO adm_threads(id, source, first_seen) VALUES (?,?,?)').run('github:o/r#1', 'github:o/r', 'x');
  new ThreadLinks(adm).link('github:o/r#1', id);
  await post(path, csrf, { ...fields, task: 'canal' });
  expect(await html(url)).toContain('invalid_input');
  expect(readdirSync(dir).filter(f => f.startsWith('suite-candidata-'))).toEqual([output]);
});

test('un change en curso y un servidor sin escritura no ofrecen ni aceptan generar una candidata', async () => {
  const id = change('implemented'), url = `/changes/${id}`, path = `${url}/suite-task`;
  await login();
  expect(await html(url)).not.toContain('Añadir a suite');
  await post(path, await csrfAt(url), { task: 'incompleta', split: 'development' });
  expect(await html(url)).toContain('invalid_transition');
  expect(readdirSync(dir).some(f => f.startsWith('suite-candidata-'))).toBe(false);
  server.stop(true);
  server = startWeb(dir, 0);
  expect((await post(path, '', {})).status).toBe(405);
  expect(await html('/benchmarks')).toContain('No hay benchmarks');
});
