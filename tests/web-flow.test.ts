import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';

let dir: string, server: ReturnType<typeof startWeb> | undefined;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fab-web-flow-')); });
afterEach(() => { server?.stop(true); server = undefined; rmSync(dir, { recursive: true, force: true }); });
function seed(opts: Record<string, unknown>, titles: string[] = []) {
  const store = new Store(join(dir, 'fabrica.db'));
  try {
    const ws = store.createWorkstream({ slug: 'demo', goal: 'g', repo: '/synthetic', agent: 'fake', ...opts });
    store.setWorkstreamState(ws.id, 'active');
    for (const t of titles) store.createChange(ws.id, t, '');
    store.addSignal(ws.id, '<img src=x onerror=alert(1)>', 'cuerpo');
  } finally { store.close(); }
}
const get = async (path: string) => { server ??= startWeb(dir, 0); return fetch(`http://${server.host ?? "127.0.0.1"}:${server.port}${path}`); };

test('puerta de spec abierta con --no-spec-approval: se dibuja y se avisa', async () => {
  seed({ requireApproval: false });
  const html = await (await get('/flujo?ws=demo')).text();
  expect(html).toContain('fl-open');
  expect(html).toContain('Sin revisión humana');
  expect(html).toContain('Abierta: sin revisión humana');
});

test('con la puerta cerrada no se anuncia como abierta', async () => {
  seed({});
  const html = await (await get('/flujo?ws=demo')).text();
  expect(html).not.toContain('Sin revisión humana');
  expect(html).toContain('Cerrada: requiere revisión');
});

test('hay tabla equivalente con una fila por nodo presente, recuentos reales y sin style= ni Blueprint', async () => {
  seed({ verify: ['true'] }, ['a', 'b']);
  const html = await (await get('/flujo?ws=demo')).text();
  const main = html.slice(html.indexOf('<main'));
  const nodes = (main.match(/class="fl-node/g) ?? []).length;
  const rows = (main.match(/<tbody>[\s\S]*?<\/tbody>/)![0].match(/<tr>/g) ?? []).length;
  expect(rows).toBe(nodes); expect(rows).toBe(10);
  expect(main).toContain('role="img"');
  expect(main).toContain('2 changes'); // los dos changes esperan en la revisión del change
  expect(main).toContain('1 nuevas'); // una señal nueva
  expect(html).not.toMatch(/\sstyle=|<style/i);
  expect(html).not.toMatch(/blueprint/i);
});

test('sin verify el nodo gates no está presente', async () => {
  seed({});
  const html = await (await get('/flujo?ws=demo')).text();
  expect(html).not.toContain('>Gates<');
});

test('texto de terceros no llega al HTML sin escapar y un ws desconocido da 404', async () => {
  seed({});
  const html = await (await get('/flujo?ws=demo')).text();
  expect(html).not.toContain('<img src=x');
  expect((await get('/flujo?ws=no-existe')).status).toBe(404);
});

test('es solo lectura: la base y el directorio no cambian y POST no se acepta', async () => {
  seed({});
  const files = readdirSync(dir).sort(), db = readFileSync(join(dir, 'fabrica.db'));
  server = startWeb(dir, 0, { write: true });
  const res = await fetch(`http://${server.host ?? "127.0.0.1"}:${server.port}/flujo?ws=demo`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('Flujo');
  const post = await fetch(`http://${server.host ?? "127.0.0.1"}:${server.port}/flujo?ws=demo`, { method: 'POST', body: 'x' });
  expect(post.status).toBe(405);
  expect(readdirSync(dir).sort()).toEqual(files);
  expect(readFileSync(join(dir, 'fabrica.db')).equals(db)).toBe(true);
});

test('sin ws y con un único workstream muestra su flujo; con varios, un selector', async () => {
  seed({});
  expect(await (await get('/flujo')).text()).toContain('Flujo · demo');
  const store = new Store(join(dir, 'fabrica.db')); store.createWorkstream({ slug: 'otro', goal: 'g', repo: '/synthetic' }); store.close();
  const html = await (await get('/flujo')).text();
  expect(html).toContain('Elige un workstream');
});

test('T53-H1/H2: la tabla cuenta changes reales y cada nodo enlaza a los changes que cuenta', async () => {
  seed({ verify: ['true'] }, ['uno', 'dos']);
  const store = new Store(join(dir, 'fabrica.db'));
  const ids = store.listChanges('demo').map(c => c.id);
  store.db.query('DELETE FROM activities WHERE change_id = ?').run(ids[0]!);
  store.db.query("UPDATE changes SET status='declined' WHERE id = ?").run(ids[0]!); // «Hecho: 1» con un declined
  store.close();
  const html = await (await get('/flujo?ws=demo')).text();
  expect(html).toMatch(/<th scope="row">Revisión del change<\/th>[^]*?<td>1<\/td><\/tr>/); // recuento distinto de cero en la tabla
  expect(html).toContain('href="/changes?ws=demo&amp;stage=done"');
  expect(html).toContain('href="/signals"');
  const done = await (await get('/changes?ws=demo&stage=done')).text();
  expect(done).toContain('uno'); expect(done).not.toContain('>dos<');
  expect(done).toContain('1 changes');
  const rest = await (await get('/changes?ws=demo&stage=change_review')).text();
  expect(rest).toContain('dos'); expect(rest).not.toContain('>uno<');
});
