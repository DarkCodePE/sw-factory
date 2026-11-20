import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { ACTIONS } from '../src/web-actions.ts';
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
  for (const p of [`/changes/${change}/merge`, `/changes/${change}/gate`, `/changes/${change}/approve`, '/keys']) expect((await post(p, {})).status).toBe(404);
  expect(Object.keys(ACTIONS).sort()).toEqual(['activities/review', 'activities/score', 'automations/disable', 'automations/enable', 'automations/run', 'changes/cancel', 'changes/note', 'changes/rename', 'changes/retry', 'questions/answer', 'scorers/backfill', 'signals/create', 'signals/ignore', 'signals/triage', 'workstreams/archive', 'workstreams/create', 'workstreams/settings', 'workstreams/state']);
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
