// Protocolo v1 de los runners remotos (T74 §4.2). Puro: sin E/S ni git.
// Todo lo que llega del otro lado es dato no confiable: cada campo se valida y una violación lanza ProtocolError.
import { boundedAgentOutput } from '../agents.ts';
import { modelId, readUsage, tokenCount, type AgentUsage } from '../inference-usage.ts';
import { MODEL_RE } from '../profile.ts';
import { CONFINABLE_AGENTS } from '../sandbox/confine.ts';

const MiB = 1024 * 1024;
const ERROR_CODES = ['not_confinable', 'busy', 'bad_request', 'unknown_adapter', 'agent_missing', 'result_rejected', 'internal'] as const;
export const LIMITS = {
  version: 1,
  lineBytes: MiB,
  promptBytes: MiB,
  jobBundleBytes: 512 * MiB, // por defecto; el runner lo baja con maxBundleMb
  resultBundleBytes: 64 * MiB,
  logBytes: 5 * MiB,
  haveMax: 64,
  timeoutMs: [1_000, 3_600_000] as const,
  messageChars: 2_000,
  /** Por encima de esto el uso declarado por el runner no es creíble: se descarta (No medido) en vez de sumarse a las métricas. */
  usageMax: { costUsd: 10_000, tokens: 1_000_000_000 },
  errorCodes: ERROR_CODES,
};

export type ErrorCode = (typeof ERROR_CODES)[number];
export type Usage = AgentUsage;
export type Message =
  | { v: 1; type: 'hello'; repoKey: string }
  | { v: 1; type: 'hello'; have: string[]; fabSha: string; sandbox: string; agents: Record<string, { sha256: string }> }
  | { v: 1; type: 'job'; jobId: string; adapter: string; model: string | null; readOnly: boolean; expectChanges: boolean; timeoutMs: number; base: string; head: string; promptBytes: number; bundleBytes: number; bundleSha256: string }
  | { v: 1; type: 'accepted'; jobId: string }
  | { v: 1; type: 'log'; data: string }
  | { v: 1; type: 'result'; jobId: string; exitCode: number; durationMs: number; usage: Usage | null; output: string; head: string | null; bundleBytes: number; bundleSha256: string | null }
  | { v: 1; type: 'error'; code: ErrorCode; message: string };
export type MessageType = Message['type'];
/** Quién envía: `home` manda hello(repoKey) y job; `runner` manda el resto. */
export type Side = 'home' | 'runner';
export interface DecodeOptions {
  /** Tope del bundle de ida; el runner lo fija con `maxBundleMb`. */
  maxBundleBytes?: number;
  /** Solo para `result`: si es falso, no se admite bundle. */
  expectChanges?: boolean;
}

export class ProtocolError extends Error {
  readonly code = 'bad_request';
  constructor(message: string) { super(message); this.name = 'ProtocolError'; }
}
const fail = (m: string): never => { throw new ProtocolError(m); };

