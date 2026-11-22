// T119c: pareo de la CLI remota, despacho tipado `/cli/v1/commands` y `user resolve-work`.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { cliRoutes, CliPairings, PAIR_ATTEMPTS_PER_CODE, PAIR_TTL_MS, REMOTE_ACTION_OPS } from '../src/web-cli.ts';
import { ACTION_CAPABILITIES } from '../src/policy.ts';
import { csrfToken, SESSION_COOKIE } from '../src/web-auth.ts';
import { disableUser, resolvePrincipal } from '../src/users.ts';
import { cloud, ORIGIN, ROLE_LIST, SECRET, type Cloud } from './helpers/cloud.ts';
import type { Role } from '../src/users.ts';

let c: Cloud;
let now: number;
let routes: ReturnType<typeof cliRoutes>;
let ws: { id: string; slug: string };
let changeId: string;
const HOST = 'fab.example.test';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

beforeEach(() => {
  c = cloud();
  now = Date.now();
  routes = cliRoutes({ stateDir: c.stateDir, publicOrigin: ORIGIN, write: true, secret: SECRET, clock: () => now });
  const repo = join(c.dir, 'repo'); mkdirSync(join(repo, '.git'), { recursive: true });
  ws = c.store.createWorkstream({ slug: 'nube', goal: 'g', repo, requireChangeApproval: false });
  changeId = c.store.createChange(ws.id, 'cambio', 'd').id;
});
afterEach(() => c.close());

const hdr = (extra: Record<string, string> = {}) => ({ host: HOST, ...extra });
async function call(path: string, init: RequestInit & { ip?: string } = {}): Promise<Response> {
  const { ip, ...rest } = init;
  const r = await routes.handle(new Request(`${ORIGIN}${path}`, rest), ip ?? '203.0.113.7');
  return r!;
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}, ip?: string) =>
  call(path, { method: 'POST', body: JSON.stringify(body), headers: hdr({ 'content-type': 'application/json', ...headers }), ip });

async function start(verifier = randomBytes(32).toString('base64url'), ip?: string) {
  const res = await post('/cli/v1/pair/start', { challenge: sha(verifier) }, {}, ip);
  return { res, verifier, code: ((await res.clone().json()) as { data?: { code: string } }).data?.code ?? '' };
}
/** La persona (con su sesión web) teclea el código y confirma. */
async function approve(role: Role, code: string, confirm = true, headers: Record<string, string> = {}) {
  const p = c.web[role], csrf = csrfToken(SECRET, p.sessionId!);
  const form = (extra: Record<string, string>) => call('/cuenta/cli/autorizar', { method: 'POST', body: new URLSearchParams({ csrf, code, ...extra }),
    headers: hdr({ cookie: `${SESSION_COOKIE}=${c.tokens.web[role]}`, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...headers }) });
  const step1 = await form({});
  return confirm ? { step1, step2: await form({ confirm: 'yes' }) } : { step1 };
}
const exchange = (code: string, verifier: string, ip?: string) => post('/cli/v1/pair/exchange', { code, verifier }, {}, ip);

// ---- pareo ------------------------------------------------------------------

test('pareo completo: código visible, confirmación en segundo paso con origen y rol, canje con el verificador y sesión CLI de 1 h', async () => {
  const { res, verifier, code } = await start();
  const info = (await res.json() as { data: { url: string; expiresIn: number } }).data;
  expect(info).toMatchObject({ url: `${ORIGIN}/cuenta/cli/autorizar`, expiresIn: 300 });
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const { step1, step2 } = await approve('member', code);
  const shown = await step1.text();
  expect(shown).toContain('203.0.113.7');  // origen de la solicitud
  expect(shown).toContain('member');        // rol
  expect(shown).toContain(HOST);            // servidor
  expect(shown).toContain('1 hora');        // alcance
  expect(step1.headers.get('cache-control')).toBe('no-store');
  expect(step2!.status).toBe(200);
  const ex = await exchange(code, verifier);
  const { token, expiresAt } = (await ex.json() as { data: { token: string; expiresAt: string } }).data;
  expect(Date.parse(expiresAt) - now).toBeLessThanOrEqual(3600_000 + 5000);
  const p = resolvePrincipal(c.store, token, 'cli');
  expect(p).toMatchObject({ userId: c.web.member.userId, role: 'member', via: 'cli' });
  expect(resolvePrincipal(c.store, token, 'web')).toBeNull(); // otra superficie
  expect((await exchange(code, verifier)).status).toBe(403);  // segundo canje
});

