import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processActivity } from '../src/pool.ts';
import type { RemoteRunner } from '../src/runners/client.ts';
import { Store } from '../src/store.ts';
import type { RunnerCheckOptions } from '../src/web-runner-check.ts';
import { startWeb } from '../src/web.ts';

const inventory = '/config/runners';
const check = (name = 'torre') => `${inventory}/${name}/comprobar`;
const fake = join(import.meta.dir, 'helpers/fake-runner.ts');
let dir: string, store: Store, server: ReturnType<typeof startWeb> | undefined;
let origin: string, cookie: string, csrf: string, workstream: string;
let attempts: RemoteRunner[];
const path = () => `/workstreams/${workstream}/runner`;

function boot(scenario = 'check', timer?: RunnerCheckOptions['timer'], onTransport?: () => void) {
  server = startWeb(dir, 0, { write: true, runnerCheck: {
    transport: runner => {
      onTransport?.();
      attempts.push(runner);
      if (scenario === 'silent') return [process.execPath, '-e', 'setInterval(() => {}, 1000)'];
      if (scenario === 'raw') return [process.execPath, '-e', `
        console.error("stderr-canario-privado");
        console.log(JSON.stringify({ v: 1, type: 'error', code: 'internal', message: 'respuesta-canario-privada <script>' }));
      `];
      return [process.execPath, fake, scenario, dir];
    },
    timer,
  } });
  origin = `http://${server.host}:${server.port}`;
}
async function login() {
  const r = await fetch(server!.loginUrl!, { redirect: 'manual' });
  expect(r.status).toBe(303);
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  csrf = /name="csrf" value="([^"]+)"/.exec(await (await get('/workstreams')).text())?.[1] ?? '';
  expect(csrf).toHaveLength(64);
}
const get = (url: string, method = 'GET', headers: Record<string, string> = { cookie }) => fetch(origin + url, { method, headers, redirect: 'manual' });
const post = (url: string, fields: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  fetch(origin + url, { method: 'POST', redirect: 'manual', headers: { cookie, origin, ...headers }, body: new URLSearchParams({ csrf, ...fields }) });
const assign = (runner: string, expected = '', fields: Record<string, string> = {}) =>
  post(path(), { runner, expected, confirm: 'yes', ...fields });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-web-runners-admin-'));
  store = new Store(join(dir, 'fabrica.db'));
  workstream = store.createWorkstream({ slug: 'prueba', goal: 'g', repo: join(dir, 'repo') }).id;
  store.createRunner({ name: 'torre', kind: 'ssh', target: 'alias-canario', options: { maxBundleMb: 987 } });
  store.createRunner({ name: 'torre2', kind: 'ssh', target: 'alias-dos' });
  store.createRunner({ name: 'casa', kind: 'local' });
  store.createRunner({ name: 'en-pausa', kind: 'ssh', target: 'alias-pausado' });
  store.setRunnerEnabled('en-pausa', false);
  attempts = [];
  cookie = ''; csrf = '';
});
afterEach(() => {
  server?.stop(true); server = undefined;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET y HEAD requieren sesión D11, no comprueban y el inventario protege sus datos', async () => {
  boot();
  expect((await get(inventory)).status).toBe(401);
  expect((await get(inventory, 'HEAD')).status).toBe(401);
  await login();
  expect(await (await get('/config')).text()).toContain('href="/config/runners"');
  const r = await get(inventory);
  expect(r.status).toBe(200);
  const html = await r.text();
  expect(html).toContain('Sin comprobar');
  expect(html).not.toMatch(/alias-canario|alias-dos|alias-pausado|987|poll\.js/);
  const head = await get(inventory, 'HEAD');
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
  expect((await get(check())).status).toBe(404);
  expect((await post(inventory)).status).toBe(405);
  expect(attempts).toEqual([]);
});

test('inventario vacío con esquema antiguo, sin migrar ni cambiar los bytes', async () => {
  store.db.exec('DROP TABLE runners');
  store.close();
  const db = join(dir, 'fabrica.db');
  const before = readFileSync(db);
  const files = readdirSync(dir);
  boot();
  await login();
  const r = await get(inventory);
  expect(r.status).toBe(200);
  expect(await r.text()).toContain('No hay runners configurados.');
  expect(readFileSync(db)).toEqual(before);
  expect(readdirSync(dir)).toEqual(files);
  expect(attempts).toEqual([]);
});

