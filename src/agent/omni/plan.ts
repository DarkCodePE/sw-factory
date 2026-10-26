import { abortable } from '../cancellation.ts';
import type { ModelProvider, ModelRequest } from '../types.ts';
import { classifyOmniFailure, canonicalCode } from './failures.ts';
import { ProviderError, type SafeHttpFailure } from '../transport.ts';
import { isRoutingHandled, rethrowIfAborted } from '../providers/attempt-policy.ts';
import type {
  AttemptContext, Lease, Needs, OmniConfig, OmniDependencies,
  Profile, RoutedAttempt, RoutedAttemptPlan, SafeFailure,
} from './contracts.ts';

/** Hard ceiling from the spec: a misbehaving scheduler can never inspect more profiles. */
export const OMNI_MAX_PROFILE_INSPECTIONS = 32;
/** A scheduler that keeps returning `wait` for "now" must not spin forever. */
const MAX_EMPTY_WAITS = 8;

export interface OmniPlanInput extends OmniDependencies { config: OmniConfig; }

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

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
    ...(canonicalCode(code) ? { code: canonicalCode(code) } : {}),
    ...(retryAt !== undefined ? { retryAt } : {}),
    contextLimit: (http as { contextLimit?: unknown }).contextLimit === true,
  };
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

  const classify = (error: unknown): SafeFailure => input.classify
    ? input.classify(error, clock.now())
    : classifyOmniFailure(error, clock.now());

  return {
    id: 'omni',
    async next(signal: AbortSignal): Promise<RoutedAttempt | undefined> {
      for (;;) {
        signal.throwIfAborted();
        if (clock.now() >= deadline || remainingAttempts <= 0 || inspections >= OMNI_MAX_PROFILE_INSPECTIONS) return undefined;
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
            !hardEligible(lease.profile, needs, config) ||
            input.eligible && !input.eligible(config, needs).some(p => p.modelId === lease.profile.modelId)) {
          scheduler.release(lease);
          continue;
        }
        inspectedLeases.add(lease.id);
        let provider: ModelProvider;
        try {
          provider = await abortable(resolveLeaf(lease.profile.modelId, signal), signal);
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
        if (signal.aborted || clock.now() >= deadline) {
          scheduler.release(lease);
          signal.throwIfAborted();
          return undefined;
        }
        attempted.add(lease.profile.modelId);
        remainingAttempts -= 1;
        const from = previousModelId ?? 'omni';
        previousModelId = lease.profile.modelId;
        try {
          emit?.({ type: 'model_routed', sessionId: '', from, to: lease.profile.modelId, reason: 'selection' });
        } catch (error) {
          scheduler.release(lease);
          throw error;
        }
        return {
          id: lease.id,
          provider: wrapLeaf(provider, lease.profile.modelId, error => classify(error)),
          settle: result => {
            if (result.ok) {
              scheduler.settle(lease, { ok: true });
              return;
            }
            const failure = classify(result.error);
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
