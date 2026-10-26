import type { ClassifyOmniFailure, FailureKind, SafeFailure } from './contracts.ts';
import type { SafeHttpFailure } from '../transport.ts';

/**
 * Only codes this repository maps and tests. An unmapped code is never treated as quota or
 * rate limit: a spend decision comes from a recognized code or status, not from upstream prose.
 */
const QUOTA_CODES = new Set(['insufficient_quota', 'billing_hard_limit_reached', 'credit_balance_too_low', 'quota_exceeded', 'credits_too_low']);
const RATE_CODES = new Set(['rate_limit_exceeded', 'rate_limit', 'requests_limit_exceeded', 'resource_exhausted', 'too_many_requests']);
const AUTH_CODES = new Set(['invalid_api_key', 'incorrect_api_key', 'invalid_api_key_provided', 'unauthorized', 'authentication_error', 'invalid_authentication_error', 'token_expired', 'expired_token']);
const CONTEXT_CODES = new Set(['context_length_exceeded', 'context_window_exceeded', 'prompt_is_too_long', 'request_too_large']);
const TRANSIENT_CODES = new Set(['server_error', 'internal_error', 'service_unavailable', 'bad_gateway', 'gateway_timeout', 'overloaded', 'overloaded_error', 'engine_overloaded', 'model_not_loaded']);
const CODE_SETS: ReadonlyArray<readonly [FailureKind, ReadonlySet<string>]> = [
  ['quota', QUOTA_CODES],
  ['auth', AUTH_CODES],
  ['context', CONTEXT_CODES],
  ['rate_limit', RATE_CODES],
  ['transient', TRANSIENT_CODES],
];
/** Stable texts produced by fab itself (adapter prefixes, decoder contracts) and transport-level failures. */
const TERMINAL_TEXT = /\b(?:malformed|truncated|invalid|unsupported|refus(?:al|ed)?|safety|content policy|exceeds byte budget|model returned an error in its stream)\b/i;
const TRANSIENT_TEXT = /\b(?:socket hang up|fetch failed|connection (?:lost|closed|reset|refused)|econn[a-z_]+|network (?:error|failure)|timed out|timeout|stalled|bad gateway|service unavailable|gateway timeout)\b/i;

type Bag = Record<string, unknown>;

const isRecord = (value: unknown): value is Bag => typeof value === 'object' && value !== null && !Array.isArray(value);
const field = (error: unknown, key: string): unknown => (isRecord(error) ? error[key] : undefined);
const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const statusOf = (value: unknown): number | undefined => {
  const n = typeof value === 'string' && /^\d{3}$/.test(value.trim()) ? Number(value) : finite(value);
  return n !== undefined && Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;
};
const textOf = (error: unknown): string => {
  if (typeof error === 'string') return error;
  const message = field(error, 'message');
  return typeof message === 'string' ? message : String(error ?? '');
};

/** Lowercased, separator-normalized token kept only when this file recognizes it. */
export function canonicalCode(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string') return undefined;
  const token = value.trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!token || token.length > 64) return undefined;
  for (const [, codes] of CODE_SETS) if (codes.has(token)) return token;
  return undefined;
}

export const isContextCode = (code: string | undefined): boolean =>
  code !== undefined && CONTEXT_CODES.has(code);

function kindForCode(code: string): FailureKind {
  return CODE_SETS.find(([, codes]) => codes.has(code))![0];
}

const defaultScope: Record<FailureKind, SafeFailure['scope']> = {
  rate_limit: 'group', quota: 'group', auth: 'account', transient: 'group', context: 'model', fatal: 'turn',
};

function build(kind: FailureKind, signal: { status?: number; code?: string; retryAt?: number; scope?: SafeFailure['scope'] }): SafeFailure {
  const failure: SafeFailure = { kind, scope: signal.scope ?? defaultScope[kind] };
  if (signal.status !== undefined) failure.status = signal.status;
  if (signal.code !== undefined) failure.code = signal.code;
  if (signal.retryAt !== undefined) failure.retryAt = signal.retryAt;
  return failure;
}

const isAbort = (error: unknown): boolean =>
  field(error, 'name') === 'AbortError' || (isRecord(error) && field(error, 'aborted') === true && field(error, 'reason') !== undefined);

/** Absolute deadline from a server hint, or from a relative delay plus the injected clock. */
function retryAtOf(http: SafeHttpFailure | undefined, error: unknown, now: number): number | undefined {
  const absolute = finite(http?.retryAt);
  if (absolute !== undefined && absolute > 0) return absolute;
  const delay = finite(field(error, 'retryAfterMs'));
  return delay !== undefined && delay >= 0 ? now + delay : undefined;
}

/** Metadata-first classification; `http` (set by the generic adapter) always wins over message text. */
export const classifyOmniFailure: ClassifyOmniFailure = (error, now) => {
  if (field(error, 'routingHandled') === true) return { kind: 'fatal', scope: 'turn' };
  const http = isRecord(error) ? (field(error, 'http') as SafeHttpFailure | undefined) : undefined;
  const message = textOf(error);
  const status = statusOf(http?.status) ?? statusOf(field(error, 'status')) ?? statusOf(/^(?:Model |Upstream )?HTTP (\d{3})\b/i.exec(message)?.[1]);
  const code = canonicalCode(http?.code) ?? canonicalCode(field(error, 'code'));
  const retryAt = retryAtOf(http, error, now);
  const contextLimit = http?.contextLimit === true || field(error, 'contextLimit') === true;
  const structured = { status, code, retryAt };

  const kind = code === undefined ? undefined : kindForCode(code);
  if ([400, 403, 404, 422].includes(status ?? 0) && kind !== 'quota' && kind !== 'auth' &&
      !([400, 422].includes(status!) && (contextLimit || kind === 'context'))) {
    return build('fatal', { ...structured, scope: 'turn' });
  }
  if (code !== undefined) {
    // A Retry-After header is not a credit reset: v1 never reopens a quota group from it.
    if (kind === 'quota') return build('quota', { status, code });
    if (kind === 'auth') return build('auth', { status, code });
    if (kind === 'context') return build('context', structured);
    if (kind === 'rate_limit') return build('rate_limit', structured);
    return build('transient', structured);
  }
  if (contextLimit) return build('context', structured);
  if (status === 402) return build('quota', { status });
  if (status === 401) return build('auth', { status });
  if (status === 429) return build('rate_limit', structured);
  if (status !== undefined && status >= 500) return build('transient', structured);
  if (isAbort(error)) return build('fatal', { scope: 'turn' });
  // Decoder prefixes outrank words supplied in an invalid finish_reason (e.g. "timeout").
  if (message.startsWith('Unsupported model finish reason:')) return build('fatal', { ...structured, scope: 'turn' });
  if (field(error, 'name') === 'TimeoutError' || TRANSIENT_TEXT.test(message)) return build('transient', structured);
  if (TERMINAL_TEXT.test(message)) return build('fatal', { ...structured, scope: 'turn' });
  if (status !== undefined && status >= 400 && status < 500) return build('fatal', { ...structured, scope: 'turn' });
  // No recognized signal at all: one bounded per-attempt retry is allowed, never a quota decision.
  return build('transient', structured);
};
