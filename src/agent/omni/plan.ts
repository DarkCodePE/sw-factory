import type { AgentEvent, ModelProvider, ModelRequest } from '../types.ts';
import { ProviderError, type SafeHttpFailure } from '../transport.ts';
import { isRoutingHandled, rethrowIfAborted } from '../providers/attempt-policy.ts';
import type {
  AttemptContext, FailureKind, Lease, Needs, OmniConfig, OmniDependencies,
  Profile, RoutedAttempt, RoutedAttemptPlan, SafeFailure, Scheduler,
} from './contracts.ts';

/** Hard ceiling from the spec: a misbehaving scheduler can never inspect more profiles. */
export const OMNI_MAX_PROFILE_INSPECTIONS = 32;
/** A scheduler that keeps returning `wait` for "now" must not spin forever. */
const MAX_EMPTY_WAITS = 8;

const QUOTA_CODES = new Set(['insufficient_quota', 'billing_hard_limit_reached', 'credit_balance_too_low', 'quota_exceeded']);
const AUTH_CODES = new Set(['invalid_api_key', 'authentication_error', 'account_deactivated', 'invalid_authentication']);
/** Only allowlisted codes may survive into SafeFailure; raw upstream payloads never do. */
const SAFE_CODES = new Set([...QUOTA_CODES, ...AUTH_CODES, 'rate_limit', 'context_length_exceeded']);
/** Provider-independent decode failures: no recoverable code, so another key must not be tried. */
const FATAL_PATTERNS = [
  'malformed model sse json', 'malformed model json', 'truncated sse event',
  'invalid model message', 'invalid model choice array', 'invalid model delta',
  'invalid model text delta', 'invalid model tool index', 'invalid tool call id',
  'unsupported tool type', 'data after model finish', 'multiple model finish signals',
  'unsupported model finish reason',
];

/** Seam for package B `classifyOmniFailure`; the local map is a conservative fallback. */
export type OmniClassifyFailure = (error: unknown, now: number) => SafeFailure;

export interface OmniPlanInput {
  config: OmniConfig;
  scheduler: Scheduler;
  clock: OmniDependencies['clock'];
  resolveLeaf: OmniDependencies['resolveLeaf'];
  estimateRequest: OmniDependencies['estimateRequest'];
  emit?: (event: AgentEvent) => void;
  classify?: OmniClassifyFailure;
}

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Messages are only inspected locally; they are never copied into a SafeFailure. */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : '';

function statusOf(error: unknown): number | undefined {
  const http = (error as { http?: { status?: unknown } } | null)?.http;
  const fromHttp = finite(http?.status);
  if (fromHttp !== undefined) return fromHttp;
  const direct = finite((error as { status?: unknown } | null)?.status);
  if (direct !== undefined) return direct;
  const match = /\bHTTP\s+(\d{3})\b/.exec(messageOf(error));
  return match ? Number(match[1]) : undefined;
}

function codeOf(error: unknown): string | undefined {
  const http = (error as { http?: { code?: unknown } } | null)?.http;
  if (typeof http?.code === 'string') return http.code;
  const direct = (error as { code?: unknown } | null)?.code;
  return typeof direct === 'string' ? direct : undefined;
}

/** Bounded, sanitized HTTP metadata; equivalent to what package B returns. */
function safeHttp(error: unknown): SafeHttpFailure | undefined {
  const http = (error as { http?: unknown } | null)?.http;
  if (!http || typeof http !== 'object') return undefined;
  const status = finite((http as { status?: unknown }).status);
  if (status === undefined) return undefined;
  const code = (http as { code?: unknown }).code;
  const retryAt = finite((http as { retryAt?: unknown }).retryAt);
  return {
    status,
    ...(typeof code === 'string' && SAFE_CODES.has(code) ? { code } : {}),
    ...(retryAt !== undefined ? { retryAt } : {}),
    contextLimit: (http as { contextLimit?: unknown }).contextLimit === true,
  };
}

/** Local backoff: base 500 ms, 2^n growth, 8 s cap, non-negative jitter only. */
function backoffMs(attempt: number, random: () => number): number {
  const base = Math.min(8_000, 500 * 2 ** Math.max(0, attempt - 1));
  const sample = Math.min(1, Math.max(0, random()));
  return Math.round(base * (0.5 + sample / 2));
}

/**
 * Fallback classifier used until the integrator wires package B's
 * `classifyOmniFailure` through `OmniPlanInput.classify`.
 */
