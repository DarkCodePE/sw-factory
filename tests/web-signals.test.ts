import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store, StoreError } from '../src/store.ts';
import { ensureWorktree } from '../src/worktrees.ts';
import { startWeb } from '../src/web.ts';

let dir: string, repo: string, store: Store, server: ReturnType<typeof startWeb>, cookie: string, csrf: string, change: string;
const req = (path: string, init?: RequestInit) => fetch(`http://${server.host ?? "127.0.0.1"}:${server.port}${path}`, { redirect: 'manual', ...init });
const html = async (path: string) => (await req(path, { headers: { cookie } })).text();
const field = (page: string, name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(page)?.[1] ?? '';
const git = (cwd: string, ...a: string[]) => { const p = Bun.spawnSync(['git', ...a], { cwd }); if (p.exitCode) throw new Error(p.stderr.toString()); };
const post = (path: string, data: Record<string, string> = {}, headers: Record<string, string> = {}) => req(path, {
  method: 'POST', headers: { cookie, origin: `http://${server.host ?? "127.0.0.1"}:${server.port}`, 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams({ csrf, ...data }),
});
const events = () => store.listEvents(store.getWorkstream('prueba').id, 200);
async function login() {
  cookie = (await fetch(server.loginUrl!, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
  csrf = field(await html('/signals'), 'csrf'); expect(csrf.length).toBe(64);
}
beforeEach(() => {
  dir = mkdtempSync('/tmp/fab-web-signals-'); repo = join(dir, 'repo');
  git(dir, 'init', '-q', '-b', 'main', repo); git(repo, 'config', 'user.name', 't'); git(repo, 'config', 'user.email', 't@t');
  writeFileSync(join(repo, 'a'), 'x'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'i');
  store = new Store(join(dir, 'fabrica.db'));
  const ws = store.createWorkstream({ slug: 'prueba', goal: 'g', repo });
  change = store.createChange(ws.id, 'Change sintético', 'd').id;
  server = startWeb(dir, 0, { write: true });
});
afterEach(() => { server?.stop(true); store?.close(); rmSync(dir, { recursive: true, force: true }); });

test('sin --write los POST de señales, triaje y cambios dan 405 y no hay formularios', async () => {
  server.stop(true); server = startWeb(dir, 0);
  for (const p of ['/signals', '/signals/x/triage', '/signals/x/ignore', `/changes/${change}/cancel`, `/changes/${change}/rename`]) expect((await post(p)).status).toBe(405);
  expect(await html('/signals')).not.toContain('method="post"');
  expect(store.listSignals('prueba').length).toBe(0);
});
test('sin sesión 401; sin CSRF u Origin 403; nada se escribe', async () => {
  expect((await post('/signals', { workstream: 'prueba', title: 't' })).status).toBe(401);
  await login();
  expect((await post('/signals', { workstream: 'prueba', title: 't', csrf: 'mal' })).status).toBe(403);
  expect((await post('/signals', { workstream: 'prueba', title: 't' }, { origin: 'http://ajeno.test' })).status).toBe(403);
  expect(store.listSignals('prueba').length).toBe(0);
});
test('crear: señal new, evento web, sin change ni turno nuevo, texto escapado', async () => {
  await login(); const before = store.listChanges('prueba').length;
  const r = await post('/signals', { workstream: 'prueba', title: '<b>t</b>', body: '<script>x</script>' });
  expect(r.status).toBe(303);
  const [s] = store.listSignals('prueba', 'new'); expect(s!.title).toBe('<b>t</b>');
  expect(store.listChanges('prueba').length).toBe(before);
  expect(events().at(-1)!.actor).toBe('web');
  const page = await html('/signals');
  expect(page).toContain('&lt;b&gt;t&lt;/b&gt;'); expect(page).not.toContain('<b>t</b>'); expect(page).not.toContain('<script>x');
});
test('crear: límites de tamaño y entradas inválidas', async () => {
  await login();
  expect((await post('/signals', { workstream: 'prueba', title: 'x'.repeat(201) })).status).toBe(400);
  expect((await post('/signals', { workstream: 'prueba', title: '  ' })).status).toBe(400);
  expect((await post('/signals', { workstream: 'prueba', title: 't', body: 'x'.repeat(8193) })).status).toBe(413);
  expect((await post('/signals', { workstream: 'prueba', title: 't', body: 'y'.repeat(20000) })).status).toBe(413);
  const bad = await post('/signals', { workstream: 'no-existe', title: 't' });
  expect(await html(bad.headers.get('location')!)).toContain('not_found');
  expect(store.listSignals('prueba').length).toBe(0);
});
test('triar crea el change con actor web y el doble envío da conflict', async () => {
  await login(); await post('/signals', { workstream: 'prueba', title: 'Idea', body: 'cuerpo' });
  const s = store.listSignals('prueba', 'new')[0]!; const n = store.listChanges('prueba').length;
  const r = await post(`/signals/${s.id}/triage`); expect(r.status).toBe(303);
  expect(store.listChanges('prueba').length).toBe(n + 1);
  expect(store.listSignals('prueba')[0]!.status).toBe('triaged');
  expect(events().filter(e => String(e.message).startsWith('change created: Idea')).at(-1)!.actor).toBe('web');
  const dup = await post(`/signals/${s.id}/triage`);
  expect(await html(dup.headers.get('location')!)).toContain('conflict');
  expect(store.listChanges('prueba').length).toBe(n + 1);
});
test('ignorar deja la señal ignored; repetir da conflict', async () => {
  await login(); const s = store.addSignal('prueba', 'x', 'y');
  expect((await post(`/signals/${s.id}/ignore`)).status).toBe(303);
  expect(store.listSignals('prueba')[0]!.status).toBe('ignored');
  expect(events().at(-1)!.actor).toBe('web');
  expect(await html((await post(`/signals/${s.id}/ignore`)).headers.get('location')!)).toContain('conflict');
});
test('cancelar exige confirmación; luego cancela, libera el worktree y deja evento web', async () => {
  await login(); const { path } = await ensureWorktree(repo, dir, change);
  expect(existsSync(path)).toBe(true);
  expect((await post(`/changes/${change}/cancel`)).status).toBe(400);
  expect(store.getChange(change).status).not.toBe('canceled');
  expect(await html(`/changes/${change}`)).toContain('name="confirm"');
  expect((await post(`/changes/${change}/cancel`, { confirm: 'yes' })).status).toBe(303);
  expect(store.getChange(change).status).toBe('canceled'); expect(existsSync(path)).toBe(false);
  expect(events().filter(e => e.change_id === change).every(e => e.actor === 'web' || String(e.message).startsWith('change created'))).toBe(true);
  expect(events().some(e => e.message === 'change canceled' && e.actor === 'web')).toBe(true);
});
test('cancelar un change terminal da invalid_transition sin efecto', async () => {
  await login(); store.closeChange(change, 'canceled'); const n = events().length;
  const r = await post(`/changes/${change}/cancel`, { confirm: 'yes' });
  expect(await html(r.headers.get('location')!)).toContain('invalid_transition');
  expect(events().length).toBe(n);
  expect(await html(`/changes/${change}`)).not.toContain('/cancel');
});
test('renombrar guarda el título anterior en el evento, actor web, escapado y con tope de 200', async () => {
  await login();
  expect((await post(`/changes/${change}/rename`, { title: 'x'.repeat(201) })).status).toBe(400);
  expect((await post(`/changes/${change}/rename`, { title: ' ' })).status).toBe(400);
  expect(store.getChange(change).title).toBe('Change sintético');
  expect((await post(`/changes/${change}/rename`, { title: '<i>Nuevo</i>' })).status).toBe(303);
  expect(store.getChange(change).title).toBe('<i>Nuevo</i>');
  const e = events().at(-1)!; expect(e.actor).toBe('web'); expect(e.message).toContain('Change sintético');
  const page = await html(`/changes/${change}`); expect(page).toContain('&lt;i&gt;Nuevo&lt;/i&gt;'); expect(page).not.toContain('<i>Nuevo');
  expect((await post(`/changes/${change}/rename`, { title: 'y'.repeat(200) })).status).toBe(303);
});
test('Store.renameChange valida y no existe para cambios ajenos', () => {
  expect(() => store.renameChange(change, '')).toThrow(StoreError);
  expect(() => store.renameChange(change, 'x'.repeat(201))).toThrow(StoreError);
  expect(() => store.renameChange('nada', 'x')).toThrow(StoreError);
});
