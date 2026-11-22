import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { acceptInvitation, bootstrapOwner, createUserKey, listUserKeys, enterRecovery, inviteUser, issueSession, listSessions, resolvePrincipal, type Principal, type Role } from '../src/users.ts';
import { GithubConnector, identityRoutes, validGithubLogin, GITHUB_ISSUER } from '../src/web-identity.ts';
import { LoginTransactions, PENDING_LOGIN_MAX, csrfToken } from '../src/web-auth.ts';
import { CLIENT_ID, CLIENT_SECRET, startFakeGithub, type FakeGithub } from './helpers/fake-github.ts';

const ORIGIN = 'https://fab.test', HOST = 'fab.test', SECRET = 'secreto-de-servicio';
let now: number, dir: string, path: string, store: Store, gh: FakeGithub, routes: ReturnType<typeof identityRoutes>;
const clock = () => new Date(now);
const open = () => new Store(path, { clock });
const mount = (write = true, timeoutMs?: number) => { routes = identityRoutes({ store, github: new GithubConnector({ clientId: CLIENT_ID, clientSecret: () => CLIENT_SECRET, publicOrigin: ORIGIN,
  authorizeUrl: `${gh.url}/login/oauth/authorize`, tokenUrl: `${gh.url}/login/oauth/access_token`, apiBase: `${gh.url}/api`, timeoutMs }), publicOrigin: ORIGIN, write, secret: SECRET }); };

beforeEach(() => {
  now = Date.parse('2026-11-22T10:00:00.000Z');
  dir = mkdtempSync(join(tmpdir(), 'fab-ident-')); path = join(dir, 'f.db'); store = open(); gh = startFakeGithub(`${ORIGIN}/auth/callback`); mount();
});
afterEach(() => { gh.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });

interface Call { cookie?: string; origin?: string | null; form?: Record<string, string>; ip?: string; host?: string; headers?: Record<string, string> }
async function call(method: string, p: string, o: Call = {}): Promise<Response> {
  const headers: Record<string, string> = { host: o.host ?? HOST, ...o.headers };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.origin !== null && method === 'POST') headers.origin = o.origin ?? ORIGIN;
  let body: string | undefined;
  if (o.form) { body = new URLSearchParams(o.form).toString(); headers['content-type'] ??= 'application/x-www-form-urlencoded'; }
  const res = await routes.handle(new Request(`${ORIGIN}${p}`, { method, headers, body, redirect: 'manual' }), o.ip ?? '10.0.0.1');
  return res ?? new Response('sin ruta', { status: 599 });
}
/** El `Origin` que un navegador pone en un POST de formulario del mismo origen enviado desde `from`: `null` si su Referrer-Policy es `no-referrer` (Fetch). */
const browserOrigin = (from: Response): string => from.headers.get('referrer-policy') === 'no-referrer' ? 'null' : ORIGIN;
const setCookies = (r: Response) => r.headers.getSetCookie();
const cookieOf = (r: Response, name: string) => setCookies(r).find(c => c.startsWith(`${name}=`));
const pair = (c: string | undefined) => c!.split(';')[0]!;

/** El navegador: /login → POST /auth/start. Devuelve el `state` y la cookie de login. */
async function startLogin(invitation = '', ip = '10.0.0.1') {
  const page = await call('GET', '/login', { ip });
  const pre = pair(cookieOf(page, '__Host-fab_pre')), token = /name="pre" value="([0-9a-f]+)"/.exec(await page.text())![1]!;
  const res = await call('POST', '/auth/start', { cookie: pre, form: { pre: token, invitation }, ip });
  return { res, location: res.headers.get('location') ?? '', loginCookie: pair(cookieOf(res, '__Host-fab_login')) };
}
/** Login completo contra el GitHub falso. */
async function login(account: { id: number; login: string }, invitation = '', ip = '10.0.0.1') {
  const s = await startLogin(invitation, ip);
  const state = new URL(s.location).searchParams.get('state')!;
  const res = await call('GET', `/auth/callback?code=${await gh.authorize(s.location, account)}&state=${state}`, { cookie: s.loginCookie, ip });
  return { res, state, loginCookie: s.loginCookie, session: cookieOf(res, '__Host-fab_session') };
}
function seedOwner(id = 1): Principal {
  const u = bootstrapOwner(store, { issuer: GITHUB_ISSUER, subject: String(id), displayName: 'Dueña', operator: 'op' });
  return resolvePrincipal(store, issueSession(store, u.id, 'web').token, 'web')!;
}
function invite(by: Principal, id: number, role: Role = 'member') {
  const inv = inviteUser(store, by, { expectedIssuer: GITHUB_ISSUER, expectedSubject: String(id), role });
  return inv.code;
}
const csrfFor = (cookie: string) => csrfToken(SECRET, routes.principalOf(new Request(ORIGIN, { headers: { cookie } }))!.sessionId!);