test('la URL con el código no lo precarga ni lo aprueba; sin la confirmación no hay canje', async () => {
  const { verifier, code } = await start();
  const page = await call(`/cuenta/cli/autorizar?code=${code}`, { headers: hdr({ cookie: `${SESSION_COOKIE}=${c.tokens.web.owner}` }) });
  expect(await page.text()).not.toContain(code);
  const { step1 } = await approve('owner', code, false);
  expect(step1.status).toBe(200); // solo la vista de confirmación
  expect((await exchange(code, verifier)).status).toBe(409);
});

test('otra terminal con el código visible pero sin el verificador no canjea, y no consume el pareo ajeno', async () => {
  const { verifier, code } = await start();
  await approve('admin', code);
  expect((await exchange(code, randomBytes(32).toString('base64url'))).status).toBe(403);
  expect((await exchange(code, verifier)).status).toBe(200);
});

test('el código se limita: tras demasiados intentos de la persona el pareo se descarta', async () => {
  const { verifier, code } = await start();
  for (let i = 0; i < PAIR_ATTEMPTS_PER_CODE; i++) await approve('member', code, false);
  expect((await approve('member', code, false)).step1.status).toBe(400);
  expect((await exchange(code, verifier)).status).toBe(403);
});

test('el pareo caduca a los 5 minutos', async () => {
  const { verifier, code } = await start();
  await approve('member', code);
  now += PAIR_TTL_MS + 1;
  expect((await exchange(code, verifier)).status).toBe(403);
});

test('límites: por IP y por código antes de seguir; la IP que vale es la que pasa quien monta, no las cabeceras', async () => {
  for (let i = 0; i < 10; i++) expect((await start(undefined, '198.51.100.1')).res.status).toBe(200);
  expect((await start(undefined, '198.51.100.1')).res.status).toBe(429);
  const spoof = await post('/cli/v1/pair/start', { challenge: sha('x') }, { 'x-forwarded-for': '192.0.2.99' }, '198.51.100.1');
  expect(spoof.status).toBe(429);
  expect(spoof.headers.get('retry-after')).toBeTruthy();
  expect((await start(undefined, '198.51.100.2')).res.status).toBe(200);
  const { code } = await start(undefined, '198.51.100.3');
  const bad = () => exchange(code.replace('-', ''), randomBytes(32).toString('base64url'), '198.51.100.4');
  for (let i = 0; i < 5; i++) await bad();
  expect((await bad()).status).toBe(429); // 5/min por flujo
});

test('el almacén de pareos tiene tope', () => {
  const p = new CliPairings(() => now);
  for (let i = 0; i < 1000; i++) expect(p.start(sha(String(i)), 'ip')).not.toBeNull();
  expect(p.start(sha('x'), 'ip')).toBeNull();
  now += PAIR_TTL_MS + 1;
  expect(p.start(sha('x'), 'ip')).not.toBeNull();
});

