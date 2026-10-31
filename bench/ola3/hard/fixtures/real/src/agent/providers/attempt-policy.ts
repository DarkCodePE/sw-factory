/** Shared mechanics only: no provider selection, quota state or HTTP parsing. */
export interface AttemptOutput {
  readonly committed: boolean;
  readonly delta: ((text: string) => void) | undefined;
}

/** Legacy callers keep an absent callback; dynamic plans may observe privately. */
export function observeAttemptOutput(delta?: (text: string) => void, observeWithoutConsumer = false): AttemptOutput {
  let committed = false;
  return {
    get committed() { return committed; },
    delta: delta || observeWithoutConsumer ? text => {
      if (text.length > 0) committed = true;
      delta?.(text);
    } : undefined,
  };
}

export function rethrowIfAborted(signal: AbortSignal, error: unknown): void {
  if (signal.aborted) throw signal.reason ?? error;
}

/** Explicit terminal delegation takes precedence over message/status heuristics. */
export function isRoutingHandled(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { routingHandled?: unknown }).routingHandled === true;
}

/** Preserve auto's defaults, random sampling and Retry-After behavior exactly. */
export function retryDelayMs(attempt: number, random: () => number, retryAfter?: unknown): number {
  const backoff = Math.min(8000, 500 * 2 ** (attempt - 1)) * (0.5 + random() / 2);
  const hint = Number(retryAfter);
  return Math.max(backoff, Number.isFinite(hint) ? hint : 0);
}
