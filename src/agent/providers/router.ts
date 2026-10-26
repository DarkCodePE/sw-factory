import type { AgentEvent, ModelProvider, ModelRequest, ModelTurn } from '../types.ts';
import type { RoutedAttempt, RoutedAttemptPlan } from '../omni/contracts.ts';
import { isRoutingHandled, observeAttemptOutput, rethrowIfAborted } from './attempt-policy.ts';

export type FallbackReason = 'rate_limit' | 'server_error' | 'timeout' | 'context_length';

export interface FallbackTarget {
  id: string;
  provider: ModelProvider;
}

export interface RouterPolicy {
  fallback?: string[];
  on?: FallbackReason[];
}

export function classifyProviderError(error: unknown): FallbackReason | undefined {
  if (!error || isRoutingHandled(error)) return undefined;
  const anyErr = error as any;
  const msg = typeof anyErr.message === 'string' ? anyErr.message : String(error);

  if (anyErr.contextLimit === true || /context[ _-]?length|context[ _-]?window|token limit|too many tokens|maximum context/i.test(msg)) {
    return 'context_length';
  }

  const status = typeof anyErr.status === 'number' ? anyErr.status : undefined;
  if (status === 429) return 'rate_limit';
  if (status && status >= 500 && status < 600) return 'server_error';

  if (/\b(?:HTTP\s+)?429\b|rate[ _-]?limit/i.test(msg)) return 'rate_limit';
  if (/\b(?:HTTP\s+)?5\d\d\b|server error|bad gateway|service unavailable|gateway timeout/i.test(msg)) return 'server_error';
  if (anyErr.name === 'TimeoutError' || /stalled|timeout|timed out|idle/i.test(msg)) {
    return 'timeout';
  }

  return undefined;
}

/** Dynamic plans are invocation-local; their owner supplies selection/settlement. */
export function createRoutedProvider(plan: RoutedAttemptPlan): ModelProvider;
export function createRoutedProvider(
  primary: ModelProvider,
  fallbacks: Array<{ id: string; provider: ModelProvider } | ModelProvider>,
  policy?: { on?: FallbackReason[] },
  onEvent?: (event: AgentEvent) => void,
): ModelProvider;
export function createRoutedProvider(
  primaryOrPlan: ModelProvider | RoutedAttemptPlan,
  fallbacks?: Array<{ id: string; provider: ModelProvider } | ModelProvider>,
  policy: { on?: FallbackReason[] } = {},
  onEvent?: (event: AgentEvent) => void,
): ModelProvider {
  const plan = fallbacks === undefined && 'next' in primaryOrPlan ? primaryOrPlan : undefined;
  const primary = primaryOrPlan as ModelProvider;
  const chain: FallbackTarget[] = plan ? [] : [
    { id: primary.id, provider: primary },
    ...fallbacks!.map(f => 'provider' in f ? { id: f.id, provider: f.provider } : { id: f.id, provider: f }),
  ];
  if (chain.some(target => target.provider.id === 'omni')) {
    throw new Error('Omni cannot be composed with a static router');
  }
  const allowedReasons = new Set<FallbackReason>(policy.on ?? ['rate_limit', 'server_error', 'timeout']);

  return {
    id: primaryOrPlan.id,
    async complete(request: ModelRequest, signal: AbortSignal, delta?: (text: string) => void): Promise<ModelTurn> {
      let index = 0;
      let lastError: unknown;
      for (;;) {
        signal.throwIfAborted();
        let current: FallbackTarget | RoutedAttempt | undefined;
        try {
          current = plan ? await plan.next(signal) : chain[index];
        } catch (error: unknown) {
          rethrowIfAborted(signal, error);
          throw error;
        }
        if (!current) {
          signal.throwIfAborted();
          if (plan) throw plan.exhausted();
          throw lastError;
        }
        const attempt = plan ? current as RoutedAttempt : undefined;
        const output = observeAttemptOutput(delta, !!plan);
        try {
          // next() may have acquired a lease while the caller was being aborted.
          signal.throwIfAborted();
          let turn: ModelTurn;
          try {
            turn = await current.provider.complete(request, signal, output.delta);
          } catch (err: unknown) {
            lastError = err;
            rethrowIfAborted(signal, err);
            attempt?.settle({ ok: false, error: err, committed: output.committed });
            if (output.committed || isRoutingHandled(err)) throw err;
            if (plan) continue; // settle/next decide; no policy implementation here.
            if (index === chain.length - 1) throw err;
            const reason = classifyProviderError(err);
            if (!reason || !allowedReasons.has(reason)) throw err;
            const next = chain[index + 1]!;
            onEvent?.({ type: 'model_fallback' as any, sessionId: '', from: current.id, to: next.id, reason });
            index++;
            continue;
          }
          if (plan) signal.throwIfAborted();
          // Hook errors are terminal, never treated as another upstream attempt.
          attempt?.settle({ ok: true });
          return turn;
        } finally {
          attempt?.release();
        }
      }
    },
  };
}
