import type { AgentEvent, ModelProvider, ModelRequest, ModelTurn } from '../types.ts';

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
  if (!error) return undefined;
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

export function createRoutedProvider(
  primary: ModelProvider,
  fallbacks: Array<{ id: string; provider: ModelProvider } | ModelProvider>,
  policy: { on?: FallbackReason[] } = {},
  onEvent?: (event: AgentEvent) => void,
): ModelProvider {
  const targets: FallbackTarget[] = fallbacks.map(f =>
    'provider' in f ? { id: f.id, provider: f.provider } : { id: f.id, provider: f },
  );
  const allowedReasons = new Set<FallbackReason>(
    policy.on ?? ['rate_limit', 'server_error', 'timeout'],
  );

  const chain: FallbackTarget[] = [
    { id: primary.id, provider: primary },
    ...targets,
  ];

  return {
    id: primary.id,
    async complete(request: ModelRequest, signal: AbortSignal, delta?: (text: string) => void): Promise<ModelTurn> {
      let lastError: unknown;
      for (let i = 0; i < chain.length; i++) {
        signal.throwIfAborted();
        const current = chain[i]!;
        let hasEmittedDelta = false;
        try {
          return await current.provider.complete(request, signal, delta ? (t: string) => {
            if (t.length > 0) hasEmittedDelta = true;
            delta(t);
          } : undefined);
        } catch (err: unknown) {
          lastError = err;
          if (signal.aborted) throw signal.reason ?? err;
          if (hasEmittedDelta) throw err;
          if (i === chain.length - 1) throw err;

          const reason = classifyProviderError(err);
          if (!reason || !allowedReasons.has(reason)) {
            throw err;
          }

          const next = chain[i + 1]!;
          onEvent?.({
            type: 'model_fallback' as any,
            sessionId: '',
            from: current.id,
            to: next.id,
            reason,
          });
        }
      }
      throw lastError;
    },
  };
}
