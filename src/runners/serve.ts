// Lado runner de los runners remotos (T74 §4.5). Ejecutor sin estado: una sesión, un encargo, por stdin/stdout.
// No arranca trabajo, no sondea y no habla con GitHub. La credencial del modelo es la del propio runner (D10, P1):
// nada viaja desde casa, y el entorno del agente sale de `agentEnv` sobre el entorno del runner (R2, R4).
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { boundedAgentOutput, getAgent, type AgentAdapter } from '../agents.ts';
import { fabSha } from '../profile.ts';
import { assertConfinement, confineAgent, CONFINABLE_AGENTS } from '../sandbox/confine.ts';
import { GIT_SAFE_FLAGS } from '../worktrees.ts';
import { receiveJob, sealResult } from './bundle.ts';
import { Reader } from './client.ts';
import { LIMITS, ProtocolError, decodeLine, encode, logBudget, type ErrorCode, type Message } from './protocol.ts';

const DAY_MS = 24 * 3_600_000;
const KILL_MS = 2_000;
const CHUNK = 64 * 1024; // en base64 queda muy por debajo del tope de línea
const STDOUT_CAP = 32 * 1024 * 1024;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface ServeDeps {
  /** Reloj inyectado para la limpieza de 24 h. */
  now?: () => number;
  /** Para tests sin esperas reales: arma el plazo del agente y devuelve cómo cancelarlo. */
  timer?: (fire: () => void, ms: number) => () => void;
  /** SIGHUP/SIGTERM del proceso: equivale a que casa cierre la sesión. */
  signal?: AbortSignal;
  confine?: (adapter: string) => void;
  /** Solo tests: sustituye al sellado para provocar un rechazo determinista. */
  seal?: typeof sealResult;
}
type Write = (b: string | Buffer) => Promise<void>;
type Out = (m: Message) => void;

const GIT_ENV = { PATH: process.env.PATH ?? '', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

/** Directorio propio del runner: real, no un symlink (A9). */
function ensureDir(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  if (!lstatSync(path).isDirectory()) throw new Error('directorio inesperado en la raíz del runner');
}

function config(root: string): { maxJobs: number; maxBundleMb: number } {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(readFileSync(join(root, 'runner.json'), 'utf8')); } catch {}
  const pos = (x: unknown, d: number, max: number) => (typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= max ? x : d);
  return { maxJobs: pos(raw.maxJobs, 1, 64), maxBundleMb: pos(raw.maxBundleMb, 512, 512) };
}

const alive = (pid: number) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const lockPid = (path: string) => { try { return Number(readFileSync(path, 'utf8')); } catch { return NaN; } };

/** Borra encargos y bloqueos huérfanos de más de 24 h o de procesos muertos. */
function sweep(root: string, jobs: string, now: number): void {
  for (const n of readdirSync(jobs)) {
    const p = join(jobs, n);
    if (n.startsWith('.lock-')) { if (!alive(lockPid(p))) rmSync(p, { force: true }); continue; }
    if (now - lstatSync(p).mtimeMs > DAY_MS) rmSync(p, { recursive: true, force: true });
  }
  for (const n of readdirSync(root)) if (n.startsWith('in-') && now - lstatSync(join(root, n)).mtimeMs > DAY_MS) rmSync(join(root, n), { recursive: true, force: true });
}

/** `maxJobs` con ficheros de bloqueo en `jobs/`. En una carrera de arranque simultáneo ambos pueden contestar `busy`: es el lado seguro. */
function takeLock(jobs: string, jobId: string, max: number): boolean {
  const mine = join(jobs, `.lock-${jobId}`);
  const create = () => writeFileSync(mine, String(process.pid), { flag: 'wx', mode: 0o600 });
  try { create(); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    if (alive(lockPid(mine))) return false;
    rmSync(mine, { force: true });
    create();
  }
  const live = readdirSync(jobs).filter(n => n.startsWith('.lock-') && alive(lockPid(join(jobs, n)))).length;
  if (live > max) { rmSync(mine, { force: true }); return false; }
  return true;
}

async function git(cwd: string, ...args: string[]): Promise<string | null> {
  const p = Bun.spawn(['git', ...GIT_SAFE_FLAGS, ...args], { cwd, env: GIT_ENV, stdout: 'pipe', stderr: 'ignore' });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return code === 0 ? out.trim() : null;
}

async function cacheHave(cache: string): Promise<string[]> {
  if (lstatSync(cache, { throwIfNoEntry: false })?.isDirectory() !== true) return [];
  const tip = await git(cache, `--git-dir=${cache}`, 'rev-parse', '--verify', '-q', 'refs/fab/cache/head^{commit}');
  return tip && /^[0-9a-f]{40}$/.test(tip) ? [tip] : [];
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const c of Bun.file(path).stream() as unknown as AsyncIterable<Uint8Array>) h.update(c);
  return h.digest('hex');
}

