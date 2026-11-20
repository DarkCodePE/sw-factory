import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defaultProfile, DEFAULT_DIGEST, listProfiles, saveProfile } from '../src/profile.ts';
import { Store, StoreError } from '../src/store.ts';
import { startWeb } from '../src/web.ts';

let dir: string, store: Store, server: ReturnType<typeof startWeb>, cookie: string, csrf: string, wsId: string;
const base = () => `http://${server.host ?? "127.0.0.1"}:${server.port}`;
const req = (path: string, init?: RequestInit) => fetch(base() + path, { redirect: 'manual', ...init });
const html = async (path: string) => (await req(path, { headers: { cookie } })).text();
async function login() {
  const r = await fetch(server.loginUrl!, { redirect: 'manual' });
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  csrf = /name="csrf" value="([^"]+)"/.exec(await html('/perfiles'))![1]!;
}
const post = (path: string, data: Record<string, string>, extra: Record<string, string> = {}) => req(path, {
  method: 'POST', headers: { cookie, origin: base(), 'content-type': 'application/x-www-form-urlencoded', ...extra },
  body: new URLSearchParams({ csrf, ws: 'prueba', ...data }),
});
const tpl = (over: Record<string, string> = {}) => {
  const p = defaultProfile(); const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.worker)) o[`worker.${k}`] = v;
  for (const [k, v] of Object.entries(p.validators)) o[`validators.${k}`] = v;
  return { ...o, ...over };
};
const edited = () => tpl({ 'worker.investigate': defaultProfile().worker.investigate + '\nExtra de prueba.' });
const digestOf = (r: Response) => /digest=([0-9a-f]{64})/.exec(r.headers.get('location')!)![1]!;
const snapshot = () => listProfiles(dir).map(d => [d, readFileSync(join(dir, 'profiles', `${d}.json`), 'utf8'), statSync(join(dir, 'profiles', `${d}.json`)).mtimeMs]);

beforeEach(() => {
  dir = mkdtempSync('/tmp/fab-web-profile-'); store = new Store(join(dir, 'fabrica.db'));
  wsId = store.createWorkstream({ slug: 'prueba', goal: 'g', repo: '/repo' }).id;
  server = startWeb(dir, 0, { write: true }); cookie = ''; csrf = '';
});
afterEach(() => { server?.stop(true); store?.close(); rmSync(dir, { recursive: true, force: true }); });

test('Store.assignProfile deja evento con digest anterior y nuevo, y rechaza lo obsoleto o desconocido', () => {
  const { digest } = saveProfile(dir, JSON.parse(JSON.stringify({ ...defaultProfile(), model: undefined, worker: { ...defaultProfile().worker, investigate: 'x STATUS:' } })));
  store.assignProfile('prueba', digest, DEFAULT_DIGEST);
  expect(store.getWorkstream('prueba').profile).toBe(digest);
  expect(JSON.stringify(store.listEvents('prueba', 10))).toContain(`${DEFAULT_DIGEST} → ${digest}`);
  expect(() => store.assignProfile('prueba', digest, DEFAULT_DIGEST)).toThrow(StoreError);
  expect(() => store.assignProfile('prueba', 'a'.repeat(64), digest)).toThrow(/invalid_input|desconocido/);
  store.assignProfile('prueba', DEFAULT_DIGEST, digest);
  expect(store.getWorkstream('prueba').profile).toBeNull();
});

test('sin sesión o sin --write no hay formularios ni POST', async () => {
  expect(await html('/perfiles')).not.toContain('<form action="/perfiles/guardar"');
  expect((await post('/perfiles/guardar', tpl())).status).toBe(401);
  server.stop(true); server = startWeb(dir, 0);
  expect(await (await req('/perfiles')).text()).not.toContain('<textarea');
  expect((await post('/perfiles/guardar', tpl())).status).toBe(405);
});

