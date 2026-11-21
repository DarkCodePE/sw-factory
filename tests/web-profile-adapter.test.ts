import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AdmissionDb } from '../src/admission/db.ts';
import { SessionStore } from '../src/admission/sessions.ts';
import { DEFAULT_DIGEST, defaultProfile, saveProfile } from '../src/profile.ts';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';

let dir: string, store: Store, server: ReturnType<typeof startWeb>, id: string, cookie: string, csrf: string;
const origin = () => `http://${server.host ?? '127.0.0.1'}:${server.port}`;
const page = '/perfiles?ws=prueba';
const path = () => `/workstreams/${id}/adaptador`;
const fields = () => ({ csrf, agent: 'codex', previous: 'claude', profileExpected: DEFAULT_DIGEST, confirm: 'yes' });
const req = (path: string, init?: RequestInit) => fetch(origin() + path, { redirect: 'manual', ...init });
const view = async () => (await req(page, { headers: { cookie } })).text();
const post = (path: string, data: URLSearchParams | Record<string, string>, headers: Record<string, string> = {}) => req(path, {
  method: 'POST', body: new URLSearchParams(data),
  headers: { cookie, origin: origin(), 'content-type': 'application/x-www-form-urlencoded', ...headers },
});
async function login() {
  const r = await fetch(server.loginUrl!, { redirect: 'manual' });
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  csrf = /name="csrf" value="([^"]+)"/.exec(await view())![1]!;
}

beforeEach(() => {
  dir = mkdtempSync('/tmp/fab-web-profile-adapter-');
  store = new Store(join(dir, 'fabrica.db'));
  id = store.createWorkstream({ slug: 'prueba', goal: 'g', repo: '/repo', agent: 'claude', requireChangeApproval: false }).id;
  server = startWeb(dir, 0, { write: true });
  cookie = ''; csrf = '';
});
afterEach(() => { server.stop(true); store.close(); rmSync(dir, { recursive: true, force: true }); });

test('mutaciones de perfiles requieren sesión, Origin, CSRF y Host único; la clave decide no las expone', async () => {
  const bearer = `Bearer ${store.createApiKey('api-prueba', 'decide').key}`;
  const routes = [
    [path(), fields()],
    ['/perfiles/guardar', { ws: 'prueba', base: DEFAULT_DIGEST, expectedAgent: 'claude' }],
    ['/perfiles/asignar', { ws: 'prueba', previous: DEFAULT_DIGEST, expectedAgent: 'claude', digest: DEFAULT_DIGEST, confirm: 'yes' }],
  ] as const;
  expect(await view()).not.toContain(`action="${path()}"`);
  for (const [url, data] of routes) {
    expect((await post(url, data, { authorization: bearer })).status).toBe(401);
    const api = await fetch(`http://127.0.0.1:${server.port}/api/v1${url}`, {
      method: 'POST', headers: { authorization: bearer, 'content-type': 'application/json' }, body: JSON.stringify(data),
    });
    expect(api.status).toBe(404);
  }
  await login();
  for (const [url, data] of routes) {
    const form = { ...data, csrf };
    expect((await post(url, form, { origin: 'http://localhost:9999' })).status).toBe(403);
    expect((await post(url, { ...form, csrf: 'incorrecto' })).status).toBe(403);
    expect((await post(url, form, { host: `127.0.0.1:${server.port}` })).status).toBe(403);
  }
  server.stop(true);
  server = startWeb(dir, 0);
  for (const [url, data] of routes) expect((await post(url, data)).status).toBe(405);
  expect(store.getWorkstream(id)).toMatchObject({ agent: 'claude', profile: null });
});

test('adaptador exige confirmación y campos únicos, y registra anterior, nuevo y actor web', async () => {
  await login();
  const html = await view();
  expect(html).toContain(`action="${path()}"`);
  expect(html).toContain(`name="profileExpected" value="${DEFAULT_DIGEST}"`);
  expect((await post(path(), { ...fields(), confirm: '' })).status).toBe(400);
  expect((await post(path(), { ...fields(), agent: 'inventado' })).status).toBe(400);
  expect((await post(path(), { ...fields(), approval: 'no' })).status).toBe(400);
  const duplicate = new URLSearchParams(fields()); duplicate.append('agent', 'fake');
  expect((await post(path(), duplicate)).status).toBe(400);
  expect((await post(path(), { ...fields(), extra: 'x'.repeat(17000) })).status).toBe(413);
  expect(store.getWorkstream(id).agent).toBe('claude');
  const beforeActor = process.env.FAB_ACTOR;
  const r = await post(path(), fields());
  expect([r.status, r.headers.get('location')]).toEqual([303, page]);
  expect(store.getWorkstream(id)).toMatchObject({ agent: 'codex', profile: null });
  expect(store.listEvents(id, 10).at(-1)).toMatchObject({ actor: 'web', message: 'adaptador del workstream: claude → codex' });
  expect(process.env.FAB_ACTOR).toBe(beforeActor);
  expect(await view()).toMatch(/<code>codex<\/code> · Workstream/);
});