/** Binario de cada adaptador confinable que hay en este runner, con su hash. Dato declarado, no verificado. */
async function declaredAgents(): Promise<Record<string, { sha256: string }>> {
  const out: Record<string, { sha256: string }> = {};
  for (const name of CONFINABLE_AGENTS) {
    try {
      const bin = Bun.which(getAgent(name).command('', {})[0]!, { PATH: process.env.PATH });
      if (bin) out[name] = { sha256: await sha256File(realpathSync(bin)) };
    } catch {}
  }
  return out;
}

/** Lanza el agente confinado en `repo`, reenvía su salida como `log` y devuelve el resultado. El argv lo construye el adaptador del runner (R4). */
async function runAgentJob(
  agent: AgentAdapter, job: Extract<Message, { type: 'job' }>, prompt: string, repo: string, send: Out,
  deps: ServeDeps, aborted: () => boolean, onProc: (kill: () => void) => void,
) {
  const start = Date.now();
  let phase = 'preparación';
  let confined: ReturnType<typeof confineAgent> | undefined;
  try {
    const argv = agent.command(prompt, { readOnly: job.readOnly, confine: true, promptStdin: agent.promptStdin === true, ...(job.model ? { model: job.model } : {}) });
    // Modo declarado y lista vacía: solo la base y las variables fijas del adaptador, tomadas del entorno de este runner.
    confined = confineAgent(agent.name, argv, repo, agent.env?.(), undefined, undefined, job.model ?? undefined, { wsAllow: [], roleEnv: [], mcpRequired: [] });
    phase = 'lanzamiento';
    const proc = confined.spawn(agent.promptStdin ? new TextEncoder().encode(prompt) : 'ignore');
    const killGroup = (sig: 'SIGTERM' | 'SIGKILL') => { try { process.kill(-proc.pid, sig); } catch { try { proc.kill(sig); } catch {} } };
    let stopped = false;
    let finished = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    const stop = () => {
      if (stopped || finished) return;
      stopped = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_MS);
      killTimer.unref?.();
    };
    let stdout = '', stderr = '', code: number;
    phase = 'control de ejecución';
    try {
      onProc(stop);
      if (aborted()) stop();
      const arm = deps.timer ?? ((fire, ms) => { const h = setTimeout(fire, ms); return () => clearTimeout(h); });
      cancel = arm(stop, job.timeoutMs);
      phase = 'lectura de salida';
      const budget = logBudget();
      const pump = async (s: ReadableStream<Uint8Array>, keep: (t: string) => void) => {
        for await (const c of s as unknown as AsyncIterable<Uint8Array>) {
          const buf = Buffer.from(c);
          keep(buf.toString('utf8'));
          for (let i = 0; i < buf.length; i += CHUNK) { const kept = budget.take(buf.subarray(i, i + CHUNK)); if (kept.length) send({ v: 1, type: 'log', data: kept.toString('base64') }); }
        }
      };
      [, , code] = await Promise.all([
        pump(proc.stdout, t => { if (stdout.length < STDOUT_CAP) stdout += t; }),
        pump(proc.stderr, t => { if (stderr.length < STDOUT_CAP) stderr += t; }),
        proc.exited,
      ]);
    } catch (e) {
      killGroup('SIGKILL');
      await proc.exited.catch(() => {});
      throw e;
    } finally {
      finished = true;
      clearTimeout(killTimer);
      cancel?.();
    }
    phase = 'interpretación del resultado';
    const parsed = agent.parse?.(stdout) ?? null;
    const output = boundedAgentOutput((parsed ? parsed.text : stdout).trim() || stderr.trim());
    return { exitCode: Math.max(-255, Math.min(255, code ?? 1)), durationMs: Date.now() - start, usage: parsed?.usage ?? null, output };
  } catch {
    return { error: `falló la fase de ${phase} del agente` } as const;
  } finally { confined?.cleanup(); }
}