export function classifyOmniError(error: unknown, now: number, attempt: number, random: () => number): SafeFailure {
  if (isRoutingHandled(error)) return { kind: 'fatal', scope: 'turn' };
  const status = statusOf(error);
  const code = codeOf(error);
  const http = safeHttp(error);
  const message = messageOf(error).toLowerCase();
  let kind: FailureKind;
  if ((error as { contextLimit?: unknown } | null)?.contextLimit === true || http?.contextLimit === true ||
      /context[ _-]?(?:length|window)|maximum context|too many tokens|token limit/.test(message)) {
    kind = 'context';
  } else if (status === 402 || (code !== undefined && QUOTA_CODES.has(code)) ||
             (status === undefined && /insufficient[ _-]?quota|quota|credit|billing/.test(message))) {
    kind = 'quota';
  } else if (status === 401 || (code !== undefined && AUTH_CODES.has(code)) ||
             (status === undefined && /unauthor|invalid api key|api key|credential|authentication/.test(message))) {
    kind = 'auth';
  } else if (status === 429 || (code !== undefined && code === 'rate_limit') ||
             (status === undefined && /rate limit|too many requests/.test(message))) {
    kind = 'rate_limit';
  } else if (status === 400 || status === 403 || status === 404 || status === 422) {
    kind = 'fatal';
  } else if (status !== undefined && status >= 500) {
    kind = 'transient';
  } else if (FATAL_PATTERNS.some(pattern => message.includes(pattern))) {
    kind = 'fatal';
  } else {
    kind = 'transient';
  }
  const scope: SafeFailure['scope'] = kind === 'auth' ? 'account'
    : kind === 'quota' || kind === 'rate_limit' ? 'group'
      : kind === 'fatal' ? 'turn' : 'model';
  const failure: SafeFailure = {
    kind,
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined && SAFE_CODES.has(code) ? { code } : {}),
    scope,
  };
  if (kind !== 'fatal') {
    const serverRetryAt = http?.retryAt;
    const relative = finite((error as { retryAfterMs?: unknown } | null)?.retryAfterMs);
    // An explicit server deadline is preserved verbatim (no 120 s truncation, no cap).
    failure.retryAt = serverRetryAt !== undefined && serverRetryAt > 0
      ? serverRetryAt
      : relative !== undefined && relative > 0 ? now + relative : now + backoffMs(attempt, random);
  }
  return failure;
}

/** Hard per-turn requirements only; quota health and cooldowns belong to the scheduler. */
function hardEligible(profile: Profile, needs: Needs, config: OmniConfig): boolean {
  if (profile.tos === 'avoid') return false;
  if (profile.costTier === 'paid' && !config.allowPaid) return false;
  if (needs.tools && profile.supportsTools !== true) return false;
  if (needs.images && profile.supportsImages !== true) return false;
  if (!(profile.contextWindow > 0)) return false;
  return needs.estimatedInputTokens + needs.maxOutputTokens <= profile.contextWindow;
}

function terminalError(modelId: string, stage: 'output' | 'final', cause: unknown): Error {
  const message = stage === 'output'
    ? `Omni attempt failed after output began (${modelId})`
    : `Omni attempt failed terminally (${modelId})`;
  const error = new ProviderError(message, false, false, undefined, safeHttp(cause));
  (error as ProviderError & { routingHandled?: boolean }).routingHandled = true;
  return error;
}

/**
 * Wraps one leaf so a dynamic-plan turn can never fall back after publishing
 * output nor rotate away an explicit refusal, without touching the shared router.
 */
function wrapLeaf(provider: ModelProvider, modelId: string, classify: (error: unknown) => SafeFailure): ModelProvider {
  return {
    id: provider.id,
    async complete(request, signal, delta) {
      let committed = false;
      const observe = (text: string) => { if (text.length > 0) committed = true; delta?.(text); };
      try {
        return await provider.complete(request, signal, observe);
      } catch (error) {
        rethrowIfAborted(signal, error);
        if (isRoutingHandled(error)) throw error;
        // Text already reached the caller: another model would duplicate or mix it.
        if (committed) throw terminalError(modelId, 'output', error);
        if (classify(error).kind === 'fatal') throw terminalError(modelId, 'final', error);
        throw error;
      }
    },
  };
}

function exhaustedError(retryAt: number | undefined, now: number): Error {
  const delay = retryAt === undefined ? undefined : Math.max(0, retryAt - now);
  const error = new ProviderError('Omni routing exhausted', false, false, delay);
  const tagged = error as ProviderError & { routingHandled?: boolean; retryAt?: number };
  tagged.routingHandled = true;
  if (retryAt !== undefined) tagged.retryAt = retryAt;
  return tagged;
}