test('asignar y cambiar adaptador invalidan la otra confirmación si quedó obsoleta', async () => {
  await login();
  const digest = saveProfile(dir, { ...defaultProfile(), schemaVersion: 2 }).digest;
  const assign = { csrf, ws: 'prueba', digest, previous: DEFAULT_DIGEST, expectedAgent: 'claude', confirm: 'yes' };
  expect((await post('/perfiles/asignar', assign)).status).toBe(303);
  expect((await post(path(), fields())).status).toBe(303);
  expect(await view()).toContain('Revisa el estado actual');
  expect(store.getWorkstream(id)).toMatchObject({ agent: 'claude', profile: digest });
  expect((await post(path(), { ...fields(), profileExpected: digest })).status).toBe(303);
  expect((await post('/perfiles/asignar', { ...assign, digest: DEFAULT_DIGEST, previous: digest })).status).toBe(303);
  expect(await view()).toContain('Revisa el estado actual');
  expect(store.getWorkstream(id)).toMatchObject({ agent: 'codex', profile: digest });
});

test('ambas activaciones muestran el motivo durante trabajo vivo y guardar sigue disponible', async () => {
  await login();
  store.setWorkstreamState(id, 'active');
  const change = store.createChange(id, 'c', 'd');
  const a = store.claimActivity(id, 'worker')!;
  store.setActivityProvenance(a.id, DEFAULT_DIGEST, 'sha', { agent: 'claude', model: 'modelo-real' });
  const saved = await post('/perfiles/guardar', { csrf, ws: 'prueba', expectedAgent: 'claude', base: DEFAULT_DIGEST, 'worker.investigate': 'otra investigación' });
  expect(saved.status).toBe(303);
  const digest = new URL(saved.headers.get('location')!, origin()).searchParams.get('digest')!;
  const assign = { csrf, ws: 'prueba', digest, previous: DEFAULT_DIGEST, expectedAgent: 'claude', confirm: 'yes' };
  const sessions = new SessionStore(new AdmissionDb(store));
  const { session } = sessions.begin(change.id, a.kind, { backend: 'claude', cwd: '/repo' });
  const blocked = async () => {
    expect((await post(path(), fields())).status).toBe(303);
    expect(await view()).toContain('El workstream tiene trabajo vivo');
    expect((await post('/perfiles/asignar', assign)).status).toBe(303);
    expect(await view()).toContain('El workstream tiene trabajo vivo');
    expect(store.getWorkstream(id)).toMatchObject({ agent: 'claude', profile: null });
    expect(store.getActivity(a.id)).toMatchObject({ profileDigest: DEFAULT_DIGEST, agent: 'claude', model: 'modelo-real' });
  };
  await blocked();
  sessions.markLaunched(session.sessionId);
  store.awaitHuman(a.id, 'worker', { questionId: 'q', waitUntil: '2099-01-01T00:00:00Z' });
  await blocked();
  expect(store.answerAwaiting(a.id, 'q')).toBe(true);
  await blocked();
});

test('T84-H4: sin trabajo vivo la página no sugiere un bloqueo', async () => {
  await login();
  expect(await view()).not.toContain('termine el trabajo vivo');
});

test('T84-H5: los selectores ofrecen solo adaptadores confinables y sin fake; un rol ya declarado se conserva', async () => {
  await login();
  const html = await view();
  const roleSelect = /<select name="roles\.implement\.harness">(.*?)<\/select>/s.exec(html)![1]!;
  const adapterSelect = /<select name="agent" required>(.*?)<\/select>/s.exec(html)![1]!;
  for (const options of [roleSelect, adapterSelect]) {
    expect(options).toContain('value="codex"');
    for (const bad of ['droid', 'agy', 'native', 'fake']) expect(options).not.toContain(`value="${bad}"`);
  }
  const digest = saveProfile(dir, { ...defaultProfile(), schemaVersion: 2, harness: 'claude', roles: { implement: { harness: 'droid' } } }).digest;
  store.db.query('UPDATE workstreams SET profile = ? WHERE id = ?').run(digest, id);
  expect(/<select name="roles\.implement\.harness">(.*?)<\/select>/s.exec(await view())![1]).toContain('value="droid" selected');
});
