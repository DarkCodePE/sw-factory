// E2E de nube (T119e): `bun run e2e:nube` (y al final de `bun run e2e`). El modo servidor completo (`startWeb --server --write`) sobre un socket Unix,
// con un frontal HTTPS que hace de Caddy (certificado autofirmado, X-Fab-Client-IP, sin X-Forwarded-*) y un GitHub falso. Navegador real
// (agent-browser, sesión `t119e`) para el login de los tres roles y un formulario; la CLI remota real (`fab --remote`) se parea y opera.
// Nunca usa ~/.fabrica, red externa ni agentes reales. Sin esperas fijas: se espera a condiciones.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../../src/store.ts';
import { acceptInvitation, bootstrapOwner, inviteUser, issueSession, resolvePrincipal, type Principal, type Role } from '../../src/users.ts';
import { GithubConnector } from '../../src/web-identity.ts';
import { startWeb } from '../../src/web.ts';
import { SESSION_COOKIE } from '../../src/web-auth.ts';
import { CLIENT_ID, CLIENT_SECRET, startFakeGithub } from '../../tests/helpers/fake-github.ts';

const ROOT = resolve(import.meta.dir, '../..');
const CAPTURAS = process.env.E2E_CAPTURAS ? resolve(process.env.E2E_CAPTURAS) : join(ROOT, '.e2e/capturas-nube');
const SESSION = 't119e';
const TOPE_MS = 20_000;
const tmp = mkdtempSync(join(tmpdir(), 'fab-e2e-nube-'));
type Resultado = { flujo: string; ok: boolean; detalle: string };
const resultados: Resultado[] = [];
let captura = 0;

const assert = (cond: unknown, msg: string): asserts cond => { if (!cond) throw new Error(msg); };
const eq = <T>(a: T, e: T, msg: string) => assert(a === e, `${msg}: esperaba ${JSON.stringify(e)}, obtuve ${JSON.stringify(a)}`);
async function flujo(nombre: string, fn: () => Promise<void> | void) {
  try { await fn(); resultados.push({ flujo: nombre, ok: true, detalle: '' }); console.log(`  ok      ${nombre}`); }
  catch (e) {
    const detalle = e instanceof Error ? e.message : String(e);
    resultados.push({ flujo: nombre, ok: false, detalle }); console.log(`  FALLO   ${nombre}: ${detalle.split('\n')[0]}`);
    try { await ab('screenshot', join(CAPTURAS, `fallo-${nombre.replace(/\W+/g, '-')}.png`)); } catch { /* sin navegador */ }
  }
}
async function ab(...args: string[]): Promise<string> {
  // Asíncrono: los servidores corren en este proceso y un spawnSync los dejaría sin atender.
  const proc = Bun.spawn(['agent-browser', '--session', SESSION, '--args', '--no-sandbox,--ignore-certificate-errors', ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: String(TOPE_MS) } });
  const timer = setTimeout(() => proc.kill(), 45_000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`agent-browser ${args.join(' ')}: ${err.trim() || out.trim()}`);
  return out.trim();
}
const abrir = async (url: string) => { await ab('open', url); await ab('wait', '--load', 'domcontentloaded'); };
const click = async (sel: string) => { await ab('scrollintoview', sel); return ab('click', sel); };
const texto = (sel = 'body') => ab('get', 'text', sel);
mkdirSync(CAPTURAS, { recursive: true }); // antes de los flujos: `foto()` escribe desde el primero (T119e-H3)
const foto = (n: string) => ab('screenshot', '--full', join(CAPTURAS, `${String(++captura).padStart(2, '0')}-${n}.png`));

// ---- infraestructura -------------------------------------------------------------------------------------------
const certPem = join(tmp, 'cert.pem'), keyPem = join(tmp, 'key.pem');
const ssl = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPem, '-out', certPem, '-days', '1', '-subj', '/CN=fab.localhost', '-addext', 'subjectAltName=DNS:fab.localhost'], { stderr: 'pipe' });
assert(ssl.exitCode === 0, `openssl: ${ssl.stderr.toString()}`);

const stateDir = join(tmp, 'state'); mkdirSync(stateDir, { mode: 0o700 });
const socket = join(tmp, 'fab.sock');
const store = new Store(join(stateDir, 'fabrica.db'));
const cuentas = { owner: { id: 1, login: 'duena' }, member: { id: 2, login: 'miembro' }, viewer: { id: 3, login: 'lectora' } };
let cuenta = cuentas.owner;

