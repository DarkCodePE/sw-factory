// T119e: arranque de producción de `fab web --server`: credenciales por referencia y bootstrap obligatorio (§2, D-K).
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { bootstrapOwner, issueSession } from '../src/users.ts';
import { csrfToken } from '../src/web-auth.ts';
import { webMain } from '../src/web.ts';

let dir: string, state: string;
const saved = new Map<string, string | undefined>();
const env = (k: string, v?: string) => { if (!saved.has(k)) saved.set(k, process.env[k]); if (v === undefined) delete process.env[k]; else process.env[k] = v; };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-main-'));
  state = join(dir, 'state'); Bun.spawnSync(['mkdir', '-m', '700', state]);
  new Store(join(state, 'fabrica.db')).close();
  for (const k of ['FAB_GITHUB_CLIENT_ID', 'FAB_GITHUB_CLIENT_SECRET_FILE', 'FAB_SERVICE_SECRET_FILE', 'CREDENTIALS_DIRECTORY']) env(k);
});
afterEach(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } saved.clear(); rmSync(dir, { recursive: true, force: true }); });

const args = (socket: string) => ['--server', '--public-origin', 'https://fab.example.test', '--socket', socket];
async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; err: string }> {
  const orig = console.error; let err = ''; console.error = (...a: unknown[]) => { err += a.join(' ') + '\n'; };
  try { return { result: await fn(), err }; } finally { console.error = orig; }
}

test('sin credenciales de GitHub el servidor no arranca y no deja un socket', async () => {
  const socket = join(dir, 'a.sock');
  const { result, err } = await quiet(() => webMain(args(socket), state));
  expect(result).toBe(1); expect(err).toContain('FAB_GITHUB_CLIENT_ID'); expect(existsSync(socket)).toBe(false);
  env('FAB_GITHUB_CLIENT_ID', 'id'); env('FAB_GITHUB_CLIENT_SECRET_FILE', join(dir, 'no-existe'));
  expect((await quiet(() => webMain(args(socket), state))).result).toBe(1);
});

test('con credenciales pero sin bootstrap del primer owner el servidor no arranca', async () => {
  writeFileSync(join(dir, 'secret'), 'secreto-sintetico\n');
  env('FAB_GITHUB_CLIENT_ID', 'id'); env('FAB_GITHUB_CLIENT_SECRET_FILE', join(dir, 'secret'));
  const socket = join(dir, 'b.sock');
  const { result, err } = await quiet(() => webMain(args(socket), state));
  expect(result).toBe(1); expect(err).toContain('bootstrap'); expect(err).not.toContain('secreto-sintetico'); expect(existsSync(socket)).toBe(false);
});

function bootstrapped() {
  const store = new Store(join(state, 'fabrica.db'));
  bootstrapOwner(store, { issuer: 'github', subject: '1', displayName: 'Dueña', operator: 'op' }); store.close();
}

test('un secreto de servicio vacío o corto no arranca el servidor (T119e-H2): el CSRF sería calculable', async () => {
  bootstrapped();
  writeFileSync(join(dir, 'secret'), 'secreto-sintetico\n');
  env('FAB_GITHUB_CLIENT_ID', 'id'); env('FAB_GITHUB_CLIENT_SECRET_FILE', join(dir, 'secret'));
  for (const [i, contenido] of ['', '\n', 'x', 'a'.repeat(31)].entries()) {
    writeFileSync(join(dir, 'servicio'), contenido); env('FAB_SERVICE_SECRET_FILE', join(dir, 'servicio'));
    const socket = join(dir, `s${i}.sock`);
    const { result, err } = await quiet(() => webMain(args(socket), state));
    expect([contenido, result, err.includes('service-secret') || err.includes('FAB_SERVICE_SECRET_FILE')]).toEqual([contenido, 1, true]);
    expect(existsSync(socket)).toBe(false);
  }
});

test('el control de arranque no crea ni migra la base, y un secreto de GitHub vacío o un fichero de servicio ausente no pasan (T119e-H7)', async () => {
  writeFileSync(join(dir, 'secret'), 'secreto-sintetico\n');
  env('FAB_GITHUB_CLIENT_ID', 'id'); env('FAB_GITHUB_CLIENT_SECRET_FILE', join(dir, 'secret'));
  const vacio = join(dir, 'vacio'); Bun.spawnSync(['mkdir', '-m', '700', vacio]);
  expect((await quiet(() => webMain(args(join(dir, 'd.sock')), vacio))).result).toBe(1);
  expect(existsSync(join(vacio, 'fabrica.db'))).toBe(false); // el control abre en solo lectura: no crea nada
  bootstrapped();
  writeFileSync(join(dir, 'secret'), '\n');
  const g = await quiet(() => webMain(args(join(dir, 'e.sock')), state));
  expect(g.result).toBe(1); expect(g.err).toContain('FAB_GITHUB_CLIENT_SECRET_FILE');
  writeFileSync(join(dir, 'secret'), 'secreto-sintetico\n'); env('FAB_SERVICE_SECRET_FILE', join(dir, 'no-existe'));
  const f = await quiet(() => webMain(args(join(dir, 'f.sock')), state));
  expect(f.result).toBe(1); expect(f.err).toContain('FAB_SERVICE_SECRET_FILE'); expect(f.err).not.toContain('FABRICA_HOME');
});