test('login: redirect exacto, scope vacío, PKCE S256, cookie Lax y sesión con los atributos de §3.1', async () => {
  seedOwner(1);
  const s = await startLogin();
  expect(s.res.status).toBe(303);
  const u = new URL(s.location);
  expect(u.origin + u.pathname).toBe(`${gh.url}/login/oauth/authorize`);
  expect(u.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`);
  expect(u.searchParams.get('scope')).toBe('');
  expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  expect(u.searchParams.get('client_id')).toBe(CLIENT_ID);
  expect(u.searchParams.has('client_secret')).toBe(false);
  const lc = cookieOf(s.res, '__Host-fab_login')!;
  expect(lc).toMatch(/Secure/); expect(lc).toMatch(/HttpOnly/); expect(lc).toMatch(/SameSite=Lax/); expect(lc).toMatch(/Path=\//); expect(lc).not.toMatch(/Domain/);

  const state = u.searchParams.get('state')!;
  const cb = await call('GET', `/auth/callback?code=${await gh.authorize(s.location, { id: 1, login: 'duena' })}&state=${state}`, { cookie: s.loginCookie });
  expect(cb.status).toBe(200);
  const sc = cookieOf(cb, '__Host-fab_session')!;
  expect(sc).toMatch(/Secure/); expect(sc).toMatch(/HttpOnly/); expect(sc).toMatch(/SameSite=Strict/); expect(sc).toMatch(/Path=\//); expect(sc).not.toMatch(/Domain/);
  expect(cookieOf(cb, '__Host-fab_login')).toMatch(/Max-Age=0/);
  expect(cb.headers.get('cache-control')).toBe('no-store'); expect(cb.headers.get('referrer-policy')).toBe('no-referrer');
  const p = resolvePrincipal(store, pair(sc).split('=')[1]!, 'web')!;
  expect(p.role).toBe('owner'); expect(p.via).toBe('web');
  // PKCE: GitHub recibió el verificador y el redirect exacto.
  const exchange = gh.calls.find(c => c.path === '/login/oauth/access_token')!;
  expect(exchange.body?.redirect_uri).toBe(`${ORIGIN}/auth/callback`);
  expect(typeof exchange.body?.code_verifier).toBe('string');
});

test('el token del proveedor se revoca siempre: al entrar y también cuando se deniega el alta', async () => {
  seedOwner(1);
  await login({ id: 1, login: 'duena' });
  expect(gh.tokensRevoked.length).toBe(1);
  const denied = await login({ id: 99, login: 'extrano' }); // sin cuenta ni invitación
  expect(denied.res.status).toBe(403);
  expect(gh.tokensRevoked.length).toBe(2);
});

test('un fallo al revocar se audita sin el valor del token y no tumba el login', async () => {
  seedOwner(1);
  gh.fail.revoke = true;
  const r = await login({ id: 1, login: 'duena' });
  expect(r.session).toBeTruthy();
  const rows = store.db.query(`SELECT * FROM identity_audit WHERE action = 'login.revoke-failed'`).all() as { result: string; detail: string | null }[];
  expect(rows.length).toBe(1); expect(rows[0]!.result).toBe('error');
  expect(JSON.stringify(store.db.query('SELECT * FROM identity_audit').all())).not.toContain('gho_');
});

test('identidad por ID numérico: cambiar el login visible conserva la cuenta; un ID no numérico no entra', async () => {
  const o = seedOwner(1);
  const a = await login({ id: 1, login: 'duena' }), b = await login({ id: 1, login: 'duena-renombrada' });
  expect(a.session && b.session).toBeTruthy();
  expect(resolvePrincipal(store, pair(b.session).split('=')[1]!, 'web')!.userId).toBe(o.userId);
  // Cuentas con sujeto «0» y «-1» existen: un ID no positivo del proveedor no debe llegar a ellas.
  for (const sub of ['0', '-1']) acceptInvitation(store, { code: invite(o, Number(sub)), issuer: GITHUB_ISSUER, subject: sub, displayName: sub });
  for (const bad of ['1', 1.5, -1, null, 0]) { now += 60_000; gh.fail.userId = bad; expect((await login({ id: 1, login: 'duena' })).res.status).toBe(403); }
});

test('state de un solo uso, ligado al navegador, y caducidad de 5 minutos', async () => {
  seedOwner(1);
  const s = await startLogin(), state = new URL(s.location).searchParams.get('state')!;
  const other = await startLogin(); // otro navegador
  // El state de uno con la cookie de otro no sirve, y además se consume.
  expect((await call('GET', `/auth/callback?code=${gh.grant({ id: 1, login: 'd' })}&state=${state}`, { cookie: other.loginCookie })).status).toBe(403);
  expect((await call('GET', `/auth/callback?code=${gh.grant({ id: 1, login: 'd' })}&state=${state}`, { cookie: s.loginCookie })).status).toBe(403);
  // Sin cookie, sin state y state inventado.
  const t = await startLogin(), st = new URL(t.location).searchParams.get('state')!;
  expect((await call('GET', `/auth/callback?code=x&state=${st}`)).status).toBe(403);
  expect((await call('GET', `/auth/callback?code=x`, { cookie: t.loginCookie })).status).toBe(403);
  expect((await call('GET', `/auth/callback?code=x&state=nope`, { cookie: t.loginCookie })).status).toBe(403);
  // Caducado.
  const u = await startLogin(), su = new URL(u.location).searchParams.get('state')!;
  now += 5 * 60_000 + 1;
  expect((await call('GET', `/auth/callback?code=${gh.grant({ id: 1, login: 'd' })}&state=${su}`, { cookie: u.loginCookie })).status).toBe(403);
  // Ninguna de las fallidas llegó a canjear nada.
  expect(gh.calls.filter(c => c.path === '/login/oauth/access_token').length).toBe(0);
});

test('invitación: se canjea con el código y el ID verificado; otro sujeto, segundo uso o sin código no crean cuenta', async () => {
  const o = seedOwner(1);
  const c = invite(o, 10, 'viewer');
  expect((await login({ id: 11, login: 'otro' }, c)).res.status).toBe(403); // otro sujeto
  expect((await login({ id: 10, login: 'ana' })).res.status).toBe(403); // sin código
  const ok = await login({ id: 10, login: 'ana' }, c);
  expect(ok.session).toBeTruthy();
  expect(resolvePrincipal(store, pair(ok.session).split('=')[1]!, 'web')!.role).toBe('viewer');
  const again = await login({ id: 12, login: 'tercero' }, c);
  expect(again.res.status).toBe(403);
  expect(store.db.query('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 2 });
  // El código viaja con la transacción, no en la URL de GitHub.
  expect((await startLogin(c)).location).not.toContain(c);
});

test('cuenta desconocida, dada de baja y proveedor caído dan la misma respuesta pública', async () => {
  const o = seedOwner(1);
  const u = acceptInvitation(store, { code: invite(o, 5), issuer: GITHUB_ISSUER, subject: '5', displayName: 'x' });
  store.db.query('UPDATE users SET disabled_at = ? WHERE id = ?').run(store.now(), u.id);
  const unknown = await login({ id: 77, login: 'nadie' }), disabled = await login({ id: 5, login: 'x' });
  gh.fail.token = true; const down = await login({ id: 1, login: 'duena' });
  const bodies = await Promise.all([unknown.res, disabled.res, down.res].map(async r => [r.status, await r.text()]));
  expect(bodies[0]).toEqual(bodies[1]); expect(bodies[0]).toEqual(bodies[2]); expect(bodies[0]![0]).toBe(403);
});

test('GitHub no se sigue por redirecciones', async () => {
  seedOwner(1);
  gh.fail.redirectUser = true;
  expect((await login({ id: 1, login: 'd' })).res.status).toBe(403);
  expect(gh.calls.some(c => c.path === '/elsewhere')).toBe(false);
});

test('rotación: una sesión que llega al callback se revoca y se emite otra', async () => {
  const o = seedOwner(1);
  const s = await startLogin(), state = new URL(s.location).searchParams.get('state')!;
  const old = issueSession(store, o.userId, 'web');
  const cb = await call('GET', `/auth/callback?code=${await gh.authorize(s.location, { id: 1, login: 'd' })}&state=${state}`, { cookie: `${s.loginCookie}; __Host-fab_session=${old.token}` });
  const fresh = pair(cookieOf(cb, '__Host-fab_session')).split('=')[1]!;
  expect(fresh).not.toBe(old.token);
  expect(resolvePrincipal(store, old.token, 'web')).toBeNull();
  expect(resolvePrincipal(store, fresh, 'web')).not.toBeNull();
});

test('límites: la petición sobre el umbral da 429 con Retry-After antes de llamar a GitHub; los headers del cliente no lo cambian', async () => {
  seedOwner(1);
  for (let i = 0; i < 10; i++) await call('GET', '/auth/callback?code=x&state=y', { headers: { 'x-forwarded-for': `1.1.1.${i}` } });
  const r = await call('GET', `/auth/callback?code=${gh.grant({ id: 1, login: 'd' })}&state=y`, { headers: { 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '8.8.8.8' } });
  expect(r.status).toBe(429); expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
  expect(gh.calls.length).toBe(0);
  const page = await call('GET', '/login', { ip: '10.0.0.1' });
  const start = await call('POST', '/auth/start', { ip: '10.0.0.1', cookie: pair(cookieOf(page, '__Host-fab_pre')), form: { pre: 'x' } });
  expect(start.status).toBe(429);
  now += 60_000; // otra ventana
  expect((await call('GET', '/auth/callback?code=x&state=y')).status).toBe(403);
  // Los inicios cuentan por la IP que pone quien monta las rutas, no por una cabecera del cliente.
  for (let i = 0; i < 10; i++) await call('POST', '/auth/start', { ip: '10.7.7.7', form: { pre: 'x' }, headers: { 'x-forwarded-for': `2.2.2.${i}` } });
  expect((await call('POST', '/auth/start', { ip: '10.7.7.7', form: { pre: 'x' }, headers: { 'x-forwarded-for': '3.3.3.3' } })).status).toBe(429);
});

test('límite global de inicios: 60 por minuto aunque cambie la IP', async () => {
  for (let i = 0; i < 60; i++) {
    const ip = `10.1.${Math.floor(i / 10)}.${i % 10}`;
    const page = await call('GET', '/login', { ip });
    const r = await call('POST', '/auth/start', { ip, cookie: pair(cookieOf(page, '__Host-fab_pre')), form: { pre: /name="pre" value="([0-9a-f]+)"/.exec(await page.text())![1]! } });
    expect(r.status).toBe(303);
  }
  const page = await call('GET', '/login', { ip: '10.9.9.9' });
  const r = await call('POST', '/auth/start', { ip: '10.9.9.9', cookie: pair(cookieOf(page, '__Host-fab_pre')), form: { pre: /name="pre" value="([0-9a-f]+)"/.exec(await page.text())![1]! } });
  expect(r.status).toBe(429);
});

test('el almacén de transacciones pendientes está acotado', () => {
  const t = new LoginTransactions(() => now);
  for (let i = 0; i < PENDING_LOGIN_MAX; i++) expect(t.start()).not.toBeNull();
  expect(t.start()).toBeNull();
  now += 5 * 60_000 + 1; // las caducadas liberan sitio
  expect(t.start()).not.toBeNull();
});

test('inicio de login: Origin exacto y token de prelogin ligado al navegador', async () => {
  const page = await call('GET', '/login'), pre = pair(cookieOf(page, '__Host-fab_pre')), token = /name="pre" value="([0-9a-f]+)"/.exec(await page.text())![1]!;
  const ok = { cookie: pre, form: { pre: token } };
  expect((await call('POST', '/auth/start', { ...ok, origin: null })).status).toBe(403);
  expect((await call('POST', '/auth/start', { ...ok, origin: 'https://evil.test' })).status).toBe(403);
  expect((await call('POST', '/auth/start', { form: { pre: token } })).status).toBe(403); // sin la cookie del navegador
  expect((await call('POST', '/auth/start', { cookie: pre, form: { pre: 'f'.repeat(64) } })).status).toBe(403);
  expect((await call('POST', '/auth/start', ok)).status).toBe(303);
});

test('Host ajeno y rutas ajenas', async () => {
  expect((await call('GET', '/login', { host: 'evil.test' })).status).toBe(403);
  expect(await routes.handle(new Request(`${ORIGIN}/ws`, { headers: { host: HOST } }), 'ip')).toBeNull();
  expect(await routes.handle(new Request(`${ORIGIN}/auth?token=abc`, { headers: { host: HOST } }), 'ip')).toBeNull(); // el enlace local no existe en servidor
});

test('logout y revocación: Origin, CSRF de la sesión y persistencia tras reabrir el Store', async () => {
  seedOwner(1);
  const a = pair((await login({ id: 1, login: 'd' })).session), b = pair((await login({ id: 1, login: 'd' })).session);
  const csrfA = csrfFor(a), csrfB = csrfFor(b);
  expect(csrfA).not.toBe(csrfB);
  const bad: Call[] = [{ origin: null, form: { csrf: csrfA } }, { origin: 'https://evil.test', form: { csrf: csrfA } }, { form: { csrf: csrfB } }, { form: { csrf: 'x' } }, { form: {} }];
  for (const o of bad) expect((await call('POST', '/logout', { cookie: a, ...o })).status).toBe(403);
  expect((await call('POST', '/logout', { form: { csrf: csrfA } })).status).toBe(401); // sin sesión
  expect(routes.principalOf(new Request(ORIGIN, { headers: { cookie: a } }))).not.toBeNull();
  const out = await call('POST', '/logout', { cookie: a, form: { csrf: csrfA } });
  expect(out.status).toBe(303); expect(cookieOf(out, '__Host-fab_session')).toMatch(/Max-Age=0/);
  store.close(); store = open(); mount();
  expect(routes.principalOf(new Request(ORIGIN, { headers: { cookie: a } }))).toBeNull();
  expect((await call('POST', '/logout', { cookie: a, form: { csrf: csrfA } })).status).toBe(401);
  expect(routes.principalOf(new Request(ORIGIN, { headers: { cookie: b } }))).not.toBeNull(); // la otra sigue
});

test('una cookie repetida o un token de otra superficie no autentican', async () => {
  const o = seedOwner(1);
  const web = pair((await login({ id: 1, login: 'd' })).session);
  expect(routes.principalOf(new Request(ORIGIN, { headers: { cookie: `${web}; ${web}` } }))).toBeNull();
  const cli = issueSession(store, o.userId, 'cli').token;
  expect((await call('GET', '/cuenta', { cookie: `__Host-fab_session=${cli}` })).status).toBe(303);
});

test('cuenta: sesiones propias, nunca las de otro usuario, y revocar una propia', async () => {
  const o = seedOwner(1);
  const m = acceptInvitation(store, { code: invite(o, 2), issuer: GITHUB_ISSUER, subject: '2', displayName: 'Mía' });
  const mine = pair((await login({ id: 2, login: 'mia' })).session);
  const mine2 = pair((await login({ id: 2, login: 'mia' })).session);
  const ownerSessionId = listSessions(store, o)[0]!.id;
  const html = await (await call('GET', '/cuenta', { cookie: mine })).text();
  expect(html).toContain('rol member'); expect(html).not.toContain(ownerSessionId);
  expect(html.match(/\/cuenta\/sesiones\/[a-f0-9]{12}\/revocar/g)!.length).toBe(2);
  // Revocar la sesión de otro usuario no la toca.
  const csrf = csrfFor(mine);
  expect((await call('POST', `/cuenta/sesiones/${ownerSessionId}/revocar`, { cookie: mine, form: { csrf } })).status).toBe(400);
  expect(listSessions(store, o).some(s => s.id === ownerSessionId)).toBe(true);
  // Revocar la otra mía: 303 a /cuenta; la actual sigue.
  const otherId = routes.principalOf(new Request(ORIGIN, { headers: { cookie: mine2 } }))!.sessionId!;
  const r = await call('POST', `/cuenta/sesiones/${otherId}/revocar`, { cookie: mine, form: { csrf } });
  expect(r.headers.get('location')).toBe('/cuenta');
  expect(routes.principalOf(new Request(ORIGIN, { headers: { cookie: mine2 } }))).toBeNull();
  expect(routes.principalOf(new Request(ORIGIN, { headers: { cookie: mine } }))).not.toBeNull();
  expect(m.id).toBeTruthy();
  // Cerrar la sesión actual desde la lista limpia la cookie y vuelve al login.
  const cur = routes.principalOf(new Request(ORIGIN, { headers: { cookie: mine } }))!.sessionId!;
  const out = await call('POST', `/cuenta/sesiones/${cur}/revocar`, { cookie: mine, form: { csrf } });
  expect(out.headers.get('location')).toBe('/login'); expect(cookieOf(out, '__Host-fab_session')).toMatch(/Max-Age=0/);
});

test('D-2: viewer sin claves ni sección de claves; member crea y revoca las suyas y el valor sale una vez', async () => {
  const o = seedOwner(1);
  acceptInvitation(store, { code: invite(o, 3, 'viewer'), issuer: GITHUB_ISSUER, subject: '3', displayName: 'V' });
  acceptInvitation(store, { code: invite(o, 4, 'member'), issuer: GITHUB_ISSUER, subject: '4', displayName: 'M' });
  const v = pair((await login({ id: 3, login: 'v' })).session), m = pair((await login({ id: 4, login: 'm' })).session);
  const vPage = await (await call('GET', '/cuenta', { cookie: v })).text();
  expect(vPage).not.toContain('Claves de API'); expect(vPage).toContain('/logout');
  expect((await call('POST', '/cuenta/claves', { cookie: v, form: { csrf: csrfFor(v), name: 'k', scope: 'read' } })).status).toBe(403);
  const made = await call('POST', '/cuenta/claves', { cookie: m, form: { csrf: csrfFor(m), name: 'ci', scope: 'read' } });
  const key = /fabu_[a-f0-9]{12}_[A-Za-z0-9_-]{43}/.exec(await made.text())![0];
  expect(made.status).toBe(200);
  const listed = await (await call('GET', '/cuenta', { cookie: m })).text();
  expect(listed).toContain('>ci<'); expect(listed).not.toContain(key);
  const id = /\/cuenta\/claves\/([a-f0-9]{12})\/revocar/.exec(listed)![1]!;
  expect((await call('POST', `/cuenta/claves/${id}/revocar`, { cookie: v, form: { csrf: csrfFor(v) } })).status).toBe(403); // la de otro
  expect((await call('POST', `/cuenta/claves/${id}/revocar`, { cookie: m, form: { csrf: csrfFor(m) } })).status).toBe(303);
  expect(await (await call('GET', '/cuenta', { cookie: m })).text()).toContain('revocada');
});

test('sin --write no se emiten claves ni se invita; login, logout y sesiones siguen', async () => {
  seedOwner(1); mount(false);
  const s = pair((await login({ id: 1, login: 'd' })).session), csrf = csrfFor(s);
  expect((await call('POST', '/cuenta/claves', { cookie: s, form: { csrf, name: 'k', scope: 'read' } })).status).toBe(403);
  gh.users.set('ana', { id: 5, login: 'ana' });
  expect((await call('POST', '/equipo/invitaciones', { cookie: s, form: { csrf, login: 'ana', role: 'member' } })).status).toBe(403);
  expect((await call('POST', '/logout', { cookie: s, form: { csrf } })).status).toBe(303);
});

test('invitar por login: valida el formato antes de la red, aplica la política antes de la cuota y muestra el ID numérico', async () => {
  const o = seedOwner(1);
  const s = pair((await login({ id: 1, login: 'd' })).session), csrf = csrfFor(s);
  gh.users.set('ana-b', { id: 777, login: 'Ana-B' });
  gh.calls.length = 0;
  for (const bad of ['', 'a/b', '-a', 'a-', 'a--b', 'a b', '../x', 'x'.repeat(40), 'é']) {
    expect((await call('POST', '/equipo/invitaciones', { cookie: s, form: { csrf, login: bad, role: 'member' } })).status).toBe(400);
  }
  expect(gh.calls.length).toBe(0);
  expect(validGithubLogin('a'.repeat(39))).toBe(true);
  // owner no se invita (se promueve).
  expect((await call('POST', '/equipo/invitaciones', { cookie: s, form: { csrf, login: 'ana-b', role: 'owner' } })).status).toBe(400);
  const ok = await call('POST', '/equipo/invitaciones', { cookie: s, form: { csrf, login: 'ana-b', role: 'member' } });
  const html = await ok.text();
  expect(ok.status).toBe(200); expect(html).toContain('777'); expect(html).toContain('Ana-B');
  const codeIn = /<code>([^<]+)<\/code>/.exec(html)![1]!;
  const inv = store.db.query('SELECT expected_issuer, expected_subject FROM user_invitations').get() as { expected_issuer: string; expected_subject: string };
  expect(inv).toEqual({ expected_issuer: GITHUB_ISSUER, expected_subject: '777' });
  // Y esa invitación se canjea con el ID numérico, no con el login.
  expect((await login({ id: 777, login: 'renombrado' }, codeIn)).session).toBeTruthy();
});

test('invitar: un member no llega a GitHub ni gasta cuota; 10 por minuto por invitador', async () => {
  const o = seedOwner(1);
  acceptInvitation(store, { code: invite(o, 4), issuer: GITHUB_ISSUER, subject: '4', displayName: 'M' });
  const m = pair((await login({ id: 4, login: 'm' })).session);
  gh.calls.length = 0;
  expect((await call('POST', '/equipo/invitaciones', { cookie: m, form: { csrf: csrfFor(m), login: 'ana', role: 'member' } })).status).toBe(403);
  expect(gh.calls.length).toBe(0);
  const s = pair((await login({ id: 1, login: 'd' })).session), csrf = csrfFor(s);
  gh.users.set('ana', { id: 5, login: 'ana' });
  for (let i = 0; i < 10; i++) expect((await call('POST', '/equipo/invitaciones', { cookie: s, form: { csrf, login: 'ana', role: 'viewer' } })).status).toBe(200);
  gh.calls.length = 0;
  const r = await call('POST', '/equipo/invitaciones', { cookie: s, form: { csrf, login: 'ana', role: 'viewer' } });
  expect(r.status).toBe(429); expect(r.headers.get('retry-after')).toBeTruthy(); expect(gh.calls.length).toBe(0);
});

test('un nombre visible hostil es dato: se escapa y no cambia el rol ni el actor', async () => {
  const o = seedOwner(1);
  gh.users.set('x', { id: 9, login: 'x' });
  acceptInvitation(store, { code: invite(o, 9), issuer: GITHUB_ISSUER, subject: '9', displayName: '<img src=x onerror=1> rol owner' });
  const s = pair((await login({ id: 9, login: 'x' })).session);
  const html = await (await call('GET', '/cuenta', { cookie: s })).text();
  expect(html).not.toContain('<img'); expect(html).toContain('&lt;img');
  expect(routes.principalOf(new Request(ORIGIN, { headers: { cookie: s } }))!.role).toBe('member');
});

test('T119b-H1: los formularios funcionan con el Origin que pone un navegador según la Referrer-Policy de su página', async () => {
  seedOwner(1);
  // Login: el formulario de /login, con el Origin que el navegador deriva de la política de esa página (sin ponerlo a mano).
  const page = await call('GET', '/login'), pre = pair(cookieOf(page, '__Host-fab_pre')), token = /name="pre" value="([0-9a-f]+)"/.exec(await page.text())![1]!;
  const start = await call('POST', '/auth/start', { cookie: pre, form: { pre: token }, origin: browserOrigin(page) });
  expect(start.status).toBe(303);
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const cb = await call('GET', `/auth/callback?code=${await gh.authorize(start.headers.get('location')!, { id: 1, login: 'd' })}&state=${state}`, { cookie: pair(cookieOf(start, '__Host-fab_login')) });
  // Logout desde /cuenta: igual.
  const s = pair(cookieOf(cb, '__Host-fab_session'));
  const cuenta = await call('GET', '/cuenta', { cookie: s });
  expect(cuenta.headers.get('referrer-policy')).toBe('same-origin');
  const out = await call('POST', '/logout', { cookie: s, form: { csrf: csrfFor(s) }, origin: browserOrigin(cuenta) });
  expect(out.status).toBe(303);
  // Los 303 y las páginas sin formulario (con la cookie de sesión o el código) siguen sin referente.
  expect(out.headers.get('referrer-policy')).toBe('no-referrer');
  expect(start.headers.get('referrer-policy')).toBe('no-referrer');
  expect(cb.headers.get('referrer-policy')).toBe('no-referrer');
});

test('T119b-H2: en recuperación restringida el owner designado entra, /cuenta responde 403 sin excepción y un segundo login con cookie válida no falla', async () => {
  const o = bootstrapOwner(store, { issuer: GITHUB_ISSUER, subject: '1', displayName: 'Dueña', operator: 'op' });
  enterRecovery(store, 'op', 'restauración', o.id);
  const a = await login({ id: 1, login: 'd' });
  expect(a.res.status).toBe(200);
  const cuenta = await call('GET', '/cuenta', { cookie: pair(a.session) });
  expect(cuenta.status).toBe(403);
  const again = await login({ id: 1, login: 'd' }, '', '10.0.0.2');
  const s = pair(a.session);
  const second = await startLogin('', '10.0.0.3');
  const cb = await call('GET', `/auth/callback?code=${await gh.authorize(second.location, { id: 1, login: 'd' })}&state=${new URL(second.location).searchParams.get('state')}`, { cookie: `${second.loginCookie}; ${s}`, ip: '10.0.0.3' });
  expect(again.res.status).toBe(200); expect(cb.status).toBe(200); expect(cookieOf(cb, '__Host-fab_session')).toBeTruthy();
  expect((await call('POST', '/logout', { cookie: s, form: { csrf: csrfFor(s) } })).status).toBe(403); // revocar sesión no vale en recuperación: es de la política (T119e)
});

test('T119b-H3: los intentos basura no agotan los presupuestos globales; solo los canjes y los inicios reales', async () => {
  seedOwner(1);
  // 100 callbacks y 100 inicios inválidos desde IP distintas: ninguno gasta el global.
  for (let i = 0; i < 100; i++) {
    const ip = `10.2.${Math.floor(i / 10)}.${i % 10}`;
    expect((await call('GET', '/auth/callback?code=x&state=nope', { ip })).status).toBe(403);
    expect((await call('POST', '/auth/start', { ip, form: { pre: 'x' } })).status).toBe(403);
  }
  // Un login legítimo sigue entrando.
  expect((await login({ id: 1, login: 'd' }, '', '10.3.0.1')).session).toBeTruthy();
});

test('T119b-H8: 60 canjes por minuto en todo el servidor; el 61 da 429 sin llamar a GitHub', async () => {
  seedOwner(1);
  const t = await startLogin('', '10.5.0.2'), state = new URL(t.location).searchParams.get('state')!; // empezada en otra ventana: no gasta los inicios de la siguiente
  now += 60_000;
  for (let i = 0; i < 60; i++) expect((await login({ id: 1, login: 'd' }, '', `10.4.${Math.floor(i / 10)}.${i % 10}`)).res.status).toBe(200);
  const code = await gh.authorize(t.location, { id: 1, login: 'd' });
  gh.calls.length = 0;
  const r = await call('GET', `/auth/callback?code=${code}&state=${state}`, { cookie: t.loginCookie, ip: '10.5.0.2' });
  expect(r.status).toBe(429); expect(gh.calls.length).toBe(0);
});

test('T119b-H4: el GitHub falso comprueba PKCE y redirect_uri como el real', async () => {
  const s = await startLogin();
  const code = await gh.authorize(s.location, { id: 1, login: 'd' });
  const exchange = (body: Record<string, unknown>) => fetch(`${gh.url}/login/oauth/access_token`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, ...body }) }).then(r => r.json() as Promise<{ access_token?: string }>);
  const verifier = 'x'.repeat(43), uri = `${ORIGIN}/auth/callback`;
  expect((await exchange({ code_verifier: verifier, redirect_uri: uri })).access_token).toBeUndefined(); // verificador que no corresponde al challenge
  expect((await exchange({ code_verifier: 'otro', redirect_uri: `${ORIGIN}/otra` })).access_token).toBeUndefined();
  // El authorize con otro redirect o sin S256 se rechaza.
  const bad = new URL(s.location); bad.searchParams.set('redirect_uri', `${ORIGIN}/otra`);
  expect((await fetch(bad, { redirect: 'manual' })).status).toBe(400);
  const plainMethod = new URL(s.location); plainMethod.searchParams.set('code_challenge_method', 'plain');
  expect((await fetch(plainMethod, { redirect: 'manual' })).status).toBe(400);
});

test('T119b-H4: resolveLogin va con las credenciales de la aplicación y una cuota agotada es «inténtalo más tarde», no «usuario inexistente»', async () => {
  seedOwner(1);
  const s = pair((await login({ id: 1, login: 'd' })).session), csrf = csrfFor(s);
  gh.users.set('ana', { id: 5, login: 'ana' }); gh.calls.length = 0;
  expect((await call('POST', '/equipo/invitaciones', { cookie: s, form: { csrf, login: 'ana', role: 'member' } })).status).toBe(200);
  expect(gh.calls.find(c => c.path === '/api/users/ana')!.auth).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`);
  gh.fail.quota = true;
  const r = await call('POST', '/equipo/invitaciones', { cookie: s, form: { csrf, login: 'ana', role: 'member' } });
  expect(r.status).toBe(503); expect(r.headers.get('retry-after')).toBeTruthy();
  expect(store.db.query('SELECT COUNT(*) AS n FROM user_invitations').get()).toEqual({ n: 1 });
});

