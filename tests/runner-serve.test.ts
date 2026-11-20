// T74d: lado runner (`fab runner serve`), con adaptador `fake` y bwrap real. Sin sshd ni esperas fijas: se espera a condiciones.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getAgent } from '../src/agents.ts';
import { RunnerError, runRemoteAgent, type RemoteJob, type Transport } from '../src/runners/client.ts';
import { makeJobBundle } from '../src/runners/bundle.ts';
import { encode, type Message } from '../src/runners/protocol.ts';
import { serveSession, type ServeDeps } from '../src/runners/serve.ts';

const CLI = resolve(import.meta.dir, '../src/cli.ts');
const runner = { name: 'torre', target: 'torre' };
const KEY = 'a'.repeat(64);
let tmp: string, home: string, wt: string, root: string, head: string;

const git = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
/** `serve` como proceso real, con variables extra del entorno del runner puestas por `env`. */
const serveProc = (envVars: string[] = [], path?: string): Transport => () =>
  ['env', ...(path ? [`PATH=${path}`] : []), ...envVars, process.execPath, CLI, 'runner', 'serve', '--root', root];
const job = (over: Partial<RemoteJob> = {}): RemoteJob => ({
  activityId: 'act1', attempt: 1, adapter: 'fake', model: null, readOnly: false, expectChanges: true, prompt: 'haz algo',
  repo: home, worktree: wt, head, base: head, timeoutMs: 60_000, repoKey: KEY, ...over,
});
const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 2000; i++) { if (cond()) return; await Bun.sleep(5); }
  throw new Error(`no se cumplió: ${what}`);
};

/** Una sesión en proceso: casa escribe con `send`/`end`; lo que el runner emite se lee de `messages()`. */
function session(deps: ServeDeps = {}) {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const stdin = new ReadableStream<Uint8Array>({ start: c => { ctl = c; } });
  const chunks: Buffer[] = [];
  const done = serveSession(root, stdin, async b => { chunks.push(Buffer.from(b)); }, deps);
  const messages = (): Array<Record<string, unknown>> => {
    const buf = Buffer.concat(chunks), out: Array<Record<string, unknown>> = [];
    for (let at = 0;;) {
      const nl = buf.indexOf(10, at);
      if (nl < 0) return out;
      const m = JSON.parse(buf.subarray(at, nl).toString());
      out.push(m); at = nl + 1;
      if (m.type === 'result') at += m.bundleBytes as number;
    }
  };
  const has = (type: string) => messages().some(m => m.type === type);
  return { done, messages, has, send: (b: string | Buffer) => ctl.enqueue(new Uint8Array(Buffer.from(b))), end: () => ctl.close() };
}
type S = ReturnType<typeof session>;
const hello = (s: S) => s.send(encode({ v: 1, type: 'hello', repoKey: KEY }));
async function sendJob(s: S, over: Record<string, unknown> = {}, jobId = 'act1-1', prompt = 'haz algo') {
  const have = (s.messages()[0]?.have as string[]) ?? [];
  const bundle = await makeJobBundle(home, head, have);
  const data = readFileSync(bundle.path);
  s.send(encode({
    v: 1, type: 'job', jobId, adapter: 'fake', model: null, readOnly: false, expectChanges: true, timeoutMs: 60_000, base: head, head,
    promptBytes: Buffer.byteLength(prompt), bundleBytes: bundle.bytes, bundleSha256: bundle.sha256, ...over,
  } as Message));
  s.send(prompt); s.send(data);
}
const procFile = (pid: number, f: string) => readFileSync(`/proc/${pid}/${f}`);
const bwrapOf = () => Bun.spawnSync(['pgrep', '-P', String(process.pid), '-x', 'bwrap']).stdout.toString().trim().split('\n').filter(Boolean).map(Number);
const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fab-serve-'));
  home = join(tmp, 'home'); wt = join(tmp, 'wt'); root = join(tmp, 'runner');
  mkdirSync(home);
  git(home, 'init', '-q', '-b', 'main');
  writeFileSync(join(home, 'a.txt'), 'uno\n');
  git(home, 'add', '-A'); git(home, 'commit', '-q', '-m', 'base');
  head = git(home, 'rev-parse', 'HEAD');
  git(home, 'worktree', 'add', '-q', '-b', 'fab/change', wt);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