test('la página de autorización exige sesión, Origin exacto, CSRF y Host', async () => {
  const { code } = await start();
  const noSession = await call('/cuenta/cli/autorizar', { headers: hdr() });
  expect(noSession.status).toBe(303);
  const p = c.web.member, csrf = csrfToken(SECRET, p.sessionId!);
  const send = (origin: string | null, token: string, h: string = HOST) => call('/cuenta/cli/autorizar', { method: 'POST', body: new URLSearchParams({ csrf: token, code }),
    headers: { host: h, cookie: `${SESSION_COOKIE}=${c.tokens.web.member}`, 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) } });
  expect((await send(null, csrf)).status).toBe(403);
  expect((await send('https://otro.example', csrf)).status).toBe(403);
  expect((await send(ORIGIN, csrfToken(SECRET, c.web.admin.sessionId!))).status).toBe(403);
  expect((await send(ORIGIN, csrf, 'otro.example')).status).toBe(403);
  expect((await send(ORIGIN, csrf)).status).toBe(200);
  // una sesión CLI no aprueba pareos
  const cliCookie = await call('/cuenta/cli/autorizar', { headers: hdr({ cookie: `${SESSION_COOKIE}=${c.tokens.cli.owner}` }) });
  expect(cliCookie.status).toBe(303);
});

test('un usuario dado de baja entre la aprobación y el canje no obtiene sesión', async () => {
  const { verifier, code } = await start();
  await approve('admin', code);
  disableUser(c.store, c.web.owner, c.web.admin.userId);
  expect((await exchange(code, verifier)).status).toBe(403);
});

// ---- comandos ---------------------------------------------------------------

const cmd = (role: Role, body: Record<string, unknown>, token = c.tokens.cli[role]) =>
  post('/cli/v1/commands', body, { authorization: `Bearer ${token}` });
const letter: Record<Role, string> = { owner: 'O', admin: 'A', member: 'M', viewer: 'V' };

test('sin sesión de CLI: 401; con una sesión web o una clave de API: 401', async () => {
  expect((await post('/cli/v1/commands', { op: 'ops/read', fields: { path: '/workstreams' } })).status).toBe(401);
  expect((await cmd('owner', { op: 'ops/read', fields: { path: '/workstreams' } }, c.tokens.web.owner)).status).toBe(401);
  expect((await cmd('owner', { op: 'ops/read', fields: { path: '/workstreams' } }, c.keys.owner.decide)).status).toBe(401);
});

test('inventario: toda ACTION de la web (menos las claves, que van por api-key/*) tiene operación remota del mismo rol', async () => {
  const ops = REMOTE_ACTION_OPS();
  expect(ops.sort()).toEqual(Object.keys(ACTION_CAPABILITIES).filter(n => !n.startsWith('api-keys/')).sort());
});

for (const name of REMOTE_ACTION_OPS()) {
  test(`CLI ${name}: solo ${ACTION_CAPABILITIES[name]!.roles} pasan la política`, async () => {
    for (const role of ROLE_LIST) {
      const res = await cmd(role, { op: name, id: 'x1', fields: {} });
      const allowed = ACTION_CAPABILITIES[name]!.roles.includes(letter[role]);
      if (allowed) expect([401, 403], `${role} (${res.status})`).not.toContain(res.status);
      else expect(res.status, role).toBe(403);
    }
  });
}

test('operaciones desconocidas o con campos de más: 404 / 400, nunca un fallback', async () => {
  expect((await cmd('owner', { op: 'chat', fields: {} })).status).toBe(404);
  expect((await cmd('owner', { op: 'ws/list' })).status).toBe(404);
  expect((await cmd('owner', { op: 'ops/read', argv: ['rm'] })).status).toBe(400);
  expect((await cmd('owner', { op: 'ops/read', fields: { path: '/workstreams' }, extra: 1 })).status).toBe(400);
  expect((await cmd('owner', { op: 'ops/read', fields: { path: 'http://evil/x' } })).status).toBe(400);
});