test('guardar crea un perfil nuevo sin tocar el vigente ni los ficheros; dos guardados dan el mismo digest', async () => {
  await login();
  const before = snapshot();
  const r1 = await post('/perfiles/guardar', edited());
  expect(r1.status).toBe(303); expect(r1.headers.get('location')).toContain('nuevo=1');
  const d = digestOf(r1);
  expect(d).not.toBe(DEFAULT_DIGEST);
  expect(snapshot().slice(0, before.length)).toEqual(before.length ? before : []);
  expect(store.getWorkstream('prueba').profile).toBeNull();
  const r2 = await post('/perfiles/guardar', edited());
  expect(digestOf(r2)).toBe(d); expect(r2.headers.get('location')).toContain('nuevo=0');
  expect(readdirSync(join(dir, 'profiles')).filter(f => f.endsWith('.json')).length).toBe(1);
});

test('CRLF del navegador no cambia el digest de una plantilla sin editar', async () => {
  await login();
  const crlf = Object.fromEntries(Object.entries(tpl()).map(([k, v]) => [k, v.replace(/\n/g, '\r\n')]));
  expect(digestOf(await post('/perfiles/guardar', crlf))).toBe(DEFAULT_DIGEST);
});

test('plantilla de más de 32 KiB se rechaza; una de 20 KiB entra', async () => {
  await login();
  const big = await post('/perfiles/guardar', tpl({ 'worker.investigate': 'a'.repeat(32 * 1024 + 1) }));
  expect(big.status).toBe(400); expect(listProfiles(dir)).toEqual([]);
  const ok = await post('/perfiles/guardar', tpl({ 'worker.investigate': 'a'.repeat(20 * 1024) }));
  expect(ok.status).toBe(303);
});

test('perfil sin STATUS: se rechaza con el campo; CSRF y origen se exigen', async () => {
  await login();
  const r = await post('/perfiles/guardar', tpl({ 'worker.rules': 'sin marca' }));
  expect([r.status, await r.text()]).toEqual([400, expect.stringContaining('worker.rules')]);
  expect((await post('/perfiles/guardar', { ...edited(), csrf: 'x' })).status).toBe(403);
  expect((await post('/perfiles/guardar', edited(), { origin: 'http://evil.test' })).status).toBe(403);
});

test('asignar exige confirmación y deja el digest anterior en el evento; las activities en curso conservan el suyo', async () => {
  await login();
  const ch = store.createChange(wsId, 'c', 'd'); const a = store.listActivities({ changeId: ch.id })[0]!;
  store.setActivityProvenance(a.id, DEFAULT_DIGEST, null);
  const d = digestOf(await post('/perfiles/guardar', edited()));
  expect((await post('/perfiles/asignar', { digest: d, previous: DEFAULT_DIGEST })).status).toBe(400);
  expect(store.getWorkstream('prueba').profile).toBeNull(); // sin confirm no cambia
  expect((await post('/perfiles/asignar', { digest: d, previous: DEFAULT_DIGEST, confirm: 'yes' })).status).toBe(303);
  expect(store.getWorkstream('prueba').profile).toBe(d);
  expect(JSON.stringify(store.listEvents('prueba', 10))).toContain(`${DEFAULT_DIGEST} → ${d}`);
  expect(store.getActivity(a.id).profileDigest).toBe(DEFAULT_DIGEST);
  // obsoleto: el digest anterior ya no es el vigente
  await post('/perfiles/asignar', { digest: DEFAULT_DIGEST, previous: DEFAULT_DIGEST, confirm: 'yes' });
  expect(store.getWorkstream('prueba').profile).toBe(d);
});

test('restaurar valores por defecto asigna DEFAULT_DIGEST', async () => {
  await login();
  const d = digestOf(await post('/perfiles/guardar', edited()));
  await post('/perfiles/asignar', { digest: d, previous: DEFAULT_DIGEST, confirm: 'yes' });
  await post('/perfiles/asignar', { digest: DEFAULT_DIGEST, previous: d, confirm: 'yes' });
  expect(store.getWorkstream('prueba').profile).toBeNull();
});

