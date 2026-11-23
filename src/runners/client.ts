// Lado casa de los runners remotos (T74 §4.1, §4.2, §4.6, §4.7). Una sesión por encargo, abierta desde casa.
// Todo lo que llega del runner es dato no confiable: pasa por protocol.ts, y el bundle de vuelta por importResult (T74c).
// Casa no ejecuta nada que mande el runner, no envía credenciales y nunca vuelve a local por un fallo (R2, R5, R9).
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundedAgentOutput, type AgentRun } from '../agents.ts';
import { parseReportStatus } from '../prompts.ts';
import { discardBundle, importResult, makeJobBundle, type Bundle } from './bundle.ts';
import { EXECUTION_ENDED_LOG, LIMITS, ProtocolError, decodeLine, encode, logBudget, type Message, type MessageType } from './protocol.ts';

export type RunnerErrorCode = 'RUNNER_UNREACHABLE' | 'RUNNER_REFUSED' | 'RUNNER_BUSY' | 'RUNNER_LOST' | 'RUNNER_RESULT_REJECTED';
/** Error tipado que el pool (T74f) mapea a bloquear, reencolar o fallar. El detalle lo escribe casa, nunca el runner. */
export class RunnerError extends Error {
  constructor(readonly code: RunnerErrorCode, detail: string, readonly reason?: 'timeout' | 'invalid_hello') {
    super(`${code}: ${detail.replace(/[^\x20-\x7e]/g, '?').slice(0, 200)}`);
    this.name = 'RunnerError';
  }
}

export interface RemoteRunner { name: string; /** Alias de ~/.ssh/config del dueño. */ target: string }
export interface RemoteJob {
  activityId: string; attempt: number; attemptId?: string; adapter: string; model: string | null; readOnly: boolean; expectChanges: boolean;
  prompt: string; repo: string; worktree: string; head: string; base: string; timeoutMs: number; repoKey: string;
  /** Tope de ida en MiB del runner (`--max-bundle-mb`); el del protocolo (512 MiB) manda si es menor. */
  maxBundleMb?: number;
  signal?: AbortSignal; onSpawn?: (pgid: number) => void; onDispatch?: () => void; onAccepted?: () => void; onExecutionEnd?: (durationMs: number | undefined) => void;
}
export interface Declared { fabSha: string; agentSha256: string | null; sandbox: string }
export interface RemoteDeps {
  /** Para tests sin esperas reales: arma un plazo y devuelve cómo cancelarlo. */
  timer?: (fire: () => void, ms: number) => () => void;
  /** Margen sobre `timeoutMs` para que el runner mate al agente y alcance a contestar. */
  graceMs?: number;
  monotonicNow?: () => number;
}
export type Transport = (runner: RemoteRunner) => string[];

const TARGET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KILL_MS = 2_000;
const CHECK_MS = 30_000;

/** El argv de §4.1, más las opciones que cierran lo que `~/.ssh/config` del dueño pudiera abrir (agente, X11, LocalCommand, multiplexado, known_hosts). */
export const sshTransport: Transport = runner => {
  if (!TARGET.test(runner.target)) throw new RunnerError('RUNNER_REFUSED', 'alias ssh inválido');
  return [
    'ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4',
    '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no',
    '-o', 'ControlPath=none', '-o', 'UpdateHostKeys=no', '-o', 'VerifyHostKeyDNS=no', '--', runner.target, 'fab-runner',
  ];
};

/** Entorno mínimo del proceso de transporte: nada de credenciales del modelo, aunque `SendEnv` las pidiera. */
function transportEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'SSH_AUTH_SOCK']) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

