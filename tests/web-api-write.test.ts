import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { ACTIONS } from '../src/web-actions.ts';
import { handleApi } from '../src/web-api.ts';
import { startWeb } from '../src/web.ts';

let dir: string, store: Store, server: ReturnType<typeof startWeb>, decide: string, read: string, change: string, activity: string;
const boot = (write: boolean) => { server?.stop(true); server = startWeb(dir, 0, write ? { write: true } : {}); };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-apiw-'));
  store = new Store(join(dir, 'fabrica.db'));
  const ws = store.createWorkstream({ slug: 'prueba', goal: 'Objetivo', repo: '/ruta/repo' });
  const c = store.createChange(ws.id, 'Título', 'Descripción');
  change = c.id; activity = store.listActivities({ changeId: c.id })[0]!.id;
  decide = store.createApiKey('agente', 'decide').key; read = store.createApiKey('lector', 'read').key;
  boot(true);
});
afterEach(() => { server?.stop(true); store?.close(); rmSync(dir, { recursive: true, force: true }); });
const post = (path: string, body: unknown, init: { auth?: string | null; type?: string | null; raw?: string; headers?: object } = {}) => {
  const { auth = decide, type = 'application/json', raw, headers } = init;
  return fetch(`http://127.0.0.1:${server.port}/api/v1${path}`, { method: 'POST', body: raw ?? JSON.stringify(body), headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(type ? { 'Content-Type': type } : {}), ...headers } });
};
const notes = () => store.db.query('SELECT COUNT(*) AS n FROM change_notes').get() as { n: number };

test('nota con clave decide: 200 y evento con actor api:<name>', async () => {
  const r = await post(`/changes/${change}/note`, { body: 'hola' });
  expect(r.status).toBe(200); expect((await r.json() as any).ok).toBe(true);
  expect(notes().n).toBe(1);
  expect((store.db.query("SELECT COUNT(*) AS n FROM events WHERE actor='api:agente'").get() as { n: number }).n).toBeGreaterThan(0);
});

test('T110: el origen API viene de la petición autenticada y no de sus campos', async () => {
  expect((await post('/signals', { workstream: 'prueba', title: 'señal API', source: 'web', actorId: 'otro' })).status).toBe(200);
  const [signal] = store.listSignals('prueba', 'new');
  expect(signal?.source).toBe('api');
  expect((await post(`/signals/${signal!.id}/triage`, {})).status).toBe(200);
  const [triaged] = store.listSignals('prueba', 'triaged');
  expect(store.getChangeOrigin(triaged!.changeId!)).toEqual({ source: 'api', actorId: null });
});

test('A7: sin --write, clave decide da 405 y no cambia nada', async () => {
  boot(false);
  expect((await post(`/changes/${change}/note`, { body: 'x' })).status).toBe(405);
  expect(notes().n).toBe(0);
});

test('A4: clave read muta: 403 y la base no cambia', async () => {
  expect((await post(`/changes/${change}/note`, { body: 'x' }, { auth: read })).status).toBe(403);
  expect(notes().n).toBe(0);
});

test('A2: clave en la URL o en cookie, o sesión: 401', async () => {
  expect((await post(`/changes/${change}/note?key=${decide}`, { body: 'x' }, { auth: null })).status).toBe(401);
  expect((await post(`/changes/${change}/note`, { body: 'x' }, { auth: null, headers: { Cookie: `fab_session=${decide}` } })).status).toBe(401);
  expect(notes().n).toBe(0);
});

test('A5: merge, gate y rutas ajenas a ACTIONS dan 404; las rutas salen de ACTIONS', async () => {
  for (const p of [`/changes/${change}/merge`, `/changes/${change}/gate`, `/changes/${change}/approve`, '/keys', '/perfiles/importar', '/definicion/importar', '/scorers/nuevo']) expect((await post(p, {})).status).toBe(404);
  expect(Object.keys(ACTIONS).sort()).toEqual(['activities/review', 'activities/score', 'api-keys/create', 'api-keys/revoke', 'automations/create', 'automations/delete', 'automations/disable', 'automations/enable', 'automations/run', 'automations/update', 'automejora/save', 'benchmarks/cancel', 'changes/cancel', 'changes/note', 'changes/rename', 'changes/retry', 'changes/suite-task', 'definicion/importar', 'jira/import', 'perfiles/importar', 'questions/answer', 'resident/config', 'runners/check', 'runners/create', 'runners/delete', 'runners/update', 'scorers/backfill', 'scorers/create', 'signals/create', 'signals/ignore', 'signals/triage', 'workstreams/acceso', 'workstreams/adaptador', 'workstreams/archive', 'workstreams/create', 'workstreams/runner', 'workstreams/settings', 'workstreams/state']);
});

