import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RunnerError, type RunnerErrorCode, checkRunner, runRemoteAgent, sshTransport, type RemoteJob, type Transport } from '../src/runners/client.ts';
import { runnerMain } from '../src/runner-cli.ts';

const FAKE = resolve(import.meta.dir, 'helpers/fake-runner.ts');
const runner = { name: 'torre', target: 'torre' };
const noTimer = { timer: () => () => {} }; // los tests no esperan plazos reales
let tmp: string, home: string, wt: string, head: string, dir: string;

const git = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
const fake = (scenario: string): Transport => () => ['bun', FAKE, scenario, dir];
const job = (over: Partial<RemoteJob> = {}): RemoteJob => ({
  activityId: 'act1', attempt: 1, adapter: 'fake', model: null, readOnly: false, expectChanges: true, prompt: 'haz algo',
  repo: home, worktree: wt, head, base: head, timeoutMs: 60_000, repoKey: 'a'.repeat(64), ...over,
});
const rejects = async (p: Promise<unknown>, code: RunnerErrorCode) => {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(RunnerError); expect((e as RunnerError).code).toBe(code); return (e as Error).message; }
  throw new Error('no rechazó');
};
const untouched = () => { expect(git(wt, 'rev-parse', 'HEAD')).toBe(head); expect(git(wt, 'status', '--porcelain', '--untracked-files=all')).toBe(''); };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fab-client-'));
  home = join(tmp, 'home'); wt = join(tmp, 'wt'); dir = join(tmp, 'fake'); mkdirSync(home); mkdirSync(dir);
  git(home, 'init', '-q', '-b', 'main');
  Bun.write(join(home, 'a.txt'), 'uno\n');
  git(home, 'add', '-A'); git(home, 'commit', '-q', '-m', 'base');
  head = git(home, 'rev-parse', 'HEAD');
  git(home, 'worktree', 'add', '-q', '-b', 'fab/change', wt);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

test('ciclo completo: log, informe, uso y commit importado con el padre enviado; declared sin verificar', async () => {
  const r = await runRemoteAgent(runner, job(), fake('ok'));
  expect(r.ok).toBe(true);
  expect(r.output).toBe('hecho');
  expect(r.stdout).toContain('trabajando');
  expect(r.declared).toEqual({ fabSha: 'fake123', agentSha256: 'c'.repeat(64), sandbox: 'bwrap' });
  expect(git(wt, 'rev-parse', 'HEAD^')).toBe(head);
  expect(readFileSync(join(wt, 'nuevo.txt'), 'utf8')).toBe('hola desde el runner\n');
});

test('A1: ningún canario de credenciales llega al runner ni a su entorno', async () => {
  const canary = { ANTHROPIC_API_KEY: 'CANARIO-ANT', GH_TOKEN: 'CANARIO-GH', OPENAI_API_KEY: 'CANARIO-OAI', DECLARADA: 'CANARIO-ENV' };
  Object.assign(process.env, canary);
  try { await runRemoteAgent(runner, job(), fake('ok')); } finally { for (const k of Object.keys(canary)) delete process.env[k]; }
  const seen = readFileSync(join(dir, 'transcript')).toString('latin1') + readFileSync(join(dir, 'env'), 'utf8');
  for (const v of Object.values(canary)) expect(seen).not.toContain(v);
  for (const k of Object.keys(canary)) expect(seen).not.toContain(k);
});

test('A2: un runner que miente es rechazado sin tocar el worktree', async () => {
  for (const s of ['evil-extra', 'evil-usage', 'evil-line', 'evil-jobid']) {
    await rejects(runRemoteAgent(runner, job(), fake(s)), 'RUNNER_RESULT_REJECTED');
    untouched();
  }
});

test('A2: output enorme se recorta, log enorme se acota y se anota; el resultado sin cambios no importa nada', async () => {
  const o = await runRemoteAgent(runner, job({ expectChanges: false }), fake('evil-output'));
  expect(o.output.length).toBeLessThanOrEqual(20_000);
  const l = await runRemoteAgent(runner, job({ expectChanges: false }), fake('evil-log'));
  expect(l.stdout!.length).toBeLessThan(5 * 1024 * 1024 + 200);
  expect(l.stdout).toContain('descartados');
  untouched();
});

test('A2/A3: bundle con hash distinto o que llega a mitad no importa nada; el reintento parte del mismo head', async () => {
  await rejects(runRemoteAgent(runner, job(), fake('bundle-bad-hash')), 'RUNNER_RESULT_REJECTED');
  untouched();
  await rejects(runRemoteAgent(runner, job({ attempt: 2 }), fake('lost-bundle')), 'RUNNER_LOST');
  untouched();
  await runRemoteAgent(runner, job({ attempt: 3 }), fake('ok'));
  expect(git(wt, 'rev-parse', 'HEAD^')).toBe(head);
});