export class Reader {
  private buf = Buffer.alloc(0);
  private it: AsyncIterator<Uint8Array>;
  constructor(stream: ReadableStream<Uint8Array>) { this.it = (stream as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator](); }
  private async fill(): Promise<boolean> {
    try {
      const r = await this.it.next();
      if (r.done) return false;
      this.buf = Buffer.concat([this.buf, r.value]);
      return true;
    } catch { return false; } // proceso muerto: lo trata como fin de la sesión
  }
  /** Una línea sin el `\n`, o null en EOF. */
  async line(max: number): Promise<string | null> {
    for (;;) {
      const i = this.buf.indexOf(10);
      if (i >= 0) { const l = this.buf.subarray(0, i).toString('utf8'); this.buf = this.buf.subarray(i + 1); return l; }
      if (this.buf.length > max) throw new ProtocolError('línea demasiado larga');
      if (!await this.fill()) return null;
    }
  }
  /** Vuelca exactamente `n` bytes a `path`; false si la sesión acaba antes. */
  async toFile(path: string, n: number): Promise<boolean> {
    const fd = openSync(path, 'wx', 0o600);
    try {
      for (let left = n; left > 0;) {
        if (this.buf.length === 0 && !await this.fill()) return false;
        const take = this.buf.subarray(0, Math.min(left, this.buf.length));
        writeSync(fd, take);
        this.buf = this.buf.subarray(take.length);
        left -= take.length;
      }
      return true;
    } finally { closeSync(fd); }
  }
}

