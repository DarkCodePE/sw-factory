import type { ResolvedLimits, ScriptContent, ScriptErrorOrigin, ScriptLimits } from './types.ts';

export const MAX_FRAME_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_LIMITS: Readonly<ResolvedLimits> = Object.freeze({
  maxResultBytes: 5 * 1024 * 1024,
  maxOutputBytes: 5 * 1024 * 1024,
  maxPendingCalls: 64,
  maxTimers: 64,
});

export class RuntimeFailure extends Error {
  constructor(public readonly origin: ScriptErrorOrigin, message: string) {
    super(message);
  }
}

export function resolveLimits(limits: ScriptLimits = {}): ResolvedLimits {
  if (!limits || typeof limits !== 'object') throw new Error('Invalid Script limits');
  const result = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(result) as (keyof ResolvedLimits)[]) {
    const value = limits[key] ?? result[key];
    if (!Number.isSafeInteger(value) || value < 0 ||
        (key !== 'maxTimers' && value > DEFAULT_LIMITS[key])) {
      throw new Error(`Invalid Script limit: ${key}`);
    }
    result[key] = value;
  }
  return result;
}

export function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'Unknown error';
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function encodeFrame(frame: unknown): string {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(frame); } catch {
    throw new RuntimeFailure('runtime', 'Frame is not JSON serializable');
  }
  if (encoded === undefined) throw new RuntimeFailure('runtime', 'Invalid JSON frame');
  if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) {
    throw new RuntimeFailure('output_limit', 'Script frame exceeds 10 MiB');
  }
  return encoded + '\n';
}

/** Bounded byte framing, including fragmented UTF-8 and unterminated frames. */
export async function* readFrames(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      let offset = 0;
      while (offset < next.value.length) {
        const newline = next.value.indexOf(10, offset);
        const end = newline === -1 ? next.value.length : newline;
        const part = next.value.subarray(offset, end);
        size += part.length;
        if (size > MAX_FRAME_BYTES) {
          throw new RuntimeFailure('output_limit', 'Script frame exceeds 10 MiB');
        }
        if (part.length) parts.push(part);
        if (newline === -1) break;
        let frame: unknown;
        try { frame = JSON.parse(decoder.decode(Buffer.concat(parts, size))); } catch {
          throw new RuntimeFailure('runtime', 'Invalid Script NDJSON frame');
        }
        if (!record(frame) || typeof frame.type !== 'string') {
          throw new RuntimeFailure('runtime', 'Invalid Script protocol envelope');
        }
        parts = [];
        size = 0;
        yield frame;
        offset = newline + 1;
      }
    }
    if (size) throw new RuntimeFailure('runtime', 'Truncated Script NDJSON frame');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function isContent(value: unknown): value is ScriptContent {
  if (!record(value)) return false;
  if (value.type === 'text') return typeof value.text === 'string';
  return value.type === 'image' && (value.mime === 'image/png' || value.mime === 'image/jpeg') &&
    typeof value.data === 'string' && value.data.length > 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data);
}

export function contentBytes(content: ScriptContent): number {
  // Include structure: emitting empty strings must also consume the output budget.
  return Buffer.byteLength(JSON.stringify(content));
}
