// T103: secretos y MCP por nombre, nunca por valor.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultProfile, ROLES, saveProfile } from '../src/profile.ts';
import { Store } from '../src/store.ts';
import { ACTIONS } from '../src/web-actions.ts';
import { startWeb } from '../src/web.ts';

let dir: string, store: Store, server: ReturnType<typeof startWeb>, cookie: string, csrf: string, wsId: string;
const base = () => `http://${server.host}:${server.port}`;
const get = (path: string, headers: Record<string, string> = { cookie }) => fetch(base() + path, { redirect: 'manual', headers });
const post = (path: string, data: Record<string, string>, headers: Record<string, string> = {}) => fetch(base() + path, {
  method: 'POST', redirect: 'manual', headers: { cookie, origin: base(), ...headers }, body: new URLSearchParams({ csrf, ...data }),
});
const acceso = (data: Record<string, string>) => post(`/workstreams/${wsId}/acceso`, data);
const SECRET = 'valor-secreto-canario-9f8e7d';
const saved: Record<string, string | undefined> = {};
const env = (k: string, v?: string) => { if (!(k in saved)) saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fab-web-access-'));
  store = new Store(join(dir, 'fabrica.db'));
  wsId = store.createWorkstream({ slug: 'prueba', goal: 'g', repo: join(dir, 'repo') }).id;
  writeFileSync(join(dir, 'mcp-servers.json'), JSON.stringify({ servers: { tracker: { url: 'https://mcp.example.com/sse', headers: {} } } }));
  server = startWeb(dir, 0, { write: true });
  const r = await fetch(server.loginUrl!, { redirect: 'manual' });
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  csrf = /name="csrf" value="([^"]+)"/.exec(await (await get('/config')).text())?.[1] ?? '';
});
afterEach(() => {
  server?.stop(true); store?.close(); rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('la edición no está en la API con clave y exige sesión, origin y CSRF', async () => {
  expect(ACTIONS['workstreams/acceso']!.api).toBe(false);
  expect((await acceso({ kind: 'env', mode: 'declared', names: 'A_B' })).status).toBe(303);
  expect(store.getWorkstream('prueba').envAllow).toEqual(['A_B']);
  expect((await post(`/workstreams/${wsId}/acceso`, { kind: 'env', mode: 'declared', names: 'X' }, { cookie: '' })).status).toBe(401);
  expect((await post(`/workstreams/${wsId}/acceso`, { kind: 'env', mode: 'declared', names: 'X' }, { origin: 'http://evil.test' })).status).toBe(403);
  expect((await post(`/workstreams/${wsId}/acceso`, { kind: 'env', mode: 'declared', names: 'X', csrf: 'a'.repeat(64) })).status).toBe(403);
  expect(store.getWorkstream('prueba').envAllow).toEqual(['A_B']);
});

test('guarda nombres válidos de variables y de MCP y deja un evento de web', async () => {
  expect((await acceso({ kind: 'env', mode: 'declared', names: 'TRACKER_TOKEN\n\nOTRA_VAR\n' })).status).toBe(303);
  expect((await acceso({ kind: 'mcp', mode: 'declared', names: 'tracker' })).status).toBe(303);
  const ws = store.getWorkstream('prueba');
  expect(ws.envAllow).toEqual(['TRACKER_TOKEN', 'OTRA_VAR']);
  expect(ws.mcpAllow).toEqual(['tracker']);
  expect(store.listEvents('prueba', 20).some(e => e.actor === 'web' && String(e.message).includes('mcp_allow'))).toBe(true);
});

test('un valor pegado se rechaza y no se guarda ni se repite en la respuesta', async () => {
  for (const names of [`TOKEN=${SECRET}`, SECRET, `export TOKEN=${SECRET}`, `sk-${SECRET}`, 'A'.repeat(65)]) {
    const r = await acceso({ kind: 'env', mode: 'declared', names });
    expect(r.status).toBe(400);
    const text = await r.text();
    expect(text).not.toContain(SECRET);
    if (/[\s=]/.test(names)) expect(text).toContain('un valor pegado se rechaza'); // la guarda propia, no solo el formato del Store
    expect(store.getWorkstream('prueba').envAllow).toBeNull();
  }
  // Pasa el formato de un nombre de variable pero está prohibido (cargador de librerías).
  expect((await acceso({ kind: 'env', mode: 'declared', names: 'LD_PRELOAD' })).status).toBe(400);
  expect(store.getWorkstream('prueba').envAllow).toBeNull();
});

test('MCP: un nombre fuera del registro se rechaza sin nombrarlo; admite modo anterior', async () => {
  const r = await acceso({ kind: 'mcp', mode: 'declared', names: 'hunter2' });
  expect(r.status).toBe(400);
  const text = await r.text();
  expect(text).toContain('1 nombre(s)');
  expect(text).not.toContain('hunter2');
  expect(store.getWorkstream('prueba').mcpAllow).toBeNull();
  expect((await acceso({ kind: 'mcp', mode: 'declared', names: 'constructor' })).status).toBe(400); // no es un nombre del registro aunque sea propiedad heredada
  await acceso({ kind: 'env', mode: 'declared', names: 'A_B' });
  expect((await acceso({ kind: 'env', mode: 'legacy', names: '' })).status).toBe(303);
  expect(store.getWorkstream('prueba').envAllow).toBeNull();
  expect((await acceso({ kind: 'otro', mode: 'declared', names: '' })).status).toBe(400);
});

test('T103-H3: «modo anterior» con nombres se rechaza en vez de descartarlos en silencio y el selector arranca en Declarado', async () => {
  const r = await acceso({ kind: 'env', mode: 'legacy', names: 'TRACKER_TOKEN' });
  expect(r.status).toBe(400);
  expect(await r.text()).toContain('modo anterior');
  expect(store.getWorkstream('prueba').envAllow).toBeNull();
  const page = await (await get('/config')).text();
  expect(page).toMatch(/<option value="declared" selected>/);
  expect(page).not.toMatch(/<option value="legacy" selected>/);
});

test('límites del Store: demasiados nombres y repetidos se rechazan', async () => {
  const many = Array.from({ length: 17 }, (_, i) => `V${i}`).join('\n');
  expect((await acceso({ kind: 'env', mode: 'declared', names: many })).status).toBe(400);
  expect((await acceso({ kind: 'env', mode: 'declared', names: 'A_B\nA_B' })).status).toBe(400);
  expect(store.getWorkstream('prueba').envAllow).toBeNull();
});

test('la página muestra nombres y roles pero nunca un valor del entorno', async () => {
  env('TRACKER_TOKEN', SECRET);
  store.setWorkstreamEnvAllow(wsId, ['TRACKER_TOKEN']);
  const digest = saveProfile(dir, { ...defaultProfile(), schemaVersion: 2, harness: 'claude', roles: { qa: { env: ['TRACKER_TOKEN', 'FUERA_TOPE'], mcp: ['tracker'] } } }).digest;
  store.assignProfile(wsId, digest, store.getWorkstream('prueba').profile ?? (await import('../src/profile.ts')).DEFAULT_DIGEST);
  const page = await (await get('/config')).text();
  expect(page).toContain('Secretos y MCP del workstream');
  expect(page).toContain('<code>TRACKER_TOKEN</code>');
  expect(page).toContain('FUERA_TOPE</code> <em>(fuera del tope');
  expect(page).not.toContain(SECRET);
  expect(page).toContain('name="names"');
  // Solo lectura: el mismo contenido sin formularios.
  server.stop(true); server = startWeb(dir, 0);
  const ro = await (await fetch(`http://127.0.0.1:${server.port}/config`)).text();
  expect(ro).toContain('<code>TRACKER_TOKEN</code>');
  expect(ro).not.toContain('name="names"');
  expect(ro).not.toContain(SECRET);
  expect((await fetch(`http://127.0.0.1:${server.port}/workstreams/${wsId}/acceso`, { method: 'POST' })).status).toBe(405);
});

test('perfiles: nombres por rol con las mismas validaciones; un valor pegado se rechaza', async () => {
  const rolesForm = (over: Record<string, string> = {}) => ({
    mode: 'roles', model: '', ws: 'prueba', expectedAgent: 'native', base: '',
    ...Object.fromEntries(ROLES.flatMap(role => [[`roles.${role}.harness`, ''], [`roles.${role}.model`, '']])), ...over,
  });
  const { DEFAULT_DIGEST } = await import('../src/profile.ts');
  const send = (over: Record<string, string>) => post('/perfiles/guardar', { ...rolesForm(over), base: DEFAULT_DIGEST });
  for (const bad of [`TOKEN=${SECRET}`, SECRET, 'LD_PRELOAD']) {
    const r = await send({ 'roles.qa.harness': 'claude', 'roles.qa.env': bad });
    expect(r.status).toBe(400);
    const text = await r.text();
    expect(text).not.toContain(SECRET);
    if (bad.includes('=')) expect(text).toContain('un valor pegado se rechaza');
  }
  // T103-H1: un valor en minúsculas o hexadecimal cumple el formato de un nombre MCP; debe estar en el registro, como en el workstream.
  for (const hex of ['0123456789abcdef0123456789abcdef', 'hunter2']) {
    const r = await send({ 'roles.qa.harness': 'claude', 'roles.qa.mcp': hex });
    expect(r.status).toBe(400);
    expect(await r.text()).not.toContain(hex);
  }
  const ok = await send({ 'roles.qa.harness': 'claude', 'roles.qa.env': 'TRACKER_TOKEN, OTRA', 'roles.qa.mcp': 'tracker' });
  expect(ok.status).toBe(303);
  const digest = /digest=([a-f0-9]{64})/.exec(ok.headers.get('location')!)![1]!;
  const { resolveProfile } = await import('../src/profile.ts');
  expect(resolveProfile(dir, digest).profile.roles?.qa).toMatchObject({ env: ['TRACKER_TOKEN', 'OTRA'], mcp: ['tracker'] });
});