type Cause = 'timeout' | 'abort' | 'done';
function openSession(runner: RemoteRunner, transport: Transport, deps: RemoteDeps, ms: number, signal?: AbortSignal, onSpawn?: (pgid: number) => void) {
  const proc = Bun.spawn(transport(runner), { env: transportEnv(), stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', detached: true });
  try { onSpawn?.(proc.pid); } catch {}
  let cause: Cause | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (sig: 'SIGTERM' | 'SIGKILL') => { try { process.kill(-proc.pid, sig); } catch { try { proc.kill(sig); } catch {} } };
  const stop = (c: Cause) => {
    if (cause) return;
    cause = c;
    kill('SIGTERM');
    killTimer = setTimeout(() => kill('SIGKILL'), KILL_MS);
    killTimer.unref?.();
  };
  const onAbort = () => stop('abort');
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  const arm = deps.timer ?? ((fire, t) => { const h = setTimeout(fire, t); return () => clearTimeout(h); });
  const cancel = arm(() => stop('timeout'), ms);
  return {
    proc, reader: new Reader(proc.stdout), get cause() { return cause; },
    // Un pipe roto (EPIPE) solo dice que el otro extremo cerró: lo clasifica `next` al leer el EOF (UNREACHABLE en el hello, LOST después).
    async send(data: string | Uint8Array) { try { proc.stdin.write(data); await proc.stdin.flush(); } catch {} },
    /** Cierra la sesión: el runner ve EOF, mata al agente y limpia; casa mata el grupo de `ssh`. */
    async close(): Promise<number> {
      try { proc.stdin.end(); } catch {}
      stop('done');
      const code = await proc.exited;
      cancel(); if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      return code;
    },
  };
}
type Session = ReturnType<typeof openSession>;

const REFUSED: readonly string[] = ['not_confinable', 'unknown_adapter', 'agent_missing', 'bad_request'];
function runnerError(m: Extract<Message, { type: 'error' }>): RunnerError {
  if (m.code === 'busy') return new RunnerError('RUNNER_BUSY', 'el runner está ocupado');
  if (REFUSED.includes(m.code)) return new RunnerError('RUNNER_REFUSED', m.code);
  if (m.code === 'result_rejected') return new RunnerError('RUNNER_RESULT_REJECTED', 'el runner no pudo sellar el resultado'); // determinista: no se reintenta
  return new RunnerError('RUNNER_LOST', `error ${m.code} del runner`); // internal: el intento se repite
}

/** Lee el siguiente mensaje. Antes del primer hello, un EOF es «no conectó»; después, «se perdió». */
async function next(s: Session, expect: MessageType[], phase: 'hello' | 'job', opts: { expectChanges?: boolean } = {}): Promise<Message> {
  let line: string | null;
  try { line = await s.reader.line(LIMITS.lineBytes); } catch (e) {
    if (phase === 'hello' && e instanceof ProtocolError) throw new RunnerError('RUNNER_RESULT_REJECTED', e.message, 'invalid_hello');
    throw rejected(e);
  }
  if (line === null) throw new RunnerError(phase === 'hello' ? 'RUNNER_UNREACHABLE' : 'RUNNER_LOST', phase === 'hello' ? 'sin respuesta del runner' : 'la sesión terminó sin resultado');
  let m: Message;
  try { m = decodeLine(line, [...expect, 'error'], 'runner', opts); } catch (e) {
    if (phase === 'hello' && e instanceof ProtocolError) throw new RunnerError('RUNNER_REFUSED', `hello inválido: ${e.message}`, 'invalid_hello');
    throw rejected(e);
  }
  if (m.type === 'error') throw runnerError(m);
  return m;
}
const rejected = (e: unknown) => new RunnerError('RUNNER_RESULT_REJECTED', e instanceof Error ? e.message : String(e));

type RunnerHello = Extract<Message, { have: string[] }>;
async function handshake(s: Session, repoKey: string): Promise<RunnerHello> {
  await s.send(encode({ v: 1, type: 'hello', repoKey }));
  return await next(s, ['hello'], 'hello') as RunnerHello;
}

async function sendJob(s: Session, line: string, prompt: Buffer, bundlePath: string) {
  await s.send(line);
  await s.send(prompt);
  for await (const chunk of createReadStream(bundlePath)) await s.send(chunk as Buffer);
}

const failedRun = (cause: Cause, start: number, log: string, exitCode: number): AgentRun => ({
  ok: false, output: '', exitCode, durationMs: Date.now() - start, status: { kind: 'missing', reason: cause === 'timeout' ? 'timeout' : 'aborted' }, stdout: log,
});

export async function runRemoteAgent(runner: RemoteRunner, job: RemoteJob, transport: Transport = sshTransport, deps: RemoteDeps = {}): Promise<AgentRun & { declared: Declared }> {
  const start = Date.now();
  const jobId = job.attemptId ?? `${job.activityId}-${job.attempt}`;
  const s = openSession(runner, transport, deps, job.timeoutMs + (deps.graceMs ?? 30_000), job.signal, job.onSpawn);
  const tmp = mkdtempSync(join(tmpdir(), 'fab-remote-'));
  const budget = logBudget();
  const log: Buffer[] = [];
  let declared: Declared = { fabSha: '', agentSha256: null, sandbox: '' };
  let bundle: Bundle | undefined;
  try {
    const hello = await handshake(s, job.repoKey);
    declared = { fabSha: hello.fabSha, agentSha256: hello.agents[job.adapter]?.sha256 ?? null, sandbox: hello.sandbox };
    bundle = await makeJobBundle(job.repo, job.head, hello.have);
    const prompt = Buffer.from(job.prompt);
    // Se valida lo que se va a enviar con las mismas reglas que aplicará el runner: un encargo mal formado no sale de casa.
    const jobLine = encode({
      v: 1, type: 'job', jobId, adapter: job.adapter, model: job.model, readOnly: job.readOnly, expectChanges: job.expectChanges,
      timeoutMs: job.timeoutMs, base: job.base, head: job.head, promptBytes: prompt.length, bundleBytes: bundle.bytes, bundleSha256: bundle.sha256,
    });
    const maxBundleBytes = Math.min((job.maxBundleMb ?? Infinity) * 1024 * 1024, LIMITS.jobBundleBytes);
    try { decodeLine(jobLine.trimEnd(), ['job'], 'home', { maxBundleBytes }); } catch (e) { throw new RunnerError('RUNNER_REFUSED', `encargo inválido: ${(e as Error).message}`); }
    // Si el runner contesta `error` y cierra a mitad, la escritura falla: lo que cuenta es lo que dijo.
    // Desde el envío, si se pierde la conexión puede haber inferencia sin contadores.
    job.onDispatch?.();
    try { await sendJob(s, jobLine, prompt, bundle.path); } catch {}
    discardBundle(bundle); // ya salió: no se retiene hasta 512 MiB mientras corre el agente

    const accepted = await next(s, ['accepted'], 'job');
    if (accepted.type !== 'accepted' || accepted.jobId !== jobId) throw new RunnerError('RUNNER_RESULT_REJECTED', 'accepted con otro jobId');
    const monotonicNow = deps.monotonicNow ?? (() => performance.now());
    const acceptedAt = monotonicNow();
    job.onAccepted?.();
    let executionMs: number | undefined;
    let ended = false;
    let result: Extract<Message, { type: 'result' }> | undefined;
    while (!result) {
      const m = await next(s, ['log', 'result'], 'job', { expectChanges: job.expectChanges });
      if (m.type === 'result') result = m;
      if (m.type === 'log' && m.data === EXECUTION_ENDED_LOG) {
        executionMs = ended ? undefined : Math.round(monotonicNow() - acceptedAt);
        ended = true;
        job.onExecutionEnd?.(executionMs);
      } else if (m.type === 'log') {
        const kept = budget.take(Buffer.from(m.data, 'base64'));
        if (kept.length) log.push(kept);
      }
    }
    if (result.jobId !== jobId) throw new RunnerError('RUNNER_RESULT_REJECTED', 'result con otro jobId');
    // R6: solo con el resultado completo se toca el worktree; importResult verifica tamaño, hash, padre y fast-forward.
    if (result.bundleBytes > 0) {
      const path = join(tmp, 'result.bundle');
      if (!await s.reader.toFile(path, result.bundleBytes)) throw new RunnerError('RUNNER_LOST', 'la sesión terminó a mitad del bundle');
      try {
        await importResult(job.repo, job.worktree, job.head, { path, bytes: result.bundleBytes, sha256: result.bundleSha256!, head: result.head!, expectChanges: job.expectChanges }, jobId);
      } catch (e) { throw rejected(e); }
    }
    const output = boundedAgentOutput(result.output);
    const text = Buffer.concat(log).toString('utf8') + (budget.dropped ? `\n[log: ${budget.dropped} bytes descartados]\n` : '');
    const st = parseReportStatus(output);
    return {
      ok: result.exitCode === 0 && output.length > 0, output, exitCode: result.exitCode, durationMs: result.durationMs, executionMs,
      status: { kind: st.kind, reason: st.reason }, ...(result.usage ? { usage: result.usage } : {}), stdout: text, declared,
    };
  } catch (e) {
    // Plazo o aborto: se comporta como un agente local que se agota o se cancela; no se importó nada.
    if (s.cause === 'timeout' || s.cause === 'abort') return { ...failedRun(s.cause, start, Buffer.concat(log).toString('utf8'), 1), declared };
    throw e;
  } finally {
    if (bundle) discardBundle(bundle); // también si el encargo no pasó la validación
    await s.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface RunnerCheck { protocol: 1; fabSha: string; sandbox: string; agents: Record<string, { sha256: string }> }
/** `fab runner check`: abre la sesión e intercambia `hello`. No envía código ni bundles. */
export async function checkRunner(runner: RemoteRunner, transport: Transport = sshTransport, deps: RemoteDeps = {}, signal?: AbortSignal): Promise<RunnerCheck> {
  const s = openSession(runner, transport, deps, CHECK_MS, signal);
  try {
    const h = await handshake(s, createHash('sha256').update('fab-runner-check').digest('hex'));
    return { protocol: 1, fabSha: h.fabSha, sandbox: h.sandbox, agents: h.agents };
  } catch (e) {
    if (s.cause === 'timeout') throw new RunnerError('RUNNER_UNREACHABLE', 'tiempo agotado', 'timeout');
    if (s.cause === 'abort') throw new RunnerError('RUNNER_UNREACHABLE', 'cancelado');
    throw e;
  } finally { await s.close(); }
}