test('T119b-H5: un rol inválido no gasta cuota ni llega a GitHub', async () => {
  seedOwner(1);
  const s = pair((await login({ id: 1, login: 'd' })).session), csrf = csrfFor(s);
  gh.users.set('ana', { id: 5, login: 'ana' }); gh.calls.length = 0;
  for (let i = 0; i < 12; i++) for (const role of ['zzz', 'owner', '']) expect((await call('POST', '/equipo/invitaciones', { cookie: s, form: { csrf, login: 'ana', role } })).status).toBe(400);
  expect(gh.calls.length).toBe(0);
  // La cuota (10/min) sigue intacta tras 36 intentos inválidos.
  expect((await call('POST', '/equipo/invitaciones', { cookie: s, form: { csrf, login: 'ana', role: 'admin' } })).status).toBe(200);
});

test('T119b-H6: un cuerpo en trozos sin Content-Length se corta al pasar del tope, sin leerlo entero', async () => {
  const page = await call('GET', '/login'), pre = pair(cookieOf(page, '__Host-fab_pre'));
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) { if (++pulled > 1000) return c.close(); c.enqueue(new Uint8Array(1024).fill(97)); } });
  const res = await routes.handle(new Request(`${ORIGIN}/auth/start`, { method: 'POST', body, duplex: 'half',
    headers: { host: HOST, origin: ORIGIN, cookie: pre, 'content-type': 'application/x-www-form-urlencoded' } } as RequestInit), '10.0.0.1');
  expect(res!.status).toBe(403);
  expect(pulled).toBeLessThan(20); // 4 KiB de tope: no se leyó el megabyte
});

