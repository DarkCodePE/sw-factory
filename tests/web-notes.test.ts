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
let repo: string;
beforeEach(async () => {
  dir = mkdtempSync('/tmp/fab-web-notes-'); store = new Store(join(dir, 'fabrica.db'));
  // Un repo real y ajeno al estado: la comprobación de adjuntos consulta sus worktrees.
  repo = mkdtempSync('/tmp/fab-web-notes-repo-'); Bun.spawnSync(['git', 'init', '-q', repo]);
  change = store.createChange(store.createWorkstream({ slug: 'p', goal: 'g', repo }).id, 'Change', 'd').id;
  server = startWeb(dir, 0, { write: true }); await login();
});
afterEach(() => { server?.stop(true); store?.close(); rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); });

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

// T96d: recepción multipart acotada.
const origin = () => `http://${server.host ?? '127.0.0.1'}:${server.port}`;
type Part = { name: string; value: string | Uint8Array; filename?: string; type?: string };
function multipart(parts: Part[]): { body: Uint8Array<ArrayBuffer>; type: string } {
  const b = 'XBOUNDARYT96', enc = new TextEncoder(), out: Uint8Array[] = [];
  for (const p of parts) {
    out.push(enc.encode(`--${b}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename !== undefined ? `; filename="${p.filename}"` : ''}\r\n${p.type ? `Content-Type: ${p.type}\r\n` : ''}\r\n`));
    out.push(typeof p.value === 'string' ? enc.encode(p.value) : p.value, enc.encode('\r\n'));
  }
  out.push(enc.encode(`--${b}--\r\n`));
  return { body: new Uint8Array(Buffer.concat(out)), type: `multipart/form-data; boundary=${b}` };
}
const upload = (parts: Part[], headers: Record<string, string> = {}, chunked = false) => {
  const { body, type } = multipart(parts);
  const payload = chunked ? new ReadableStream({ start(c) { c.enqueue(body); c.close(); } }) : new Blob([body]);
  return req(`/changes/${change}/note`, { method: 'POST', headers: { cookie, origin: origin(), 'content-type': type, ...headers }, body: payload, ...(chunked ? { duplex: 'half' } : {}) } as RequestInit);
};
const file = (name = 'datos.txt', value: string | Uint8Array = 'contenido de consulta'): Part => ({ name: 'attachment', value, filename: name, type: 'text/plain' });
const base = (): Part[] => [{ name: 'csrf', value: csrf }, { name: 'body', value: 'con archivo' }];

test('T96d: multipart válido guarda nota y adjunto; el evento y la página no llevan bytes ni nombre crudo', async () => {
  const r = await upload([...base(), file()]);
  expect(r.status).toBe(303); expect(r.headers.get('location')).toBe(`/changes/${change}`);
  expect(notes()).toMatchObject([{ body: 'con archivo', attachment: { name: 'datos.txt', size: 21 } }]);
  const events = store.db.query('SELECT message FROM events').all().map((e: any) => e.message).join('\n');
  expect(events).not.toContain('datos.txt'); expect(events).not.toContain('contenido de consulta');
  expect(await html()).not.toContain('contenido de consulta');
});

test('T96d: parte de archivo vacía sin nombre (sin elegir) guarda solo la nota; también sin Content-Length', async () => {
  expect((await upload([...base(), { name: 'attachment', value: '', filename: '' }])).status).toBe(303);
  expect(notes()).toMatchObject([{ body: 'con archivo' }]); expect(notes()[0]!.attachment).toBeUndefined();
  expect((await upload([...base(), file()], {}, true)).status).toBe(303);
  expect(notes()).toHaveLength(2);
});

test('T96d: formulario urlencoded antiguo sigue funcionando', async () => {
  expect((await post({ body: 'antigua' })).status).toBe(303);
  expect(notes()).toMatchObject([{ body: 'antigua' }]);
});

test('T96d: nombres hostiles, extensión, binario, UTF-8 roto y exceso se rechazan sin escribir', async () => {
  const bad: Part[] = [
    file('../datos.txt'), file('a/datos.txt'), file('/etc/datos.txt'), file('datos.exe'), file('datos'), file('datos.txt '),
    file('datos.txt', new Uint8Array([0x61, 0, 0x62])), file('datos.txt', new Uint8Array([0xff, 0xfe, 0xfd])),
    file('datos.txt', 'a'.repeat(65_537)), file('datos.txt', ''),
  ];
  for (const f of bad) { const status = (await upload([...base(), f])).status; expect([f.filename, f.value.length, status === 413 ? 400 : status]).toEqual([f.filename, f.value.length, 400]); }
  expect(notes()).toHaveLength(0);
});

test('T96d: partes desconocidas, repetidas o con archivo donde va texto se rechazan', async () => {
  for (const extra of [[{ name: 'otro', value: 'x' }], [file(), file('dos.txt')], [{ name: 'body', value: 'otra' }, file()],
    [{ name: 'attachment', value: 'texto sin archivo' }], [{ name: 'path', value: '/etc/passwd' }, file()]] as Part[][]) {
    expect((await upload([...base(), ...extra])).status).toBe(400);
  }
  expect((await upload([{ name: 'csrf', value: csrf }, { name: 'body', value: 'x', filename: 'b.txt' }, file()])).status).toBe(400);
  expect(notes()).toHaveLength(0);
});