test('lecturas: owner ve el estado; el viewer no recibe texto libre de los workers', async () => {
  const a = c.store.listActivities({ changeId })[0]!;
  c.store.db.query("UPDATE activities SET result = 'texto del worker', error = 'otro texto' WHERE id = ?").run(a.id);
  const owner = await (await cmd('owner', { op: 'ops/read', fields: { path: `/activities/${a.id}` } })).json() as { data: { result: string } };
  expect(owner.data.result).toBe('texto del worker');
  const viewer = await (await cmd('viewer', { op: 'ops/read', fields: { path: `/activities/${a.id}` } })).json() as { data: { result: string | null; error: string | null } };
  expect(viewer.data.result).toBeNull();
  expect(viewer.data.error).toBeNull();
  expect(JSON.stringify(await (await cmd('viewer', { op: 'ops/read', fields: { path: `/changes/${changeId}` } })).json())).not.toContain('texto del worker');
});

test('sin --write ninguna mutación pasa, pero las lecturas y la cuenta sí', async () => {
  routes = cliRoutes({ stateDir: c.stateDir, publicOrigin: ORIGIN, write: false, secret: SECRET, clock: () => now });
  expect((await cmd('owner', { op: 'signals/create', fields: { title: 't', workstream: ws.slug } })).status).toBe(403);
  expect((await cmd('owner', { op: 'api-key/create', fields: { name: 'k1', scope: 'read' } })).status).toBe(403);
  expect((await cmd('owner', { op: 'ops/read', fields: { path: '/workstreams' } })).status).toBe(200);
  expect((await cmd('owner', { op: 'session/list' })).status).toBe(200);
});

test('una acción por CLI deja el actor del usuario (fuente cli) y el rol de la nota', async () => {
  const res = await cmd('member', { op: 'changes/note', id: changeId, fields: { body: 'por cli' } });
  expect(res.status).toBe(200);
  const [n] = c.store.listChangeNotes(changeId);
  expect(n).toMatchObject({ actorUserId: c.cli.member.userId, actorRole: 'member' });
  const ev = c.store.db.query("SELECT actor_source FROM events WHERE message LIKE 'nota del dueño%'").get() as { actor_source: string };
  expect(ev.actor_source).toBe('cli');
});

test('identidad por CLI: claves propias (viewer no), sesiones, usuarios y roles según §4.2', async () => {
  expect((await cmd('viewer', { op: 'api-key/create', fields: { name: 'k', scope: 'read' } })).status).toBe(403);
  const made = await cmd('member', { op: 'api-key/create', fields: { name: 'mia', scope: 'read' } });
  expect(made.status).toBe(200);
  expect(((await made.json()) as { data: { key: string } }).data.key).toMatch(/^fabu_/);
  expect((await cmd('member', { op: 'api-key/list' })).status).toBe(200);
  expect((await cmd('viewer', { op: 'api-key/list' })).status).toBe(403);
  for (const role of ROLE_LIST) expect((await cmd(role, { op: 'session/list' })).status).toBe(200);
  expect((await cmd('member', { op: 'user/list' })).status).toBe(403);
  expect((await cmd('admin', { op: 'user/list' })).status).toBe(200);
  expect((await cmd('admin', { op: 'user/role', id: c.web.member.userId, fields: { role: 'viewer' } })).status).toBe(403);
  expect((await cmd('owner', { op: 'user/role', id: c.web.member.userId, fields: { role: 'viewer' } })).status).toBe(200);
  // logout revoca la sesión de la CLI
  expect((await cmd('viewer', { op: 'session/logout' })).status).toBe(200);
  expect((await cmd('viewer', { op: 'session/list' })).status).toBe(401);
});