test('escritura, Host, Origin, sesión y CSRF se exigen en ambos POST, incluso con Bearer', async () => {
  boot();
  const keys = [store.createApiKey('lector', 'read').key, store.createApiKey('decide', 'decide').key];
  for (const key of keys) {
    expect((await get(inventory, 'GET', { cookie: '', Authorization: `Bearer ${key}` })).status).toBe(401);
    for (const p of [check(), path()]) {
      expect((await post(p, {}, { Authorization: `Bearer ${key}` })).status).toBe(401);
      const r = await fetch(`http://127.0.0.1:${server!.port}/api/v1${p}`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{}',
      });
      expect(r.status).toBe(404);
    }
  }
  await login();
  for (const p of [check(), path()]) {
    const valid = { runner: 'casa', expected: '', confirm: 'yes' };
    expect((await post(p, valid, { host: `localhost:${server!.port}` })).status).toBe(403);
    expect((await post(p, valid, { origin: 'http://origen.invalid' })).status).toBe(403);
    expect((await post(p, { ...valid, csrf: 'a'.repeat(64) })).status).toBe(403);
  }
  server!.stop(true);
  server = startWeb(dir, 0);
  origin = `http://127.0.0.1:${server.port}`;
  for (const p of [check(), path()]) expect((await post(p)).status).toBe(405);
  expect((await get(inventory)).status).toBe(401);
  expect(store.getWorkstream(workstream).runner).toBeNull();
  expect(attempts).toEqual([]);
});

test('check valida el nombre completo, rechaza local y pausado y toma solo el destino guardado', async () => {
  let lookup: Store | undefined;
  boot('check', undefined, () => {
    expect(lookup).toBeDefined();
    expect(() => lookup!.db.query('SELECT 1').get()).toThrow(/closed/);
  });
  await login();
  for (const name of ['Torre', 'to%2Frre', 'torre%20', 'torre%0A', 'a'.repeat(42)]) {
    expect((await post(check(name))).status).toBe(400);
  }
  expect((await post(check('torr'))).status).toBe(404);
  expect((await post(check('casa'))).status).toBe(400);
  const paused = await post(check('en-pausa'));
  expect(paused.status).toBe(409);
  expect(await paused.text()).toContain('El runner está pausado');
  expect(attempts).toEqual([]);

  // Un relato antiguo con alias sigue en la base y no se copia a la web.
  store.event(workstream, 'info', 'runner histórico: usuario-canario@ruta-canario');
  const getRunner = Store.prototype.getRunner;
  const spy = spyOn(Store.prototype, 'getRunner').mockImplementation(function (this: Store, name) {
    lookup = this;
    expect(() => this.db.query("UPDATE runners SET enabled = 0").run()).toThrow(/readonly/);
    return getRunner.call(this, name);
  });
  let r: Response;
  try {
    r = await post(check(), { name: 'torre2', target: 'alias-cliente', command: 'comando-canario', prompt: 'prompt-canario', repo: '/repo-canario' });
  } finally { spy.mockRestore(); }
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(r.headers.get('content-type')).toContain('text/html');
  expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
  const html = await r.text();
  expect(html).toContain('SSH alcanzable');
  expect(html).toContain('Protocolo 1');
  expect(html).toContain('Declarado por el runner, no verificado');
  expect(html).toContain('fake123');
  expect(html).toContain('bwrap');
  expect(html).toContain('cccccccccccc');
  expect(html).not.toContain('c'.repeat(64));
  expect(html).not.toMatch(/<script|<form|alias-canario|alias-cliente|comando-canario|prompt-canario|repo-canario|usuario-canario|ruta-canario/);
  expect(attempts).toEqual([{ name: 'torre', target: 'alias-canario' }]);
  const repoKey = createHash('sha256').update('fab-runner-check').digest('hex');
  expect(readFileSync(join(dir, 'transcript'), 'utf8')).toBe(JSON.stringify({ v: 1, type: 'hello', repoKey }) + '\n');
  expect(existsSync(join(dir, 'in.bundle'))).toBe(false);
  expect(existsSync(join(dir, 'repo'))).toBe(false);
  expect(await (await get(inventory)).text()).not.toContain('fake123');
  expect(store.getWorkstream(workstream).runner).toBeNull();
});

for (const [scenario, message] of [
  ['v2', 'Protocolo incompatible'],
  ['die', 'Runner inaccesible'],
  ['raw', 'Runner inaccesible'],
] as const) {
  test(`check ${scenario}: respuesta controlada y sin reintentos`, async () => {
    boot(scenario);
    await login();
    const response = await post(check());
    expect(response.status).toBe(502);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain(message);
    expect(html).not.toMatch(/stderr-canario|respuesta-canario|alias-canario|RUNNER_|hello inválido|<script/);
    expect(attempts).toHaveLength(1);
  });
}

test('un check en vuelo por sesión, plazo inyectado de 30 s y liberación tras timeout', async () => {
  const entered = Promise.withResolvers<{ fire: () => void; ms: number }>();
  let cancelled = 0;
  boot('silent', (fire, ms) => {
    entered.resolve({ fire, ms });
    if (cancelled) queueMicrotask(fire);
    return () => { cancelled++; };
  });
  await login();
  const first = post(check());
  const { fire, ms } = await entered.promise;
  try {
    expect(ms).toBe(30_000);
    expect((await post(check('torre2'))).status).toBe(409);
    expect(attempts).toHaveLength(1);
    // Otra operación puede escribir mientras la comprobación espera.
    expect((await assign('casa')).status).toBe(303);
  } finally { fire(); }
  const response = await first;
  expect(response.status).toBe(504);
  expect(await response.text()).toContain('Tiempo de comprobación agotado');
  expect(cancelled).toBe(1);
  expect((await post(check('torre2'))).status).toBe(504);
  expect(attempts).toHaveLength(2);
});