test('A8: el argv de ssh lleva las opciones de §4.1 y rechaza alias con usuario@host o guion', () => {
  const argv = sshTransport(runner);
  for (const o of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ServerAliveInterval=15', 'ServerAliveCountMax=4', 'ClearAllForwardings=yes', 'ForwardAgent=no']) expect(argv).toContain(o);
  expect(argv.join(' ')).not.toContain('accept-new');
  expect(argv.slice(-3)).toEqual(['--', 'torre', 'fab-runner']);
  for (const t of ['u@h', '-oProxyCommand=x', 'a b', '']) expect(() => sshTransport({ name: 'x', target: t })).toThrow(RunnerError);
});

test('§4.7: sin conexión o clave de host rechazada → RUNNER_UNREACHABLE y no sale código', async () => {
  await rejects(runRemoteAgent(runner, job(), fake('die')), 'RUNNER_UNREACHABLE');
  await rejects(runRemoteAgent(runner, job(), () => ['sh', '-c', 'exit 255']), 'RUNNER_UNREACHABLE');
  untouched();
});

test('A16: hello con otra versión → RUNNER_REFUSED', async () => {
  await rejects(runRemoteAgent(runner, job(), fake('v2')), 'RUNNER_REFUSED');
});

test('§4.7: error del runner → REFUSED, BUSY (reencolable) o LOST; el texto del runner no se copia', async () => {
  for (const c of ['not_confinable', 'unknown_adapter', 'agent_missing', 'bad_request']) await rejects(runRemoteAgent(runner, job(), fake(`refuse:${c}`)), 'RUNNER_REFUSED');
  await rejects(runRemoteAgent(runner, job(), fake('busy')), 'RUNNER_BUSY');
  await rejects(runRemoteAgent(runner, job(), fake('refuse:internal')), 'RUNNER_LOST');
});

test('A11/§4.7: corte tras accepted o a mitad del log → RUNNER_LOST sin importar nada', async () => {
  await rejects(runRemoteAgent(runner, job(), fake('lost-accepted')), 'RUNNER_LOST');
  await rejects(runRemoteAgent(runner, job(), fake('lost-log')), 'RUNNER_LOST');
  untouched();
});

test('A10: un runner caído nunca cae a local: el error es tipado y no se importa nada', async () => {
  const e = await rejects(runRemoteAgent(runner, job(), fake('die')), 'RUNNER_UNREACHABLE');
  expect(e).toContain('RUNNER_UNREACHABLE');
  untouched();
});

test('el plazo mata el proceso de transporte y devuelve un fallo como un agente local agotado', async () => {
  let spawned = 0;
  let fire!: () => void;
  const timer = (f: () => void) => { fire = f; return () => {}; };
  const p = runRemoteAgent(runner, job({ onSpawn: pid => { spawned = pid; } }), fake('hang'), { timer });
  while (!spawned || !await Bun.file(join(dir, 'transcript')).exists()) await Bun.sleep(0); // sin plazos fijos: espera a que el runner haya contestado hello
  fire();
  const r = await p;
  expect(r.ok).toBe(false);
  expect(r.status.reason).toBe('timeout');
  expect(() => process.kill(spawned, 0)).toThrow();
  untouched();
});

test('abortar la señal mata el transporte y no importa nada', async () => {
  const ac = new AbortController();
  let spawned = 0;
  const p = runRemoteAgent(runner, job({ signal: ac.signal, onSpawn: pid => { spawned = pid; } }), fake('hang'), noTimer);
  while (!await Bun.file(join(dir, 'transcript')).exists()) await Bun.sleep(0);
  ac.abort();
  const r = await p;
  expect(r.ok).toBe(false);
  expect(() => process.kill(spawned, 0)).toThrow();
  untouched();
});

test('fab runner check: intercambia hello y no envía código ni bundle', async () => {
  const c = await checkRunner(runner, fake('check'), noTimer);
  expect(c).toMatchObject({ protocol: 1, fabSha: 'fake123', sandbox: 'bwrap' });
  const sent = readFileSync(join(dir, 'transcript'), 'utf8');
  expect(sent.trim().split('\n')).toHaveLength(1);
  expect(sent).toContain('"type":"hello"');
  expect(sent).not.toContain('"type":"job"');
  const out: string[] = [];
  const spy = console.log; console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  try { expect(await runnerMain(['check', '--ssh', 'torre'], fake('check'))).toBe(0); } finally { console.log = spy; }
  expect(out.join('\n')).toContain('no verificado');
});

test('fab runner check: sin conexión devuelve 1; sin argumentos, 2', async () => {
  const err = console.error; console.error = () => {};
  try {
    expect(await runnerMain(['check', '--ssh', 'torre'], fake('die'))).toBe(1);
    expect(await runnerMain(['check'])).toBe(2);
  } finally { console.error = err; }
});

test('un encargo mal formado no sale de casa (prompt de más de 1 MiB) y un bundle en un encargo de solo lectura se rechaza', async () => {
  await rejects(runRemoteAgent(runner, job({ prompt: 'x'.repeat(1024 * 1024 + 1) }), fake('ok')), 'RUNNER_REFUSED');
  expect(Bun.file(join(dir, 'transcript')).size).toBeLessThan(200); // solo el hello
  await rejects(runRemoteAgent(runner, job({ readOnly: true, expectChanges: false }), fake('ok')), 'RUNNER_RESULT_REJECTED');
  untouched();
});