test('no edita flags de aprobación ni muestra secretos', async () => {
  await login();
  const before = store.getWorkstream('prueba');
  await post('/perfiles/guardar', { ...edited(), require_approval: '0', requireChangeApproval: '0' });
  const after = store.getWorkstream('prueba');
  expect([after.requireApproval, after.requireChangeApproval]).toEqual([before.requireApproval, before.requireChangeApproval]);
  const page = await html('/perfiles');
  expect(page).not.toMatch(/name="(require|approval)/i);
  const secret = 'ghp_' + 'A1b2C3d4E5'.repeat(4);
  const d = digestOf(await post('/perfiles/guardar', tpl({ 'worker.investigate': defaultProfile().worker.investigate + `\n${secret}` })));
  await post('/perfiles/asignar', { digest: d, previous: DEFAULT_DIGEST, confirm: 'yes' });
  expect(await html('/perfiles')).not.toContain(secret);
});

// ---- ronda web: T58 H1-H3 ----
test('T58-H1: asignar deja el evento con actor web y no cambia FAB_ACTOR', async () => {
  await login();
  const previous = process.env.FAB_ACTOR;
  const d = digestOf(await post('/perfiles/guardar', edited()));
  await post('/perfiles/asignar', { digest: d, previous: DEFAULT_DIGEST, confirm: 'yes' });
  const e = store.listEvents('prueba', 10).find(x => String(x.message).includes('perfil asignado'));
  expect(e?.actor).toBe('web');
  expect(process.env.FAB_ACTOR).toBe(previous);
});

test('T58-H2: con el perfil asignado roto la página ofrece restaurar los valores por defecto', async () => {
  await login();
  const d = digestOf(await post('/perfiles/guardar', edited()));
  await post('/perfiles/asignar', { digest: d, previous: DEFAULT_DIGEST, confirm: 'yes' });
  rmSync(join(dir, 'profiles', `${d}.json`)); // perfil asignado que ya no existe
  const page = await html('/perfiles');
  expect(page).toContain('no está disponible');
  expect(page).toContain('Restaurar valores por defecto');
  expect(page).toContain(`name="previous" value="${d}"`);
  expect((await post('/perfiles/asignar', { digest: DEFAULT_DIGEST, previous: d, confirm: 'yes' })).status).toBe(303);
  expect(store.getWorkstream('prueba').profile).toBeNull();
  expect(await html('/perfiles')).not.toContain('no está disponible');
});

test('T58-H3: guardar parte del perfil asignado (conserva su modelo), avisa del texto enmascarado y solo acepta digests', async () => {
  await login();
  const base0 = JSON.parse(JSON.stringify(defaultProfile())); base0.harness = 'claude'; base0.model = 'claude-sonnet-5-5';
  const { digest } = saveProfile(dir, base0);
  store.assignProfile('prueba', digest, DEFAULT_DIGEST);
  const r = await post('/perfiles/guardar', edited());
  const nuevo = JSON.parse(readFileSync(join(dir, 'profiles', `${digestOf(r)}.json`), 'utf8'));
  expect(nuevo.model).toBe('claude-sonnet-5-5'); expect(nuevo.harness).toBe('claude');
  // texto con aspecto de secreto: la página avisa de que se ocultó
  const secret = 'ghp_' + 'A1b2C3d4E5'.repeat(4);
  const conSecreto = JSON.parse(JSON.stringify(base0)); conSecreto.worker.investigate += `\n${secret}`;
  const s = saveProfile(dir, conSecreto).digest;
  store.assignProfile('prueba', s, digest);
  expect(await html('/perfiles')).toContain('Se ocultó texto con aspecto de secreto');
  // ?digest= que no es un digest no se carga
  expect(await html('/perfiles?digest=../../etc/passwd')).not.toContain('Perfil guardado');
});
