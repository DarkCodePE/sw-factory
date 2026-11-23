// T119e: el modo servidor completo sobre el socket Unix, con GitHub falso. Cada rol ve y hace solo lo suyo, por HTTP real:
// identidad → API de usuario → CLI remota → activos → principalOf → recuperación → POST de negocio → GET autorizado antes de abrir el Store.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { CANARIO_ACTIVITY, CANARIO_EVENT, cloudServer, HOST, type CloudServer } from './helpers/cloud-server.ts';
import { ORIGIN, ROLE_LIST, SECRET } from './helpers/cloud.ts';
import { csrfToken } from '../src/web-auth.ts';
import { enterRecovery, issueSession, resolvePrincipal, declareNoJournal, type Role } from '../src/users.ts';

let s: CloudServer;
beforeEach(() => { s = cloudServer(); });
afterEach(() => s.stop());

const html = { accept: 'text/html' };

test('sin sesión: 401 en todo lo de negocio, redirección al login para un navegador, y los activos y el login siguen abiertos', async () => {
  for (const p of ['/', '/changes', `/changes/${s.changeId}`, '/signals', '/config', '/metricas']) expect([p, (await s.call(p)).status]).toEqual([p, 401]);
  const nav = await s.call('/', { headers: html });
  expect([nav.status, nav.headers.get('location')]).toEqual([303, '/login']);
  for (const p of ['/style.css', '/poll.js', '/login', '/healthz']) expect([p, (await s.call(p)).status]).toEqual([p, 200]);
  expect((await s.call('/signals', { method: 'POST', body: 'x', headers: { origin: ORIGIN } })).status).toBe(401);
});

test('todas las respuestas del servidor llevan anti-marco y HSTS, también las de identidad, y el cuerpo tiene tope', async () => {
  for (const r of [await s.call('/login'), await s.call('/'), await s.call('/style.css'), await s.call('/healthz'), await s.call('/api/v1/workstreams')]) {
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(r.headers.get('strict-transport-security')).toContain('max-age=31536000');
  }
  // Sin sesión: si el 413 no lo da el servidor antes del despacho, la respuesta sería 401.
  const big = await s.call('/signals', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1), headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' } });
  expect(big.status).toBe(413);
});

// GET por rol: 200 donde hay vista para ese rol; el viewer nunca recibe 200 en una ruta sin vista estructurada.
const SIN_VISTA_DE_VIEWER = ['/changes', '/automations', '/flujo', '/metricas', '/benchmarks', '/experimentos', '/config', '/config/runners', '/perfiles', '/definicion', '/automejora', '/webhooks', '/automations/nueva', '/workstreams/nuevo'];
test('GET por rol: owner, admin y member abren las páginas; el viewer solo las que tienen vista estructurada', async () => {
  for (const role of ['owner', 'admin', 'member'] as const) {
    for (const p of ['/', '/changes', '/signals', '/workstreams', '/flujo', '/metricas', `/changes/${s.changeId}`, `/activities/${s.activityId}`]) {
      expect([role, p, (await s.call(p, { as: role })).status]).toEqual([role, p, 200]);
    }
  }
  for (const p of SIN_VISTA_DE_VIEWER) expect(['viewer', p, (await s.call(p, { as: 'viewer' })).status]).toEqual(['viewer', p, 403]);
  for (const p of ['/signals', '/workstreams', `/changes/${s.changeId}`, `/activities/${s.activityId}`]) expect(['viewer', p, (await s.call(p, { as: 'viewer' })).status]).toEqual(['viewer', p, 200]);
  const home = await s.call('/', { as: 'viewer' });
  expect([home.status, home.headers.get('location')]).toEqual([303, '/workstreams']);
  expect((await s.call('/ruta/que/no/existe', { as: 'owner' })).status).toBe(404); // falla cerrado también para el owner
});

