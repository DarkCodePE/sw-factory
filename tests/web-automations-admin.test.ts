import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { automationRevision, Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';

let dir: string, store: Store, web: ReturnType<typeof startWeb>, ws: string;
let cookie: string, csrf: string;
const base = () => `http://${web.host ?? '127.0.0.1'}:${web.port}`;
const createPath = '/automations/create';
const createFields = () => ({ ws, name: 'diaria', schedule: 'cron', cron: '30 7 * * *', title: 'Resumen', body: 'Texto fijo' });
const mutationPath = (id: string, action: string) => `/automations/${id}/${action}`;
const fetchLocal = (path: string, init?: RequestInit) => fetch(base() + path, { redirect: 'manual', ...init });
const get = (path: string) => fetchLocal(path, { headers: { cookie } });
const post = (path: string, values: Record<string, string> | URLSearchParams, headers: Record<string, string> = {}) =>
  fetchLocal(path, {
    method: 'POST', headers: { cookie, origin: base(), 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: values instanceof URLSearchParams ? values : new URLSearchParams({ csrf, ...values }),
  });
const counts = () => ['signals', 'changes', 'activities'].map(table =>
  store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
const seed = () => store.createAutomation({ workstream: ws, ...createFields() });
const editFields = (id: string) => {
  const { ws: _, ...values } = createFields();
  return { ...values, revision: automationRevision(store.getAutomation(id)), confirm: 'yes' };
};
async function login() {
  cookie = (await fetch(web.loginUrl!, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
  csrf = /name="csrf" value="([^"]+)"/.exec(await (await get('/signals')).text())![1]!;
}

beforeEach(() => {
  dir = mkdtempSync('/tmp/fab-t86-web-');
  store = new Store(join(dir, 'fabrica.db'));
  ws = store.setWorkstreamState(store.createWorkstream({ slug: 'prueba', goal: 'g', repo: dir }).id, 'active').id;
  web = startWeb(dir, 0, { write: true });
  cookie = ''; csrf = '';
});

afterEach(() => {
  web.stop(true);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('editores requieren sesión; alta y edición conservan texto literal, con historial y actor en el borrado', async () => {
  const old = seed();
  expect((await get('/automations/nueva')).status).toBe(401);
  expect((await get(mutationPath(old.id, 'editar'))).status).toBe(401);
  await login();
  const editor = await get('/automations/nueva?ws=prueba');
  expect(editor.status).toBe(200);
  const page = await editor.text();
  expect(page).toContain(`value="${ws}" selected`);
  expect(page).not.toContain('/poll.js');
  expect(page).toContain('/automation-editor.js');
  const body = '</textarea><img src=x>\nTexto con "comillas"';
  const created = await post(createPath, { ...createFields(), name: 'otra', title: '<b>"t"</b>', body });
  expect(created.status).toBe(303);
  expect(created.headers.get('location')).toBe('/automations');
  const automation = store.listAutomations().find(a => a.name === 'otra')!;
  expect(automation).toMatchObject({ createdBy: 'web', body, workstreamId: ws });
  expect(counts()).toEqual([0, 0, 0]);
  const edit = await get(mutationPath(automation.id, 'editar'));
  expect(edit.status).toBe(200);
  expect(edit.headers.get('cache-control')).toContain('no-store');
  expect(await edit.text()).toContain('&lt;/textarea&gt;&lt;img src=x&gt;');
  const values = editFields(automation.id);
  expect((await post(mutationPath(automation.id, 'update'), { ...values, name: 'renombrada', body: body.replace('\n', '\r\n') })).status).toBe(303);
  expect(store.getAutomation(automation.id)).toMatchObject({ body, name: 'renombrada' });
  expect(counts()).toEqual([0, 0, 0]);
  expect((await post(mutationPath(automation.id, 'run'), { title: 'ignorado' })).status).toBe(303);
  const [signal] = store.listSignals(ws);
  expect(signal).toMatchObject({ body, status: 'new', source: `automation:${automation.id}` });
  expect((await post(mutationPath(automation.id, 'delete'), {
    revision: automationRevision(store.getAutomation(automation.id)), confirm: 'yes',
  })).status).toBe(303);
  expect(counts()).toEqual([1, 0, 0]);
  expect(store.listSignals(ws)).toEqual([signal!]);
  const events = store.listEvents(ws, -1).filter(event => event.actor === 'web');
  expect(events.some(event => String(event.message).includes('editada') && String(event.message).includes('"name":"otra"'))).toBe(true);
  expect(events.at(-1)!.message).toContain('"name":"renombrada"');
});

test.each([
  ['hour', ':09', '', '9 * * * *'], ['day', '07:30', '', '30 7 * * *'], ['week', '07:30', '2', '30 7 * * 2'],
])('selecciona el preset %s tanto en alta como en edición', async (schedule, at, weekday, expected) => {
  await login();
  expect((await post(createPath, { ...createFields(), cron: '', schedule, at, weekday })).status).toBe(303);
  const a = store.listAutomations()[0]!;
  expect(a.cron).toBe(expected);
  const edit = mutationPath(a.id, 'update');
  expect((await post(edit, { ...editFields(a.id), cron: '0 9 * * *' })).status).toBe(303);
  expect((await post(edit, { ...editFields(a.id), cron: '', schedule, at, weekday })).status).toBe(303);
  expect(store.getAutomation(a.id).cron).toBe(expected);
  expect(counts()).toEqual([0, 0, 0]);
});

test('cron inválido muestra el campo, escapa lo escrito y deja la fila intacta', async () => {
  const a = seed();
  await login();
  const invalid = { ...editFields(a.id), cron: '<img> 7 * * *', body: '</textarea><script>alert(1)</script>' };
  const res = await post(mutationPath(a.id, 'update'), invalid);
  expect(res.status).toBe(400);
  expect(res.headers.get('referrer-policy')).toBe('same-origin');
  const page = await res.text();
  expect(page).toContain('cron: el campo minuto');
  expect(page).toContain('«&lt;img&gt;»');
  expect(page).toContain('&lt;/textarea&gt;&lt;script&gt;');
  expect(page).not.toContain('<img>');
  expect(page).not.toContain('<script>alert(1)</script>');
  expect(store.getAutomation(a.id)).toEqual(a);
  expect((await post(createPath, { ...createFields(), name: 'otra', cron: '8 '.repeat(129) })).status).toBe(400);
});

test('revisión obsoleta, guardado idéntico, confirmación y fila borrada', async () => {
  const a = seed();
  await login();
  const edit = mutationPath(a.id, 'update'), remove = mutationPath(a.id, 'delete');
  const fields = editFields(a.id);
  const oldEvents = store.listEvents(ws, -1).length;
  expect((await post(edit, fields)).status).toBe(303);
  expect(store.listEvents(ws, -1)).toHaveLength(oldEvents);
  expect((await post(edit, { ...fields, confirm: '' })).status).toBe(400);
  expect((await post(remove, { revision: fields.revision })).status).toBe(400);
  const responses = await Promise.all(['a', 'b'].map(title => post(edit, { ...fields, title })));
  expect(responses.map(r => r.status).sort()).toEqual([303, 409]);
  expect(await responses.find(r => r.status === 409)!.text()).toContain(`href="/automations/${a.id}/editar"`);
  expect(store.listEvents(ws, -1)).toHaveLength(oldEvents + 1);
  expect((await post(remove, { revision: fields.revision, confirm: 'yes' })).status).toBe(409);
  expect((await post(remove, { revision: editFields(a.id).revision, confirm: 'yes' })).status).toBe(303);
  expect((await post(remove, { revision: fields.revision, confirm: 'yes' })).status).toBe(404);
  expect((await get(mutationPath(a.id, 'editar'))).status).toBe(404);
});

test('el servidor rechaza campos repetidos, ausentes, ajenos y destinos en edición', async () => {
  const a = seed();
  await login();
  const edit = mutationPath(a.id, 'update');
  for (const values of [
    { ...createFields(), stage: 'merge' }, { ...createFields(), name: '' }, { ...createFields(), at: '09:30' },
  ]) expect((await post(createPath, values)).status).toBe(400);
  const duplicate = new URLSearchParams({ csrf, ...createFields(), name: 'otra' });
  duplicate.append('name', 'duplicada');
  expect((await post(createPath, duplicate)).status).toBe(400);
  const duplicateCsrf = new URLSearchParams({ csrf, ...createFields(), name: 'otra' });
  duplicateCsrf.append('csrf', csrf);
  expect((await post(createPath, duplicateCsrf)).status).toBe(400);
  expect((await post(edit, { ...editFields(a.id), ws: 'otra' })).status).toBe(400);
  expect((await post(mutationPath(a.id.slice(0, 8), 'update'), editFields(a.id))).status).toBe(404);
  expect(store.listAutomations()).toEqual([a]);
});

test('límite UTF-8 y límite del formulario tras escapes y saltos CRLF', async () => {
  await login();
  expect((await post(createPath, { ...createFields(), body: 'é'.repeat(4097) })).status).toBe(413);
  expect((await post(createPath, { ...createFields(), body: '%'.repeat(60_000) })).status).toBe(413);
  expect((await post(createPath, { ...createFields(), body: 'é'.repeat(4096) })).status).toBe(303);
  expect((await post(createPath, { ...createFields(), name: 'lineas', body: '\r\n'.repeat(8192) })).status).toBe(303);
  expect(store.listAutomations().map(a => a.body.length)).toEqual([4096, 8192]);
});

test('Host, Origin, sesión, CSRF y ambos ámbitos API en las tres mutaciones', async () => {
  const a = seed();
  const read = store.createApiKey('lector', 'read').key;
  const decide = store.createApiKey('editor', 'decide').key;
  await login();
  const attempts = [
    [createPath, { ...createFields(), name: 'otra' }],
    [mutationPath(a.id, 'update'), { ...editFields(a.id), name: 'otra' }],
    [mutationPath(a.id, 'delete'), { confirm: 'yes', revision: editFields(a.id).revision }],
  ] as const;
  for (const [path, values] of attempts) {
    expect((await post(path, values, { host: `localhost:${web.port}` })).status).toBe(403);
    expect((await post(path, values, { origin: 'http://ajeno.test' })).status).toBe(403);
    expect((await post(path, values, { cookie: 'fab_session=alterada' })).status).toBe(401);
    expect((await post(path, { ...values, csrf: 'alterado' })).status).toBe(403);
    for (const key of [read, decide]) {
      const bearer = { authorization: `Bearer ${key}` };
      expect((await post(path, values, { ...bearer, cookie: '' })).status).toBe(401);
      expect((await fetchLocal('/api/v1' + path, {
        method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify(values),
      })).status).toBe(404);
    }
  }
  expect(store.listAutomations()).toEqual([a]);
  expect(counts()).toEqual([0, 0, 0]);
});

test('la lista antigua queda vacía y el GET de solo lectura no crea el esquema', async () => {
  web.stop(true);
  store.db.exec('DROP TABLE automations');
  store.close();
  web = startWeb(dir, 0);
  const path = join(dir, 'fabrica.db'), before = readFileSync(path);
  const page = await get('/automations');
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('No hay automations');
  expect((await post(createPath, createFields())).status).toBe(405);
  expect(readFileSync(path)).toEqual(before);
  store = new Store(path, { readonly: true });
});

test('un cuerpo por bloques que excede el límite se rechaza aunque el texto decodificado quepa', async () => {
  await login();
  const prefix = new URLSearchParams({ csrf, ...createFields(), body: 'b' }).toString();
  const payload = new TextEncoder();
  const response = await fetchLocal(createPath, {
    method: 'POST', headers: { cookie, origin: base(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(payload.encode(prefix));
        controller.enqueue(payload.encode('&'.repeat(57 * 1024)));
        controller.close();
      },
    }),
  });
  expect(response.status).toBe(413);
  expect(store.listAutomations()).toEqual([]);
});
