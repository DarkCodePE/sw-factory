import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultProfile, saveProfile, type ScorerDef } from '../src/profile.ts';
import { ensureSchema } from '../src/scorers.ts';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';

let dir: string, store: Store, server: ReturnType<typeof startWeb> | undefined, cookie = '', csrf = '';
const def = (extra: Partial<ScorerDef> = {}): ScorerDef => ({ scope: 'implement', rubric: 'Evalúa <b>bien</b>.', classes: [{ label: 'ok', score: 1 }, { label: 'mal', score: 0 }], passing: 0.5, sampling: 1, ...extra });
const url = (p: string) => `http://${server!.host ?? "127.0.0.1"}:${server!.port}${p}`;
const html = async (p: string) => (await fetch(url(p), { headers: { cookie } })).text();
const post = (p: string, data: Record<string, string>, headers: Record<string, string> = {}) => fetch(url(p), { method: 'POST', redirect: 'manual', headers: { cookie, origin: `http://${server!.host ?? "127.0.0.1"}:${server!.port}`, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ csrf, ...data }) });
const hasTable = () => store.db.query("SELECT 1 FROM sqlite_master WHERE name='scores'").get() !== null;
const rows = () => (hasTable() ? store.db.query('SELECT * FROM scores ORDER BY created_at, id').all() : []) as any[];

function seed(n = 3) {
  const digest = saveProfile(dir, { ...defaultProfile(), schemaVersion: 2, harness: 'fake', scorers: { calidad: def() } } as any).digest;
  store.createWorkstream({ slug: 'ws', goal: 'g', repo: dir, agent: 'fake', requireChangeApproval: false, profile: digest });
  const impls: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = store.createChange('ws', i === 0 ? '<img src=x> cambio' : `Cambio ${i}`, 'd');
    const inv = store.listActivities({ changeId: c.id })[0]!;
    const impl = (store as any).insertActivity(c.workstreamId, c.id, inv.id, 'implementation', 'pending', null);
    const id = (impl.id ?? impl) as string; impls.push(id);
    store.db.query(`UPDATE activities SET status='completed', result='r', profile_digest=?, completed_at=?, started_at=? WHERE id IN (?,?)`).run(digest, store.now(), store.now(), inv.id, id);
  }
  return { digest, impls };
}
function insertScore(digest: string, activity: string, o: { status?: string; passed?: number | null; cost?: number | null; label?: string | null; at?: string; round?: number } = {}) {
  ensureSchema(store.db);
  const a = store.getActivity(activity);
  store.db.query(`INSERT INTO scores (id, scorer, profile_digest, scope, subject_activity_id, change_id, workstream_id, round, origin, status, label, score, passed, cost_usd, created_at, finished_at)
    VALUES (?,?,?,?,?,?,?,?,'sample',?,?,?,?,?,?,?)`).run(crypto.randomUUID(), 'calidad', digest, 'implement', activity, a.changeId, a.workstreamId, o.round ?? 0, o.status ?? 'done',
    o.label === undefined ? 'ok' : o.label, o.label === null ? null : o.label === 'ok' ? 1 : 0, o.passed === undefined ? 1 : o.passed, o.cost === undefined ? 0.1 : o.cost, o.at ?? store.now(), o.at ?? store.now());
}
async function login() {
  const r = await fetch(server!.loginUrl!, { redirect: 'manual' });
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  csrf = /name="csrf" value="([^"]+)"/.exec(await html('/metricas?tab=jueces&ws=ws&preview=1&skip=0'))?.[1] ?? '';
  expect(csrf.length).toBe(64);
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fab-web-scorers-')); mkdirSync(join(dir, 'x')); store = new Store(join(dir, 'fabrica.db')); cookie = ''; csrf = ''; });
afterEach(() => { server?.stop(true); server = undefined; store.close(); rmSync(dir, { recursive: true, force: true }); });

