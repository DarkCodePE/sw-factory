// T119c: cliente de la CLI remota (`fab --remote`): alias, pareo, sesión privada, verbos tipados y sin salidas por redirección.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliRoutes, REMOTE_ACTION_OPS, REMOTE_IDENTITY_OPS } from '../src/web-cli.ts';
import { parseVerb, remoteMain, VERBS } from '../src/remote.ts';
import { csrfToken, SESSION_COOKIE } from '../src/web-auth.ts';
import { cloud, ORIGIN, SECRET, type Cloud } from './helpers/cloud.ts';
import type { Role } from '../src/users.ts';

let c: Cloud;
let routes: ReturnType<typeof cliRoutes>;
let client: string;
let out: string[], errs: string[];
let seen: { url: string; body: string; auth: string | null }[];
let ws: { id: string; slug: string };
let changeId: string;
const HOST = 'fab.example.test';

beforeEach(() => {
  c = cloud();
  routes = cliRoutes({ stateDir: c.stateDir, publicOrigin: ORIGIN, write: true, secret: SECRET });
  client = join(c.dir, 'cliente');
  mkdirSync(client, { mode: 0o700 });
  out = []; errs = []; seen = [];
  const repo = join(c.dir, 'repo'); mkdirSync(join(repo, '.git'), { recursive: true });
  ws = c.store.createWorkstream({ slug: 'nube', goal: 'g', repo, requireChangeApproval: false });
  changeId = c.store.createChange(ws.id, 'cambio', 'd').id;
});
afterEach(() => c.close());

/** `fetch` que entra directo en las rutas del servidor y anota lo enviado (sin red). */
const fakeFetch = (async (url: string, init: RequestInit) => {
  const headers = new Headers(init.headers); headers.set('host', HOST);
  expect(init.redirect).toBe('manual'); // una redirección con credenciales nunca se sigue
  seen.push({ url, body: String(init.body ?? ''), auth: headers.get('authorization') });
  return (await routes.handle(new Request(url, { ...init, headers }), '203.0.113.9')) ?? new Response('no', { status: 404 });
}) as unknown as typeof fetch;

const deps = (extra: Partial<Parameters<typeof remoteMain>[1]> = {}) => ({ stateDir: client, fetch: fakeFetch, out: (s: string) => out.push(s), err: (s: string) => errs.push(s), sleep: async () => {}, ...extra });
const run = (...argv: string[]) => remoteMain(argv, deps());

/** La persona aprueba el pareo cuando la terminal enseña el código. */
async function approveWhenShown(role: Role) {
  const p = c.web[role], csrf = csrfToken(SECRET, p.sessionId!);
  const post = (code: string, extra: Record<string, string>) => routes.handle(new Request(`${ORIGIN}/cuenta/cli/autorizar`, { method: 'POST', body: new URLSearchParams({ csrf, code, ...extra }),
    headers: { host: HOST, origin: ORIGIN, cookie: `${SESSION_COOKIE}=${c.tokens.web[role]}`, 'content-type': 'application/x-www-form-urlencoded' } }), '198.51.100.5');
  return async () => { const code = /código ([A-Z0-9-]{9})/.exec(out.join('\n'))![1]!; await post(code, {}); await post(code, { confirm: 'yes' }); };
}
async function login(role: Role = 'member'): Promise<void> {
  expect(await run('remote', 'add', 'prod', ORIGIN)).toBe(0);
  const approve = await approveWhenShown(role);
  let polls = 0;
  const code = await remoteMain(['prod', 'login'], deps({
    sleep: async () => { if (polls++ === 0) await approve(); },
  }));
  expect(code).toBe(0);
}

test('alias: solo https://<host> canónico; un alias desconocido no se resuelve ni llama a la red', async () => {
  expect(await run('remote', 'add', 'x', 'http://evil.example')).toBe(1);
  expect(await run('remote', 'add', 'x', 'https://fab.example.test/ruta')).toBe(1);
  expect(await run('remote', 'add', 'x', 'https://fab.example.test/')).toBe(1);
  expect(await run('remote', 'add', 'Mal Alias', ORIGIN)).toBe(1);
  expect(await run('nada', 'ws', 'list')).toBe(1);
  expect(errs.at(-1)).toContain('alias desconocido');
  expect(seen).toEqual([]);
});