test('encargo completo con el cliente real y serve como proceso: commit importado, informe y declared', async () => {
  const r = await runRemoteAgent(runner, job(), serveProc(['FABRICA_FAKE_TOUCH=marca']));
  expect(r.ok).toBe(true);
  expect(r.output).toContain('fake agent handled: haz algo');
  expect(r.declared.sandbox).toBe('bwrap');
  expect(r.declared.agentSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(git(wt, 'rev-parse', 'HEAD^')).toBe(head);
  expect(readdirSync(wt).some(f => f.startsWith('marca-'))).toBe(true);
  // El runner no deja nada: ni encargo, ni bloqueo, ni bundle.
  expect(readdirSync(join(root, 'jobs'))).toEqual([]);
  expect(readdirSync(root).filter(n => n.startsWith('in-'))).toEqual([]);
});

test('hello anuncia la punta de la caché tras un encargo; el siguiente encargo envía menos', async () => {
  await runRemoteAgent(runner, job(), serveProc());
  const s = session(); hello(s);
  await until(() => s.has('hello'), 'hello');
  expect(s.messages()[0]!.have).toEqual([head]);
  s.end(); expect(await s.done).toBe(0);
});

test('A6: sin bwrap contesta not_confinable y no crea el proceso ni el encargo', async () => {
  const e = await runRemoteAgent(runner, job(), serveProc(['FABRICA_FAKE_TOUCH=marca'], '/nonexistent')).catch(x => x as RunnerError);
  expect(e).toBeInstanceOf(RunnerError);
  expect((e as RunnerError).message).toBe('RUNNER_REFUSED: not_confinable');
  expect(readdirSync(join(root, 'jobs'))).toEqual([]);
  expect(readdirSync(wt).some(f => f.startsWith('marca-'))).toBe(false);
});

test('A6 en proceso: la comprobación de confinamiento fallida impide ejecutar', async () => {
  const s = session({ confine: () => { throw new Error('sin bwrap'); } });
  hello(s); await until(() => s.has('hello'), 'hello');
  expect(s.messages()[0]!.sandbox).toBe('none');
  await sendJob(s);
  expect(await s.done).toBe(1);
  expect(s.messages().at(-1)).toMatchObject({ type: 'error', code: 'not_confinable' });
  expect(s.has('accepted')).toBe(false);
});

test('A7: adapter, model y jobId fuera de regla son bad_request; SSH_ORIGINAL_COMMAND se ignora', async () => {
  process.env.SSH_ORIGINAL_COMMAND = 'rm -rf /';
  try {
    for (const [over, id] of [[{ adapter: 'rm' }, 'act1-1'], [{ model: '-x' }, 'act1-1'], [{}, '../x'], [{ adapter: 'sh -c' }, 'a/b']] as const) {
      const s = session(); hello(s); await until(() => s.has('hello'), 'hello');
      await sendJob(s, over as Record<string, unknown>, id);
      expect(await s.done).toBe(1);
      expect(s.messages().at(-1)).toMatchObject({ type: 'error', code: 'bad_request' });
    }
  } finally { delete process.env.SSH_ORIGINAL_COMMAND; }
  expect(readdirSync(join(root, 'jobs'))).toEqual([]);
});

test('A7: el job no puede llevar env, argv ni cwd', async () => {
  for (const k of ['env', 'argv', 'cwd']) {
    const s = session(); hello(s); await until(() => s.has('hello'), 'hello');
    await sendJob(s, { [k]: k === 'env' ? { X: '1' } : 'x' });
    expect(await s.done).toBe(1);
    expect(s.messages().at(-1)).toMatchObject({ type: 'error', code: 'bad_request' });
  }
});

test('A16: hello con v distinta de 1 corta la sesión con bad_request', async () => {
  const s = session(); s.send(JSON.stringify({ v: 2, type: 'hello', repoKey: KEY }) + '\n');
  expect(await s.done).toBe(1);
  expect(s.messages()[0]).toMatchObject({ type: 'error', code: 'bad_request' });
});

test('el agente remoto comprueba su argv, stdin y los marcadores del entorno del runner', async () => {
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  const prompt = 'pide algo';
  const expected = getAgent('claude').command(prompt, { readOnly: false, confine: true, promptStdin: true }).slice(1);
  expected.push('--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/python3
import json, os, sys
assert sys.argv[1:] == ${JSON.stringify(expected)}
assert sys.stdin.read() == ${JSON.stringify(prompt)}
assert os.environ["ANTHROPIC_API_KEY"] == "sintetico-runner"
assert "CANARIO_RUNNER" not in os.environ
assert "GH_TOKEN" not in os.environ
assert "SSH_AUTH_SOCK" not in os.environ
print(json.dumps({"type": "result", "result": "STATUS: done\\n\\nconfirmado"}))
`, { mode: 0o755 });
  const r = await runRemoteAgent(runner, job({ adapter: 'claude', prompt, expectChanges: false }), serveProc([
    'ANTHROPIC_API_KEY=sintetico-runner', 'CANARIO_RUNNER=excluido', 'GH_TOKEN=sintetico-gh', 'SSH_AUTH_SOCK=/tmp/sintetico',
  ], `${bin}:${process.env.PATH}`));
  expect(r.exitCode).toBe(0);
  expect(r.ok).toBe(true);
  expect(r.output).toContain('confirmado');
});

test('A13: al cerrarse la sesión se mata al agente y se borra el encargo', async () => {
  process.env.FABRICA_FAKE_SLEEP = '30';
  const s = session();
  try {
    hello(s); await until(() => s.has('hello'), 'hello');
    await sendJob(s);
    await until(() => bwrapOf().length > 0, 'bwrap en marcha');
    const [pid] = bwrapOf();
    expect(existsSync(join(root, 'jobs', 'act1-1'))).toBe(true);
    s.end();
    expect(await s.done).toBe(0);
    await until(() => gone(pid!), 'agente muerto');
    expect(readdirSync(join(root, 'jobs'))).toEqual([]);
    expect(s.has('result')).toBe(false);
  } finally { delete process.env.FABRICA_FAKE_SLEEP; }
});

test('con maxJobs = 1 y un encargo en marcha, el segundo recibe busy; al terminar el primero entra', async () => {
  process.env.FABRICA_FAKE_SLEEP = '30';
  const a = session();
  try {
    hello(a); await until(() => a.has('hello'), 'hello');
    await sendJob(a);
    await until(() => a.has('accepted'), 'accepted');
    delete process.env.FABRICA_FAKE_SLEEP;
    const b = session(); hello(b); await until(() => b.has('hello'), 'hello b');
    await sendJob(b, {}, 'act2-1');
    expect(await b.done).toBe(1);
    expect(b.messages().at(-1)).toMatchObject({ type: 'error', code: 'busy' });
  } finally { delete process.env.FABRICA_FAKE_SLEEP; a.end(); await a.done; }
  const c = session(); hello(c); await until(() => c.has('hello'), 'hello c');
  await sendJob(c, { expectChanges: false }, 'act3-1');
  expect(await c.done).toBe(0);
  expect(c.has('result')).toBe(true);
});

test('el plazo del agente lo mata y el resultado lo refleja (reloj inyectado)', async () => {
  process.env.FABRICA_FAKE_SLEEP = '30';
  try {
    const s = session({ timer: fire => { queueMicrotask(fire); return () => {}; } });
    hello(s); await until(() => s.has('hello'), 'hello');
    await sendJob(s, { expectChanges: false });
    expect(await s.done).toBe(0);
    const r = s.messages().find(m => m.type === 'result')!;
    expect(r.exitCode).not.toBe(0);
    expect(r.bundleBytes).toBe(0);
  } finally { delete process.env.FABRICA_FAKE_SLEEP; }
});

test('T98: un fallo tras el spawn termina al agente antes de borrar el encargo', async () => {
  const saved = process.env.FABRICA_FAKE_SLEEP;
  process.env.FABRICA_FAKE_SLEEP = '30';
  let pid: number | undefined;
  const s = session({ timer: () => { [pid] = bwrapOf(); throw new Error('fallo sintético al armar el plazo'); } });
  try {
    hello(s); await until(() => s.has('hello'), 'hello');
    await sendJob(s);
    expect(await s.done).toBe(1);
    expect(pid).toBeDefined();
    expect(gone(pid!)).toBe(true);
    expect(readdirSync(join(root, 'jobs'))).toEqual([]);
    expect(s.messages().at(-1)).toMatchObject({ type: 'error', code: 'internal', message: expect.stringContaining('control de ejecución') });
  } finally {
    s.end();
    if (pid !== undefined) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
    if (saved === undefined) delete process.env.FABRICA_FAKE_SLEEP; else process.env.FABRICA_FAKE_SLEEP = saved;
  }
});

test('expectChanges falso no devuelve bundle aunque el agente escriba', async () => {
  process.env.FABRICA_FAKE_TOUCH = 'marca';
  try {
    const s = session(); hello(s); await until(() => s.has('hello'), 'hello');
    await sendJob(s, { expectChanges: false });
    expect(await s.done).toBe(0);
    expect(s.messages().find(m => m.type === 'result')).toMatchObject({ bundleBytes: 0, head: null, bundleSha256: null });
  } finally { delete process.env.FABRICA_FAKE_TOUCH; }
});

test('A9: symlink plantado en jobs/<jobId> o en jobs falla cerrado sin escribir fuera de la raíz', async () => {
  const victim = join(tmp, 'victima'); mkdirSync(victim);
  mkdirSync(join(root, 'jobs'), { recursive: true });
  symlinkSync(victim, join(root, 'jobs', 'act1-1'));
  const s = session(); hello(s); await until(() => s.has('hello'), 'hello');
  await sendJob(s);
  expect(await s.done).toBe(1);
  expect(s.messages().at(-1)).toMatchObject({ type: 'error', code: 'internal' });
  expect(readdirSync(victim)).toEqual([]);
  rmSync(join(root, 'jobs'), { recursive: true });
  symlinkSync(victim, join(root, 'jobs'));
  const t = session(); hello(t);
  expect(await t.done).toBe(1);
  expect(t.messages()[0]).toMatchObject({ type: 'error', code: 'internal' });
  expect(readdirSync(victim)).toEqual([]);
});

test('arranque: borra encargos de más de 24 h con reloj inyectado y conserva los recientes', async () => {
  const old = join(root, 'jobs', 'viejo'), fresh = join(root, 'jobs', 'nuevo');
  mkdirSync(old, { recursive: true }); mkdirSync(fresh);
  const t0 = Date.now();
  utimesSync(old, new Date(t0 - 25 * 3_600_000), new Date(t0 - 25 * 3_600_000));
  const s = session({ now: () => t0 });
  s.end();
  expect(await s.done).toBe(0);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
});

test('cada línea mal formada o fuera de orden corta la sesión sin ejecutar nada', async () => {
  for (const bad of ['no es json\n', JSON.stringify({ v: 1, type: 'job' }) + '\n', JSON.stringify({ v: 1, type: 'hello', repoKey: KEY, x: 1 }) + '\n']) {
    const s = session(); s.send(bad);
    expect(await s.done).toBe(1);
    expect(s.messages()[0]).toMatchObject({ type: 'error', code: 'bad_request' });
  }
});

test('H1: si el sellado rechaza el resultado, serve contesta result_rejected (no internal) y no deja restos', async () => {
  const s = session({ seal: async () => { throw new Error('repositorio anidado en el resultado'); } });
  hello(s); await until(() => s.has('hello'), 'hello');
  await sendJob(s);
  expect(await s.done).toBe(1);
  const e = s.messages().find(m => m.type === 'error')!;
  expect(e.code).toBe('result_rejected');
  expect(String(e.message)).not.toContain('anidado'); // texto fijo, sin detalle del árbol del agente
  expect(s.has('result')).toBe(false);
  expect(readdirSync(join(root, 'jobs'))).toEqual([]);
});

test('T98-H1/H2: un fallo tras el spawn borra el scratch confinado y el error no lleva el detalle interno', async () => {
  const scratch = join(tmp, 'scratch'); mkdirSync(scratch);
  const savedTmp = process.env.TMPDIR, savedSleep = process.env.FABRICA_FAKE_SLEEP;
  process.env.TMPDIR = scratch; process.env.FABRICA_FAKE_SLEEP = '30';
  let pid: number | undefined;
  const s = session({ timer: () => { [pid] = bwrapOf(); throw new Error('fallo sintético al armar el plazo'); } });
  try {
    hello(s); await until(() => s.has('hello'), 'hello');
    await sendJob(s);
    expect(await s.done).toBe(1);
    expect(readdirSync(scratch).filter(n => n.startsWith('fab-confine-'))).toEqual([]); // M20: sin `cleanup()` quedaría el directorio
    const message = String(s.messages().at(-1)!.message);
    expect(message).toContain('control de ejecución');
    expect(message).not.toContain('fallo sintético'); // M25: la fase se nombra, el detalle no viaja
  } finally {
    s.end();
    if (pid !== undefined) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
    if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
    if (savedSleep === undefined) delete process.env.FABRICA_FAKE_SLEEP; else process.env.FABRICA_FAKE_SLEEP = savedSleep;
  }
});

/** Registra las señales a procesos y los temporizadores de 2 s (el SIGKILL diferido de `runAgentJob`). */
function spyKills() {
  const signals: Array<[number, unknown]> = [], timers: unknown[] = [], cleared = new Set<unknown>();
  const kill = process.kill, set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  process.kill = ((pid: number, sig?: string | number) => { if (sig === 'SIGTERM' || sig === 'SIGKILL') signals.push([pid, sig]); return kill.call(process, pid, sig as never); }) as typeof process.kill;
  globalThis.setTimeout = ((fn: never, ms?: number, ...rest: never[]) => { const h = set(fn, ms, ...rest); if (ms === 2000) timers.push(h); return h; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((h?: never) => { cleared.add(h); return clear(h); }) as typeof clearTimeout;
  return { signals, timers, cleared, restore() { process.kill = kill; globalThis.setTimeout = set; globalThis.clearTimeout = clear; } };
}

test('T98-H3: cancelar y terminar el agente cancela el SIGKILL diferido; un plazo tardío no señala un grupo ya terminado', async () => {
  const savedSleep = process.env.FABRICA_FAKE_SLEEP;
  process.env.FABRICA_FAKE_SLEEP = '30';
  const spy = spyKills();
  try {
    const s = session({ timer: fire => { queueMicrotask(fire); return () => {}; } }); // el plazo vence ya: SIGTERM y temporizador de SIGKILL
    hello(s); await until(() => s.has('hello'), 'hello');
    await sendJob(s, { expectChanges: false });
    expect(await s.done).toBe(0);
    expect(spy.timers).toHaveLength(1);
    expect(spy.timers.every(h => spy.cleared.has(h))).toBe(true); // M22: sin clearTimeout seguiría vivo y dispararía SIGKILL tarde
  } finally { spy.restore(); }
  delete process.env.FABRICA_FAKE_SLEEP;
  const late = spyKills();
  try {
    let fire!: () => void;
    const s = session({ timer: f => { fire = f; return () => {}; } });
    hello(s); await until(() => s.has('hello'), 'hello');
    await sendJob(s, { expectChanges: false });
    expect(await s.done).toBe(0);
    expect(s.has('result')).toBe(true);
    late.signals.length = 0; late.timers.length = 0;
    fire(); // el plazo llega cuando el agente ya terminó: el PID pudo reutilizarse
    expect(late.signals).toEqual([]); // M21: sin la guarda `finished` se enviaría SIGTERM
    expect(late.timers).toEqual([]);
  } finally { late.restore(); if (savedSleep !== undefined) process.env.FABRICA_FAKE_SLEEP = savedSleep; }
});

// T98-H4(a): la aserción de la base, recuperada: todas las variables del proceso confinado están en una lista fija, no solo faltan tres canarios.
test('T98-H4: el argv lanzado es el del adaptador local y el entorno solo trae base y lista fija', async () => {
  const canary = { CANARIO_RUNNER: 'x1', GH_TOKEN: 'x2', SSH_AUTH_SOCK: '/tmp/x3', FABRICA_FAKE_SLEEP: '30' };
  Object.assign(process.env, canary);
  const s = session();
  try {
    hello(s); await until(() => s.has('hello'), 'hello');
    await sendJob(s, {}, 'act1-1', 'pide algo');
    await until(() => bwrapOf().length > 0, 'bwrap en marcha');
    const [pid] = bwrapOf();
    const cmd = procFile(pid!, 'cmdline').toString().split('\0');
    const expected = getAgent('fake').command('pide algo', { readOnly: false, confine: true, promptStdin: false });
    expect(cmd.slice(cmd.indexOf('--') + 1, cmd.indexOf('--') + 1 + expected.length)).toEqual(expected);
    const env = procFile(pid!, 'environ').toString().split('\0').filter(Boolean).map(l => l.split('=')[0]!);
    expect(env).not.toContain('CANARIO_RUNNER');
    expect(env).not.toContain('GH_TOKEN');
    expect(env).not.toContain('SSH_AUTH_SOCK');
    for (const k of env) expect(['PATH', 'HOME', 'TMPDIR', 'LANG', 'FABRICA_FAKE_SLEEP', 'FABRICA_FAKE_STATUS', 'FABRICA_FAKE_TOUCH'].includes(k) || k.startsWith('GIT_CONFIG_'), `variable inesperada ${k}`).toBe(true);
  } finally {
    for (const k of Object.keys(canary)) delete process.env[k];
    s.end(); await s.done;
  }
});
