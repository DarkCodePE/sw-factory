// T119e: arranque de producción de `fab web --server`: credenciales por referencia y bootstrap obligatorio (§2, D-K).
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { bootstrapOwner } from '../src/users.ts';
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