test('asignación: dos formularios, confirmaciones, CAS con CLI, pausa, borrado y archivo', async () => {
  boot();
  await login();
  const form = async () => {
    const html = await (await get('/workstreams')).text();
    return /name="expected" value="([^"]*)"/.exec(html)?.[1]!;
  };
  const first = await form(), second = await form();
  expect(first).toBe('');
  expect((await post(path(), { expected: '', confirm: 'yes' })).status).toBe(400);
  expect((await post(path(), { runner: 'casa', confirm: 'yes' })).status).toBe(400);
  expect((await assign('casa', first, { confirm: '' })).status).toBe(400);
  expect((await assign('torre', first)).status).toBe(400);
  expect((await post('/workstreams/prueba/runner', { runner: 'casa', expected: '', confirm: 'yes' })).status).toBe(404);
  const r = await assign('torre', first, { confirm_ssh: 'yes' });
  expect(r.status).toBe(303);
  expect(r.headers.get('location')).toBe('/workstreams');
  expect((await assign('torre', second, { confirm_ssh: 'yes' })).status).toBe(409);
  expect((await assign('torre', await form(), { confirm_ssh: 'yes' })).status).toBe(303);
  const events = store.listEvents(workstream).filter(e => String(e.message).startsWith('runner:'));
  expect(events.map(e => [e.actor, e.message])).toEqual([['web', 'runner: ninguno -> torre; el código de este workstream se enviará al runner remoto']]);
  const beforeCli = await form();
  store.setWorkstreamRunner('prueba', 'casa');
  expect((await assign('', beforeCli)).status).toBe(409);
  const beforePause = await form();
  store.setRunnerEnabled('torre2', false);
  expect((await assign('torre2', beforePause, { confirm_ssh: 'yes' })).status).toBe(409);
  store.deleteRunner('torre2');
  expect((await assign('torre2', beforePause, { confirm_ssh: 'yes' })).status).toBe(404);
  expect((await assign('', beforePause)).status).toBe(303);
  store.setWorkstreamState(workstream, 'archived');
  expect((await assign('casa')).status).toBe(409);
  expect(store.getWorkstream(workstream).runner).toBeNull();
  expect(attempts).toEqual([]);
});

test('la activity iniciada conserva procedencia y el turno siguiente usa la nueva asignación', async () => {
  const repo = join(dir, 'repo');
  const git = (...argv: string[]) => {
    const p = Bun.spawnSync(['git', ...argv]);
    expect(p.exitCode).toBe(0);
  };
  git('init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'base.txt'), 'base');
  git('-C', repo, 'add', '.');
  git('-C', repo, '-c', 'user.name=Fab', '-c', 'user.email=fab@example.invalid', 'commit', '-qm', 'base');
  workstream = store.createWorkstream({ slug: 'turnos', goal: 'g', repo, agent: 'fake', requireChangeApproval: false, requireApproval: false }).id;
  store.setWorkstreamState(workstream, 'active');
  store.setWorkstreamRunner(workstream, 'torre');
  const change = store.createChange(workstream, 'cambio', 'descripción');
  const started = Promise.withResolvers<void>();
  const release = join(dir, 'reanudar');
  const opts = { workstream, stateDir: dir, log: () => {} };
  boot();
  await login();
  const first = store.claimActivity(workstream, 'worker-1')!;
  const running = processActivity(store, first, 'worker-1', { ...opts, runnerTransport: () => {
    started.resolve();
    const argv = [process.execPath, fake, 'auto', dir, 'STATUS: done\nhecho'];
    return [process.execPath, '-e', `
      import { existsSync, watch } from 'node:fs';
      await new Promise(resolve => {
        const watcher = watch(${JSON.stringify(dir)}, ready);
        function ready() {
          if (!existsSync(${JSON.stringify(release)})) return;
          watcher.close();
          resolve();
        }
        ready();
      });
      process.argv = ${JSON.stringify(argv)};
      await import(${JSON.stringify(fake)});
    `];
  } });
  try {
    await Promise.race([started.promise, running.then(() => { throw new Error('la activity no alcanzó el transporte'); })]);
    expect((await assign('casa', 'torre')).status).toBe(303);
    expect(store.getActivity(first.id)).toMatchObject({ status: 'in_progress', runner: 'torre' });
  } finally {
    writeFileSync(release, '');
    await running;
  }
  expect(store.getActivity(first.id)).toMatchObject({ status: 'completed', runner: 'torre' });
  const next = store.claimActivity(workstream, 'worker-2')!;
  expect(next.changeId).toBe(change.id);
  await processActivity(store, next, 'worker-2', { ...opts, runnerTransport: () => { throw new Error('el turno local no abre transporte'); } });
  expect(store.getActivity(next.id)).toMatchObject({ status: 'completed', runner: 'casa' });
});
