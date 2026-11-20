import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdmissionDb } from '../src/admission/db.ts';
import { startHook } from '../src/admission/hook.ts';
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

  // Iniciar receptor real y enviar petición sin cabecera de firma
  const hook = startHook({
    port: 0,
    secret: SECRET_CANARY,
    repo: 'owner/repo',
    adm,
    wake: () => {},
    now: () => Date.now(),
  });

  const res = await fetch(`http://127.0.0.1:${hook.port}/github`, {
    method: 'POST',
    body: JSON.stringify({ action: 'opened', issue: { number: 42 } }),
  });
  expect(res.status).toBe(401);
  hook.stop();

  server = startWeb(dir, 0);
  const html = await getHtml('/webhooks');

  // La web debe reflejar el rechazo por falta de firma
  expect(html).toContain('Entregas rechazadas (sin firma)');
  expect(html).toContain('1');
  // Invariante de seguridad: ningún cuerpo de petición se guarda ni se publica
  expect(html).not.toContain('opened');
  expect(html).not.toContain('number: 42');
});

test('lista entregas con su resultado (woke, coalesced, ignored_event, ignored_repo) y tamaño', async () => {
  store = new Store(join(dir, 'fabrica.db'));
  const adm = new AdmissionDb(store);
  const t0 = new Date(Date.now() - 15000).toISOString();
  const t1 = new Date(Date.now() - 10000).toISOString();
  const t2 = new Date(Date.now() - 5000).toISOString();
  const t3 = new Date().toISOString();

  adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
    .run('del-woke-1', 'issues', t0, 512, 'woke');
  adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
    .run('del-coal-2', 'issues', t1, 512, 'coalesced');
  adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
    .run('del-ign-3', 'ping', t2, 64, 'ignored_event');
  adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
    .run('del-repo-4', 'issues', t3, 256, 'ignored_repo');

  server = startWeb(dir, 0);
  const html = await getHtml('/webhooks');

  expect(html).toContain('del-woke-1');
  expect(html).toContain('Aceptada (despertó)');
  expect(html).toContain('del-coal-2');
  expect(html).toContain('Coalescida');
  expect(html).toContain('del-ign-3');
  expect(html).toContain('Evento ignorado');
  expect(html).toContain('del-repo-4');
  expect(html).toContain('Repo ignorado');
  expect(html).toContain('512 B');
  expect(html).toContain('64 B');
  expect(html).toContain('256 B');
});

test('muestra el estado del receptor activo si hay lock vivo e inactivo si no hay lock', async () => {
  store = new Store(join(dir, 'fabrica.db'));
  const adm = new AdmissionDb(store);
  server = startWeb(dir, 0);

  const htmlInactivo = await getHtml('/webhooks');
  expect(htmlInactivo).toContain('Inactivo');

  // Simular lock activo del residente (dentro de la ventana TTL de 30s)
  adm.db.query('INSERT INTO adm_lock (id, owner, pid, host, heartbeat_at) VALUES (1, ?, ?, ?, ?)')
    .run('residente-test', process.pid, 'localhost', Date.now());

  const htmlActivo = await getHtml('/webhooks');
  expect(htmlActivo).toContain('Activo');
});

test('un latido de residente mayor a 30s caduca y se muestra como inactivo', async () => {
  store = new Store(join(dir, 'fabrica.db'));
  const adm = new AdmissionDb(store);

  // Latido de hace 45 segundos (vencido respecto al TTL de 30s)
  adm.db.query('INSERT INTO adm_lock (id, owner, pid, host, heartbeat_at) VALUES (1, ?, ?, ?, ?)')
    .run('residente-test', process.pid, 'localhost', Date.now() - 45_000);

  server = startWeb(dir, 0);
  const html = await getHtml('/webhooks');
  expect(html).toContain('Estado del residente');
  expect(html).toContain('Inactivo');
  expect(html).not.toContain('Activo');
});

test('búsqueda por ID, evento o resultado filtra la lista de entregas', async () => {
  store = new Store(join(dir, 'fabrica.db'));
  const adm = new AdmissionDb(store);
  const now = new Date().toISOString();

  adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
    .run('del-uuid-alpha', 'issues', now, 100, 'woke');
  adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
    .run('del-uuid-beta', 'issue_comment', now, 200, 'ignored_repo');

  server = startWeb(dir, 0);

  // Búsqueda por ID exacto o parcial
  const searchId = await getHtml('/webhooks?q=uuid-alpha');
  expect(searchId).toContain('del-uuid-alpha');
  expect(searchId).not.toContain('del-uuid-beta');

  // Búsqueda por evento
  const searchEvent = await getHtml('/webhooks?q=comment');
  expect(searchEvent).toContain('del-uuid-beta');
  expect(searchEvent).not.toContain('del-uuid-alpha');

  // Búsqueda por resultado crudo (woke)
  const searchRawResult = await getHtml('/webhooks?q=woke');
  expect(searchRawResult).toContain('del-uuid-alpha');
  expect(searchRawResult).not.toContain('del-uuid-beta');

  // Búsqueda por resultado formateado o etiqueta
  const searchResult = await getHtml('/webhooks?q=ignored_repo');
  expect(searchResult).toContain('del-uuid-beta');
  expect(searchResult).not.toContain('del-uuid-alpha');

  const searchNone = await getHtml('/webhooks?q=inexistente');
  expect(searchNone).toContain('Ninguna entrega coincide con la búsqueda.');
});

