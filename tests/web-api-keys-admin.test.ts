import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';
import { handleApi } from '../src/web-api.ts';
import { ApiKeyUsage, revokeApiKeyResponse } from '../src/web-api-keys.ts';

const list = '/config/claves-api';
const create = `${list}/crear`;
const revoke = (id: string) => `${list}/${id}/revocar`;
let dir: string, store: Store, server: ReturnType<typeof startWeb>, cookie: string, csrf: string;
const origin = () => `http://${server.host ?? '127.0.0.1'}:${server.port}`;
const req = (path: string, init?: RequestInit) => fetch(origin() + path, { redirect: 'manual', ...init });
const get = (path = list) => req(path, { headers: { cookie } });
const post = (path: string, fields: Record<string, string> = {}, headers?: Headers) => req(path, {
  method: 'POST',
  headers: headers ?? formHeaders(),
  body: new URLSearchParams({ csrf, ...fields }),
});
const formHeaders = () => new Headers({ cookie, origin: origin(), 'content-type': 'application/x-www-form-urlencoded' });
const api = (key: string, path = '/workstreams', init?: RequestInit) => fetch(`http://127.0.0.1:${server.port}/api/v1${path}`, {
  ...init, headers: { Authorization: `Bearer ${key}`, ...init?.headers },
});
function boot(write: boolean, clock?: () => Date) {
  server?.stop(true);
  server = startWeb(dir, 0, { write, clock });
}
async function login() {
  const response = await fetch(server.loginUrl!, { redirect: 'manual' });
  expect(response.status).toBe(303);
  cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const page = await get();
  expect(page.status).toBe(200);
  csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(await page.text())?.[1] ?? '';
  expect(csrf.length).toBe(64);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-web-key-admin-'));
  store = new Store(join(dir, 'fabrica.db'));
  cookie = csrf = '';
});
afterEach(() => {
  server?.stop(true);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('solo la sesión del host del arranque administra las claves', async () => {
  const reader = store.createApiKey('lector', 'read');
  const owner = store.createApiKey('dueno', 'decide');
  const before = store.listApiKeys();
  const data = { name: 'nueva', scope: 'read', confirm: 'yes' };
  for (const write of [false, true]) {
    boot(write);
    for (const key of [reader.key, owner.key]) {
      const authorization = `Bearer ${key}`;
      for (const method of ['GET', 'HEAD']) {
        for (const headers of [{}, { cookie: 'fab_session=invalida' }, { authorization }]) {
          const res = await req(list, { method, headers: new Headers(headers as Record<string, string>) });
          expect(res.status).toBe(401);
          expect((await res.text()).includes('lector')).toBe(false);
        }
      }
      for (const path of [create, revoke(reader.id)]) {
        const headers = formHeaders();
        headers.delete('cookie');
        headers.set('authorization', authorization);
        expect((await post(path, data, headers)).status).toBe(write ? 401 : 405);
        expect((await api(key, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })).status).toBe(404);
      }
      expect((await api(key, list)).status).toBe(404);
    }
  }
  await login();
  for (const method of ['GET', 'HEAD']) {
    expect((await req(list, { method, headers: { cookie, host: `localhost:${server.port}` } })).status).toBe(403);
  }
  const head = await req(list, { method: 'HEAD', headers: { cookie } });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
  for (const path of [create, revoke(reader.id)]) {
    for (const [header, value, status] of [
      ['cookie', null, 401], ['cookie', 'fab_session=invalida', 401],
      ['origin', null, 403], ['origin', `http://localhost:${server.port}`, 403],
      ['host', `localhost:${server.port}`, 403], ['content-type', 'text/plain', 415],
    ] as const) {
      const headers = formHeaders();
      if (value === null) headers.delete(header); else headers.set(header, value);
      expect((await post(path, data, headers)).status).toBe(status);
    }
    expect((await post(path, { ...data, csrf: '' })).status).toBe(403);
    expect((await post(path, { ...data, csrf: '0'.repeat(64) })).status).toBe(403);
    expect((await post(path, { ...data, padding: 'a'.repeat(17 * 1024) })).status).toBe(413);
  }
  expect(store.listApiKeys()).toEqual(before);
});

test('la página de Configuración enlaza el listado y tolera una base antigua', async () => {
  store.db.exec('DROP TABLE api_keys');
  boot(true);
  await login();
  expect(await (await get('/config')).text()).toContain(`href="${list}"`);
  expect(await (await get()).text()).toContain('No hay claves API.');
  expect(store.db.query("SELECT 1 FROM sqlite_schema WHERE name = 'api_keys'").get()).toBeNull();
});

test('el alta entrega el secreto una vez y autentica hasta revocar por id', async () => {
  boot(true);
  await login();
  const logs = [spyOn(console, 'log'), spyOn(console, 'warn'), spyOn(console, 'error')];
  try {
    const invalid = await post(create, { name: '<script>', scope: 'write' });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain('<script>');
    expect(store.listApiKeys()).toEqual([]);

    const data = { name: 'canario', scope: 'read' };
    const response = await post(create, data);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(response.headers.has('location')).toBe(false);
    const document = await response.text();
    const keys = [...document.matchAll(/fabk_([a-f0-9]{12})_([A-Za-z0-9_-]{43})/g)];
    expect(keys).toHaveLength(1);
    const [key, id, secret] = keys[0]!;
    const hash = createHash('sha256').update(secret!).digest('hex');
    expect(store.db.query('SELECT hash FROM api_keys WHERE id = ?').get(id!)).toEqual({ hash });
    expect(document).toContain(`<code>${key}</code>`);
    expect(document).toContain(`href="${list}"`);
    expect(document).not.toMatch(/<(script|form|input|iframe)\b/);
    const apiResponse = await api(key);
    expect(apiResponse.status).toBe(200);
    const mutation = await api(key, '/changes/prueba/note', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"body":"hola"}' });
    expect(mutation.status).toBe(403);
    const page = await (await get()).text();
    expect(page).toContain('canario');
    expect(page).toContain('read');
    expect(page).toContain('Activa');
    expect(page).toContain(store.listApiKeys()[0]!.createdAt);
    expect(page).toContain(`action="${revoke(id!)}"`);
    const retry = await post(create, data);
    expect(retry.status).toBe(409);
    const reload = await get(create);
    expect(reload.status).toBe(404);
    for (const text of [page, await retry.text(), await reload.text(), await apiResponse.text(), await mutation.text(), JSON.stringify([...response.headers])]) {
      expect(text.includes(secret!) || text.includes(hash)).toBe(false);
    }
    for (const file of readdirSync(dir).filter(name => name.startsWith('fabrica.db'))) {
      expect(readFileSync(join(dir, file)).includes(secret!)).toBe(false);
    }

    expect((await post(revoke(id!))).status).toBe(400);
    expect((await api(key)).status).toBe(200);
    const revoked = await post(revoke(id!), { confirm: 'yes' });
    expect(revoked.status).toBe(303);
    expect(revoked.headers.get('location')).toBe(list);
    expect(await revoked.text()).toBe('');
    const rejected = await api(key);
    expect(rejected.status).toBe(401);
    const after = await (await get()).text();
    expect(after).toContain('Revocada');
    for (const text of [after, await rejected.text(), JSON.stringify(logs.flatMap(log => log.mock.calls))]) {
      expect(text.includes(secret!) || text.includes(hash)).toBe(false);
    }
    expect(store.listApiKeys()).toHaveLength(1);
    expect(store.db.query('SELECT id FROM events').all()).toEqual([]);
  } finally {
    for (const log of logs) log.mockRestore();
  }
});

test('la revocación no interpreta nombres ni ids codificados y el listado escapa datos antiguos', async () => {
  const name = '0123456789ab';
  const alias = store.createApiKey(name, 'decide');
  store.db.query('UPDATE api_keys SET created_at = ? WHERE id = ?').run('<svg onload="x">', alias.id);
  boot(true);
  await login();
  const page = await (await get()).text();
  expect(page).toContain('&lt;svg onload=&quot;x&quot;&gt;');
  expect(page).not.toContain('<svg onload=');
  for (const id of ['incorrecto', '%30' + name.slice(1), alias.id + '%0A']) {
    expect((await post(revoke(id), { confirm: 'yes' })).status).toBe(400);
  }
  expect((await post(revoke(name), { confirm: 'yes' })).status).toBe(404);
  expect(store.verifyApiKey(alias.key)?.id).toBe(alias.id);
});

const row = (page: string, name: string) => page.match(/<tr>[\s\S]*?<\/tr>/g)?.find(r => r.startsWith(`<tr><td>${name}</td>`)) ?? '';

test('último uso solo registra 2xx, funciona en lectura y se pierde al reiniciar', async () => {
  const reader = store.createApiKey('lector', 'read');
  const owner = store.createApiKey('dueno', 'decide');
  const ws = store.createWorkstream({ slug: 'prueba', goal: 'g', repo: '/repo' });
  const change = store.createChange(ws.id, 'cambio', 'd');
  const note = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"body":"hola"}' };
  const first = '2026-11-20T07:00:00.000Z';
  const second = '2026-11-20T08:00:00.000Z';
  let now = first;
  let calls = 0;
  const clock = () => { calls++; return new Date(now); };
  boot(false, clock);
  const paths = [store.dbPath, store.dbPath + '-wal'];
  const before = paths.map(path => readFileSync(path));
  expect((await api(reader.key)).status).toBe(200);
  expect(calls).toBe(1);
  for (const [i, path] of paths.entries()) expect(readFileSync(path).equals(before[i]!)).toBe(true);

  boot(true, clock);
  await login();
  const initial = await (await get()).text();
  expect(initial).toContain('Último uso en este arranque');
  expect(row(initial, 'lector')).toContain('No medido');
  expect(row(initial, 'dueno')).toContain('No medido');
  expect((await api(reader.key)).status).toBe(200);
  now = second;
  expect((await api('fabk_invalida')).status).toBe(401);
  expect((await api(reader.key, `/changes/${change.id}/note`, note)).status).toBe(403);
  expect((await api(reader.key, '/sin-ruta')).status).toBe(404);
  expect((await api(reader.key, '/workstreams', { method: 'HEAD' })).status).toBe(405);
  expect((await api(owner.key, `/changes/${change.id}/note`, { ...note, body: '{' })).status).toBe(400);
  expect(calls).toBe(2);
  expect((await api(owner.key, `/changes/${change.id}/note`, note)).status).toBe(200);
  expect(calls).toBe(3);
  const observed = await (await get()).text();
  expect(row(observed, 'lector')).toContain(`<time>${first}</time>`);
  expect(row(observed, 'dueno')).toContain(`<time>${second}</time>`);
  const revoked = await post(revoke(reader.id), { confirm: 'yes' });
  expect(revoked.status).toBe(303);
  expect(row(await (await get()).text(), 'lector')).not.toContain(first);

  boot(true, clock);
  await login();
  expect(row(await (await get()).text(), 'dueno')).toContain('No medido');
  expect(calls).toBe(3);
});

