import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';

let dir: string, store: Store, server: ReturnType<typeof startWeb>, change: string, cookie: string, csrf: string;
const req = (path: string, init?: RequestInit) => fetch(`http://${server.host ?? "127.0.0.1"}:${server.port}${path}`, { redirect: 'manual', ...init });
const html = async (path = `/changes/${change}`) => (await req(path, { headers: { cookie } })).text();
async function login() {
  const r = await fetch(server.loginUrl!, { redirect: 'manual' });
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  csrf = /name="csrf" value="([^"]+)"/.exec(await html())?.[1] ?? '';
}
const post = (data: Record<string, string> = {}, headers: Record<string, string> = {}) => req(`/changes/${change}/note`, {
  method: 'POST', headers: { cookie, origin: `http://${server.host ?? "127.0.0.1"}:${server.port}`, 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams({ csrf, ...data }),
});
const notes = () => store.listChangeNotes(change);
beforeEach(async () => {
  dir = mkdtempSync('/tmp/fab-web-notes-'); store = new Store(join(dir, 'fabrica.db'));
  change = store.createChange(store.createWorkstream({ slug: 'p', goal: 'g', repo: '/repo' }).id, 'Change', 'd').id;
  server = startWeb(dir, 0, { write: true }); await login();
});
afterEach(() => { server?.stop(true); store?.close(); rmSync(dir, { recursive: true, force: true }); });

test('A5: sin --write no hay formulario y el POST da 405', async () => {
  server.stop(true); server = startWeb(dir, 0);
  expect((await post()).status).toBe(405);
  expect(await html()).not.toContain('note-body');
  expect(notes()).toHaveLength(0);
});
test('A5: sin sesión 401; CSRF u Origin erróneo 403; ninguna fila', async () => {
  expect((await post({ body: 'x' }, { cookie: '' })).status).toBe(401);
  expect((await post({ body: 'x', csrf: 'mal' })).status).toBe(403);
  expect((await post({ body: 'x' }, { origin: 'http://evil.test' })).status).toBe(403);
  expect(notes()).toHaveLength(0);
});
test('A5: ningún fichero de src/admission/ llama a addChangeNote', () => {
  for (const f of readdirSync(join(import.meta.dir, '../src/admission'), { recursive: true }) as string[]) {
    if (f.endsWith('.ts')) expect(readFileSync(join(import.meta.dir, '../src/admission', f), 'utf8')).not.toContain('addChangeNote');
  }
});
test('nota válida: 303, actor web, pendiente, escapada y sin el cuerpo en el evento (A9)', async () => {
  const r = await post({ body: '<script>alert(1)</script> hola' });
  expect(r.status).toBe(303); expect(r.headers.get('location')).toBe(`/changes/${change}`);
  expect(notes()).toMatchObject([{ body: '<script>alert(1)</script> hola', actor: 'web', deliveredAt: null }]);
  const page = await html();
  expect(page).toContain('Pendiente de entrega'); expect(page).toContain('Acción registrada.');
  expect(page).not.toContain('<script>alert(1)'); expect(page).toContain('&lt;script&gt;');
  const ws = store.getChange(change).workstreamId;
  expect(store.listEvents(ws, 50, change).map(e => e.message).join('\n')).not.toContain('hola');
});
test('la lista distingue Entregada y Pendiente de entrega', async () => {
  store.addChangeNote(change, 'una'); store.addChangeNote(change, 'dos');
  const act = store.listActivities({ changeId: change })[0]!;
  store.reserveNotes(change, act.id, 'att-1'); store.confirmNotes('att-1');
  const page = await html();
  expect(page).toMatch(/Entregada/); expect(page).toMatch(/Entregada/);
  store.addChangeNote(change, 'tres');
  expect(await html()).toContain('Pendiente de entrega');
});
test('A10: cuerpo vacío, de 8193 bytes y nota 21 no crean fila y avisan', async () => {
  expect((await post({ body: '   ' })).status).toBe(303);
  expect(await html()).toContain('invalid_input');
  expect((await post({ body: 'a'.repeat(8193) })).status).toBe(413);
  for (let i = 0; i < 20; i++) store.addChangeNote(change, `n${i}`);
  expect((await post({ body: 'veintiuna' })).status).toBe(303);
  expect(await html()).toContain('limit_reached');
  expect(notes()).toHaveLength(20);
});
test('el formulario no aparece en un change terminal, y el POST no crea fila', async () => {
  expect(await html()).toContain('note-body');
  store.db.query("UPDATE changes SET status='canceled' WHERE id=?").run(change);
  expect(await html()).not.toContain('note-body');
  expect((await post({ body: 'tarde' })).status).toBe(303);
  expect(await html()).toContain('invalid_transition');
  expect(notes()).toHaveLength(0);
});
test('sin sesión el detalle lista las notas pero no muestra formulario', async () => {
  store.addChangeNote(change, 'visible');
  const page = await (await req(`/changes/${change}`)).text();
  expect(page).toContain('visible'); expect(page).not.toContain('note-body');
});
test('doble envío crea dos notas (no idempotente por diseño)', async () => {
  await post({ body: 'igual' }); await post({ body: 'igual' });
  expect(notes()).toHaveLength(2);
});
test('una nota no toca activities', async () => {
  const before = JSON.stringify(store.listActivities({ changeId: change }));
  await post({ body: 'x' });
  expect(JSON.stringify(store.listActivities({ changeId: change }))).toBe(before);
});

test('T56c-H2: un change implemented con una nota pendiente avisa de que puede no entregarse', async () => {
  store.addChangeNote(change, 'pendiente');
  expect(await html()).not.toContain('espera merge');
  store.db.query("UPDATE changes SET status='implemented' WHERE id=?").run(change);
  expect(await html()).toContain('espera merge: puede que no haya más turnos');
});
test('T56c-H3: sin turno previsto lo dice, y el actor de la lista se escapa', async () => {
  store.db.query("UPDATE activities SET status='completed' WHERE change_id=?").run(change);
  expect(await html()).toContain('Ahora no hay ningún turno previsto.');
  store.addChangeNote(change, 'x');
  store.db.query('UPDATE change_notes SET actor = ? WHERE change_id = ?').run('<b>ana</b>', change);
  const page = await html();
  expect(page).toContain('&lt;b&gt;ana&lt;/b&gt;'); expect(page).not.toContain('<b>ana</b>');
});

test('el selector y el aviso de transferencia preceden a guardar, y un runner SSH oculta el selector', async () => {
  const page = await html();
  expect(page).toContain('enctype="multipart/form-data"');
  expect(page).toContain('type="file" name="attachment" accept=".txt,.md,.log,.json,.csv"');
  expect(page).toContain('64 KiB');
  expect(page.indexOf('proveedor del modelo')).toBeLessThan(page.indexOf('Guardar nota'));
  expect(page).toContain('proveedor del modelo');
  const ws = store.getChange(change).workstreamId;
  store.createRunner({ name: 'remoto', kind: 'ssh', target: 'runner-ssh' });
  store.setWorkstreamRunner(ws, 'remoto');
  expect(await html()).toContain('El runner asignado es remoto');
  expect(await html()).not.toContain('name="attachment"');
});

test('la vista escapa el nombre que guarda SQLite y muestra tamaño y estado, sin mostrar contenido', async () => {
  const n = store.addChangeNote(change, 'nota con archivo');
  store.db.query('UPDATE change_notes SET attachment_name = ?, attachment_bytes = ? WHERE id = ?')
    .run('<b>datos</b>.txt', new TextEncoder().encode('CANARIO ARCHIVO PRIVADO'), n.id);
  const page = await html();
  expect(page).toContain('&lt;b&gt;datos&lt;/b&gt;.txt');
  expect(page).toContain('23 bytes');
  expect(page).toContain('Pendiente de entrega');
  expect(page).toContain('turno local confinado');
  expect(page).not.toContain('<b>datos</b>');
  expect(page).not.toContain('CANARIO ARCHIVO PRIVADO');
  store.db.query('UPDATE change_notes SET delivered_at = ? WHERE id = ?').run(store.now(), n.id);
  const delivered = await html();
  expect(delivered).toMatch(/Entregada <time>/);
  expect(delivered).not.toContain('CANARIO ARCHIVO PRIVADO');
});