test('T96d: el tope de 80 KiB vale con y sin Content-Length y no escribe nada', async () => {
  const big = file('datos.txt', 'a'.repeat(90_000));
  expect((await upload([...base(), big])).status).toBe(413);
  expect((await upload([...base(), big], {}, true)).status).toBe(413);
  expect(notes()).toHaveLength(0);
});

test('T96d: sin sesión 401, Origin o CSRF erróneos 403 y ninguna fila', async () => {
  expect((await upload([...base(), file()], { cookie: '' })).status).toBe(401);
  expect((await upload([...base(), file()], { origin: 'http://evil.test' })).status).toBe(403);
  expect((await upload([{ name: 'csrf', value: 'mal' }, { name: 'body', value: 'x' }, file()])).status).toBe(403);
  expect(notes()).toHaveLength(0);
});

test('T96d: multipart solo se admite en la nota; otras acciones dan 415', async () => {
  const { body, type } = multipart([{ name: 'csrf', value: csrf }, { name: 'confirm', value: 'yes' }]);
  const r = await req(`/changes/${change}/cancel`, { method: 'POST', headers: { cookie, origin: origin(), 'content-type': type }, body: new Blob([body]) });
  expect(r.status).toBe(415);
  expect(store.getChange(change).status).not.toBe('canceled');
});

test('T96d: la API con clave rechaza multipart y el campo attachment', async () => {
  const key = store.createApiKey('agente', 'decide').key;
  const api = (body: BodyInit, type: string) => req(`/api/v1/changes/${change}/note`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': type }, body });
  const { body, type } = multipart([...base(), file()]);
  expect((await api(new Blob([body]), type)).status).toBe(415);
  expect((await api(JSON.stringify({ body: 'x', attachment: 'datos.txt' }), 'application/json')).status).toBe(400);
  expect(notes()).toHaveLength(0);
});

test('T96-H1/H3: un estado no privado se avisa antes de guardar y el rechazo nombra la causa y el remedio', async () => {
  const { chmodSync } = await import('node:fs');
  chmodSync(dir, 0o755);
  const page = await html();
  expect(page).toContain('chmod 700'); expect(page).not.toContain('name="attachment"');
  expect((await upload([...base(), file()])).status).toBe(303);
  expect(notes()).toHaveLength(0);
  expect(await html()).toContain('chmod 700');
  chmodSync(dir, 0o700);
  expect((await upload([...base(), file()])).status).toBe(303);
  expect(notes()).toHaveLength(1);
});

test('T96-H3: un runner remoto rechaza la carga con su motivo, sin código genérico', async () => {
  store.createRunner({ name: 'remoto', kind: 'ssh', target: 'runner-ssh' });
  store.setWorkstreamRunner(store.getChange(change).workstreamId, 'remoto');
  expect((await upload([...base(), file()])).status).toBe(303);
  expect(notes()).toHaveLength(0);
  const page = await html();
  expect(page).toContain('El runner asignado es remoto.'); expect(page).not.toContain('revisa los datos de la acción');
});

test('T96-H4: un estado no apto se rechaza sin tocar la base ni su WAL', async () => {
  const { chmodSync, watch } = await import('node:fs');
  chmodSync(dir, 0o755);
  const touched: string[] = [];
  const watcher = watch(dir, (_event, name) => { if (name) touched.push(String(name)); });
  try {
    expect((await upload([...base(), file()])).status).toBe(303);
    await Bun.sleep(100);
  } finally { watcher.close(); }
  expect(touched).toEqual([]);
  expect(notes()).toHaveLength(0);
});

test('T96-H5: el texto de la nota que imita una cabecera de archivo no se confunde con un archivo vacío', async () => {
  const mimic = 'x\r\n\r\nContent-Disposition: form-data; name="attachment"; filename="x.txt"\r\n\r\n';
  const r = await upload([{ name: 'csrf', value: csrf }, { name: 'body', value: mimic }, { name: 'attachment', value: '', filename: '' }]);
  expect(r.status).toBe(303);
  expect(notes()).toHaveLength(1);
  expect(notes()[0]!.attachment).toBeUndefined();
  expect((await upload([...base(), { name: 'attachment', value: '', filename: 'vacio.txt' }])).status).toBe(400);
});

test('T96-H10: el aviso de ancestro con su ruta se muestra escapado y una ruta con marcado se descarta', async () => {
  const { actionNotice } = await import('../src/web-actions.ts');
  const { NOTE_ATTACHMENT_STATE, ANCESTOR_PATH_PREFIX } = await import('../src/note-attachments.ts');
  const ok = actionNotice(`${NOTE_ATTACHMENT_STATE.ancestor}${ANCESTOR_PATH_PREFIX}/home/dueño-x/estado`.replace('dueño-x', 'dueno'));
  expect(ok).toContain('Directorio: /home/dueno/estado');
  expect(actionNotice(`${NOTE_ATTACHMENT_STATE.ancestor}${ANCESTOR_PATH_PREFIX}/tmp/<img src=x onerror=alert(1)>`)).toBe('');
  expect(actionNotice(`${NOTE_ATTACHMENT_STATE.ancestor} Otra cosa: /tmp`)).toBe('');
});