test('el viewer no recibe texto libre de workers ni la ruta del repo; el owner sí ve el comentario y el evento', async () => {
  const owner = await (await s.call(`/activities/${s.activityId}`, { as: 'owner' })).text();
  expect(owner).toContain(CANARIO_ACTIVITY);
  expect(await (await s.call(`/changes/${s.changeId}`, { as: 'owner' })).text()).toContain(CANARIO_EVENT);
  for (const p of [`/activities/${s.activityId}`, `/changes/${s.changeId}`, '/workstreams', '/signals']) {
    const t = await (await s.call(p, { as: 'viewer' })).text();
    for (const canary of [CANARIO_ACTIVITY, CANARIO_EVENT, 'repo-canario']) expect([p, t.includes(canary)]).toEqual([p, false]);
  }
  expect(await (await s.call('/workstreams', { as: 'admin' })).text()).not.toContain('repo-canario'); // la ruta del repo no sale a ningún rol (§4.2)
});

test('menú filtrado: el viewer no ve enlaces a lo que daría 403, y el owner ve la configuración', async () => {
  const nav = (t: string) => t.match(/<nav aria-label="Navegación principal">(.*?)<\/nav>/s)![1]!;
  const v = nav(await (await s.call('/workstreams', { as: 'viewer' })).text());
  expect(v).toContain('href="/workstreams"'); expect(v).toContain('href="/signals"');
  for (const p of ['/config', '/metricas', '/changes', '/perfiles', '/benchmarks']) expect(v).not.toContain(`href="${p}"`);
  expect(nav(await (await s.call('/', { as: 'owner' })).text())).toContain('href="/config"');
  expect(nav(await (await s.call('/', { as: 'member' })).text())).not.toContain('href="/config"');
});

test('/config: el admin no ve credenciales del host ni la ruta; el owner ve los indicadores', async () => {
  process.env.JIRA_HOSTNAME = 'j.invalid';
  try {
    const admin = await (await s.call('/config', { as: 'admin' })).text();
    for (const t of ['Credencial local', 'Jira (entorno)', 'definida en el entorno del proceso fab web', '>Ruta<']) expect(admin, t).not.toContain(t);
    expect(await (await s.call('/config', { as: 'owner' })).text()).toContain('Jira (entorno)');
  } finally { delete process.env.JIRA_HOSTNAME; }
});

test('POST de negocio: cada rol hace solo lo suyo, con Origin y CSRF, y el actor es el de la sesión', async () => {
  const create = (role: Role, title: string, extra: Record<string, string> = {}) => s.post(role, '/signals', { workstream: s.ws.slug, title, body: 'b', ...extra });
  for (const role of ['owner', 'admin', 'member'] as const) expect([role, (await create(role, `señal ${role}`)).status]).toEqual([role, 303]);
  expect((await create('viewer', 'señal viewer')).status).toBe(403);
  const raw = (role: Role, csrf: string, headers: Record<string, string>) => s.call('/signals', { method: 'POST', as: role, headers,
    body: new URLSearchParams({ csrf, workstream: s.ws.slug, title: 'no debe crearse' }) });
  expect((await raw('owner', 'otro', { origin: ORIGIN })).status).toBe(403); // CSRF incorrecto
  expect((await raw('member', s.csrf('owner'), { origin: ORIGIN })).status).toBe(403); // CSRF de otra sesión
  expect((await raw('owner', s.csrf('owner'), {})).status).toBe(403); // sin Origin
  expect((await raw('owner', s.csrf('owner'), { origin: 'https://otro.example' })).status).toBe(403); // Origin ajeno
  const titles = s.c.store.listSignals(s.ws.id, 'new').map(x => x.title).sort();
  expect(titles).toEqual(['señal admin', 'señal member', 'señal owner']);
  const actors = s.c.store.db.query("SELECT actor FROM events WHERE message LIKE 'signal creada desde la web%'").all() as { actor: string }[];
  expect(actors.map(a => a.actor).sort()).toEqual([s.c.web.admin, s.c.web.member, s.c.web.owner].map(p => `user:${p.userId}`).sort());
});

test('con --server sin --write no hay mutaciones de negocio para nadie, pero sí login y sesiones propias', async () => {
  s.stop(); s = cloudServer({ write: false });
  for (const role of ROLE_LIST) expect([role, (await s.post(role, '/signals', { workstream: s.ws.slug, title: 'x' })).status]).toEqual([role, 403]);
  expect((await s.call('/automations/nueva', { as: 'owner' })).status).toBe(403);
  expect((await s.call('/workstreams', { as: 'owner' })).status).toBe(200);
  expect((await s.post('member', '/logout', {})).status).toBe(303);
});