test('T119b-H7: publicOrigin se valida al construir: https, sin ruta, sin barra final', () => {
  for (const bad of ['http://fab.test', 'https://fab.test/', 'https://fab.test/app', 'https://fab.test?x=1', 'fab.test', '']) {
    expect(() => new GithubConnector({ clientId: CLIENT_ID, clientSecret: () => CLIENT_SECRET, publicOrigin: bad })).toThrow('publicOrigin');
    expect(() => identityRoutes({ store, github: routes as never, publicOrigin: bad, write: true })).toThrow('publicOrigin');
  }
  expect(() => new GithubConnector({ clientId: CLIENT_ID, clientSecret: () => CLIENT_SECRET, publicOrigin: 'https://fab.test:8443' })).not.toThrow();
});

test('T119b-H9: el token de prelogin caduca a los 5 minutos en servidor y no se puede rejuvenecer', async () => {
  const page = await call('GET', '/login'), pre = pair(cookieOf(page, '__Host-fab_pre')), token = /name="pre" value="([0-9a-f]+)"/.exec(await page.text())![1]!;
  now += 5 * 60_000; // justo en el límite sigue valiendo
  expect((await call('POST', '/auth/start', { cookie: pre, form: { pre: token } })).status).toBe(303);
  now += 1;
  expect((await call('POST', '/auth/start', { cookie: pre, form: { pre: token }, ip: '10.0.0.2' })).status).toBe(403);
  // Cambiar la marca de tiempo por una reciente invalida el HMAC.
  const forged = now.toString(16).padStart(12, '0') + token.slice(12);
  expect((await call('POST', '/auth/start', { cookie: pre, form: { pre: forged }, ip: '10.0.0.3' })).status).toBe(403);
  // Y una marca de tiempo futura no vale.
  const future = (await call('GET', '/login'));
  const t2 = /name="pre" value="([0-9a-f]+)"/.exec(await future.text())![1]!;
  now -= 10 * 60_000;
  expect((await call('POST', '/auth/start', { cookie: pair(cookieOf(future, '__Host-fab_pre')), form: { pre: t2 }, ip: '10.0.0.4' })).status).toBe(403);
});