export async function serveSession(rootArg: string, stdin: ReadableStream<Uint8Array>, write: Write, deps: ServeDeps = {}): Promise<number> {
  let q: Promise<void> = Promise.resolve();
  const out = (b: string | Buffer) => { q = q.then(() => write(b)).catch(() => {}); return q; };
  const send: Out = m => { out(encode(m)); };
  const fail = (code: ErrorCode, message: string): number => { send({ v: 1, type: 'error', code, message }); return 1; };
  const reader = new Reader(stdin);
  const confine = deps.confine ?? assertConfinement;
  const tidy: Array<() => unknown> = [];
  try {
    mkdirSync(rootArg, { recursive: true, mode: 0o700 });
    const root = realpathSync(rootArg);
    const jobs = join(root, 'jobs');
    ensureDir(join(root, 'cache')); ensureDir(jobs);
    sweep(root, jobs, (deps.now ?? Date.now)());
    const cfg = config(root);

    // 1-2. hello: casa nombra el repo; el runner dice qué tiene y qué es.
    let line: string | null;
    try { line = await reader.line(LIMITS.lineBytes); } catch (e) { return fail('bad_request', (e as Error).message); }
    if (line === null) return 0;
    let hello: Message;
    try { hello = decodeLine(line, ['hello'], 'home'); } catch (e) { return fail('bad_request', (e as ProtocolError).message); }
    if (hello.type !== 'hello' || !('repoKey' in hello)) return fail('bad_request', 'hello inesperado');
    const cache = join(root, 'cache', `${hello.repoKey}.git`);
    let sandbox = 'bwrap';
    try { confine('fake'); } catch { sandbox = 'none'; }
    const sha = fabSha();
    send({ v: 1, type: 'hello', have: await cacheHave(cache), fabSha: sha && TOKEN.test(sha) ? sha : 'unknown', sandbox, agents: await declaredAgents() });

    // 3. job.
    try { line = await reader.line(LIMITS.lineBytes); } catch (e) { return fail('bad_request', (e as Error).message); }
    if (line === null) return 0;
    let decoded: Message;
    try { decoded = decodeLine(line, ['job'], 'home', { maxBundleBytes: cfg.maxBundleMb * 1024 * 1024 }); } catch (e) { return fail('bad_request', (e as ProtocolError).message); }
    if (decoded.type !== 'job') return fail('bad_request', 'job inesperado');
    const job = decoded;
    try { confine(job.adapter); } catch { return fail('not_confinable', 'el runner no puede confinar este adaptador'); } // R3: sin confinar no se ejecuta
    let agent: AgentAdapter;
    try { agent = getAgent(job.adapter); } catch { return fail('unknown_adapter', job.adapter); }
    if (!Bun.which(agent.command('', {})[0]!, { PATH: process.env.PATH })) return fail('agent_missing', job.adapter);
    if (!takeLock(jobs, job.jobId, cfg.maxJobs)) return fail('busy', 'el runner está ocupado');
    tidy.push(() => rmSync(join(jobs, `.lock-${job.jobId}`), { force: true }));
    tidy.push(() => rmSync(join(jobs, job.jobId), { recursive: true, force: true }));

    // Prompt y bundle a un directorio nuevo y privado del runner; el sandbox no lo ve.
    const incoming = mkdtempSync(join(root, 'in-'));
    tidy.push(() => rmSync(incoming, { recursive: true, force: true }));
    const promptPath = join(incoming, 'prompt'), bundlePath = join(incoming, 'job.bundle');
    if (!await reader.toFile(promptPath, job.promptBytes) || !await reader.toFile(bundlePath, job.bundleBytes)) return 1;
    const prompt = readFileSync(promptPath, 'utf8');

    let stopAgent = () => {};
    let closed = false;
    const onClose = () => { closed = true; stopAgent(); };
    deps.signal?.addEventListener('abort', onClose, { once: true });
    tidy.push(() => deps.signal?.removeEventListener('abort', onClose));
    if (deps.signal?.aborted) closed = true;
    // Tras el job casa no envía nada más: cualquier byte o el EOF significan que la sesión se cerró.
    reader.line(LIMITS.lineBytes).then(onClose, onClose);

    let repo: string;
    try { repo = await receiveJob(cache, { path: bundlePath, bytes: job.bundleBytes, sha256: job.bundleSha256 }, job.head, job.jobId); } catch { return fail('internal', 'no se pudo preparar el encargo'); }
    tidy.push(() => git(cache, `--git-dir=${cache}`, 'update-ref', '-d', `refs/fab/in/${job.jobId}`));
    send({ v: 1, type: 'accepted', jobId: job.jobId });

    const run = await runAgentJob(agent, job, prompt, repo, send, deps, () => closed, k => { stopAgent = k; });
    if (closed) return 0;
    if (run.error !== undefined) return fail('internal', run.error);

    // 6. Sellado: git sobre la caché y un índice propio, nunca sobre el `.git` del clon.
    let sealed = null;
    if (job.expectChanges) {
      try { sealed = await (deps.seal ?? sealResult)(cache, repo, join(jobs, job.jobId, 'index'), job.head); } catch { return fail('result_rejected', 'no se pudo sellar el resultado'); }
    }
    if (sealed) tidy.push(() => rmSync(join(sealed!.bundle.path, '..'), { recursive: true, force: true }));
    send({
      v: 1, type: 'result', jobId: job.jobId, ...run, head: sealed?.sha ?? null,
      bundleBytes: sealed?.bundle.bytes ?? 0, bundleSha256: sealed?.bundle.sha256 ?? null,
    });
    if (sealed) await out(Buffer.from(readFileSync(sealed.bundle.path)));
    await q;
    return 0;
  } catch (e) {
    return fail('internal', e instanceof Error && e.name === 'ProtocolError' ? e.message : 'error interno del runner');
  } finally {
    for (const t of tidy.reverse()) { try { await t(); } catch {} }
    await q;
  }
}