test('escapa el valor del parámetro de búsqueda q en el input del formulario contra XSS', async () => {
  store = new Store(join(dir, 'fabrica.db'));
  new AdmissionDb(store);
  server = startWeb(dir, 0);

  const maliciousQ = '"><script>alert("xss")</script>';
  const html = await getHtml(`/webhooks?q=${encodeURIComponent(maliciousQ)}`);
  expect(html).not.toContain(maliciousQ);
  expect(html).toContain('&quot;&gt;&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
});

test('lista entregas en orden descendente por fecha de recepción', async () => {
  store = new Store(join(dir, 'fabrica.db'));
  const adm = new AdmissionDb(store);
  const tOld = new Date(Date.now() - 60_000).toISOString();
  const tNew = new Date(Date.now()).toISOString();

  adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
    .run('del-first-earlier', 'issues', tOld, 100, 'woke');
  adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
    .run('del-second-later', 'issues', tNew, 100, 'woke');

  server = startWeb(dir, 0);
  const html = await getHtml('/webhooks');
  const posNew = html.indexOf('del-second-later');
  const posOld = html.indexOf('del-first-earlier');
  expect(posNew).toBeGreaterThan(-1);
  expect(posOld).toBeGreaterThan(-1);
  expect(posNew).toBeLessThan(posOld);
});

test('resumen de últimas 24h contabiliza solo entregas dentro de la ventana de 24 horas', async () => {
  store = new Store(join(dir, 'fabrica.db'));
  const adm = new AdmissionDb(store);
  const inside24h = new Date(Date.now() - 3600_000).toISOString();
  const outside24h = new Date(Date.now() - 100_000_000).toISOString();

  adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
    .run('del-recent', 'issues', inside24h, 100, 'woke');
  adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
    .run('del-ancient', 'issues', outside24h, 100, 'ignored_event');

  server = startWeb(dir, 0);
  const html = await getHtml('/webhooks');
  expect(html).toContain('Aceptada (despertó): 1');
  expect(html).not.toContain('Evento ignorado: 1');
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

test('adm_hook_deliveries conserva el check constraint original sin rejected', () => {
  store = new Store(join(dir, 'fabrica.db'));
  const adm = new AdmissionDb(store);
  const now = new Date().toISOString();

  // Insertar un valor permitido funciona
  adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
    .run('del-valid', 'issues', now, 100, 'woke');

  // Insertar 'rejected' debe fallar por CHECK constraint al revertirse el cambio de esquema
  expect(() => {
    adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
      .run('del-invalid', 'issues', now, 100, 'rejected');
  }).toThrow(/CHECK constraint failed/);
});

test('la web no anuncia su propio puerto como url de destino del webhook', async () => {
  store = new Store(join(dir, 'fabrica.db'));
  new AdmissionDb(store);
  server = startWeb(dir, 0);

  const html = await getHtml('/webhooks');
  // No debe anunciar el puerto de la web porque el receptor escucha en --hook-port
  expect(html).not.toContain(`http://127.0.0.1:${server.port}/github`);
  expect(html).toContain('--hook-port');
});

test('secreto de entorno menor a 16 caracteres se reporta como no configurado', async () => {
  store = new Store(join(dir, 'fabrica.db'));
  new AdmissionDb(store);

  // Secreto demasiado corto (15 caracteres)
  process.env.FAB_GITHUB_WEBHOOK_SECRET = '123456789012345';
  server = startWeb(dir, 0);

  const html = await getHtml('/webhooks');
  expect(html).toContain('Secreto en entorno (proceso web)');
  expect(html).toContain('No configurado');
});

test('muestra aviso de total cuando hay mas de 200 entregas registradas', async () => {
  store = new Store(join(dir, 'fabrica.db'));
  const adm = new AdmissionDb(store);
  const now = new Date().toISOString();

  // Insertar 230 entregas
  adm.tx(() => {
    for (let i = 1; i <= 230; i++) {
      adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
        .run(`del-${i.toString().padStart(4, '0')}`, 'issues', now, 100, 'woke');
    }
  });

  server = startWeb(dir, 0);
  const html = await getHtml('/webhooks');
  expect(html).toContain('200 de 230');
});