test('API de usuario: solo fabu_ con rol vigente; la clave local y la ausencia dan 401; el viewer no tiene clave', async () => {
  const ok = await s.call('/api/v1/workstreams', { headers: { authorization: `Bearer ${s.c.keys.member.read}` } });
  expect(ok.status).toBe(200);
  expect((await s.call('/api/v1/workstreams', { headers: { authorization: `Bearer ${s.c.store.createApiKey('local', 'read').key}` } })).status).toBe(401);
  expect((await s.call('/api/v1/workstreams')).status).toBe(401);
  // Un bearer no necesita Origin (no hay cookies); una cookie de sesión no abre la API.
  expect((await s.call('/api/v1/workstreams', { as: 'owner' })).status).toBe(401);
  const post = await s.call(`/api/v1/changes/${s.changeId}/note`, { method: 'POST', headers: { authorization: `Bearer ${s.c.keys.member.decide}`, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'nota por API' }) });
  expect(post.status).toBeLessThan(300);
  expect((await s.call('/api/v1/automations', { method: 'POST', headers: { authorization: `Bearer ${s.c.keys.owner.decide}`, 'content-type': 'application/json' }, body: '{}' })).status).toBe(404); // api:false no es ruta ni para el owner
});

test('CLI remota por el socket: pareo con confirmación humana, canje con el verificador y operaciones con la sesión CLI', async () => {
  const verifier = 'verificador-secreto-de-la-terminal';
  const json = { 'content-type': 'application/json' };
  const start = await (await s.call('/cli/v1/pair/start', { method: 'POST', headers: json, body: JSON.stringify({ challenge: createHash('sha256').update(verifier).digest('hex') }) })).json() as any;
  expect(start.data.url).toBe(`${ORIGIN}/cuenta/cli/autorizar`);
  const code = start.data.code as string;
  // La persona abre la URL fija (sin el código en ella), lo teclea y confirma: sesión web + Origin + CSRF.
  expect((await s.call('/cuenta/cli/autorizar', { as: 'member', headers: html })).status).toBe(200);
  const typed = await s.post('member', '/cuenta/cli/autorizar', { code });
  expect(typed.status).toBe(200);
  expect(await typed.text()).toContain('member');
  const approved = await s.post('member', '/cuenta/cli/autorizar', { code, confirm: 'yes' });
  expect(approved.status).toBeLessThan(400);
  const ex = await (await s.call('/cli/v1/pair/exchange', { method: 'POST', headers: json, body: JSON.stringify({ code, verifier }) })).json() as any;
  const token = ex.data.token as string;
  expect(token).toMatch(/^fabs_/);
  const ops = (op: string, fields: Record<string, unknown> = {}) => s.call('/cli/v1/commands', { method: 'POST', headers: { ...json, authorization: `Bearer ${token}` }, body: JSON.stringify({ op, fields }) });
  expect((await ops('ops/read', { path: '/workstreams' })).status).toBe(200);
  expect((await ops('automations/create', {})).status).toBe(403); // member no crea automations
  expect((await s.call('/cli/v1/commands', { method: 'POST', headers: { ...json, authorization: `Bearer ${s.c.tokens.web.member}` }, body: JSON.stringify({ op: 'ops/read', fields: { path: '/workstreams' } }) })).status).toBe(401); // una sesión web no vale en la CLI
});

