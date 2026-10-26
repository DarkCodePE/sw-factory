import type { ReadHttpFailure } from '../omni/contracts.ts';
import type { SafeHttpFailure } from '../transport.ts';
import { canonicalCode, isContextCode } from '../omni/failures.ts';

/** Same ceiling as the generic adapter: inspect at most 8 KiB, then cancel and release the body. */
export const MAX_FAILURE_METADATA_BYTES = 8192;
/** A deadline so far away it can never be reached inside a turn: the destination is out for the turn, never 0. */
const UNREACHABLE_RETRY_AT = Number.MAX_SAFE_INTEGER;

/** Only machine-readable error fields are read. `error.message` and every header stay untouched. */
function errorCode(value: unknown): unknown {
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return record.code ?? record.type ?? errorCode(record.error);
}

/** Truncated JSON still carries a code before the budget is exhausted. */
function codeFromText(text: string): string | undefined {
  try {
    const code = canonicalCode(errorCode(JSON.parse(text)));
    if (code !== undefined) return code;
  } catch { /* fall back to a field scan when the budget cut the document. */ }
  const match = /"(?:code|type)"\s*:\s*"?([\w.:-]{1,64})/i.exec(text);
  return match ? canonicalCode(match[1]) : undefined;
}

async function readMetadata(response: Response): Promise<string> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    const body = response.body;
    if (!body) return '';
    reader = body.getReader();
  } catch { return ''; /* already consumed or unreadable: status only. */ }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const chunks: string[] = [];
  let seen = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const size = Math.min(next.value.byteLength, MAX_FAILURE_METADATA_BYTES - seen);
      if (size > 0) {
        chunks.push(decoder.decode(next.value.subarray(0, size), { stream: true }));
        seen += size;
      }
      if (seen >= MAX_FAILURE_METADATA_BYTES) break;
    }
  } catch { /* unreadable bodies yield status only. */ }
  finally {
    try { await reader.cancel(); } catch { /* already closed. */ }
    try { reader.releaseLock(); } catch { /* already released. */ }
  }
  return chunks.join('');
}

/**
 * `Retry-After` in seconds or as an HTTP date. The server deadline is preserved in full: the legacy
 * 120 s clamp is never applied here. Absent, unparsable or negative hints are dropped so the caller
 * falls back to bounded backoff; a value that cannot fit a turn disables the destination instead.
 */
export function retryAtFromHeader(value: string | null | undefined, now: number): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const seconds = Number(text);
  if (seconds === Infinity && /^(?:\+?\d+(?:\.\d*)?|\+?\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return UNREACHABLE_RETRY_AT;
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return undefined;
    const delay = seconds * 1000;
    if (!Number.isFinite(delay) || delay > UNREACHABLE_RETRY_AT - now) return UNREACHABLE_RETRY_AT;
    return now + delay;
  }
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.max(at, now);
}

/** Safe, structured HTTP failure: status, allowlisted code, absolute retryAt and context limit only. */
export const readHttpFailure: ReadHttpFailure = async (response, now) => {
  const status = Number.isInteger(response.status) ? response.status : 0;
  const failure: SafeHttpFailure = { status, contextLimit: status === 413 };
  const code = codeFromText(await readMetadata(response));
  if (code !== undefined) {
    failure.code = code;
    if (isContextCode(code)) failure.contextLimit = true;
  }
  const retryAt = retryAtFromHeader(response.headers.get('retry-after'), now);
  if (retryAt !== undefined) failure.retryAt = retryAt;
  return failure;
};
