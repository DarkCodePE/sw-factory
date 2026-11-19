import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';

let dir: string, store: Store, server: ReturnType<typeof startWeb>, cookie: string, csrf: string, auto: string;
const req = (path: string, init?: RequestInit) => fetch(`http://${server.host ?? "127.0.0.1"}:${server.port}${path}`, { redirect: 'manual', ...init });
const html = async (path: string) => (await req(path, { headers: { cookie } })).text();
const post = (path: string, data: Record<string, string> = {}, headers: Record<string, string> = {}) => req(path, {
  method: 'POST', headers: { cookie, origin: `http://${server.host ?? "127.0.0.1"}:${server.port}`, 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams({ csrf, ...data }),
});
async function login() {
  cookie = (await fetch(server.loginUrl!, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
  csrf = /name="csrf" value="([^"]+)"/.exec(await html('/signals'))![1]!;
}
const counts = () => (['signals', 'changes', 'activities'] as const).map(t => (store.db.query(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n);
beforeEach(() => {
  dir = mkdtempSync('/tmp/fab-web-auto-');
  store = new Store(join(dir, 'fabrica.db'));
  store.setWorkstreamState(store.createWorkstream({ slug: 'prueba', goal: 'g', repo: dir }).id, 'active');
  auto = store.createAutomation({ workstream: 'prueba', name: 'diaria', cron: '30 7 * * *', title: '<script>t</script>', body: 'cuerpo fijo' }).id;
  server = startWeb(dir, 0, { write: true });
});
afterEach(() => { server?.stop(true); store?.close(); rmSync(dir, { recursive: true, force: true }); });

test('lista escapada con horario y estado; no hay formulario de alta', async () => {
  store.createAutomation({ workstream: 'prueba', name: 'otra', cron: '0 * * * *', title: '<img src=x>', body: '<b>b</b>' });
  await login(); const page = await html('/automations');
  expect(page).toContain('30 7 * * *'); expect(page).toContain('Sin ejecutar'); expect(page).toContain('&lt;img src=x&gt;');
  expect(page).not.toContain('<img src=x>'); expect(page).toContain('No lanza trabajo: la señal espera tu triage.');
  expect(page).not.toContain('name="cron"');
  expect((await post('/automations', { name: 'x' })).status).toBe(404);
});
test('sin --write: lista de solo lectura, sin formularios y POST 405', async () => {
  server.stop(true); server = startWeb(dir, 0);
  const page = await (await req('/automations')).text();
  expect(page).toContain('diaria'); expect(page).not.toContain('method="post"');
  expect((await post(`/automations/${auto}/run`)).status).toBe(405);
  expect(counts()[0]).toBe(0);
});
test('sin sesión 401; sin CSRF u Origin 403; nada se escribe', async () => {
  expect((await post(`/automations/${auto}/run`)).status).toBe(401);
  await login();
  expect((await post(`/automations/${auto}/run`, { csrf: 'mal' })).status).toBe(403);
  expect((await post(`/automations/${auto}/run`, {}, { origin: 'http://ajeno.test' })).status).toBe(403);
  expect(counts()).toEqual([0, 0, 0]);
});
test('ejecutar: crea solo una señal new con el texto guardado, ignora title/body, sin change ni activity', async () => {
  await login();
  const r = await post(`/automations/${auto}/run`, { title: 'robado', body: 'robado' });
  expect(r.status).toBe(303); expect(r.headers.get('location')).toBe('/automations');
  expect(counts()).toEqual([1, 0, 0]);
  const [s] = store.listSignals('prueba', 'new');
  expect(s!.title).toContain('<script>t</script>'); expect(s!.body).toBe('cuerpo fijo'); expect(s!.source).toBe(`automation:${auto}`);
  expect(store.listAutomations()[0]!.lastResult).toBe('created');
  expect(await html('/automations')).toContain('Señal creada');
});
test('ejecutar con una señal abierta: saltada, sin duplicar', async () => {
  await login(); await post(`/automations/${auto}/run`); await post(`/automations/${auto}/run`);
  expect(counts()[0]).toBe(1); expect(store.listAutomations()[0]!.lastResult).toBe('skipped_open');
});
test('pausar y activar; id inexistente da aviso not_found sin escribir', async () => {
  await login();
  await post(`/automations/${auto}/disable`); expect(store.listAutomations()[0]!.enabled).toBe(false);
  expect(await html('/automations')).toContain('Activar');
  await post(`/automations/${auto}/enable`); expect(store.listAutomations()[0]!.enabled).toBe(true);
  expect((await post('/automations/nada/run')).status).toBe(303);
  expect(await html('/automations')).toContain('not_found'); expect(counts()).toEqual([0, 0, 0]);
});
test('acciones web con actor web; el módulo no triará ni crea changes (estructural)', async () => {
  await login(); await post(`/automations/${auto}/disable`);
  expect(store.listEvents(store.getWorkstream('prueba').id, 20).some(e => e.actor === 'web' && String(e.message).includes('pausada'))).toBe(true);
  expect(readFileSync('src/web-automations.ts', 'utf8')).not.toMatch(/triageSignal|createChange|insertActivity|addSignal/);
});
test('workstream no activo: el resultado se muestra como saltada y no hay señal', async () => {
  store.setWorkstreamState('prueba', 'paused'); await login();
  await post(`/automations/${auto}/run`);
  expect(counts()[0]).toBe(0); expect(await html('/automations')).toContain('workstream no activo');
});