const SENDS: Record<Side, readonly MessageType[]> = { home: ['hello', 'job'], runner: ['hello', 'accepted', 'log', 'result', 'error'] };
const JOB_ID = /^[A-Za-z0-9_-]{1,80}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// El marco log vacío marca execution-ended en v1. El emisor nunca lo usa para stdout/stderr.
export const EXECUTION_ENDED_LOG = '';
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
function keys(o: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${where}: clave desconocida`);
  for (const k of allowed) if (!(k in o)) fail(`${where}: falta ${k}`);
}
const str = (x: unknown, re: RegExp, f: string): string => (typeof x === 'string' && re.test(x) ? x : fail(`${f} inválido`));
const bool = (x: unknown, f: string): boolean => (typeof x === 'boolean' ? x : fail(`${f} debe ser booleano`));
const int = (x: unknown, min: number, max: number, f: string): number =>
  typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max ? x : fail(`${f} debe ser entero entre ${min} y ${max}`);
const nonNeg = (x: unknown, f: string): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : fail(`${f} debe ser un número finito no negativo`));

function usage(x: unknown): Usage | null {
  if (x === null) return null;
  if (!isObj(x)) return fail('usage inválido');
  const counts = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
  const allowed = ['costUsd', 'effectiveModel', 'priceVersion', ...counts];
  if (!Object.keys(x).every(key => allowed.includes(key))) return fail('usage: clave desconocida');
  if ('costUsd' in x) nonNeg(x.costUsd, 'usage.costUsd');
  if ('effectiveModel' in x && !modelId(x.effectiveModel)) return fail('usage.effectiveModel inválido');
  for (const key of counts) if (key in x && tokenCount(x[key]) === undefined) return fail(`usage.${key} inválido`);
  const u = readUsage(x);
  if (!u || ('priceVersion' in x && !u.priceVersion)) return fail('usage incompleto');
  const max = LIMITS.usageMax;
  return (u.costUsd ?? 0) > max.costUsd || counts.some(key => (u[key] ?? 0) > max.tokens) ? null : u;
}

function agents(x: unknown): Record<string, { sha256: string }> {
  if (!isObj(x)) return fail('agents inválido');
  const names = Object.keys(x);
  if (names.length > 16) fail('agents: demasiados');
  const out: Record<string, { sha256: string }> = {};
  for (const n of names) {
    str(n, TOKEN, 'agents (nombre)');
    const a = x[n];
    if (!isObj(a)) return fail('agents: entrada inválida');
    keys(a, ['sha256'], `agents.${n}`);
    out[n] = { sha256: str(a.sha256, HEX64, `agents.${n}.sha256`) };
  }
  return out;
}

function body(o: Record<string, unknown>, type: MessageType, side: Side, opts: DecodeOptions): Message {
  const v = 1 as const;
  switch (type) {
    case 'hello':
      if (side === 'home') { keys(o, ['v', 'type', 'repoKey'], 'hello'); return { v, type, repoKey: str(o.repoKey, HEX64, 'repoKey') }; }
      keys(o, ['v', 'type', 'have', 'fabSha', 'sandbox', 'agents'], 'hello');
      if (!Array.isArray(o.have) || o.have.length > LIMITS.haveMax) fail(`have debe ser una lista de hasta ${LIMITS.haveMax}`);
      return { v, type, have: (o.have as unknown[]).map(h => str(h, HEX40, 'have[]')), fabSha: str(o.fabSha, TOKEN, 'fabSha'), sandbox: str(o.sandbox, TOKEN, 'sandbox'), agents: agents(o.agents) };
    case 'job': {
      keys(o, ['v', 'type', 'jobId', 'adapter', 'model', 'readOnly', 'expectChanges', 'timeoutMs', 'base', 'head', 'promptBytes', 'bundleBytes', 'bundleSha256'], 'job');
      const adapter = typeof o.adapter === 'string' && CONFINABLE_AGENTS.includes(o.adapter) ? o.adapter : fail('adapter no confinable');
      const model = o.model === null ? null : str(o.model, MODEL_RE, 'model');
      const readOnly = bool(o.readOnly, 'readOnly');
      const expectChanges = bool(o.expectChanges, 'expectChanges');
      if (readOnly && expectChanges) fail('readOnly y expectChanges son incompatibles');
      return {
        v, type, jobId: str(o.jobId, JOB_ID, 'jobId'), adapter, model, readOnly, expectChanges,
        timeoutMs: int(o.timeoutMs, LIMITS.timeoutMs[0], LIMITS.timeoutMs[1], 'timeoutMs'),
        base: str(o.base, HEX40, 'base'), head: str(o.head, HEX40, 'head'),
        promptBytes: int(o.promptBytes, 0, LIMITS.promptBytes, 'promptBytes'),
        bundleBytes: int(o.bundleBytes, 0, opts.maxBundleBytes ?? LIMITS.jobBundleBytes, 'bundleBytes'),
        bundleSha256: str(o.bundleSha256, HEX64, 'bundleSha256'),
      };
    }
    case 'accepted': keys(o, ['v', 'type', 'jobId'], 'accepted'); return { v, type, jobId: str(o.jobId, JOB_ID, 'jobId') };
    case 'log': keys(o, ['v', 'type', 'data'], 'log'); return { v, type, data: str(o.data, B64, 'data') };
    case 'result': {
      keys(o, ['v', 'type', 'jobId', 'exitCode', 'durationMs', 'usage', 'output', 'head', 'bundleBytes', 'bundleSha256'], 'result');
      if (typeof o.output !== 'string') fail('output debe ser texto');
      const bundleBytes = int(o.bundleBytes, 0, opts.expectChanges === false ? 0 : LIMITS.resultBundleBytes, 'bundleBytes');
      // Sin bytes no hay commit ni hash; con bytes hacen falta los dos.
      const head = bundleBytes === 0 ? (o.head === null ? null : fail('head debe ser null sin bundle')) : str(o.head, HEX40, 'head');
      const bundleSha256 = bundleBytes === 0 ? (o.bundleSha256 === null ? null : fail('bundleSha256 debe ser null sin bundle')) : str(o.bundleSha256, HEX64, 'bundleSha256');
      return {
        v, type, jobId: str(o.jobId, JOB_ID, 'jobId'), exitCode: int(o.exitCode, -255, 255, 'exitCode'),
        durationMs: int(o.durationMs, 0, 86_400_000, 'durationMs'), usage: usage(o.usage),
        output: boundedAgentOutput(o.output as string), head, bundleBytes, bundleSha256,
      };
    }
    case 'error': {
      keys(o, ['v', 'type', 'code', 'message'], 'error');
      const code = typeof o.code === 'string' && (ERROR_CODES as readonly string[]).includes(o.code) ? (o.code as ErrorCode) : fail('code desconocido');
      if (typeof o.message !== 'string' || o.message.length > LIMITS.messageChars) fail(`message debe ser texto de hasta ${LIMITS.messageChars} caracteres`);
      return { v, type, code, message: o.message as string };
    }
  }
}

export function encode(msg: Message): string {
  const line = JSON.stringify(msg);
  if (Buffer.byteLength(line) > LIMITS.lineBytes) fail('mensaje demasiado largo');
  return line + '\n';
}

/** Valida una línea (sin el `\n` final) enviada por `from`. `expect` son los tipos admitidos en este punto del diálogo. */
export function decodeLine(line: string, expect: readonly MessageType[], from: Side, opts: DecodeOptions = {}): Message {
  if (Buffer.byteLength(line) > LIMITS.lineBytes) fail('línea demasiado larga');
  let o: unknown;
  try { o = JSON.parse(line); } catch { return fail('JSON inválido'); }
  if (!isObj(o)) return fail('el mensaje debe ser un objeto');
  if (o.v !== LIMITS.version) fail(`versión de protocolo no soportada (se espera ${LIMITS.version})`);
  const type = o.type as MessageType;
  if (typeof type !== 'string' || !SENDS[from].includes(type)) return fail('tipo de mensaje desconocido para este emisor');
  if (!expect.includes(type)) return fail(`mensaje ${type} inesperado en este punto`);
  return body(o, type, from, opts);
}

/** Presupuesto de log: 5 MiB en total; lo que exceda se descarta y se cuenta en `dropped`. */
export function logBudget(max = LIMITS.logBytes) {
  let used = 0;
  return {
    dropped: 0,
    take(chunk: Buffer): Buffer {
      const keep = Math.max(0, Math.min(chunk.length, max - used));
      used += keep;
      this.dropped += chunk.length - keep;
      return chunk.subarray(0, keep);
    },
  };
}