test('con credenciales y bootstrap arranca, sirve /login y /healthz por el socket y se detiene con SIGTERM', async () => {
  const store = new Store(join(state, 'fabrica.db'));
  bootstrapOwner(store, { issuer: 'github', subject: '1', displayName: 'Dueña', operator: 'op' }); store.close();
  writeFileSync(join(dir, 'secret'), 'secreto-sintetico\n');
  env('FAB_GITHUB_CLIENT_ID', 'id'); env('FAB_GITHUB_CLIENT_SECRET_FILE', join(dir, 'secret'));
  const socket = join(dir, 'c.sock');
  const running = quiet(() => webMain(args(socket), state));
  for (let i = 0; i < 100 && !existsSync(socket); i++) await Bun.sleep(20);
  const call = (path: string) => fetch(`http://localhost${path}`, { unix: socket, headers: { host: 'fab.example.test' } } as RequestInit);
  expect([(await call('/healthz')).status, (await call('/login')).status, (await call('/')).status]).toEqual([200, 200, 401]);
  process.emit('SIGTERM');
  expect((await running).result).toBe(0);
});

async function arrancar(secretos: { servicio?: string; github: string }, sock: string) {
  bootstrapped();
  writeFileSync(join(dir, 'secret'), secretos.github + '\n');
  env('FAB_GITHUB_CLIENT_ID', 'id'); env('FAB_GITHUB_CLIENT_SECRET_FILE', join(dir, 'secret'));
  if (secretos.servicio) { writeFileSync(join(dir, 'servicio'), secretos.servicio + '\n'); env('FAB_SERVICE_SECRET_FILE', join(dir, 'servicio')); }
  const socket = join(dir, sock);
  const running = quiet(() => webMain(args(socket), state));
  for (let i = 0; i < 100 && !existsSync(socket); i++) await Bun.sleep(20);
  const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    fetch(`http://localhost${path}`, { redirect: 'manual', unix: socket, ...init, headers: { host: 'fab.example.test', 'x-fab-client-ip': '203.0.113.9', ...init.headers } } as RequestInit);
  return { call, stop: async () => { process.emit('SIGTERM'); await running; } };
}

test('el secreto de servicio del fichero es el que firma el CSRF (T119e-H8)', async () => {
  const servicio = 's'.repeat(40);
  const w = await arrancar({ servicio, github: 'secreto-sintetico' }, 'g.sock');
  try {
    const st = new Store(join(state, 'fabrica.db')); const owner = (st.db.query('SELECT id FROM users').get() as { id: string }).id;
    const sess = issueSession(st, owner, 'web'); st.close();
    const page = await (await w.call('/cuenta', { headers: { cookie: `__Host-fab_session=${sess.token}` } })).text();
    expect(page).toContain(csrfToken(servicio, sess.id));
    expect(page).not.toContain(csrfToken('', sess.id));
  } finally { await w.stop(); }
});

test('el secreto de la aplicación de GitHub se lee del fichero por referencia y viaja en el canje (T119e-H8)', async () => {
  const w = await arrancar({ github: 'secreto-de-github-sintetico' }, 'h.sock');
  const real = globalThis.fetch; let canje: Record<string, unknown> | undefined;
  globalThis.fetch = ((input: any, init?: any) => {
    if (String(input?.url ?? input).includes('github.com/login/oauth/access_token')) { canje = JSON.parse(init.body); return Promise.resolve(Response.json({ error: 'bad_verification_code' })); }
    return real(input, init);
  }) as typeof fetch;
  try {
    const login = await w.call('/login');
    const pre = /name="pre" value="([^"]+)"/.exec(await login.text())![1]!;
    const preCookie = /(__Host-[^=]+=[^;]+)/.exec(login.headers.get('set-cookie')!)![1]!;
    const start = await w.call('/auth/start', { method: 'POST', headers: { origin: 'https://fab.example.test', cookie: preCookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ pre }) });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const loginCookie = start.headers.getSetCookie().map(c => c.split(';')[0]!).join('; ');
    await w.call(`/auth/callback?code=x&state=${state}`, { headers: { cookie: loginCookie } });
    expect(canje?.client_secret).toBe('secreto-de-github-sintetico');
  } finally { globalThis.fetch = real; await w.stop(); }
});
