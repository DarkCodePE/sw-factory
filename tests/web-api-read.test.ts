import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';

let dir: string, store: Store, server: ReturnType<typeof startWeb>, key: string, change: string, activity: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-api-'));
  store = new Store(join(dir, 'fabrica.db'));
  const ws = store.createWorkstream({ slug: 'prueba', goal: 'Objetivo', repo: '/ruta/secreta/repo' });
  const c = store.createChange(ws.id, 'Título', 'Descripción');
  change = c.id; activity = store.listActivities({ changeId: c.id })[0]!.id;
  key = store.createApiKey('lector', 'read').key;
  server = startWeb(dir, 0);
});
afterEach(() => { server?.stop(true); store?.close(); rmSync(dir, { recursive: true, force: true }); });
const api = (path: string, init: RequestInit & { auth?: string | null } = {}) => {
  const { auth = key, ...rest } = init;
  return fetch(`http://127.0.0.1:${server.port}/api/v1${path}`, { ...rest, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(rest.headers as object) } });
};
const data = async (path: string) => (await (await api(path)).json() as any).data;

test('A3: sin clave, inventada, secreto erróneo o revocada: 401 idéntico', async () => {
  const wrong = key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A');
  const rev = store.createApiKey('vieja', 'read').key; store.revokeApiKey('vieja');
  const bodies = [];
  for (const auth of [null, 'x', wrong, rev, 'fabk_000000000000_' + 'A'.repeat(43)]) {
    const r = await api('/workstreams', { auth }); expect(r.status).toBe(401); bodies.push(await r.text());
  }
  expect(new Set(bodies).size).toBe(1);
});

test('la clave solo se acepta en Authorization', async () => {
  expect((await api(`/workstreams?key=${key}`, { auth: null })).status).toBe(401);
  expect((await api('/workstreams', { auth: null, headers: { Cookie: `key=${key}`, 'X-Api-Key': key } })).status).toBe(401);
});

test('A6: sin CORS, OPTIONS 405, Host ajeno 403', async () => {
  const o = await api('/workstreams', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  expect(o.status).toBe(405); expect(o.headers.get('access-control-allow-origin')).toBeNull();
  expect((await api('/workstreams', { headers: { Host: 'evil.example' } })).status).toBe(403);
  expect((await api('/workstreams')).headers.get('access-control-allow-origin')).toBeNull();
});

test('rutas de lectura devuelven lo del Store; sin repo absoluto', async () => {
  const ws = await data('/workstreams');
  expect(ws).toHaveLength(1); expect(ws[0].slug).toBe('prueba'); expect(JSON.stringify(ws)).not.toContain('/ruta/secreta');
  expect(await data('/changes')).toEqual(JSON.parse(JSON.stringify(store.listChanges('prueba'))));
  expect(await data('/changes?ws=prueba&status=' + store.getChange(change).status)).toHaveLength(1);
  expect(await data('/changes?status=completed')).toHaveLength(0);
  const c = await data(`/changes/${change}`);
  expect(c.id).toBe(change); expect(c.activities.map((a: any) => a.id)).toEqual([activity]);
  expect(await data(`/activities/${activity}`)).toEqual(JSON.parse(JSON.stringify(store.getActivity(activity))));
  expect(await data('/inbox')).toEqual(JSON.parse(JSON.stringify(store.inbox())));
});

test('errores: limit inválido 400, no encontrado 404, ruta desconocida 404, mutación sin implementar no pasa', async () => {
  for (const l of ['201', '0', 'abc', '-1', '1.5']) expect((await api(`/changes?limit=${l}`)).status).toBe(400);
  expect((await api('/changes?limit=200')).status).toBe(200);
  expect((await api('/changes/inexistente')).status).toBe(404);
  expect((await api('/changes?ws=nada')).status).toBe(404);
  expect((await api('/changes/a%2Fb')).status).toBe(400);
  expect((await api('/nada')).status).toBe(404);
  expect((await api(`/changes/${change}/merge`, { method: 'POST' })).status).toBe(404);
});

test('A8: lectura sin tabla api_keys da 401 y no la crea; lecturas no cambian mtime', async () => {
  const old = mkdtempSync(join(tmpdir(), 'fab-api-old-'));
  try {
    const path = join(old, 'fabrica.db'); const s = new Store(path); s.createWorkstream({ slug: 'a', goal: 'g', repo: '/r' }); s.close();
    const db = new Database(path); db.run('DROP TABLE api_keys'); db.close();
    const srv = startWeb(old, 0);
    try {
      const r = await fetch(`http://127.0.0.1:${srv.port}/api/v1/workstreams`, { headers: { Authorization: `Bearer ${key}` } });
      expect(r.status).toBe(401);
      const check = new Database(path, { readonly: true });
      expect(check.query("SELECT 1 FROM sqlite_schema WHERE name='api_keys'").get()).toBeNull(); check.close();
    } finally { srv.stop(true); }
  } finally { rmSync(old, { recursive: true, force: true }); }
  const m = () => statSync(join(dir, 'fabrica.db')).mtimeMs;
  const before = m(); for (let i = 0; i < 3; i++) await api('/workstreams'); expect(m()).toBe(before);
});

test('A9: los textos de la respuesta pasan por redact', async () => {
  const secret = 'ghp_' + 'a'.repeat(30);
  const db = new Database(join(dir, 'fabrica.db'));
  db.query('UPDATE activities SET result = ?, error = ? WHERE id = ?').run(`token ${secret}`, `Bearer abc.def-ghi`, activity);
  db.query('UPDATE changes SET title = ? WHERE id = ?').run(`t ${secret}`, change); db.close();
  for (const p of [`/activities/${activity}`, `/changes/${change}`, '/changes', '/inbox']) {
    const t = await (await api(p)).text(); expect(t).not.toContain(secret); expect(t).not.toContain('abc.def-ghi');
  }
  expect(await (await api(`/activities/${activity}`)).text()).toContain('[REDACTED]');
});
