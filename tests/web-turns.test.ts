import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { AdmissionDb } from '../src/admission/db.ts';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';

const T_SCHEMA = `CREATE TABLE adm_turns (attempt_id TEXT PRIMARY KEY, activity_id TEXT NOT NULL, change_id TEXT NOT NULL, session_id TEXT NOT NULL,
  generation INTEGER NOT NULL, plan TEXT NOT NULL, question_id TEXT, started_at TEXT NOT NULL, ended_at TEXT, outcome TEXT, exit_code INTEGER,
  duration_ms INTEGER, cost_usd REAL, log TEXT)`; // esquema §2.1; la tabla real es de T54a
const d = (hm: string) => `2026-11-19T${hm}:00.000Z`;
const TOKEN = 'ghp_' + 'a'.repeat(36);
const EVIL = `<script>alert(1)</script> "q" ${TOKEN}`;

let dir: string, store: Store, server: ReturnType<typeof startWeb> | undefined, change: string, act: string;
const get = (path: string) => fetch(`http://127.0.0.1:${server!.port}${path}`);
const page = async () => (await get(`/changes/${change}`)).text();
const start = () => { server = startWeb(dir, 0); };
function turn(id: string, gen: number, plan: string, from: string, to: string | null, outcome: string | null, extra: { cost?: number | null; log?: string | null; dur?: number | null } = {}) {
  store.db.query('INSERT INTO adm_turns(attempt_id, activity_id, change_id, session_id, generation, plan, started_at, ended_at, outcome, duration_ms, cost_usd, log) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, act, change, `s${gen}`, gen, plan, d(from), to ? d(to) : null, outcome, extra.dur === undefined ? (to ? 600000 : null) : extra.dur, extra.cost ?? null, extra.log ?? null);
}
const session = (gen: number, status: string, lost: string | null) => store.db.query(
  "INSERT INTO adm_sessions(change_id, kind, generation, session_id, backend, cwd, status, lost_reason, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run(change, 'implementation', gen, `s${gen}`, 'claude', '/w', status, lost, d('09:00'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-web-turns-'));
  store = new Store(join(dir, 'fabrica.db'));
  const ws = store.createWorkstream({ slug: 'uno', goal: 'g', repo: '/r' }).id;
  change = store.createChange(ws, 'Cambio', 'd').id;
  act = store.listActivities({ changeId: change })[0]?.id ?? (() => { throw new Error('sin activity'); })();
});
afterEach(() => { server?.stop(true); server = undefined; store.close(); rmSync(dir, { recursive: true, force: true }); });

