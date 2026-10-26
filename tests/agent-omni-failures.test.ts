import { describe, expect, test } from 'bun:test';
import { classifyOmniFailure } from '../src/agent/omni/failures.ts';
import { MAX_FAILURE_METADATA_BYTES, readHttpFailure, retryAtFromHeader } from '../src/agent/providers/http-failure.ts';
import type { SafeHttpFailure } from '../src/agent/transport.ts';

const NOW = 10_000_000;
const HOUR = 3_600_000;

const http = (over: Partial<SafeHttpFailure> & { status: number }): SafeHttpFailure => ({ contextLimit: false, ...over });

/** A stream that reports how much was actually pulled, so the 8 KiB ceiling is observable. */
function countedBody(text: string, chunkSize = 4096) {
  const read = { bytes: 0, cancelled: 0 };
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= text.length) { controller.close(); return; }
      const slice = new TextEncoder().encode(text.slice(offset, offset + chunkSize));
      read.bytes += slice.byteLength;
      offset += chunkSize;
      controller.enqueue(slice);
    },
    cancel() { read.cancelled++; },
  });
  return { stream, read };
}

function responseOf(body: ReadableStream<Uint8Array> | string | null, status: number, headers: Record<string, string> = {}) {
  return new Response(body ?? null, { status, headers });
}

describe('classifyOmniFailure', () => {
  test('a rate limit is not a credit exhaustion', () => {
    expect(classifyOmniFailure({ message: 'Model HTTP 429', http: http({ status: 429, retryAt: NOW + 5_000 }) }, NOW))
      .toEqual({ kind: 'rate_limit', scope: 'group', status: 429, retryAt: NOW + 5_000 });
    // The same status with a quota code is quota: the code wins over the status.
    expect(classifyOmniFailure({ message: 'Model HTTP 429', http: http({ status: 429, code: 'insufficient_quota' }) }, NOW))
      .toEqual({ kind: 'quota', scope: 'group', status: 429, code: 'insufficient_quota' });
  });

  test('every recognized credit signal disables the group, not the turn', () => {
    for (const code of ['insufficient_quota', 'billing_hard_limit_reached', 'credit_balance_too_low']) {
      expect(classifyOmniFailure({ message: 'Model HTTP 429', http: http({ status: 429, code }) }, NOW))
        .toEqual({ kind: 'quota', scope: 'group', status: 429, code });
    }
    expect(classifyOmniFailure({ message: 'Model HTTP 402', http: http({ status: 402 }) }, NOW))
      .toEqual({ kind: 'quota', scope: 'group', status: 402 });
  });

  test('an unknown code never becomes a quota decision', () => {
    expect(classifyOmniFailure({ message: 'Model HTTP 429', http: http({ status: 429, code: 'some_vendor_weird_thing' }) }, NOW))
      .toEqual({ kind: 'rate_limit', scope: 'group', status: 429 });
    expect(classifyOmniFailure({ message: 'please buy more credits', http: http({ status: 400 }) }, NOW))
      .toEqual({ kind: 'fatal', scope: 'turn', status: 400 });
  });

  test('a provider code is canonicalized before matching', () => {
    for (const raw of ['invalid_api_key', 'InvalidApiKey', ' INVALID-API-KEY ', 'invalid api key']) {
      expect(classifyOmniFailure({ message: 'Model HTTP 401', http: http({ status: 401, code: raw }) }, NOW))
        .toMatchObject({ kind: 'auth', scope: 'account', code: 'invalid_api_key' });
    }
    expect(classifyOmniFailure({ message: 'Model HTTP 429', http: http({ status: 429, code: 'RESOURCE_EXHAUSTED' }) }, NOW).kind).toBe('rate_limit');
    // An unmapped code contributes nothing: the status decides, so 429 stays a rate limit.
    expect(classifyOmniFailure({ message: 'Model HTTP 429', http: { status: 429, code: 429, contextLimit: false } }, NOW))
      .toEqual({ kind: 'rate_limit', scope: 'group', status: 429 });
  });

  test('metadata beats the message, and the legacy four arguments still classify', () => {
    // The message says 500 while the structured metadata says quota: metadata is authoritative.
    expect(classifyOmniFailure({ message: 'Model HTTP 500', http: http({ status: 429, code: 'insufficient_quota' }) }, NOW).kind).toBe('quota');
    expect(classifyOmniFailure({ message: 'Model HTTP 429', retryable: true, retryAfterMs: 2_000 }, NOW))
      .toEqual({ kind: 'rate_limit', scope: 'group', status: 429, retryAt: NOW + 2_000 });
    expect(classifyOmniFailure({ message: 'Model HTTP 400', contextLimit: true }, NOW))
      .toEqual({ kind: 'context', scope: 'model', status: 400 });
  });

  test('ERR-01 refusal does not rotate', () => {
    for (const status of [403, 404, 400, 422]) {
      const failure = classifyOmniFailure({ message: `Model HTTP ${status}`, http: http({ status }) }, NOW);
      expect(failure).toEqual({ kind: 'fatal', scope: 'turn', status });
    }
    const safety = classifyOmniFailure({ message: 'Model refused the request for safety policy' }, NOW);
    expect(safety).toEqual({ kind: 'fatal', scope: 'turn' });
    // A clear authentication failure is scoped to its account, so another account may still serve.
    expect(classifyOmniFailure({ message: 'Model HTTP 401', http: http({ status: 401, code: 'authentication_error' }) }, NOW))
      .toEqual({ kind: 'auth', scope: 'account', status: 401, code: 'authentication_error' });
  });

  test('transient capacity and transport stay group scoped', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyOmniFailure({ message: `Model HTTP ${status}`, http: http({ status }) }, NOW))
        .toMatchObject({ kind: 'transient', scope: 'group', status });
    }
    expect(classifyOmniFailure({ message: 'Model stream stalled: no data for 120000 ms', retryable: true }, NOW))
      .toMatchObject({ kind: 'transient', scope: 'group' });
    expect(classifyOmniFailure(Object.assign(new Error('socket hang up'), { name: 'TypeError' }), NOW))
      .toMatchObject({ kind: 'transient', scope: 'group' });
    expect(classifyOmniFailure(Object.assign(new Error('slow'), { name: 'TimeoutError' }), NOW))
      .toMatchObject({ kind: 'transient', scope: 'group' });
  });

  test('a user abort is final and distinct from an attempt timeout', () => {
    const controller = new AbortController();
    controller.abort();
    expect(classifyOmniFailure(controller.signal.reason, NOW)).toEqual({ kind: 'fatal', scope: 'turn' });
    expect(classifyOmniFailure({ name: 'AbortError', message: 'The operation was aborted' }, NOW))
      .toEqual({ kind: 'fatal', scope: 'turn' });
    // A per-attempt idle timeout stays transient: the turn may still move to another account.
    expect(classifyOmniFailure(Object.assign(new Error('Model stream stalled'), { name: 'TimeoutError' }), NOW).kind).toBe('transient');
    expect(classifyOmniFailure({ message: 'Model stream stalled: no data for 30000 ms' }, NOW).kind).toBe('transient');
  });

  test('an invalid decoded stream is final, not a reason to walk the keys', () => {
    for (const message of ['Malformed model SSE JSON', 'Truncated SSE event', 'Invalid or duplicate model tool call']) {
      expect(classifyOmniFailure({ message }, NOW)).toMatchObject({ kind: 'fatal', scope: 'turn' });
    }
  });

  test('context limits come from declared metadata, never from prose', () => {
    expect(classifyOmniFailure({ message: 'Model HTTP 400', http: http({ status: 400, code: 'context_length_exceeded' }) }, NOW))
      .toMatchObject({ kind: 'context', scope: 'model' });
    // A message that merely talks about the context window is not a proven mapping.
    expect(classifyOmniFailure({ message: 'your context window is too wide friend' }, NOW))
      .toMatchObject({ kind: 'transient', scope: 'group' });
  });

  test('an error without any recognized signal is one bounded retry, never a spend decision', () => {
    expect(classifyOmniFailure({ message: 'Model HTTP 418', http: http({ status: 418 }) }, NOW)).toEqual({ kind: 'fatal', scope: 'turn', status: 418 });
    expect(classifyOmniFailure({}, NOW)).toEqual({ kind: 'transient', scope: 'group' });
  });
});