/**
 * Adapts the frozen Omni scheduler contract to the shared dynamic router plan.
 * The router stays the single owner of the attempt loop (settle/release in
 * finally); this plan only decides which lease to hand over, when to wait and
 * when to stop. It never performs HTTP and never resolves credentials by itself.
 */
export function createOmniPlan(input: OmniPlanInput, request: ModelRequest): RoutedAttemptPlan {
  const { config, scheduler, clock, resolveLeaf, estimateRequest, emit } = input;
  const needs = estimateRequest(request);
  const startedAt = clock.now();
  const deadline = startedAt + config.maxWaitMs + config.maxAttempts * config.requestTimeoutMs;
  const attempted = new Set<string>();
  const inspectedLeases = new Set<string>();
  let remainingAttempts = config.maxAttempts;
  let attempts = 0;
  let inspections = 0;
  let waitedMs = 0;
  let emptyWaits = 0;
  let previousModelId: string | undefined;
  let lastRetryAt: number | undefined;

  const context = (): AttemptContext => ({
    needs,
    attempted,
    remainingAttempts,
    waitRemainingMs: Math.max(0, config.maxWaitMs - waitedMs),
    deadline,
  });

  const classify = (error: unknown, attempt: number): SafeFailure => input.classify
    ? input.classify(error, clock.now())
    : classifyOmniError(error, clock.now(), attempt, () => clock.random());

  return {
    id: 'omni',
    async next(signal: AbortSignal): Promise<RoutedAttempt | undefined> {
      for (;;) {
        signal.throwIfAborted();
        if (remainingAttempts <= 0 || inspections >= OMNI_MAX_PROFILE_INSPECTIONS) return undefined;
        const choice = scheduler.select(context());
        if (choice.kind === 'exhausted') {
          if (choice.retryAt !== undefined) lastRetryAt = choice.retryAt;
          return undefined;
        }
        if (choice.kind === 'wait') {
          const waitMs = Math.max(0, choice.until - clock.now());
          if (waitMs <= 0) {
            if (++emptyWaits > MAX_EMPTY_WAITS) return undefined;
          } else {
            emptyWaits = 0;
          }
          const budget = config.maxWaitMs - waitedMs;
          if (waitMs > budget || clock.now() + waitMs > deadline) {
            // The real reset is outside the turn budget: stop instead of sleeping early.
            lastRetryAt = choice.until;
            return undefined;
          }
          waitedMs += waitMs;
          await clock.sleep(waitMs, signal);
          continue;
        }
        const lease: Lease = choice.lease;
        inspections += 1;
        if (inspectedLeases.has(lease.id) || attempted.has(lease.profile.modelId) ||
            !hardEligible(lease.profile, needs, config)) {
          scheduler.release(lease);
          continue;
        }
        inspectedLeases.add(lease.id);
        let provider: ModelProvider;
        try {
          provider = await resolveLeaf(lease.profile.modelId, signal);
        } catch (error) {
          try {
            rethrowIfAborted(signal, error);
            // Resolution failure means the account/key is unusable for this turn.
            scheduler.settle(lease, { ok: false, failure: { kind: 'auth', scope: 'account' } });
          } finally {
            scheduler.release(lease);
          }
          continue;
        }
        if (signal.aborted) {
          scheduler.release(lease);
          signal.throwIfAborted();
        }
        attempted.add(lease.profile.modelId);
        remainingAttempts -= 1;
        attempts += 1;
        const attemptNumber = attempts;
        const from = previousModelId ?? 'omni';
        previousModelId = lease.profile.modelId;
        emit?.({ type: 'model_routed', sessionId: '', from, to: lease.profile.modelId, reason: 'selection' });
        return {
          id: lease.id,
          provider: wrapLeaf(provider, lease.profile.modelId, error => classify(error, attemptNumber)),
          settle: result => {
            if (result.ok) {
              scheduler.settle(lease, { ok: true });
              return;
            }
            const failure = classify(result.error, attemptNumber);
            if (failure.retryAt !== undefined) lastRetryAt = failure.retryAt;
            scheduler.settle(lease, { ok: false, failure });
          },
          release: () => scheduler.release(lease),
        };
      }
    },
    exhausted: () => exhaustedError(lastRetryAt, clock.now()),
  };
}