test('user invite: política antes de red y cuota; formato antes de red; rol de admin acotado', async () => {
  let calls = 0;
  routes = cliRoutes({ stateDir: c.stateDir, publicOrigin: ORIGIN, write: true, secret: SECRET, clock: () => now,
    resolveLogin: async login => { calls++; return { login, subject: '4242' }; } });
  expect((await cmd('member', { op: 'user/invite', fields: { login: 'octo', role: 'member' } })).status).toBe(403);
  expect((await cmd('admin', { op: 'user/invite', fields: { login: 'octo', role: 'admin' } })).status).toBe(403);
  expect((await cmd('admin', { op: 'user/invite', fields: { login: '-malo-', role: 'member' } })).status).toBe(400);
  expect((await cmd('owner', { op: 'user/invite', fields: { login: 'octo', role: 'superuser' } })).status).toBe(400);
  expect((await cmd('admin', { op: 'user/invite', fields: { login: 'octo', role: 'superuser' } })).status).toBe(403);
  expect(calls).toBe(0);
  const ok = await cmd('admin', { op: 'user/invite', fields: { login: 'octo', role: 'member' } });
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { data: { subject: string; code: string } }).data).toMatchObject({ subject: '4242' });
  expect(calls).toBe(1);
  for (let i = 0; i < 9; i++) await cmd('admin', { op: 'user/invite', fields: { login: 'octo', role: 'member' } });
  const limited = await cmd('admin', { op: 'user/invite', fields: { login: 'octo', role: 'member' } });
  expect(limited.status).toBe(429);
  expect(calls).toBe(10);
});

// ---- user resolve-work ------------------------------------------------------

async function mkWork(role: Role, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    // El usuario origina el change por la web (señal + triage del admin no cuentan: el originador es quien crea el primer evento).
    c.store.asActor({ actor: `user:${c.web[role].userId}`, userId: c.web[role].userId, source: 'web', role });
    const ch = c.store.createChange(ws.id, `de ${role} ${i}`, 'd');
    c.store.event(ws.id, 'info', 'creado', ch.id);
    c.store.asActor(undefined);
    ids.push(ch.id);
  }
  return ids;
}
const resolveCmd = (id: string, fields: Record<string, string>, confirm?: string, opId?: string, role: Role = 'owner') => cmd(role, { op: 'user/resolve-work', id, fields, confirm, opId });
const data = async <T>(r: Response) => ((await r.json()) as { data: T }).data;
const OP = '11111111-1111-4111-8111-111111111111';

test('resolve-work: solo owner, solo cuentas suspendidas, vista previa con IDs y revisión', async () => {
  const ids = await mkWork('member', 2);
  expect((await resolveCmd(c.web.member.userId, {}, undefined, undefined, 'admin')).status).toBe(403);
  expect((await resolveCmd(c.web.member.userId, {})).status).toBe(409); // no está suspendido
  disableUser(c.store, c.web.owner, c.web.member.userId);
  const plan = await data<{ affected: { id: string }[]; revision: string; excluded: unknown[] }>(await resolveCmd(c.web.member.userId, {}));
  expect(plan.affected.map(a => a.id).sort()).toEqual([...ids].sort());
  expect(plan.revision).toMatch(/^[0-9a-f]{64}$/);
});

test('resolve-work --reassign-to: cambia el responsable futuro y conserva al originador histórico; idempotente por op-id', async () => {
  const ids = await mkWork('member', 2);
  disableUser(c.store, c.web.owner, c.web.member.userId);
  const { revision } = await data<{ revision: string }>(await resolveCmd(c.web.member.userId, {}));
  const fields = { reassignTo: c.web.admin.userId, reason: 'baja del equipo' };
  expect((await resolveCmd(c.web.member.userId, fields, 'x'.repeat(64), OP)).status).toBe(409); // revisión equivocada
  const first = await resolveCmd(c.web.member.userId, fields, revision, OP);
  expect(first.status).toBe(200);
  const r1 = await data<{ changeIds: string[] }>(first);
  expect([...r1.changeIds].sort()).toEqual([...ids].sort());
  const row = c.store.db.query('SELECT responsible_user_id FROM changes WHERE id = ?').get(ids[0]!) as { responsible_user_id: string };
  expect(row.responsible_user_id).toBe(c.web.admin.userId);
  // el primer evento (el originador de T110) sigue siendo del miembro
  expect((c.store.db.query('SELECT actor_user_id FROM events WHERE change_id = ? ORDER BY id LIMIT 1').get(ids[0]!) as { actor_user_id: string }).actor_user_id).toBe(c.web.member.userId);
  // mismo ID y mismos parámetros: mismo resultado; otro destino con el mismo ID: 409
  expect(await data<{ changeIds: string[] }>(await resolveCmd(c.web.member.userId, fields, revision, OP))).toEqual(r1);
  expect((await resolveCmd(c.web.member.userId, { ...fields, reassignTo: c.web.owner.userId }, revision, OP)).status).toBe(409);
  const audits = c.store.db.query("SELECT actor_user_id FROM identity_audit WHERE action = 'user.resolve-work'").all() as { actor_user_id: string }[];
  expect(audits).toEqual([{ actor_user_id: c.web.owner.userId }]);
  // una vez reasignado, ya no quedan changes del suspendido
  expect((await data<{ affected: unknown[] }>(await resolveCmd(c.web.member.userId, {}))).affected).toEqual([]);
});

