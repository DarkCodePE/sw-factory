import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdmissionDb } from '../src/admission/db.ts';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';

let dir: string;
let store: Store;
let server: ReturnType<typeof startWeb> | undefined;
let originalSecret: string | undefined;

const SECRET_CANARY = 'secreto-canario-super-privado-123456789';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-webhooks-test-'));
  originalSecret = process.env.FAB_GITHUB_WEBHOOK_SECRET;
  process.env.FAB_GITHUB_WEBHOOK_SECRET = SECRET_CANARY;
});

afterEach(() => {
  server?.stop(true);
  server = undefined;
  store?.close();
  if (originalSecret !== undefined) process.env.FAB_GITHUB_WEBHOOK_SECRET = originalSecret;
  else delete process.env.FAB_GITHUB_WEBHOOK_SECRET;
  rmSync(dir, { recursive: true, force: true });
});

async function request(path = '/webhooks', method = 'GET'): Promise<Response> {
  return fetch(`http://127.0.0.1:${server!.port}${path}`, { method });
}

async function getHtml(path = '/webhooks'): Promise<string> {
  const res = await request(path);
  expect(res.status).toBe(200);
  return res.text();
}

test('sin tablas la página dice «Sin receptor»', async () => {
  store = new Store(join(dir, 'fabrica.db'));
  store.createWorkstream({ slug: 'demo', goal: 'meta', repo: dir });
  server = startWeb(dir, 0);

  const html = await getHtml('/webhooks');
  expect(html).toContain('Sin receptor');
  expect(html).toContain('Esta fábrica no tiene configuradas tablas de admisión ni receptor de webhooks');
  expect(html).not.toContain(SECRET_CANARY);
});

test('el HTML no contiene el secreto ni el cuerpo en ninguna circunstancia', async () => {
  store = new Store(join(dir, 'fabrica.db'));
  const adm = new AdmissionDb(store);
  const now = new Date().toISOString();
  adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
    .run('11111111-2222-3333-4444-555555555555', 'issues', now, 128, 'woke');

  server = startWeb(dir, 0);
  const html = await getHtml('/webhooks');

  expect(html).not.toContain(SECRET_CANARY);
  expect(html).toContain('Configurado (FAB_GITHUB_WEBHOOK_SECRET)');
  expect(html).toContain('11111111-2222-3333-4444-555555555555');
  expect(html).toContain('Sin cuerpo');
});

test('una entrega sin firma aparece como rechazada sin cuerpo', async () => {
  store = new Store(join(dir, 'fabrica.db'));
  const adm = new AdmissionDb(store);
  const now = new Date().toISOString();

  // Registro de entrega rechazada (sin firma / firma inválida)
  adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
    .run('00000000-0000-0000-0000-000000000001', 'issues', now, 256, 'rejected');

  server = startWeb(dir, 0);
  const html = await getHtml('/webhooks');

  expect(html).toContain('00000000-0000-0000-0000-000000000001');
  expect(html).toContain('Rechazada');
  expect(html).toContain('status failed');
  expect(html).toContain('Sin cuerpo');
  expect(html).not.toContain('payload');
});

test('lista entregas con su resultado (woke, coalesced, ignored_event, ignored_repo, rejected) y tamaño', async () => {
  store = new Store(join(dir, 'fabrica.db'));
  const adm = new AdmissionDb(store);
  const t0 = new Date(Date.now() - 10000).toISOString();
  const t1 = new Date(Date.now() - 5000).toISOString();
  const t2 = new Date().toISOString();

  adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
    .run('del-woke-1', 'issues', t0, 512, 'woke');
  adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
    .run('del-coal-2', 'issues', t1, 512, 'coalesced');
  adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
    .run('del-ign-3', 'ping', t2, 64, 'ignored_event');

  server = startWeb(dir, 0);
  const html = await getHtml('/webhooks');

  expect(html).toContain('del-woke-1');
  expect(html).toContain('Aceptada (despertó)');
  expect(html).toContain('del-coal-2');
  expect(html).toContain('Coalescida');
  expect(html).toContain('del-ign-3');
  expect(html).toContain('Evento ignorado');
  expect(html).toContain('512 B');
  expect(html).toContain('64 B');
});

test('muestra el estado del receptor activo si hay lock vivo e inactivo si no hay lock', async () => {
  store = new Store(join(dir, 'fabrica.db'));
  const adm = new AdmissionDb(store);
  server = startWeb(dir, 0);

  const htmlInactivo = await getHtml('/webhooks');
  expect(htmlInactivo).toContain('Inactivo');

  // Simular lock activo del residente
  adm.db.query('INSERT INTO adm_lock (id, owner, pid, host, heartbeat_at) VALUES (1, ?, ?, ?, ?)')
    .run('residente-test', process.pid, 'localhost', Date.now());

  const htmlActivo = await getHtml('/webhooks');
  expect(htmlActivo).toContain('Activo (residente en ejecución)');
});

test('búsqueda por ID, evento o resultado filtra la lista de entregas', async () => {
  store = new Store(join(dir, 'fabrica.db'));
  const adm = new AdmissionDb(store);
  const now = new Date().toISOString();

  adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
    .run('del-uuid-alpha', 'issues', now, 100, 'woke');
  adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
    .run('del-uuid-beta', 'issue_comment', now, 200, 'rejected');

  server = startWeb(dir, 0);

  const searchEvent = await getHtml('/webhooks?q=comment');
  expect(searchEvent).toContain('del-uuid-beta');
  expect(searchEvent).not.toContain('del-uuid-alpha');

  const searchResult = await getHtml('/webhooks?q=rechazada');
  expect(searchResult).toContain('del-uuid-beta');
  expect(searchResult).not.toContain('del-uuid-alpha');

  const searchNone = await getHtml('/webhooks?q=inexistente');
  expect(searchNone).toContain('Ninguna entrega coincide con la búsqueda.');
});

test('escapa caracteres peligrosos en ID y evento contra XSS', async () => {
  store = new Store(join(dir, 'fabrica.db'));
  const adm = new AdmissionDb(store);
  const now = new Date().toISOString();

  adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
    .run('<script>alert("xss")</script>', '<b>evento</b>', now, 100, 'woke');

  server = startWeb(dir, 0);
  const html = await getHtml('/webhooks');

  expect(html).not.toContain('<script>alert("xss")</script>');
  expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  expect(html).not.toContain('<b>evento</b>');
  expect(html).toContain('&lt;b&gt;evento&lt;/b&gt;');
});

test('solo lectura: POST a /webhooks devuelve 405 Method Not Allowed', async () => {
  store = new Store(join(dir, 'fabrica.db'));
  new AdmissionDb(store);
  server = startWeb(dir, 0);

  const res = await request('/webhooks', 'POST');
  expect(res.status).toBe(405);
  expect(res.headers.get('allow')).toBe('GET, HEAD');

  // Con modo escritura habilitado, la ruta sigue siendo estrictamente de solo lectura (405)
  server.stop(true);
  server = startWeb(dir, 0, { write: true });
  const resWrite = await fetch(`http://${server.host}:${server.port}/webhooks`, {
    method: 'POST',
    headers: { host: `${server.host}:${server.port}` },
  });
  expect(resWrite.status).toBe(405);
  expect(resWrite.headers.get('allow')).toBe('GET, HEAD');
});
