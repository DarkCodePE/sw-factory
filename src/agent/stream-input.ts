import { SessionStore } from './session.ts';
import { Hooks } from './hooks.ts';
import { runCodingAgent } from './engine.ts';
import { resolveExecutionPolicy } from './execution-policy.ts';
import type { AgentOptions } from './types.ts';
import { join } from 'node:path';

const LIMIT = 1024 * 1024;
function user(value: any): Pick<AgentOptions, 'prompt' | 'images'> {
  if (Object.keys(value).some(k => !['type', 'content'].includes(k))) throw new Error('Unknown user frame field');
  if (typeof value.content === 'string') { if (!value.content.trim()) throw new Error('Empty user content'); return { prompt: value.content }; }
  if (!Array.isArray(value.content) || !value.content.length) throw new Error('Invalid user content');
  const texts: string[] = [], images: NonNullable<AgentOptions['images']> = [];
  for (const part of value.content) {
    if (!part || typeof part !== 'object') throw new Error('Invalid content part');
    if (part.type === 'text' && typeof part.text === 'string' && Object.keys(part).every(k => ['type', 'text'].includes(k))) texts.push(part.text);
    else if (part.type === 'image' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(part.mime) &&
      typeof part.data === 'string' && part.data && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.data) &&
      Object.keys(part).every(k => ['type', 'mime', 'data'].includes(k))) images.push({ mime: part.mime, data: part.data });
    else throw new Error('Invalid user content part');
  }
  if (!texts.join('').trim() && !images.length) throw new Error('Empty user content');
  return { prompt: texts.join('\n'), images };
}
/** Concurrent bounded reader and serial turn consumer: interrupt never waits behind a model/tool. */
export async function serveStreamInput(input: ReadableStream<Uint8Array>, options: AgentOptions, warn = (s: string) => console.error(s)) {
  const queue: Array<Pick<AgentOptions, 'prompt' | 'images'>> = [];
  let active: AbortController | undefined, consuming: Promise<void> | undefined, sessionId = options.fork ? undefined : options.sessionId;
  const newId = options.newSessionId ?? crypto.randomUUID();
  const hooks = options.hooks ? options.hooks instanceof Hooks ? options.hooks : await new Hooks(options.cwd, sessionId ?? newId, resolveExecutionPolicy(options), e => options.onEvent?.(e)).load() : undefined;
  const reader = input.getReader(); let failed = false, failure: unknown;
  const consume = () => {
    if (consuming) return;
    consuming = (async () => {
      while (queue.length && !options.signal?.aborted) {
        const prompt = queue.shift()!; active = new AbortController();
        const signal = options.signal ? AbortSignal.any([options.signal, active.signal]) : active.signal;
        const result = await runCodingAgent({ ...options, ...prompt, hooks, signal,
          ...(sessionId ? { sessionId, fork: false, newSessionId: undefined } : { sessionId: options.sessionId, newSessionId: newId, fork: options.fork }) });
        if (options.sessionDir && await Bun.file(join(options.sessionDir, result.sessionId + '.json')).exists()) sessionId = result.sessionId;
        if (sessionId && options.sessionDir && result.error?.type === 'aborted' && !options.signal?.aborted) {
          const store = await SessionStore.create(options.sessionDir);
          try { await store.acquire(sessionId); await store.reconcileInterrupted(sessionId); if (store.reconciled) options.onEvent?.({ type: 'reconciled', sessionId, ...store.reconciled }); }
          finally { await store.close(); }
        }
        options.onEvent?.({ type: 'turn_end', sessionId: result.sessionId, ok: result.ok, turns: result.turns });
        active = undefined;
      }
    })().catch(error => { failed = true; failure = error; queue.length = 0; void reader.cancel().catch(() => {}); })
      .finally(() => { consuming = undefined; if (queue.length && !options.signal?.aborted && !failed) consume(); });
  };
  const stop = () => { queue.length = 0; active?.abort(options.signal?.reason); void reader.cancel().catch(() => {}); };
  options.signal?.addEventListener('abort', stop, { once: true }); if (options.signal?.aborted) stop();
  const line = (bytes: Uint8Array) => {
    if (!bytes.length) return false;
    try {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid input frame');
      if (value.type === 'user') { if (queue.length >= 64) throw new Error('Input queue limit reached'); queue.push(user(value)); consume(); }
      else if (value.type === 'interrupt' && Object.keys(value).length === 1) active?.abort(new Error('Turn interrupted'));
      else if (value.type === 'end' && Object.keys(value).length === 1) return true;
      else throw new Error('Invalid input frame type');
    } catch (error) { warn('stream-json: ' + (error instanceof Error ? error.message : String(error))); }
    return false;
  };
  let parts: Uint8Array[] = [], length = 0, dropping = false, ended = false;
  try {
    while (!ended && !options.signal?.aborted && !failed) {
      const next = await reader.read(); if (next.done) break;
      let offset = 0;
      while (offset < next.value.length) {
        const newline = next.value.indexOf(10, offset), end = newline < 0 ? next.value.length : newline;
        const bytes = next.value.subarray(offset, end);
        if (!dropping) {
          length += bytes.length;
          if (length > LIMIT) { dropping = true; parts = []; warn('stream-json: line exceeds 1 MiB'); }
          else if (bytes.length) parts.push(bytes);
        }
        if (newline < 0) break;
        if (!dropping && line(Buffer.concat(parts, length))) { ended = true; break; }
        parts = []; length = 0; dropping = false; offset = newline + 1;
      }
    }
    if (!failed && !ended && !dropping && length) line(Buffer.concat(parts, length));
    while (queue.length || consuming) { consume(); await consuming; }
    if (failed) throw failure;
  } finally {
    options.signal?.removeEventListener('abort', stop);
    await reader.cancel().catch(() => {}); reader.releaseLock();
    active?.abort(new Error('Stream closed')); await consuming;
    await hooks?.close();
  }
}