test('la tasa de aprobado y el coste coinciden con datos sintéticos; fallidas no cuentan; NULL es «Sin puntuar»', async () => {
  const { digest, impls } = seed(5);
  insertScore(digest, impls[0]!, { passed: 1, cost: 0.25 }); insertScore(digest, impls[1]!, { passed: 1, cost: 0.25 });
  insertScore(digest, impls[2]!, { passed: 1, cost: null }); insertScore(digest, impls[3]!, { passed: 0, cost: 0.5, label: 'mal' });
  insertScore(digest, impls[4]!, { status: 'failed', label: null, passed: null, cost: null });
  server = startWeb(dir, 0);
  const h = await html('/metricas?tab=jueces&range=all');
  expect(h).toContain('75 % (3/4)'); // 3 aprobadas de 4 hechas
  expect(h).toContain('<td>implement</td><td>75 % (3/4)</td><td>4</td><td>1</td><td>0</td>'); // aprobadas, hechas, fallidas, en cola
  expect(h).toContain('1.0000 USD'); expect(h).toContain('1 sin coste medido');
  expect(h).toContain('Sin puntuar'); expect(h).not.toContain('(0)</td><td>No medido');
  expect(h).toContain('&lt;img src=x&gt; cambio'); expect(h).not.toContain('<img src=x>');
  const d = await html('/metricas?tab=jueces&range=all&scorer=calidad');
  expect(d).toContain('Evalúa &lt;b&gt;bien&lt;/b&gt;.'); expect(d).toContain('Tasa de aprobado por día');
});
test('un juez sin ningún coste medido muestra «No medido», no 0', async () => {
  const { digest, impls } = seed(1); insertScore(digest, impls[0]!, { cost: null });
  server = startWeb(dir, 0);
  const h = await html('/metricas?tab=jueces&range=all');
  expect(h).toContain('<td>1</td><td>0</td><td>0</td><td>No medido</td>'); expect(h).not.toContain('0.0000 USD');
});
test('sin puntuaciones: aviso, «No medido», y la web no crea la tabla', async () => {
  seed(1); server = startWeb(dir, 0);
  expect(await html('/metricas?tab=jueces')).toContain('No hay puntuaciones en este rango.');
  expect(hasTable()).toBe(false);
  expect(await html('/metricas')).toContain('Jueces'); // la pestaña existe también desde el resumen
});
test('el rango excluye puntuaciones antiguas', async () => {
  const { digest, impls } = seed(1); insertScore(digest, impls[0]!, { at: '2020-01-01T00:00:00.000Z' });
  server = startWeb(dir, 0);
  expect(await html('/metricas?tab=jueces&range=7')).toContain('No hay puntuaciones en este rango.');
  expect(await html('/metricas?tab=jueces&range=all')).toContain('100 % (1/1)');
  expect((await fetch(url('/metricas?tab=jueces&range=9'))).status).toBe(400);
});
test('rango pasado: la vista previa cuenta lo que se encola y repetir saltando no duplica', async () => {
  const { digest, impls } = seed(3); insertScore(digest, impls[0]!);
  server = startWeb(dir, 0, { write: true }); await login();
  const prev = await html('/metricas?tab=jueces&ws=ws&range=all&preview=1&skip=1');
  expect(prev).toContain('Ejecuciones a puntuar: <strong>2</strong>'); expect(prev).toContain('Coste estimado: <strong>0.2000 USD</strong>');
  const before = rows().length;
  const form = { ws: 'ws', since: '', scorer: '', skip: 'yes', expected: '2' };
  const r = await post('/scorers/backfill', form); expect(r.status).toBe(303);
  expect(rows().length - before).toBe(2); expect(rows().filter(x => x.origin === 'backfill').every(x => x.status === 'pending')).toBe(true);
  expect(await html('/metricas?tab=jueces&ws=ws&range=all&preview=1&skip=1')).toContain('No hay ejecuciones pendientes');
  await post('/scorers/backfill', { ...form, expected: '0' });
  expect(rows().length - before).toBe(2); // sin duplicados
  expect(new Set(rows().map(x => `${x.subject_activity_id}:${x.round}`)).size).toBe(rows().length);
});
test('vista previa desfasada: no se encola nada; coste sin historial es «No medido»', async () => {
  seed(2); server = startWeb(dir, 0, { write: true }); await login();
  expect(await html('/metricas?tab=jueces&ws=ws&range=all&preview=1')).toContain('Coste estimado: <strong>No medido</strong>');
  const r = await post('/scorers/backfill', { ws: 'ws', since: '', scorer: '', skip: 'yes', expected: '1' });
  expect(r.status).toBe(303); expect(rows()).toHaveLength(0);
  expect(await html('/metricas?tab=jueces')).toContain('conflict');
});
test('sin saltar: repite las ya puntuadas con ronda nueva, nunca encima de una pendiente', async () => {
  const { digest, impls } = seed(2); insertScore(digest, impls[0]!); insertScore(digest, impls[1]!, { status: 'pending', label: null, passed: null, cost: null });
  server = startWeb(dir, 0, { write: true }); await login();
  expect(await html('/metricas?tab=jueces&ws=ws&range=all&preview=1&skip=0')).toContain('Ejecuciones a puntuar: <strong>1</strong>');
  await post('/scorers/backfill', { ws: 'ws', since: '', scorer: '', skip: '', expected: '1' });
  expect(rows().filter(x => x.subject_activity_id === impls[0] && x.round === 1)).toHaveLength(1);
});
test('puntuar a mano: encola, no duplica en cola y no cambia estados (D-G)', async () => {
  const { impls } = seed(1); server = startWeb(dir, 0, { write: true }); await login();
  const snap = () => JSON.stringify([store.db.query('SELECT * FROM changes').all(), store.db.query('SELECT * FROM activities').all()]);
  const before = snap();
  expect(await html(`/activities/${impls[0]}`)).toContain('Puntuar esta ejecución');
  expect((await post(`/activities/${impls[0]}/score`, { scorer: 'calidad' })).status).toBe(303);
  expect(rows()).toHaveLength(1); expect(rows()[0].origin).toBe('manual'); expect(rows()[0].status).toBe('pending');
  await post(`/activities/${impls[0]}/score`, { scorer: 'calidad' }); expect(rows()).toHaveLength(1);
  expect(snap()).toBe(before);
  expect((await post(`/activities/${impls[0]}/score`, { scorer: 'no-existe' })).status).toBe(303); expect(rows()).toHaveLength(1);
  expect((await post(`/activities/${impls[0]}/score`, { scorer: '../x' })).status).toBe(400);
});
test('las escrituras exigen sesión, origin y CSRF; sin --write no hay botones', async () => {
  const { impls } = seed(1); server = startWeb(dir, 0, { write: true }); await login();
  const f = { ws: 'ws', since: '', scorer: '', skip: 'yes', expected: '1' };
  expect((await fetch(url('/scorers/backfill'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `http://127.0.0.1:${server.port}` }, body: new URLSearchParams(f) })).status).toBe(401);
  expect((await post('/scorers/backfill', f, { origin: 'http://evil.test' })).status).toBe(403);
  expect((await post('/scorers/backfill', { ...f, csrf: 'x'.repeat(64) })).status).toBe(403);
  expect((await post('/scorers/backfill', { ...f, expected: 'abc' })).status).toBe(400);
  expect(rows()).toHaveLength(0); server.stop(true);
  server = startWeb(dir, 0); cookie = '';
  const h = await html('/metricas?tab=jueces&ws=ws&range=all&preview=1');
  expect(h).toContain('Ejecuciones a puntuar'); expect(h).not.toContain('Encolar'); expect(h).toContain('fab web --write');
  expect(await html(`/activities/${impls[0]}`)).not.toContain('Encolar puntuación');
  expect((await fetch(url('/scorers/backfill'), { method: 'POST' })).status).toBe(405);
});

