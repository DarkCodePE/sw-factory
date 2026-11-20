import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store, StoreError } from '../src/store.ts';
import { ensureWorktree } from '../src/worktrees.ts';
import { AdmissionDb } from '../src/admission/db.ts';
import { ThreadLinks } from '../src/admission/links.ts';
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

// ---- ronda web: T50/T51 H1-H5 ----
test('T51-H1: cancelar con una activity en curso espera su liberación antes de borrar el worktree', async () => {
  await login(); const { path } = await ensureWorktree(repo, dir, change);
  const a = store.listActivities({ changeId: change })[0]!;
  store.db.query("UPDATE activities SET status='in_progress', worker_id='w', lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(a.id);
  expect((await post(`/changes/${change}/cancel`, { confirm: 'yes' })).status).toBe(303);
  expect(store.getActivity(a.id).status).toBe('canceled'); // waitForRelease la liberó antes de borrar
  expect(existsSync(path)).toBe(false);
});
test('T50-H2: triar una señal de canal desde la web une el hilo al change', async () => {
  await login();
  const s = store.addSignal('prueba', 'Del issue', 'cuerpo');
  const adm = new AdmissionDb(store);
  const T = 'github:o/r#7';
  adm.db.query('INSERT INTO adm_threads(id, source, first_seen) VALUES (?,?,?)').run(T, 'github', '2026-01-01T00:00:00Z');
  adm.db.query("INSERT INTO adm_thread_signals(thread_id, signal_id, scope, created_at) VALUES (?,?,?,?)").run(T, s.id, 'propose', '2026-01-01T00:00:00Z');
  expect((await post(`/signals/${s.id}/triage`)).status).toBe(303);
  const c = store.listChanges('prueba').find(x => x.title === 'Del issue')!;
  expect(new ThreadLinks(adm).changeOf(T)).toBe(c.id);
});
test('T50-H3: la web cancela también failed, blocked y quarantined, como fab reject; los finales dan invalid_transition', async () => {
  await login();
  const ws = store.getWorkstream('prueba');
  for (const status of ['failed', 'blocked', 'quarantined']) {
    const c = store.createChange(ws.id, status, 'd');
    store.db.query('UPDATE changes SET status=? WHERE id=?').run(status, c.id);
    expect(await html(`/changes/${c.id}`)).toContain('/cancel');
    expect(await html(`/changes/${c.id}`)).not.toContain('/note"'); // la nota sigue sin ofrecerse en terminales
    expect((await post(`/changes/${c.id}/cancel`, { confirm: 'yes' })).status).toBe(303);
    expect(store.getChange(c.id).status).toBe('canceled');
  }
  for (const status of ['completed', 'declined']) {
    const c = store.createChange(ws.id, status, 'd');
    store.db.query('UPDATE changes SET status=? WHERE id=?').run(status, c.id);
    expect(await html(`/changes/${c.id}`)).not.toContain('/cancel');
    expect(await html((await post(`/changes/${c.id}/cancel`, { confirm: 'yes' })).headers.get('location')!)).toContain('invalid_transition');
    expect(store.getChange(c.id).status as string).toBe(status);
  }
});
test('T50-H4: sin --write la página de señales con una señal pendiente no pinta Triar ni Ignorar', async () => {
  store.addSignal('prueba', 'Pendiente', 'cuerpo');
  server.stop(true); server = startWeb(dir, 0);
  const page = await (await req('/signals')).text();
  expect(page).toContain('Pendiente');
  expect(page).not.toContain('/triage'); expect(page).not.toContain('/ignore'); expect(page).not.toContain('<form');
});
test('T50-H5: cancelar deja el evento «reject solicitado» con actor web', async () => {
  await login();
  await post(`/changes/${change}/cancel`, { confirm: 'yes' });
  expect(events().some(e => e.message === 'reject solicitado' && e.actor === 'web' && e.change_id === change)).toBe(true);
});