// Frontal: reenvía al socket con el Host original, la IP del cliente y sin cabeceras de forwarding del cliente (lo que hace Caddy).
const reenviar = (hostFijo?: string) => async (req: Request): Promise<Response> => {
  const u = new URL(req.url), h = new Headers(req.headers);
  for (const k of [...h.keys()]) if (k.startsWith('x-forwarded-')) h.delete(k);
  h.set('x-fab-client-ip', '127.0.0.1'); if (hostFijo) h.set('host', hostFijo);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return fetch(`http://localhost${u.pathname}${u.search}`, { method: req.method, headers: h, body: hasBody ? await req.arrayBuffer() : undefined, redirect: 'manual', unix: socket } as RequestInit);
};
const tls = Bun.serve({ port: 0, hostname: '127.0.0.1', tls: { cert: Bun.file(certPem), key: Bun.file(keyPem) }, fetch: (req, srv) => reenviar()(req) });
const ORIGIN = `https://fab.localhost:${tls.port}`;
const plain = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: reenviar(`fab.localhost:${tls.port}`) }); // para `fab --remote` (http solo en 127.0.0.1)
const gh = startFakeGithub(`${ORIGIN}/auth/callback`);
// El navegador visita este puente en lugar de github.com: llama al `authorize` del falso (con sus comprobaciones de PKCE y redirect).
const puente = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const u = new URL(req.url);
  try {
    const code = await gh.authorize(`${gh.url}/login/oauth/authorize${u.search}`, cuenta);
    return new Response(null, { status: 302, headers: { location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}` } });
  } catch (e) { return new Response(`authorize rechazado: ${(e as Error).message}`, { status: 400 }); }
} });
const github = new GithubConnector({ clientId: CLIENT_ID, clientSecret: () => CLIENT_SECRET, publicOrigin: ORIGIN,
  authorizeUrl: `http://127.0.0.1:${puente.port}/login/oauth/authorize`, tokenUrl: `${gh.url}/login/oauth/access_token`, apiBase: `${gh.url}/api` });

// ---- datos -----------------------------------------------------------------------------------------------------
const dueña = bootstrapOwner(store, { issuer: 'github', subject: String(cuentas.owner.id), displayName: 'Dueña', operator: 'e2e' });
const principal = (userId: string): Principal => resolvePrincipal(store, issueSession(store, userId, 'web').token, 'web')!;
const pDueña = principal(dueña.id);
const invitar = (c: { id: number }, role: Role) => inviteUser(store, pDueña, { expectedIssuer: 'github', expectedSubject: String(c.id), role }).code;
const codigo = { member: invitar(cuentas.member, 'member'), viewer: invitar(cuentas.viewer, 'viewer') };
const repo = join(tmp, 'repo-canario'); mkdirSync(join(repo, '.git'), { recursive: true });
const ws = store.createWorkstream({ slug: 'nube', goal: 'objetivo', repo, requireChangeApproval: false });
store.setWorkstreamState(ws.id, 'active');
const change = store.createChange(ws.id, 'cambio de nube', 'descripción');
const activity = store.listActivities({ changeId: change.id })[0]!;
const CANARIO = 'canario-comentario-de-revision';
store.db.query('UPDATE activities SET review_comment = ? WHERE id = ?').run(CANARIO, activity.id);

const server = startWeb(stateDir, 0, { server: true, write: true, publicOrigin: ORIGIN, socketPath: socket, github, secret: 'secreto-e2e-nube' });

// ---- flujos ----------------------------------------------------------------------------------------------------
async function entrar(quien: keyof typeof cuentas, invitacion?: string, destino = 'Bandeja') {
  cuenta = cuentas[quien];
  await abrir(`${ORIGIN}/login`);
  if (invitacion) await ab('fill', 'input[name=invitation]', invitacion);
  await click('form[action="/auth/start"] button');
  try {
    await ab('wait', '--text', destino); // la página «Sesión iniciada» continúa sola al panel (meta refresh): se espera al destino
  } catch (e) { throw new Error(`${(e as Error).message} | en ${await ab('get', 'url')}: ${(await texto()).slice(0, 200)}`); }
}
async function salir() { await abrir(`${ORIGIN}/cuenta`); await click('form[action="/logout"] button'); await ab('wait', '--text', 'Entrar con GitHub'); }
const abrirTexto = async (ruta: string) => { await abrir(`${ORIGIN}${ruta}`); return texto(); };
const menu = () => texto('nav[aria-label="Navegación principal"]');
const aviso = async () => { await ab('wait', 'p.notice[role=status]'); return texto('p.notice[role=status]'); };

try {
  await flujo('owner: entra con GitHub por el navegador, ve la configuración y crea una señal con el formulario', async () => {
    await entrar('owner'); await foto('owner-panel');
    assert((await menu()).includes('Configuración'), 'el owner debe ver Configuración en el menú');
    await abrir(`${ORIGIN}/signals`);
    await ab('select', '#signal-ws', 'nube'); await ab('fill', '#signal-title', 'Señal del owner'); await ab('fill', '#signal-body', 'Cuerpo');
    await click('form[action="/signals"] button');
    assert((await aviso()).includes('Acción registrada'), 'aviso de creación');
    const s = store.listSignals(ws.id, 'new').find(x => x.title === 'Señal del owner');
    assert(s, 'la señal no está en el Store');
    const actor = (store.db.query("SELECT actor FROM events WHERE message LIKE 'signal creada desde la web%' ORDER BY rowid DESC LIMIT 1").get() as { actor: string }).actor;
    eq(actor, `user:${dueña.id}`, 'actor del evento');
    assert((await texto()).includes('Señal del owner'), 'la lista de señales no muestra la nueva');
    await foto('owner-senal');
    assert((await abrirTexto(`/activities/${activity.id}`)).includes(CANARIO), 'el owner ve el comentario de revisión');
  });

  await flujo('owner: cierra sesión y vuelve al login', async () => {
    await salir();
    eq((await abrirTexto('/')).includes('Entrar con GitHub'), true, 'tras salir, / lleva al login');
  });

  await flujo('member: entra con su invitación, crea una señal y no ve la configuración (403)', async () => {
    await entrar('member', codigo.member); await foto('member-panel');
    const m = await menu();
    assert(!m.includes('Configuración') && !m.includes('Perfiles'), `el menú del member no debe ofrecer configuración: ${m}`);
    assert(m.includes('Señales') && m.includes('Changes'), 'el member sí ve Señales y Changes');
    await abrir(`${ORIGIN}/signals`);
    await ab('select', '#signal-ws', 'nube'); await ab('fill', '#signal-title', 'Señal del member'); await ab('fill', '#signal-body', 'Cuerpo');
    await click('form[action="/signals"] button');
    assert((await aviso()).includes('Acción registrada'), 'aviso de creación del member');
    assert(store.listSignals(ws.id, 'new').some(x => x.title === 'Señal del member'), 'la señal del member no está en el Store');
    assert((await abrirTexto('/config')).includes('No autorizado'), '/config debe dar 403 al member');
    await foto('member-config-403');
  });

  await flujo('CLI remota: `fab --remote login` se parea con confirmación en el navegador y opera con el rol del member', async () => {
    const env = { ...process.env, FABRICA_HOME: join(tmp, 'cliente') };
    // Asíncrono: el servidor corre en este proceso y un spawnSync lo dejaría sin atender a la CLI.
    const fab = async (...a: string[]) => {
      const p = Bun.spawn(['bun', 'src/cli.ts', ...a], { env, cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { stdout, stderr, exitCode };
    };
    eq((await fab('remote', 'add', 'nube', `http://127.0.0.1:${plain.port}`)).exitCode, 0, 'remote add');
    const login = Bun.spawn(['bun', 'src/cli.ts', '--remote', 'nube', 'login'], { env, cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    let salida = '';
    const reader = login.stdout.getReader(), dec = new TextDecoder();
    while (!/código ([A-Z0-9]{4}-[A-Z0-9]{4})/.test(salida)) { const { value, done } = await reader.read(); if (done) break; salida += dec.decode(value); }
    const code = /código ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(salida)?.[1];
    assert(code, `la CLI no mostró el código: ${salida}`);
    await abrir(`${ORIGIN}/cuenta/cli/autorizar`);
    await ab('fill', 'input[name=code]', code); await click('form[action="/cuenta/cli/autorizar"] button');
    await ab('wait', '--text', 'member'); await foto('cli-confirmar'); // la pantalla de confirmación muestra el rol y el alcance
    assert((await texto()).includes('Sí, es mi terminal'), 'falta el segundo paso de confirmación');
    await click('form[action="/cuenta/cli/autorizar"] button');
    const fin = await Promise.race([login.exited, Bun.sleep(30_000).then(() => 'tiempo')]);
    if (fin !== 0) { login.kill(); throw new Error(`la CLI no terminó el login (${fin}): ${await new Response(login.stderr).text()} ${salida}`); }
    const ws_ = await fab('--remote', 'nube', 'ws', 'list');
    eq(ws_.exitCode, 0, `ws list: ${ws_.stderr}`); assert(ws_.stdout.includes('nube'), 'ws list no muestra el workstream');
    const add = await fab('--remote', 'nube', 'signal', 'add', 'nube', 'Señal por CLI');
    eq(add.exitCode, 0, `signal add: ${add.stderr}`);
    assert(store.listSignals(ws.id, 'new').some(x => x.title === 'Señal por CLI'), 'la señal por CLI no está en el Store');
    const denegado = await fab('--remote', 'nube', 'automation', 'rm', 'x');
    assert(denegado.exitCode !== 0, 'un member no debe poder borrar automations por la CLI');
    eq((await fab('--remote', 'nube', 'logout')).exitCode, 0, 'logout');
  });

  await flujo('viewer: entra con su invitación, aterriza en workstreams y no recibe texto de workers', async () => {
    await salir(); await entrar('viewer', codigo.viewer, 'Workstreams');
    await foto('viewer-workstreams');
    const t = await texto();
    assert(!t.includes('repo-canario'), 'el viewer no debe ver la ruta del repo');
    const m = await menu();
    for (const v of ['Configuración', 'Métricas', 'Changes', 'Perfiles']) assert(!m.includes(v), `el viewer no debe ver «${v}» en el menú`);
    assert(!(await abrirTexto(`/activities/${activity.id}`)).includes(CANARIO), 'el viewer recibió el comentario de revisión');
    assert((await abrirTexto('/metricas')).includes('No autorizado'), '/metricas debe dar 403 al viewer');
  });

  await flujo('viewer: ninguna ruta sin vista estructurada da 200 (por el frontal HTTPS, con su sesión real)', async () => {
    const vid = (store.db.query('SELECT id FROM users WHERE subject = ?').get(String(cuentas.viewer.id)) as { id: string }).id;
    const token = issueSession(store, vid, 'web').token;
    const con200: string[] = [];
    const rutas = ['/changes', '/automations', '/flujo', '/metricas', '/benchmarks', '/experimentos', '/config', '/config/runners', '/perfiles', '/definicion', '/automejora', '/webhooks',
      '/automations/nueva', '/workstreams/nuevo', '/config/claves-api', '/api/v1/workstreams', '/inbox', '/status', '/recuperacion', `/changes/${change.id}/turns/x/log`, '/ruta/inventada'];
    for (const r of rutas) {
      const res = await fetch(`https://127.0.0.1:${tls.port}${r}`, { redirect: 'manual', headers: { host: `fab.localhost:${tls.port}`, cookie: `${SESSION_COOKIE}=${token}` }, tls: { rejectUnauthorized: false } } as RequestInit);
      if (res.status === 200) con200.push(r);
    }
    eq(con200.join(','), '', 'rutas con 200 para el viewer');
    const post = await fetch(`https://127.0.0.1:${tls.port}/signals`, { method: 'POST', redirect: 'manual', headers: { host: `fab.localhost:${tls.port}`, cookie: `${SESSION_COOKIE}=${token}`, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: 'workstream=nube&title=x', tls: { rejectUnauthorized: false } } as RequestInit);
    eq(post.status, 403, 'POST del viewer');
  });
} catch (e) {
  resultados.push({ flujo: 'preparación', ok: false, detalle: e instanceof Error ? e.stack ?? e.message : String(e) });
} finally {
  try { await ab('close'); } catch { /* sin navegador */ }
  server.stop(true); tls.stop(true); plain.stop(true); puente.stop(true); gh.stop(); store.close(); rmSync(tmp, { recursive: true, force: true });
}

const fallos = resultados.filter(r => !r.ok);
writeFileSync(join(CAPTURAS, 'resumen.json'), JSON.stringify({ fecha: new Date().toISOString(), total: resultados.length, ok: resultados.length - fallos.length, fallos: fallos.length, resultados }, null, 2) + '\n');
console.log(`\ne2e nube: ${resultados.length - fallos.length} ok · ${fallos.length} fallos · ${CAPTURAS}/resumen.json`);
for (const r of fallos) console.log(`FALLO ${r.flujo}: ${r.detalle.split('\n').slice(0, 3).join(' | ')}`);
process.exit(fallos.length ? 1 : 0);