test('T119b-H8: revocar una clave exige --write', async () => {
  const o = seedOwner(1);
  const k = createUserKey(store, o, 'ci', 'read', { write: true });
  mount(false);
  const s = pair((await login({ id: 1, login: 'd' })).session);
  const id = listUserKeys(store, o)[0]!.id;
  expect(k.key).toBeTruthy();
  expect((await call('POST', `/cuenta/claves/${id}/revocar`, { cookie: s, form: { csrf: csrfFor(s) } })).status).toBe(403);
  expect(listUserKeys(store, o)[0]!.revokedAt).toBeFalsy();
});

test('T119b-H8: el prelogin de un navegador no vale con la cookie de otro', async () => {
  const a = await call('GET', '/login'), b = await call('GET', '/login');
  const tokenA = /name="pre" value="([0-9a-f]+)"/.exec(await a.text())![1]!;
  expect((await call('POST', '/auth/start', { cookie: pair(cookieOf(b, '__Host-fab_pre')), form: { pre: tokenA } })).status).toBe(403);
  expect((await call('POST', '/auth/start', { cookie: pair(cookieOf(a, '__Host-fab_pre')), form: { pre: tokenA } })).status).toBe(303);
});

test('T119b-H8: 60 invitaciones por minuto en todo el servidor aunque cada invitador esté bajo su tope', async () => {
  const o = seedOwner(1);
  const sessions: { s: string; csrf: string }[] = [];
  for (let i = 0; i < 7; i++) {
    acceptInvitation(store, { code: invite(o, 100 + i, 'admin'), issuer: GITHUB_ISSUER, subject: String(100 + i), displayName: `a${i}` });
    const s = pair((await login({ id: 100 + i, login: `a${i}` }, '', `10.8.0.${i}`)).session);
    sessions.push({ s, csrf: csrfFor(s) });
  }
  gh.users.set('ana', { id: 5, login: 'ana' });
  let n = 0;
  for (const { s, csrf } of sessions.slice(0, 6)) for (let i = 0; i < 10; i++, n++) expect((await call('POST', '/equipo/invitaciones', { cookie: s, form: { csrf, login: 'ana', role: 'viewer' } })).status).toBe(200);
  expect(n).toBe(60);
  gh.calls.length = 0;
  const r = await call('POST', '/equipo/invitaciones', { cookie: sessions[6]!.s, form: { csrf: sessions[6]!.csrf, login: 'ana', role: 'viewer' } });
  expect(r.status).toBe(429); expect(gh.calls.length).toBe(0);
});