test('H1: una clave decide no crea ni activa workstreams (api: false); settings y archive siguen', async () => {
  const body = { slug: 'nuevo', goal: 'x', repo: dir, verify: 'sh -c "id"' };
  expect((await post('/workstreams/nuevo', body)).status).toBe(404);
  expect(store.listWorkstreams().map(w => w.slug)).toEqual(['prueba']);
  const id = store.listWorkstreams()[0]!.id;
  expect((await post(`/workstreams/${id}/state`, { state: 'active' })).status).toBe(404);
  expect(ACTIONS['workstreams/create']!.api).toBe(false); expect(ACTIONS['workstreams/state']!.api).toBe(false);
  expect((await post(`/workstreams/${id}/settings`, { goal: 'otro', concurrency: '1', task_limit: '5' })).status).not.toBe(404);
});

test('415, 413 y JSON inválido', async () => {
  expect((await post(`/changes/${change}/note`, { body: 'x' }, { type: 'text/plain' })).status).toBe(415);
  expect((await post(`/changes/${change}/note`, { body: 'x' }, { type: null })).status).toBe(415);
  expect((await post(`/changes/${change}/note`, null, { raw: JSON.stringify({ body: 'a'.repeat(20000) }) })).status).toBe(413);
  expect((await post(`/changes/${change}/note`, null, { raw: '{no' })).status).toBe(400);
  expect((await post(`/changes/${change}/note`, [1])).status).toBe(400);
  expect((await post(`/changes/${change}/note`, { body: 5 })).status).toBe(400);
  expect(notes().n).toBe(0);
});

test('T71e-H1: el tope de 16 KiB lo aplica la API aunque el servidor acepte 1 MiB', async () => {
  // handleApi directo: sin el límite del servidor, solo cuentan las dos comprobaciones de la API.
  const call = (init: RequestInit) => handleApi(new Request(`http://127.0.0.1/api/v1/changes/${change}/note`, { method: 'POST', headers: { Authorization: `Bearer ${decide}`, 'Content-Type': 'application/json', ...(init.headers as object) }, body: init.body }), new URL(`http://127.0.0.1/api/v1/changes/${change}/note`), () => new Store(join(dir, 'fabrica.db'), { readonly: true }), { stateDir: dir });
  const sin = await call({ body: JSON.stringify({ body: 'x', relleno: 'a'.repeat(17 * 1024) }) });
  expect(sin.status).toBe(413);
  const cabecera = await call({ headers: { 'content-length': String(17 * 1024) }, body: JSON.stringify({ body: 'x' }) });
  expect(cabecera.status).toBe(413);
  expect((await post(`/changes/${change}/note`, { body: 'x', relleno: 'a'.repeat(17 * 1024) })).status).toBe(413);
  expect((await post(`/changes/${change}/note`, { body: 'x', relleno: 'a'.repeat(600 * 1024) })).status).toBe(413);
  expect(notes().n).toBe(0);
});

test('revisión por API y reintento con la revisión de GET /changes/<id>', async () => {
  store.db.query("UPDATE activities SET kind='change_review', status='completed', review_status='awaiting' WHERE id=?").run(activity);
  expect((await post(`/activities/${activity}/review`, { decision: 'decline' })).status).toBe(400);
  expect((await post(`/activities/${activity}/review`, { decision: 'comment', comment: 'cambia' })).status).toBe(200);
  expect(store.getActivity(activity).reviewStatus).toBe('commented');
  expect((await post(`/activities/${activity}/review`, { decision: 'comment', comment: 'otra vez' })).status).toBe(409);
  const rev = ((await (await fetch(`http://127.0.0.1:${server.port}/api/v1/changes/${change}`, { headers: { Authorization: `Bearer ${read}` } })).json()) as any).data.revision;
  expect(typeof rev).toBe('string');
  expect((await post(`/changes/${change}/retry`, { revision: 'vieja' })).status).toBe(409);
});

test('ids inválidos y cambio inexistente', async () => {
  expect((await post('/changes/a%2Fb/note', { body: 'x' })).status).toBe(400);
  expect((await post('/changes/nada/note', { body: 'x' })).status).toBe(404);
});