test('el registro descarta el uso más antiguo al entrar una clave de otro proceso', async () => {
  const initial = '2026-11-20T07:00:00.000Z';
  const latest = '2026-11-20T08:00:00.000Z';
  let now = initial;
  const keys = Array.from({ length: 20 }, (_, i) => store.createApiKey(`clave-${i}`, 'read'));
  boot(true, () => new Date(now));
  await login();
  for (const { key } of keys) expect((await api(key)).status).toBe(200);
  now = latest;
  expect((await api(keys[0]!.key)).status).toBe(200);
  const external = new Store(store.dbPath);
  try {
    external.revokeApiKey(keys[2]!.id);
    expect((await api(external.createApiKey('nueva', 'read').key)).status).toBe(200);
  } finally { external.close(); }
  const page = await (await get()).text();
  expect(row(page, 'clave-0')).toContain(`<time>${latest}</time>`);
  expect(row(page, 'clave-1')).toContain('No medido');
  expect(row(page, 'clave-2')).toContain('Revocada');
  expect(row(page, 'clave-2')).not.toContain(initial);
  expect(row(page, 'clave-3')).toContain(`<time>${initial}</time>`);
  expect(row(page, 'nueva')).toContain(`<time>${latest}</time>`);
});

test('una mutación en curso puede terminar tras revocar sin recuperar el último uso', async () => {
  const ws = store.createWorkstream({ slug: 'prueba', goal: 'g', repo: '/repo' });
  const change = store.createChange(ws.id, 'cambio', 'd');
  const { key, id } = store.createApiKey('dueno', 'decide');
  const usage = new ApiKeyUsage(() => new Date('2026-11-20T07:00:00.000Z'));
  const openReader = () => new Store(store.dbPath, { readonly: true });
  const readUrl = new URL('http://127.0.0.1/api/v1/workstreams');
  const auth = { Authorization: `Bearer ${key}` };
  expect((await handleApi(new Request(readUrl, { headers: auth }), readUrl, openReader, { stateDir: dir }, usage)).status).toBe(200);
  expect(usage.lastUse(id)).toBeDefined();

  const url = new URL(`http://127.0.0.1/api/v1/changes/${change.id}/note`);
  const { promise, resolve } = Promise.withResolvers<ArrayBuffer>();
  const request = new Request(url, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' } });
  // El cuerpo se entrega después de que la API autorice el POST y se revoque la clave.
  request.arrayBuffer = () => promise;
  const response = handleApi(request, url, openReader, { stateDir: dir }, usage);
  expect(revokeApiKeyResponse(dir, id, new URLSearchParams({ confirm: 'yes' }), usage).status).toBe(303);
  expect(usage.lastUse(id)).toBeUndefined();
  resolve(new TextEncoder().encode('{"body":"nota ya autorizada"}').buffer);
  expect((await response).status).toBe(200);
  expect(usage.lastUse(id)).toBeUndefined();
  expect((await handleApi(new Request(readUrl, { headers: auth }), readUrl, openReader, { stateDir: dir }, usage)).status).toBe(401);
});