test('T119b-H8: formulario de inicio: solo urlencoded, con Content-Length y cuerpo bajo el tope', async () => {
  const page = await call('GET', '/login'), pre = pair(cookieOf(page, '__Host-fab_pre')), token = /name="pre" value="([0-9a-f]+)"/.exec(await page.text())![1]!;
  const ok = { cookie: pre };
  expect((await call('POST', '/auth/start', { ...ok, form: { pre: token }, headers: { 'content-type': 'text/plain' } })).status).toBe(403); // tipo
  expect((await call('POST', '/auth/start', { ...ok, form: { pre: token }, headers: { 'content-length': '5000' } })).status).toBe(403); // declarado
  expect((await call('POST', '/auth/start', { ...ok, form: { pre: token, pad: 'x'.repeat(5000) }, ip: '10.0.0.2' })).status).toBe(403); // real
  expect((await call('POST', '/auth/start', { ...ok, form: { pre: token }, ip: '10.0.0.3' })).status).toBe(303);
});

test('T119b-H8: un proveedor que no responde corta en el timeout y da la respuesta pública de siempre', async () => {
  seedOwner(1); mount(true, 30);
  gh.fail.hangToken = true;
  const r = await login({ id: 1, login: 'd' });
  expect(r.res.status).toBe(403);
});

test('T119b-H8: un ID de GitHub fuera del rango entero seguro no entra aunque exista una cuenta con ese texto', async () => {
  const o = seedOwner(1);
  acceptInvitation(store, { code: invite(o, 2 ** 53), issuer: GITHUB_ISSUER, subject: String(2 ** 53), displayName: 'g' });
  gh.fail.userId = 2 ** 53;
  expect((await login({ id: 1, login: 'd' })).res.status).toBe(403);
});

test('T119b-H8: quien ya tiene cuenta y pega un código de invitación entra y no lo gasta', async () => {
  const o = seedOwner(1);
  const code = invite(o, 50, 'viewer');
  const r = await login({ id: 1, login: 'd' }, code);
  expect(r.session).toBeTruthy();
  expect(store.db.query('SELECT consumed_at FROM user_invitations').get()).toEqual({ consumed_at: null });
});