test('sin tablas adm_*: «Sin turnos vivos», 200 y el esquema no se crea (A2)', async () => {
  store.close(); store = new Store(join(dir, 'fabrica.db'));
  const before = readdirSync(dir).sort();
  start();
  const r = await get(`/changes/${change}`);
  expect(r.status).toBe(200);
  expect(await r.text()).toContain('Sin turnos vivos');
  expect(readdirSync(dir).sort()).toEqual(before);
  expect((store.db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'adm_%'").get() as { n: number }).n).toBe(0);
});

test('adm_sessions sin adm_turns: aviso de turnos no medidos y la tabla no se crea (A2)', async () => {
  new AdmissionDb(store); store.db.exec('DROP TABLE IF EXISTS adm_turns');
  session(1, 'open', null);
  start();
  const r = await get(`/changes/${change}`);
  expect(r.status).toBe(200);
  expect(await r.text()).toContain('Los turnos anteriores a esta versión no se midieron');
  expect(store.db.query("SELECT name FROM sqlite_master WHERE name = 'adm_turns'").get()).toBeNull();
});

test('una fila por turno, etiquetas de plan, sesión perdida y «No medido» en coste y duración nulos', async () => {
  new AdmissionDb(store); store.db.exec(T_SCHEMA);
  session(1, 'lost', 'boom'); session(2, 'open', null);
  turn('t1', 1, 'fresh', '10:00', '10:10', 'awaiting', { cost: 0.5 });
  turn('t2', 1, 'answer', '11:00', '11:20', 'done');
  turn('t3', 2, 'reconstructed', '12:00', '12:10', 'error', { dur: null });
  turn('t4', 2, 'retry', '13:00', '13:05', 'no_report');
  turn('t5', 2, 'orphan', '14:00', null, null);
  start();
  const h = await page();
  expect(h.match(/class="turn"/g)?.length).toBe(5);
  for (const l of ['Primer turno', 'Respuesta a una pregunta', 'Sesión reconstruida', 'Reintento con motivo', 'Continuación tras una caída']) expect(h).toContain(l);
  expect(h).toContain('Sesión perdida: boom. Generación 2.');
  expect(h).toContain('No medido');
  expect(h).toContain('0.50 USD');
  expect(h).toContain('Reintento con motivo · Sin report · 10 min · No medido</summary>'); // coste nulo, no 0
  expect(h).not.toContain('Sin turnos vivos');
});

test('A1: texto de pregunta, respuesta, report y motivo se escapa y se redacta', async () => {
  new AdmissionDb(store); store.db.exec(T_SCHEMA);
  session(1, 'lost', EVIL); session(2, 'open', null);
  turn('t1', 1, 'fresh', '10:00', '10:10', 'awaiting'); turn('t2', 2, 'reconstructed', '11:00', '11:10', 'done');
  store.db.query("INSERT INTO adm_questions(id, activity_id, change_id, text, status, asked_at, answered_at, answer, answered_by) VALUES ('q1',?,?,?,?,?,?,?,?)")
    .run(act, change, EVIL, 'answered', d('10:10'), d('10:30'), EVIL, EVIL);
  store.db.query("INSERT INTO adm_reports(attempt_id, activity_id, state, summary, created_at) VALUES ('t1',?,'awaiting',?,?)").run(act, EVIL, d('10:10'));
  start();
  const h = await page();
  expect(h).not.toContain('<script>alert');
  expect(h).not.toContain(TOKEN);
  expect(h.split('&lt;script&gt;').length - 1).toBeGreaterThanOrEqual(4); // motivo, pregunta, respuesta, report
});

test('la CSP no cambia y la sección no añade script ni estilo en línea', async () => {
  new AdmissionDb(store); store.db.exec(T_SCHEMA); session(1, 'open', null); turn('t1', 1, 'fresh', '10:00', '10:10', 'done');
  start();
  const r = await get(`/changes/${change}`);
  expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  const h = await r.text();
  expect(h).not.toMatch(/<script(?![^>]*\bsrc=)/); expect(h).not.toContain('<style'); expect(h).not.toMatch(/\sstyle=|\sonclick=/);
});

test('A4: 500 turnos muestran 200 y «Se omiten 300»', async () => {
  new AdmissionDb(store); store.db.exec(T_SCHEMA); session(1, 'open', null);
  const ins = store.db.query('INSERT INTO adm_turns(attempt_id, activity_id, change_id, session_id, generation, plan, started_at, ended_at, outcome, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 500; i++) { const t = new Date(Date.UTC(2026, 10, 1) + i * 1000).toISOString(); ins.run(`t${i}`, act, change, 's1', 1, 'answer', t, t, 'done', 1); }
  start();
  const h = await page();
  expect(h.match(/class="turn"/g)?.length).toBe(200);
  expect(h).toContain('Se omiten 300');
});

function plantLog(name: string, text: string) {
  mkdirSync(join(dir, 'runs', change), { recursive: true });
  writeFileSync(join(dir, 'runs', change, name), text);
}
const logUrl = (id: string) => `/changes/${change}/turns/${id}/log`;

test('A3: el log del turno se sirve como texto plano, redactado; sin log o turno ajeno: 404', async () => {
  new AdmissionDb(store); store.db.exec(T_SCHEMA); session(1, 'open', null);
  turn('t1', 1, 'fresh', '10:00', '10:10', 'done', { log: `${act}.t-t1.log` });
  plantLog(`${act}.t-t1.log`, `salida <b>x</b> ${TOKEN}`);
  start();
  const r = await get(logUrl('t1'));
  expect(r.status).toBe(200);
  expect(r.headers.get('content-type')).toContain('text/plain');
  const body = await r.text();
  expect(body).toContain('salida <b>x</b>'); expect(body).not.toContain(TOKEN);
  expect(await page()).toContain(`href="${logUrl('t1')}"`);
  expect((await get(logUrl('nope'))).status).toBe(404);
  expect((await get(`/changes/otro/turns/t1/log`)).status).toBe(404);
  const other = store.createChange(store.getChange(change).workstreamId, 'Otro', 'd').id;
  expect((await get(`/changes/${other}/turns/t1/log`)).status).toBe(404); // el turno es de otro change
});

test('A3: symlink en la hoja no filtra el contenido; ids con «/» o «.» dan 400', async () => {
  new AdmissionDb(store); store.db.exec(T_SCHEMA); session(1, 'open', null);
  turn('t1', 1, 'fresh', '10:00', '10:10', 'done', { log: 'x' });
  writeFileSync(join(dir, 'canario.txt'), 'CANARIO-SECRETO');
  mkdirSync(join(dir, 'runs', change), { recursive: true });
  symlinkSync(join(dir, 'canario.txt'), join(dir, 'runs', change, `${act}.t-t1.log`));
  start();
  const r = await get(logUrl('t1'));
  expect(await r.text()).not.toContain('CANARIO-SECRETO');
  expect(r.status).toBe(404);
  expect((await get(logUrl('a%2Fb'))).status).toBe(400);
  expect((await get(logUrl('a.b'))).status).toBe(400);
});

test('con la base en readonly la ruta del log no escribe nada', async () => {
  new AdmissionDb(store); store.db.exec(T_SCHEMA); session(1, 'open', null);
  turn('t1', 1, 'fresh', '10:00', '10:10', 'done', { log: 'x' }); plantLog(`${act}.t-t1.log`, 'ok');
  start();
  const before = readdirSync(dir).sort();
  await get(logUrl('t1')); await page();
  expect(readdirSync(dir).sort()).toEqual(before);
  void Database;
});