test('resolve-work: un destino suspendido o viewer, un modo doble y un motivo vacío se rechazan; un change con intento vivo queda fuera', async () => {
  const [a, b] = await mkWork('member', 2);
  c.store.db.query("UPDATE activities SET status = 'in_progress', lease_expires_at = ? WHERE change_id = ?").run(new Date(now + 60_000).toISOString(), b!);
  disableUser(c.store, c.web.owner, c.web.member.userId);
  const plan = await data<{ affected: { id: string }[]; excluded: { id: string; reason: string }[]; revision: string }>(await resolveCmd(c.web.member.userId, {}));
  expect(plan.affected.map(x => x.id)).toEqual([a!]);
  expect(plan.excluded).toEqual([{ id: b!, reason: 'active_attempt' }]);
  const go = (fields: Record<string, string>) => resolveCmd(c.web.member.userId, fields, plan.revision, OP);
  expect((await go({ reassignTo: c.web.viewer.userId, reason: 'r' })).status).toBe(409);
  expect((await go({ reassignTo: c.web.admin.userId, cancel: 'yes', reason: 'r' })).status).toBe(400);
  expect((await go({ reassignTo: c.web.admin.userId, reason: '' })).status).toBe(400);
  expect((await go({ reason: 'r' })).status).toBe(400);
  expect((await resolveCmd(c.web.member.userId, { cancel: 'yes', reason: 'r' }, plan.revision, 'no-es-uuid')).status).toBe(400);
});

test('resolve-work --cancel: cancela por la transición normal; si la cola cambió entre la vista y la aplicación, 409', async () => {
  const [a] = await mkWork('member', 1);
  disableUser(c.store, c.web.owner, c.web.member.userId);
  const { revision } = await data<{ revision: string }>(await resolveCmd(c.web.member.userId, {}));
  const [extra] = await mkWork('member', 1); // la cola cambió
  expect((await resolveCmd(c.web.member.userId, { cancel: 'yes', reason: 'cierre' }, revision, OP)).status).toBe(409);
  const fresh = await data<{ revision: string }>(await resolveCmd(c.web.member.userId, {}));
  expect((await resolveCmd(c.web.member.userId, { cancel: 'yes', reason: 'cierre' }, fresh.revision, OP)).status).toBe(200);
  expect(c.store.getChange(a!).status).toBe('canceled');
  expect(c.store.getChange(extra!).status).toBe('canceled');
});

test('resolve-work: dos aplicaciones con IDs distintos sobre la misma cola dan un único resultado válido', async () => {
  await mkWork('member', 1);
  disableUser(c.store, c.web.owner, c.web.member.userId);
  const { revision } = await data<{ revision: string }>(await resolveCmd(c.web.member.userId, {}));
  const f = { cancel: 'yes', reason: 'r' };
  const [x, y] = await Promise.all([resolveCmd(c.web.member.userId, f, revision, OP), resolveCmd(c.web.member.userId, f, revision, '22222222-2222-4222-8222-222222222222')]);
  expect([x.status, y.status].sort()).toEqual([200, 409]);
});