describe('readHttpFailure', () => {
  test('TIME-01 server reset is not shortened', async () => {
    const seconds = await readHttpFailure(responseOf(null, 429, { 'retry-after': '3600' }), NOW);
    expect(seconds).toEqual({ status: 429, contextLimit: false, retryAt: NOW + HOUR });
    // The equivalent HTTP date yields the same absolute deadline.
    const date = await readHttpFailure(responseOf(null, 429, { 'retry-after': new Date(NOW + HOUR).toUTCString() }), NOW);
    expect(date).toEqual({ status: 429, contextLimit: false, retryAt: NOW + HOUR });
    expect(retryAtFromHeader('3600', NOW)).toBe(NOW + HOUR);
    expect(retryAtFromHeader('3600.5', NOW)).toBe(NOW + 3_600_500);
  });

  test('an absent or unparsable Retry-After is dropped, not turned into zero', () => {
    expect(retryAtFromHeader(null, NOW)).toBeUndefined();
    expect(retryAtFromHeader('', NOW)).toBeUndefined();
    expect(retryAtFromHeader('soon', NOW)).toBeUndefined();
    expect(retryAtFromHeader('-5', NOW)).toBeUndefined();
    expect(retryAtFromHeader('NaN', NOW)).toBeUndefined();
  });

  test('an overflowing Retry-After disables the destination for the turn', () => {
    const value = retryAtFromHeader('99999999999999999999', NOW);
    expect(value).toBe(Number.MAX_SAFE_INTEGER);
    expect(retryAtFromHeader('1e308', NOW)).toBe(Number.MAX_SAFE_INTEGER);
    expect(value).toBeGreaterThan(NOW);
  });

  test('a past HTTP date means ready now and is never a negative deadline', () => {
    expect(retryAtFromHeader(new Date(NOW - 60_000).toUTCString(), NOW)).toBe(NOW);
  });

  test('an allowlisted JSON code is extracted and nothing else is', async () => {
    const quota = await readHttpFailure(responseOf(JSON.stringify({
      error: { message: 'quota text', type: 'insufficient_quota', code: 'insufficient_quota' },
    }), 429), NOW);
    expect(quota).toEqual({ status: 429, contextLimit: false, code: 'insufficient_quota' });
    const prose = await readHttpFailure(responseOf('Upstream said: insufficient_quota maybe?', 429), NOW);
    expect(prose).toEqual({ status: 429, contextLimit: false });
    const garbage = await readHttpFailure(responseOf('<html>502 Bad Gateway</html>', 502), NOW);
    expect(garbage).toEqual({ status: 502, contextLimit: false });
  });

  test('a context code or 413 marks the failure as a context limit', async () => {
    expect(await readHttpFailure(responseOf(JSON.stringify({ error: { code: 'context_length_exceeded' } }), 400), NOW))
      .toEqual({ status: 400, contextLimit: true, code: 'context_length_exceeded' });
    expect(await readHttpFailure(responseOf(null, 413), NOW)).toEqual({ status: 413, contextLimit: true });
  });

  test('a truncated body still yields the code that fits inside the budget', async () => {
    const body = `${JSON.stringify({ error: { code: 'rate_limit_exceeded' } })}${'x'.repeat(40_000)}`;
    const failure = await readHttpFailure(responseOf(body, 429), NOW);
    expect(failure).toEqual({ status: 429, contextLimit: false, code: 'rate_limit_exceeded' });
  });

  test('SEC-01 routing logs redact secrets', async () => {
    const key = 'sk-decoy-key-DO-NOT-LOG';
    const host = 'api-a.example.invalid';
    const decoys = {
      inKey: key,
      inUrl: `https://user:${key}@${host}/v1/chat/completions?access_token=${key}`,
      inBody: `key ${key} budget`,
      inHeader: `Bearer ${key}`,
    };
    const body = JSON.stringify({
      error: { message: decoys.inBody, type: 'billing_hard_limit_reached', code: 'billing_hard_limit_reached' },
      authorization: decoys.inHeader,
    });
    const response = responseOf(body, 429, { 'retry-after': '3600', authorization: decoys.inHeader, 'x-upstream-url': decoys.inUrl });
    const failure = await readHttpFailure(response, NOW);
    const printed = JSON.stringify(failure);
    for (const decoy of Object.values(decoys)) expect(printed).not.toContain(decoy);
    expect(printed).not.toContain('authorization');
    expect(printed).not.toContain('Bearer');
    expect(printed).not.toContain('message');
    // Only the safe four fields survive: status, allowlisted code, deadline and context flag.
    expect(failure).toEqual({ status: 429, contextLimit: false, code: 'billing_hard_limit_reached', retryAt: NOW + HOUR });
    expect(classifyOmniFailure({ message: 'Model HTTP 429', http: failure }, NOW)).toEqual({
      kind: 'quota', scope: 'group', status: 429, code: 'billing_hard_limit_reached',
    });
  });

  test('the body is inspected at most 8 KiB and always cancelled', async () => {
    const key = 'sk-decoy-key-DO-NOT-LOG';
    const body = `${JSON.stringify({ error: { code: 'insufficient_quota' } })}${' '.repeat(MAX_FAILURE_METADATA_BYTES)}${key}${'x'.repeat(1_000_000)}`;
    const { stream, read } = countedBody(body);
    const failure = await readHttpFailure(responseOf(stream, 429), NOW);
    expect(failure).toEqual({ status: 429, contextLimit: false, code: 'insufficient_quota' });
    expect(read.cancelled).toBe(1);
    expect(read.bytes).toBeLessThan(MAX_FAILURE_METADATA_BYTES * 4);
    expect(JSON.stringify(failure)).not.toContain(key);
  });

  test('a body that never arrives is a status-only failure, not a thrown error', async () => {
    const stream = new ReadableStream<Uint8Array>({ pull: () => { throw new Error('body exploded'); } });
    expect(await readHttpFailure(responseOf(stream, 503), NOW)).toEqual({ status: 503, contextLimit: false });
  });

  test('an exhausted response yields status only instead of throwing', async () => {
    const response = responseOf(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), 429);
    await response.text();
    expect(await readHttpFailure(response, NOW)).toEqual({ status: 429, contextLimit: false });
  });
});
