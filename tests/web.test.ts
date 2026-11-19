import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';
import { readEvidence, activityMetadata, activityCosts, changeCost, EVIDENCE_LIMIT } from '../src/evidence.ts';

let dir: string;
let store: Store;
let server: ReturnType<typeof startWeb>;
let change: string;
let activity: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-web-'));
  store = new Store(join(dir, 'fabrica.db'));
  const ws = store.createWorkstream({ slug: 'prueba', goal: 'Objetivo', repo: '/repo' });
  const c = store.createChange(ws.id, '<script>alert(1)</script>', 'Descripción');
  change = c.id; activity = store.listActivities({ changeId: c.id })[0]!.id;
  const run = join(dir, 'runs', change); mkdirSync(run, { recursive: true });
  writeFileSync(join(run, `${activity}.log`), '<script>log</script> Bearer abcdef-secret');
  writeFileSync(join(run, `${activity}.json`), JSON.stringify({ attemptCosts: [0.25], durationMs: 1200, isolation: 'test' }));
  writeFileSync(join(run, 'run.json'), JSON.stringify({ activities: [], secret: 'password=old-secret' }));
  writeFileSync(join(run, 'diff.patch'), '+ cambio');
  server = startWeb(dir, 0);
});
afterEach(() => { server?.stop(true); store?.close(); rmSync(dir, { recursive: true, force: true }); });
const req = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${server.port}${path}`, init);

test('rutas, filtros y evidencia escapada y redactada', async () => {
  for (const path of ['/', '/workstreams', '/changes', '/changes?ws=prueba', `/changes/${change}`, `/activities/${activity}`, '/style.css', '/poll.js']) {
    const r = await req(path); expect(r.status).toBe(200);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
  }
  const html = await (await req('/changes')).text();
  expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>alert');
  expect(await (await req('/changes?q=ausente')).text()).not.toContain('&lt;script&gt;');
  expect(await (await req('/changes?status=completed')).text()).not.toContain('&lt;script&gt;');
  const detail = await (await req(`/activities/${activity}`)).text();
  expect(detail).toContain('&lt;script&gt;log'); expect(detail).not.toContain('abcdef-secret');
  expect(detail).not.toContain('old-secret'); expect(detail).toContain('0.25'); expect(detail).toContain('1200');
  expect(detail).toContain('+ cambio');
  expect(await (await req(`/changes/${change}`)).text()).toContain('0.25');
  expect((await req('/no-existe')).status).toBe(404);
  expect((await req('/changes/ausente')).status).toBe(404);
  expect((await req('/activities/ausente')).status).toBe(404);
});

test('Host, métodos, HEAD y traversal', async () => {
  expect((await req('/', { headers: { Host: 'evil.example' } })).status).toBe(403);
  expect((await req('/', { headers: { Host: `localhost:${server.port}` } })).status).toBe(200);
  expect((await req('/', { headers: { Host: 'localhost:123' } })).status).toBe(403);
  for (const path of ['/', '/workstreams', '/changes', `/changes/${change}`, `/activities/${activity}`, '/style.css', '/poll.js', '/ausente']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) expect((await req(path, { method })).status).toBe(405);
    const head = await req(path, { method: 'HEAD' }); expect(await head.text()).toBe('');
  }
  expect((await req('/activities/%2e%2e%2fsecret')).status).toBe(400);
  expect(() => readEvidence(dir, '../escape')).toThrow();
  const outside = join(dir, 'outside.log'); writeFileSync(outside, 'NO FILTRAR');
  symlinkSync(outside, join(dir, 'runs', change, 'link.log'));
  expect(() => readEvidence(dir, `runs/${change}/link.log`)).toThrow();
  symlinkSync('/tmp', join(dir, 'runs', 'escape'));
  expect(() => readEvidence(dir, 'runs/escape/file')).toThrow();
});

test('límite de lectura y PEM incompleto no filtra secretos', () => {
  writeFileSync(join(dir, 'large.log'), '-----BEGIN PRIVATE KEY-----\n' + 'x'.repeat(EVIDENCE_LIMIT * 2));
  const r = readEvidence(dir, 'large.log')!;
  expect(r.truncated).toBe(true); expect(r.text).not.toContain('xxxxxxxx');
});

test('readonly no crea estado ni migra y todas las rutas conservan disco', async () => {
  for (const path of [join(dir, 'inexistente'), join(dir, 'vacio')]) {
    if (path.endsWith('vacio')) mkdirSync(path);
    expect(() => startWeb(path, 0)).toThrow();
    expect(existsSync(path) ? readdirSync(path) : []).toEqual([]);
    const run = Bun.spawnSync(['bun', 'src/cli.ts', 'web', '--port', '0'], { env: { ...process.env, FABRICA_HOME: path } });
    expect(run.exitCode).not.toBe(0);
    expect(existsSync(path) ? readdirSync(path) : []).toEqual([]);
  }
  const ro = new Store(join(dir, 'fabrica.db'), { readonly: true });
  expect(() => ro.db.query('INSERT INTO events(workstream_id,severity,message,created_at) VALUES (?,?,?,?)')
    .run(store.getWorkstream('prueba').id, 'info', 'no', '2026-01-01')).toThrow(/readonly/); ro.close();
  const old = join(dir, 'old.db'); const db = new Database(old); db.exec('CREATE TABLE legacy (id TEXT)'); db.close();
  const before = readFileSync(old); const legacy = new Store(old, { readonly: true }); legacy.close();
  expect(readFileSync(old)).toEqual(before);
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const dataVersion = store.db.query('PRAGMA data_version').get();
  const files = readdirSync(dir).sort();
  for (const path of ['/', '/workstreams', '/changes', `/changes/${change}`, `/activities/${activity}`]) await (await req(path)).text();
  expect(store.db.query('PRAGMA data_version').get()).toEqual(dataVersion);
  expect(readdirSync(dir).sort()).toEqual(files);
});

test('árbol, timeline, veredicto, evidencia antigua y ficheros ausentes', async () => {
  const parent = store.getActivity(activity);
  store.db.query("UPDATE activities SET status='completed', review_status='approved', validator='code_review', review_comment=? WHERE id=?").run('<script>veredicto</script>', activity);
  store.db.query('UPDATE activities SET parent_activity_id=? WHERE id=?').run(activity, activity); // ciclo histórico
  store.event(parent.workstreamId, 'info', '<script>evento</script>', change, activity);
  const html = await (await req(`/changes/${change}`)).text();
  expect(html).toContain('Timeline'); expect(html).toContain('&lt;script&gt;evento');
  expect(html.match(new RegExp(`/activities/${activity}`, 'g'))?.length).toBe(1);
  const log = await (await req(`/activities/${activity}`)).text();
  expect(log).toContain('code_review'); expect(log).toContain('&lt;script&gt;veredicto');
  const path = join(dir, 'runs', change, `${activity}.json`);
  writeFileSync(path, JSON.stringify({ usage: { costUsd: 0.5 } }));
  expect(await (await req(`/changes/${change}`)).text()).toContain('0.50 USD');
  writeFileSync(path, '{broken');
  rmSync(join(dir, 'runs', change, `${activity}.log`));
  expect(await (await req(`/activities/${activity}`)).text()).toContain('No hay evidencia guardada');
  expect(await (await req(`/changes/${change}`)).text()).toContain('No medido');
});

test('redacta secretos JSON antiguos en logs y evidencia', async () => {
  writeFileSync(join(dir, 'runs', change, `${activity}.log`), '{"api_key":"clave-antigua-123"}');
  const html = await (await req(`/activities/${activity}`)).text();
  expect(html).not.toContain('clave-antigua-123');
});

test('peticiones nuevas ven escrituras posteriores aunque la base empezara cerrada', async () => {
  server.stop(true); store.close();
  const files = readdirSync(dir).sort();
  server = startWeb(dir, 0);
  expect(readdirSync(dir).sort()).toEqual(files);
  expect(await (await req('/changes?q=posterior')).text()).toContain('0 changes');
  store = new Store(join(dir, 'fabrica.db'));
  store.createChange('prueba', 'Change posterior', '');
  expect(await (await req('/changes?q=posterior')).text()).toContain('Change posterior');
});

test('una evidencia sustituida por symlink no se sirve por HTTP', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'fab-web-outside-'));
  try {
    const target = join(outside, 'secret.log'); writeFileSync(target, 'NO-DEBE-SALIR');
    const log = join(dir, 'runs', change, `${activity}.log`); rmSync(log); symlinkSync(target, log);
    const html = await (await req(`/activities/${activity}`)).text();
    expect(html).toContain('ruta insegura'); expect(html).not.toContain('NO-DEBE-SALIR');
  } finally { rmSync(outside, { recursive: true, force: true }); }
});

test('H3: escucha real solo en loopback', () => {
  // /proc informa del socket real, sin añadir una opción pública solo para probarlo.
  if (process.platform === 'linux') {
    const port = server.port.toString(16).toUpperCase().padStart(4, '0');
    const listening = readFileSync('/proc/net/tcp', 'utf8').split('\n')
      .map(line => line.trim().split(/\s+/)).filter(row => row[1]?.endsWith(`:${port}`) && row[3] === '0A');
    expect(listening.map(row => row[1])).toEqual([`0100007F:${port}`]);
  }
});

test('H3: INSERT válido rechazado también por el snapshot deserializado', () => {
  const sql = 'INSERT INTO events(workstream_id,severity,message,created_at) VALUES (?,?,?,?)';
  const args = [store.getWorkstream('prueba').id, 'info', 'control válido', '2026-01-01'];
  expect(store.db.query(sql).run(...args).changes).toBe(1);
  server.stop(true); store.close();
  const ro = new Store(join(dir, 'fabrica.db'), { readonly: true });
  try { expect(() => ro.db.query(sql).run(...args)).toThrow(/readonly/); } finally { ro.close(); }
  // Restaura los recursos que cierra afterEach.
  store = new Store(join(dir, 'fabrica.db')); server = startWeb(dir, 0);
});

test('H3: CSP completa exacta en todas las rutas', async () => {
  const expected = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  for (const path of ['/', '/workstreams', '/changes', `/changes/${change}`, `/activities/${activity}`, '/style.css', '/poll.js', '/ausente']) {
    expect((await req(path)).headers.get('content-security-policy')).toBe(expected);
  }
});

test('H3: las comillas del filtro no pueden salir del atributo value', async () => {
  const q = '" autofocus onfocus="alert(1)\' <';
  const html = await (await req(`/changes?q=${encodeURIComponent(q)}`)).text();
  expect(html).toContain('value="&quot; autofocus onfocus=&quot;alert(1)&#39; &lt;"');
  expect(html).not.toContain('value="" autofocus');
});

test('H3: la hija aparece dentro del ul de su padre', async () => {
  const parent = activity;
  store.resolveReview(parent, 'approve');
  const child = store.listActivities({ changeId: change }).find(a => a.parentActivityId === parent)!;
  expect(child).toBeDefined();
  const html = await (await req(`/changes/${change}`)).text();
  const tree = html.slice(html.indexOf('<ul class="tree">'), html.indexOf('<h2>Timeline'));
  expect(tree).toMatch(new RegExp(`/activities/${parent}[\\s\\S]*?<ul><li>[\\s\\S]*?/activities/${child.id}[\\s\\S]*?</ul></li></ul>`));
});

test('H3: cada capa de redacción protege su entrada directamente', async () => {
  const log = join(dir, 'runs', change, `${activity}.log`);
  writeFileSync(log, 'Bearer secreto-textual-123');
  expect(readEvidence(dir, `runs/${change}/${activity}.log`)!.text).not.toContain('secreto-textual-123');
  const meta = join(dir, 'runs', change, `${activity}.json`);
  writeFileSync(meta, JSON.stringify({ api_key: 'valor-sin-patron', note: 'Bearer secreto-json-456' }));
  const json = readEvidence(dir, `runs/${change}/${activity}.json`)!.text;
  expect(json).not.toContain('valor-sin-patron'); expect(json).not.toContain('secreto-json-456');
  store.db.query('UPDATE changes SET title=? WHERE id=?').run('Bearer secreto-en-base-789', change);
  expect(await (await req('/changes')).text()).not.toContain('secreto-en-base-789');
});

test('H3: FIFO es evidencia no regular y no se intenta leer', () => {
  const path = join(dir, 'pipe.log');
  expect(Bun.spawnSync(['mkfifo', path]).exitCode).toBe(0);
  expect(() => readEvidence(dir, 'pipe.log')).toThrow('no es un fichero regular');
});

test('H3: bandeja por workstream y contadores según revisión, no solo status', async () => {
  store.db.query("UPDATE activities SET status='blocked' WHERE id=?").run(activity);
  const ws = store.createWorkstream({ slug: 'otra', goal: 'g', repo: '/repo' });
  store.createChange(ws.id, 'Título del otro workstream', '');
  const html = await (await req('/?ws=prueba')).text();
  const counts = html.slice(html.indexOf('<div class="counts">'), html.indexOf('<ul class="inbox">'));
  expect(counts).toContain('Espera revisión'); expect(counts).toContain('<strong>1</strong>');
  expect(counts).not.toContain('Bloqueado'); expect(html).not.toContain('Título del otro workstream');
});

test('H3: timeline excluye eventos de otro change del mismo workstream', async () => {
  const other = store.createChange('prueba', 'Otro change', '');
  store.event(other.workstreamId, 'info', 'EVENTO-AJENO-NO-SERVIR', other.id);
  store.event(other.workstreamId, 'info', 'EVENTO-PROPIO-SI-SERVIR', change);
  const html = await (await req(`/changes/${change}`)).text();
  expect(html).not.toContain('EVENTO-AJENO-NO-SERVIR'); expect(html).toContain('EVENTO-PROPIO-SI-SERVIR');
});

test('H5: PEM sin cierre dentro de JSON no se muestra', () => {
  const run = join(dir, 'runs', change);
  writeFileSync(join(run, 'run.json'), JSON.stringify({ note: '-----BEGIN PRIVATE KEY-----\nmaterial-privado-sin-cierre' }));
  expect(readEvidence(dir, `runs/${change}/run.json`)!.text).not.toContain('material-privado-sin-cierre');
});

test('H5: un token cortado no se muestra parcialmente', () => {
  const secret = 'ghp_' + 's'.repeat(36);
  const prefix = ' '.repeat(256 * 1024 - 10);
  writeFileSync(join(dir, 'corte.log'), prefix + secret);
  const value = readEvidence(dir, 'corte.log')!;
  expect(value.truncated).toBe(true); expect(value.text).not.toContain('ghp_');
});

test('H3/E18: metadata truncada aunque el prefijo sea JSON válido no se interpreta', () => {
  const a = store.getActivity(activity);
  writeFileSync(join(dir, 'runs', change, `${activity}.json`), JSON.stringify({ attemptCosts: [0.1] }) + ' '.repeat(256 * 1024));
  expect(activityMetadata(dir, a)).toBeNull();
});

test('H7: timeline acotada con número exacto omitido y últimos eventos en orden', async () => {
  const ws = store.getWorkstream('prueba');
  store.db.query('DELETE FROM events WHERE change_id=?').run(change);
  store.db.transaction(() => {
    const insert = store.db.query('INSERT INTO events(workstream_id,change_id,severity,message,created_at) VALUES (?,?,?,?,?)');
    for (let i = 0; i < 215; i++) insert.run(ws.id, change, 'info', `marca-evento-${String(i).padStart(3,'0')}`, '2026-01-01');
    const other = store.createChange(ws.id, 'Otro', '');
    insert.run(ws.id, other.id, 'info', 'evento ajeno final', '2026-01-01');
  })();
  const html = await (await req(`/changes/${change}`)).text();
  expect(html).toContain('Se omiten 15 eventos anteriores.');
  expect(html.match(/marca-evento-/g)?.length).toBe(200);
  expect(html).not.toContain('marca-evento-014'); expect(html).toContain('marca-evento-015');
  expect(html.indexOf('marca-evento-015')).toBeLessThan(html.indexOf('marca-evento-214'));
  expect(html).not.toContain('evento ajeno final');
});

test('N2: un log largo sin espacios conserva texto tras el recorte acotado', () => {
  writeFileSync(join(dir, 'larga.log'), 'x'.repeat(512 * 1024));
  const value = readEvidence(dir, 'larga.log')!;
  expect(value.truncated).toBe(true);
  expect(value.text.length).toBe(256 * 1024 - 4096);
  expect(value.text).not.toBe('');
});

for (const ending of ['\n', '\r\n']) test(`N1: corte en ${JSON.stringify(ending)} conserva la línea sin depender del reloj`, () => {
  const prefix = 'x'.repeat(256 * 1024 - ending.length) + ending;
  writeFileSync(join(dir, 'salto.log'), prefix + 'continuación');
  const value = readEvidence(dir, 'salto.log')!;
  expect(value.truncated).toBe(true);
  expect(value.text).toBe(prefix);
  expect(value.text).not.toBe('');
});

function costsFor(meta: Record<string, unknown>) {
  writeFileSync(join(dir, 'runs', change, `${activity}.json`), JSON.stringify(meta));
  return { attempts: activityCosts(store.getActivity(activity), meta), total: changeCost(store, dir, change) };
}

test('N3: un intento que falta no se interpreta como coste cero', () => {
  store.db.query("UPDATE activities SET retry_count=1,status='in_progress' WHERE id=?").run(activity);
  expect(costsFor({ attemptCosts: [0] })).toEqual({ attempts: null, total: null });
  expect(costsFor({ attemptCosts: [0, 0] })).toEqual({ attempts: [0, 0], total: 0 });
});

test('N3: coste null permanece desconocido y se distingue de cero conocido', () => {
  expect(costsFor({ attemptCosts: [null] })).toEqual({ attempts: [null], total: null });
  expect(costsFor({ attemptCosts: [0] })).toEqual({ attempts: [0], total: 0 });
});

test('N3: una activity fallida no exige un intento adicional que no se ejecutó', () => {
  store.db.query("UPDATE activities SET retry_count=3,status='failed' WHERE id=?").run(activity);
  expect(costsFor({ attemptCosts: [0, 0, 0] })).toEqual({ attempts: [0, 0, 0], total: 0 });
  expect(costsFor({ attemptCosts: [0, 0] })).toEqual({ attempts: null, total: null });
  expect(costsFor({ attemptCosts: [0, null, 0] })).toEqual({ attempts: [0, null, 0], total: null });
});
