import { abortable } from './cancellation.ts';

export class ProviderError extends Error {
  constructor(message: string, public readonly retryable = false, public readonly contextLimit = false, public readonly retryAfterMs?: number) { super(message); }
}
/** Parses a `retry-after` header (seconds or HTTP date) into milliseconds. */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 120_000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.min(Math.max(0, at - now), 120_000);
}
export const DEFAULT_STREAM_IDLE_MS = 120_000;
export function streamIdleFromEnv(value?: number): number {
  const env = process.env.FABRICA_STREAM_IDLE_MS;
  const ms = value ?? (env === undefined ? DEFAULT_STREAM_IDLE_MS : Number(env));
  if (env !== undefined && value === undefined && !env.trim() || !Number.isSafeInteger(ms) || ms < 0 || ms > 2_147_483_647) throw new Error('Invalid streamIdleMs (0..2147483647)');
  return ms;
}

/** One request-local controller; the agent's signal remains usable for a bounded retry. */
class IdleGuard {
  readonly controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private cancelled = false;
  private closed = false;
  private parentAbort = () => this.controller.abort(this.parent!.reason);
  get signal() { return this.controller.signal; }
  constructor(readonly ms: number, readonly parent?: AbortSignal) {
    parent?.throwIfAborted();
    parent?.addEventListener('abort', this.parentAbort, { once: true });
    this.signal.addEventListener('abort', this.cancelSource, { once: true });
    this.arm();
  }
  private disarm() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private arm() {
    this.disarm();
    if (this.ms && !this.closed && !this.signal.aborted) this.timer = setTimeout(() => this.controller.abort(new ProviderError(`Model stream stalled: no data for ${this.ms} ms`, true)), this.ms);
  }
  private cancelSource = () => {
    if (this.reader && !this.cancelled) {
      this.cancelled = true;
      // Underlying streams can ignore cancellation forever. It must not delay failure.
      void this.reader.cancel(this.signal.reason).catch(() => {});
      try { this.reader.releaseLock(); } catch { /* Pending reads settle through cancellation. */ }
    }
  };
  close = () => {
    this.closed = true;
    this.disarm(); this.parent?.removeEventListener('abort', this.parentAbort);
    this.signal.removeEventListener('abort', this.cancelSource); this.cancelSource();
  };
  wrap(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
    return new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          const next = await abortable(this.reader!.read(), this.signal);
          if (next.done) { controller.close(); this.close(); }
          else { if (next.value.byteLength) this.arm(); controller.enqueue(next.value); }
        } catch (error) { controller.error(error); this.close(); }
      },
      cancel: this.close,
    }, { highWaterMark: 0 });
  }
}

/** Standalone decoder compatibility: byte activity, including SSE comments, resets the deadline. */
export function idleTimeout(body: ReadableStream<Uint8Array>, idleMs = DEFAULT_STREAM_IDLE_MS) {
  streamIdleFromEnv(idleMs);
  if (idleMs === 0) return body;
  return new IdleGuard(idleMs).wrap(body);
}

/** Guard headers and every response-body path (SSE, JSON and errors), not only visible deltas. */
export async function withIdleResponse<T>(url: string | URL, init: RequestInit & { signal: AbortSignal },
  idleMs: number, consume: (response: Response) => Promise<T>): Promise<T> {
  const guard = new IdleGuard(idleMs, init.signal);
  try {
    const original = await abortable(fetch(url, { ...init, signal: guard.signal }), guard.signal);
    const response = new Response(original.body ? guard.wrap(original.body) : null,
      { status: original.status, statusText: original.statusText, headers: original.headers });
    return await abortable(consume(response), guard.signal);
  } catch (error) {
    if (init.signal.aborted) throw init.signal.reason;
    if (guard.signal.aborted) throw guard.signal.reason;
    throw error;
  } finally { guard.close(); }
}