test('recuperación restringida: solo el owner designado entra, solo ve /recuperacion y puede cerrar su sesión; confirmar reabre el equipo', async () => {
  enterRecovery(s.c.store, 'op', 'restauración', s.c.web.owner.userId);
  declareNoJournal(s.c.store, 'op', 'sin diario');
  const token = issueSession(s.c.store, s.c.web.owner.userId, 'web').token;
  const as = (path: string, init: RequestInit = {}) => s.call(path, { ...init, headers: { cookie: `__Host-fab_session=${token}`, ...(init.headers as Record<string, string>) } });
  expect((await s.call('/', { as: 'member' })).status).toBe(401); // otras sesiones ya cortadas
  for (const p of ['/', '/changes', '/signals', '/config']) expect([p, (await as(p)).status]).toEqual([p, 403]);
  expect((await as('/', { headers: html })).headers.get('location')).toBe('/recuperacion');
  const principal = resolvePrincipal(s.c.store, token, 'web')!;
  const csrf = csrfToken(SECRET, principal.sessionId!);
  const screen = await as('/recuperacion');
  expect(screen.status).toBe(200);
  const body = await screen.text();
  for (const r of ROLE_LIST) expect(body).toContain(`>${r}<`);
  const post = (path: string, body: URLSearchParams, origin = ORIGIN) => as(path, { method: 'POST', body, headers: { origin, 'content-type': 'application/x-www-form-urlencoded' } });
  const list = [...body.matchAll(/name="c" value="([^"]+)"/g)].map(m => m[1]!);
  expect(list.length).toBe(4);
  const form = (omit?: string) => { const f = new URLSearchParams({ csrf }); for (const v of list) if (!omit || !v.startsWith(omit)) f.append('c', v); return f; };
  expect((await post('/recuperacion/confirmar', form(), 'https://otro.example')).status).toBe(403);
  expect((await post('/recuperacion/confirmar', new URLSearchParams({ csrf: 'mal' }))).status).toBe(403);
  const viewerId = s.c.web.viewer.userId;
  const done = await post('/recuperacion/confirmar', form(viewerId));
  expect(done.status).toBe(303);
  // El viewer no confirmado queda suspendido; el resto sigue, y el equipo vuelve a operar.
  expect(s.c.store.db.query('SELECT disabled_at FROM users WHERE id = ?').get(viewerId)).toMatchObject({ disabled_at: expect.any(String) });
  expect((await as('/signals')).status).toBe(200);
});