test('login: pareo con código, sesión guardada en el almacén privado y sin el token en la salida', async () => {
  await login('member');
  const dir = join(client, 'remote'), file = join(dir, 'prod.session.json');
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { token: string; origin: string };
  expect(saved.token).toMatch(/^fabs_/);
  expect(out.join('\n') + errs.join('\n')).not.toContain(saved.token);
  // el verificador no viaja en el inicio: solo su SHA-256
  const start = seen.find(s => s.url.endsWith('/pair/start'))!;
  expect(JSON.parse(start.body)).toEqual({ challenge: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
});

test('verbos: lectura, mutación con el actor del usuario y el token solo en la cabecera', async () => {
  await login('member');
  out.length = 0;
  expect(await run('prod', 'ws', 'list')).toBe(0);
  expect(JSON.parse(out.join(''))[0]).toMatchObject({ slug: 'nube' });
  expect(await run('prod', 'signal', 'add', ws.slug, 'desde la cli', '--body', 'texto')).toBe(0);
  expect(c.store.listSignals(ws.id).map(s => s.title)).toEqual(['desde la cli']);
  expect(await run('prod', 'note', changeId, 'una nota')).toBe(0);
  expect(c.store.listChangeNotes(changeId)[0]).toMatchObject({ actorRole: 'member' });
  const token = JSON.parse(readFileSync(join(client, 'remote', 'prod.session.json'), 'utf8')).token as string;
  for (const s of seen.filter(x => x.url.endsWith('/commands'))) { expect(s.auth).toBe(`Bearer ${token}`); expect(s.url).not.toContain(token); expect(s.body).not.toContain(token); }
});

test('retry lee la revisión del change antes de enviar; rol sin permiso da el error del servidor y salida 1', async () => {
  await login('member');
  expect(await run('prod', 'retry', changeId)).toBe(1); // member no reintenta: 403
  expect(errs.at(-1)).toMatch(/forbidden|no autorizado/);
  const sent = seen.filter(s => s.url.endsWith('/commands')).map(s => JSON.parse(s.body) as { op: string; fields: Record<string, string> });
  expect(sent.map(s => s.op)).toEqual(['ops/read', 'changes/retry']);
  expect(sent[1]!.fields.revision).toMatch(/^[0-9a-f]{64}$/);
});

test('--file: el cliente lee el fichero local y manda bytes y nombre base, no la ruta', async () => {
  await login('member');
  const f = join(c.dir, 'nota-adjunta.txt'); writeFileSync(f, 'contenido');
  expect(await run('prod', 'note', changeId, 'con adjunto', '--file', f)).toBe(0);
  const body = JSON.parse(seen.at(-1)!.body) as { file: { name: string; base64: string } };
  expect(body.file).toEqual({ name: 'nota-adjunta.txt', base64: Buffer.from('contenido').toString('base64') });
  expect(seen.at(-1)!.body).not.toContain(c.dir);
  expect(await run('prod', 'note', changeId, 'otro', '--file', join(c.dir, 'no-existe'))).toBe(1);
});

test('un verbo desconocido da error sin llamar a la red ni caer al chat', async () => {
  await login('owner');
  const before = seen.length;
  expect(await run('prod', 'merge', changeId)).toBe(1);
  expect(await run('prod', 'chat')).toBe(1);
  expect(await run('prod', 'exec', 'hazlo')).toBe(1);
  expect(seen.length).toBe(before);
  expect(errs.at(-1)).toContain('verbo remoto desconocido');
});

test('sin sesión, sesión caducada o servidor distinto del pareado: pide login y no manda nada', async () => {
  expect(await run('remote', 'add', 'prod', ORIGIN)).toBe(0);
  expect(await run('prod', 'ws', 'list')).toBe(1);
  expect(errs.at(-1)).toContain('login');
  await login('member');
  const file = join(client, 'remote', 'prod.session.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...saved, expiresAt: new Date(Date.now() - 1000).toISOString() }), { mode: 0o600 });
  const before = seen.length;
  expect(await run('prod', 'ws', 'list')).toBe(1);
  writeFileSync(file, JSON.stringify({ ...saved, origin: 'https://otro.example.test' }), { mode: 0o600 });
  expect(await run('prod', 'ws', 'list')).toBe(1);
  expect(seen.length).toBe(before);
});

test('una redirección no se sigue (las credenciales no salen del origen)', async () => {
  await login('member');
  const redirecting = (async () => new Response(null, { status: 307, headers: { location: 'https://evil.example/' } })) as unknown as typeof fetch;
  expect(await remoteMain(['prod', 'ws', 'list'], deps({ fetch: redirecting }))).toBe(1);
  expect(errs.at(-1)).toContain('redirección');
});

test('logout revoca la sesión en el servidor y borra la local', async () => {
  await login('member');
  const token = JSON.parse(readFileSync(join(client, 'remote', 'prod.session.json'), 'utf8')).token as string;
  expect(await run('prod', 'logout')).toBe(0);
  expect(existsSync(join(client, 'remote', 'prod.session.json'))).toBe(false);
  const res = await routes.handle(new Request(`${ORIGIN}/cli/v1/commands`, { method: 'POST', body: JSON.stringify({ op: 'session/list' }), headers: { host: HOST, 'content-type': 'application/json', authorization: `Bearer ${token}` } }), 'x');
  expect(res!.status).toBe(401);
});

test('el pareo sin aprobar agota el tiempo y no guarda sesión', async () => {
  expect(await run('remote', 'add', 'prod', ORIGIN)).toBe(0);
  expect(await remoteMain(['prod', 'login'], deps({ pairTimeoutMs: -1 }))).toBe(1);
  expect(existsSync(join(client, 'remote', 'prod.session.json'))).toBe(false);
});

// ---- tabla de verbos --------------------------------------------------------

test('inventario: cada operación remota (acciones e identidad) tiene un verbo, y cada verbo apunta a una operación del servidor', () => {
  const ops = new Set(Object.values(VERBS).map(v => v.op));
  for (const op of [...REMOTE_ACTION_OPS(), ...REMOTE_IDENTITY_OPS.filter(o => o !== 'session/logout')]) expect(ops.has(op), op).toBe(true);
  const known = new Set<string>([...REMOTE_ACTION_OPS(), ...REMOTE_IDENTITY_OPS]);
  for (const [verb, v] of Object.entries(VERBS)) expect(known.has(v.op), verb).toBe(true);
});

test('parseVerb: posicionales, flags, booleanos y confirmaciones del comando', () => {
  expect(parseVerb(['note', 'abc', 'texto largo'])).toMatchObject({ id: 'abc', fields: { body: 'texto largo' } });
  expect(parseVerb(['reject', 'abc', '--yes']).fields).toEqual({ confirm: 'yes' });
  const r = parseVerb(['user', 'resolve-work', 'u1', '--cancel', '--reason', 'baja', '--confirm', 'rev', '--op-id', 'op']);
  expect(r).toMatchObject({ id: 'u1', fields: { cancel: 'yes', reason: 'baja' }, confirm: 'rev', opId: 'op' });
  expect(parseVerb(['user', 'resolve-work', 'u1', '--reassign-to', 'u2']).fields).toEqual({ reassignTo: 'u2' });
  expect(parseVerb(['inbox', '--ws=nube']).fields).toEqual({ ws: 'nube' });
  expect(() => parseVerb(['note', 'a', 'b', 'sobra'])).toThrow('sobran');
  expect(() => parseVerb(['merge', 'x'])).toThrow('desconocido');
  expect(() => parseVerb(['note', 'a', 'b', '--$(rm)', 'x'])).toThrow('flag desconocido');
  expect(() => parseVerb(['note', 'a', 'b', '--file'])).toThrow('falta el valor');
});

test('fab --remote: el binario enruta al cliente remoto y un verbo o alias desconocido no cae al chat ni a un comando local', () => {
  const env = { ...process.env, FABRICA_HOME: join(c.dir, 'home') };
  const fab = (...args: string[]) => Bun.spawnSync(['bun', 'src/cli.ts', ...args], { env, cwd: join(import.meta.dir, '..') });
  const a = fab('--remote', 'nada', 'ws', 'list');
  expect(a.exitCode).toBe(1);
  expect(a.stderr.toString()).toContain('alias desconocido');
  expect(fab('remote', 'add', 'prod', 'http://evil.example').exitCode).toBe(1);
  expect(fab('remote', 'add', 'prod', ORIGIN).exitCode).toBe(0);
  const b = fab('--remote', 'prod', 'merge', 'x');
  expect(b.exitCode).toBe(1);
  expect(b.stderr.toString()).toMatch(/sin sesión|desconocido/);
});