// ---- ronda web: T65 H1-H3 ----
test('T65-H1: score, round y coste raros no rompen ni inyectan HTML en /metricas ni en la activity', async () => {
  const { digest, impls } = seed(1); insertScore(digest, impls[0]!);
  store.db.query("UPDATE scores SET score = '<img src=x onerror=1>', round = '<b>r</b>', cost_usd = 'abc'").run();
  server = startWeb(dir, 0);
  for (const p of ['/metricas?tab=jueces&range=all', `/activities/${impls[0]}`]) {
    const r = await fetch(url(p));
    expect(r.status).toBe(200);
    const h = await r.text();
    expect(h).not.toContain('<img src=x'); expect(h).not.toContain('<b>r</b>');
    expect(h).toContain('&lt;img src=x onerror=1&gt;'); expect(h).toContain('No medido');
  }
});
test('T65-H2: encolar por la web deja un evento con el actor', async () => {
  const { impls } = seed(2); server = startWeb(dir, 0, { write: true }); await login();
  const ev = () => store.db.query("SELECT actor, message FROM events WHERE message LIKE '%encolad%'").all() as { actor: string; message: string }[];
  await post(`/activities/${impls[0]}/score`, { scorer: 'calidad' });
  expect(ev()).toEqual([{ actor: 'web', message: expect.stringContaining('calidad') }]);
  await post('/scorers/backfill', { ws: 'ws', since: '', scorer: '', skip: 'yes', expected: '1' });
  expect(ev().map(e => e.actor)).toEqual(['web', 'web']);
  expect(ev()[1]!.message).toContain('1 puntuaciones encoladas');
});
test('T65-H3: tasa «No medido» sin ejecuciones hechas, aprobada nula, rango en la vista previa y escape de juez y clase', async () => {
  const { digest, impls } = seed(2);
  insertScore(digest, impls[0]!, { status: 'pending', label: null, passed: null, cost: null });
  insertScore(digest, impls[1]!, { passed: null, label: '<i>cls</i>' });
  store.db.query("UPDATE scores SET scorer = '<u>juez</u>' WHERE subject_activity_id = ?").run(impls[1]!);
  server = startWeb(dir, 0, { write: true }); await login();
  const h = await html('/metricas?tab=jueces&range=all');
  expect(h).toContain('<td>implement</td><td>No medido</td>'); // calidad: cero hechas → tasa «No medido», no 0 %
  expect(h).toMatch(/<td>No medido<\/td><td>[\d.]+ USD<\/td>|No medido<\/td><td>0\.1000 USD/); // «Aprobada» nula
  expect(h).not.toContain('<u>juez</u>'); expect(h).not.toContain('<i>cls</i>');
  expect(h).toContain('&lt;u&gt;juez&lt;/u&gt;'); expect(h).toContain('&lt;i&gt;cls&lt;/i&gt;');
  const p = await html('/metricas?tab=jueces&ws=ws&range=7&preview=1');
  expect(p).toContain('name="ws" value="ws"');
  expect(p).toMatch(/name="since" value="\d{4}-\d{2}-\d{2}T/);
});
test('T111: una tarjeta por juez con la tasa de aprobado por día; el día sin puntuaciones es hueco y el rango personalizado filtra', async () => {
  const { digest, impls } = seed(3);
  insertScore(digest, impls[0]!, { passed: 1, at: '2026-11-17T10:00:00.000Z' }); insertScore(digest, impls[1]!, { passed: 0, label: 'mal', at: '2026-11-17T11:00:00.000Z' });
  insertScore(digest, impls[2]!, { passed: 1, at: '2026-11-19T10:00:00.000Z' });
  server = startWeb(dir, 0);
  const h = await html('/metricas?tab=jueces&from=2026-11-17&to=2026-11-19');
  expect(h).toContain('<section class="card"'); expect(h).toContain('<p class="fig">67 %</p>'); expect(h).toContain('<p class="sub">67 % (2/3)</p>');
  expect(h).toContain('<title>2026-11-17 · Aprobadas: 50 %</title>'); expect(h).toContain('<title>2026-11-19 · Aprobadas: 100 %</title>');
  expect(h).not.toContain('2026-11-18 · Aprobadas'); expect(h).toContain('<td>Sin datos</td>');
  const only = await html('/metricas?tab=jueces&from=2026-11-18&to=2026-11-19');
  expect(only).toContain('<p class="fig">100 %</p>'); expect(only).toContain('<p class="sub">100 % (1/1)</p>');
  expect(await html('/metricas?tab=jueces&from=2026-11-20&to=2026-11-21')).toContain('No hay puntuaciones en este rango.');
});
test('T111-H4: cambiar el rango en Jueces conserva el juez elegido', async () => {
  const { digest, impls } = seed(1); insertScore(digest, impls[0]!);
  server = startWeb(dir, 0);
  expect(await html('/metricas?tab=jueces&range=all&scorer=calidad')).toContain('<input type="hidden" name="scorer" value="calidad">');
  expect(await html('/metricas?tab=jueces&range=all')).not.toContain('name="scorer" value=');
  expect(await html('/metricas?tab=jueces&scorer=%22%3E%3Cb%3E')).not.toContain('<b>');
});
test('T111-H7: el tope de 366 días vale también en Jueces (borde exacto 366 pasa, 367 da 400)', async () => {
  seed(1); server = startWeb(dir, 0);
  for (const tab of ['productividad', 'gasto', 'jueces']) {
    expect((await fetch(url(`/metricas?tab=${tab}&from=2025-01-01&to=2025-12-31`))).status).toBe(200); // 365
    expect((await fetch(url(`/metricas?tab=${tab}&from=2024-01-01&to=2024-12-31`))).status).toBe(200); // 366 (bisiesto)
    expect((await fetch(url(`/metricas?tab=${tab}&from=2024-01-01&to=2025-01-01`))).status).toBe(400); // 367
  }
});