test('en recuperación no se empareja una CLI: ni la pantalla ni el canje, ni un pareo aprobado antes (T119e-H1)', async () => {
  const verifier = 'verificador-secreto-de-la-terminal';
  const json = { 'content-type': 'application/json' };
  const pair = async () => ((await (await s.call('/cli/v1/pair/start', { method: 'POST', headers: json, body: JSON.stringify({ challenge: createHash('sha256').update(verifier).digest('hex') }) })).json()) as any).data.code as string;
  const exchange = (code: string) => s.call('/cli/v1/pair/exchange', { method: 'POST', headers: json, body: JSON.stringify({ code, verifier }) });
  const antes = await pair(); // aprobado por el owner antes de la recuperación
  await s.post('owner', '/cuenta/cli/autorizar', { code: antes });
  expect((await s.post('owner', '/cuenta/cli/autorizar', { code: antes, confirm: 'yes' })).status).toBeLessThan(400);
  enterRecovery(s.c.store, 'op', 'restauración', s.c.web.owner.userId);
  declareNoJournal(s.c.store, 'op', 'sin diario');
  const token = issueSession(s.c.store, s.c.web.owner.userId, 'web').token;
  const principal = resolvePrincipal(s.c.store, token, 'web')!;
  const as = (path: string, init: RequestInit = {}) => s.call(path, { ...init, headers: { cookie: `__Host-fab_session=${token}`, ...(init.headers as Record<string, string>) } });
  expect((await as('/cuenta/cli/autorizar')).status).toBe(403);
  const durante = await pair();
  const post = (fields: Record<string, string>) => as('/cuenta/cli/autorizar', { method: 'POST', body: new URLSearchParams({ csrf: csrfToken(SECRET, principal.sessionId!), ...fields }), headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' } });
  expect((await post({ code: durante })).status).toBe(403);
  expect((await post({ code: durante, confirm: 'yes' })).status).toBe(403);
  expect(s.c.store.db.query("SELECT count(*) n FROM user_sessions WHERE class = 'cli' AND revoked_at IS NULL").get()).toMatchObject({ n: 0 });
  for (const code of [antes, durante]) expect((await exchange(code)).status).toBeGreaterThanOrEqual(400);
});

test('avisos de formulario por sesión: el resultado de un POST lo ve esa sesión una sola vez y no otra', async () => {
  const done = await s.post('owner', '/signals', { workstream: s.ws.slug, title: 'con aviso' });
  expect([done.status, done.headers.get('location')]).toEqual([303, '/signals']);
  expect(await (await s.call('/signals', { as: 'member' })).text()).not.toContain('role="status"');
  expect(await (await s.call('/signals', { as: 'owner' })).text()).toContain('role="status"');
  expect(await (await s.call('/signals', { as: 'owner' })).text()).not.toContain('role="status"');
});

test('la IP del límite sale solo de X-Fab-Client-IP del proxy: X-Forwarded-For no cambia el cubo y sin cabecera hay un cubo común', async () => {
  const start = (headers: Record<string, string>) => s.call('/auth/start', { method: 'POST', body: 'x', ip: '', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...headers } });
  const seen: number[] = [];
  for (let i = 0; i < 12; i++) seen.push((await start({ 'x-fab-client-ip': '198.51.100.7', 'x-forwarded-for': `10.0.0.${i}` })).status);
  expect(seen.slice(0, 10).every(n => n === 403)).toBe(true);
  expect(seen.slice(10)).toEqual([429, 429]);
  expect((await start({ 'x-fab-client-ip': '198.51.100.8' })).status).toBe(403); // otra IP del proxy: cubo propio
  const noIp: number[] = [];
  for (let i = 0; i < 12; i++) noIp.push((await start({ 'x-fab-client-ip': 'no-es-una-ip', 'x-forwarded-for': `10.1.0.${i}` })).status);
  expect(noIp.slice(10)).toEqual([429, 429]);
});

test('la página local de claves (por nombre) no se sirve en servidor: las claves de usuario se gestionan en /cuenta', async () => {
  const path = (await import('../src/web-api-keys.ts')).API_KEYS_PATH;
  for (const role of ['owner', 'admin', 'member'] as const) {
    const r = await s.call(path, { as: role });
    expect([role, r.status, r.headers.get('location')]).toEqual([role, 303, '/cuenta']);
  }
  expect((await s.call(path, { as: 'viewer' })).status).toBe(403);
});

// El navegador real lo descubrió: con `form-action 'self'`, Chrome bloquea la redirección de /auth/start hacia GitHub (e2e de nube).
test('la CSP de /login admite en form-action solo el origen de autorización de GitHub; el resto de páginas, solo self', async () => {
  const login = (await s.call('/login')).headers.get('content-security-policy')!;
  expect(login).toContain(`form-action 'self' ${new URL(s.gh.url).origin};`);
  expect(login).toContain("frame-ancestors 'none'");
  for (const p of ['/style.css', '/healthz']) expect((await s.call(p)).headers.get('content-security-policy')).toContain("form-action 'self';");
  expect((await s.call('/signals', { as: 'owner' })).headers.get('content-security-policy')).toContain("form-action 'self';");
  const page = await (await s.call('/login')).text();
  expect(page).toContain('<link rel="stylesheet" href="/style.css">'); // style-src 'self' no admite estilos en línea
  expect(page).not.toContain('<style>');
});

// El navegador real lo descubrió (e2e de nube): con `no-referrer` Chrome manda `Origin: null` en el POST de un formulario del mismo origen.
test('las páginas con formulario salen con Referrer-Policy same-origin y las que no, con no-referrer', async () => {
  const conForm = await s.call('/signals', { as: 'owner' });
  expect(await conForm.clone().text()).toContain('<form');
  expect(conForm.headers.get('referrer-policy')).toBe('same-origin');
  const sinForm = await s.call('/workstreams', { as: 'viewer' });
  expect(await sinForm.clone().text()).not.toContain('<form');
  expect(sinForm.headers.get('referrer-policy')).toBe('no-referrer');
  expect(await sinForm.text()).toContain('Solo lectura'); // el viewer no ve «Escritura habilitada»
  expect(await (await s.call('/signals', { as: 'member' })).text()).toContain('Escritura habilitada');
  expect((await s.call('/style.css')).headers.get('referrer-policy')).toBe('no-referrer');
});

test('el enlace de un solo uso local (/auth?token=) no existe en servidor', async () => {
  expect((await s.call('/auth?token=cualquiera')).status).toBe(401);
  expect((await s.call('/auth?token=cualquiera', { as: 'owner' })).status).toBe(404);
});
