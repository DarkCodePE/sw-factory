import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createChatGPTProvider } from '../src/agent/chatgpt.ts';
import { createOpenAICompatibleProvider, ProviderError, idleTimeout } from '../src/agent/provider.ts';
import { DEFAULT_STREAM_IDLE_MS, streamIdleFromEnv } from '../src/agent/transport.ts';
import { configuredProviders, loadExecSettings } from '../src/agent/settings.ts';
import { runCodingAgent } from '../src/agent/engine.ts';
import { ChatController, type ChatIO } from '../src/chat/controller.ts';
import type { AgentEvent, AgentTool, ModelRequest } from '../src/agent/types.ts';

const roots: string[] = [];
let mock: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;
afterEach(async () => { mock?.mockRestore(); mock = undefined; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const request: ModelRequest = { messages: [{ role: 'user', content: 'go' }], tools: [], maxOutputTokens: 20 };
const enc = new TextEncoder();
type Kind = 'chatgpt' | 'openai';
async function fixture(kind: Kind, idleMs = 45) {
  const root = await mkdtemp(join(tmpdir(), 'fab-stream-idle-')); roots.push(root);
  const auth = join(root, 'auth.json');
  await writeFile(auth, JSON.stringify({ tokens: { access_token: `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`, account_id: 'fixture' } }));
  const provider = kind === 'chatgpt' ? createChatGPTProvider({ model: 'fixture', authFile: auth, baseUrl: 'http://unused.invalid', streamIdleMs: idleMs })
    : createOpenAICompatibleProvider({ model: 'fixture', baseUrl: 'http://unused.invalid', streamIdleMs: idleMs });
  return { root, auth, provider };
}
function intercept(handler: (signal: AbortSignal) => Response | Promise<Response>) {
  const signals: AbortSignal[] = [];
  const implementation = Object.assign((_url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
    const signal = init!.signal!; signals.push(signal); return Promise.resolve(handler(signal));
  }, { preconnect: globalThis.fetch.preconnect });
  mock = spyOn(globalThis, 'fetch').mockImplementation(implementation);
  return signals;
}
function stalled(kind: Kind, onCancel = () => {}) {
  const event = kind === 'chatgpt' ? { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'unsafe', name: 'Probe', arguments: '{}' } }
    : { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'unsafe', type: 'function', function: { name: 'Probe', arguments: '{}' } }] }, finish_reason: null }] };
  return new Response(new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`)); },
    cancel() { onCancel(); return new Promise<void>(() => {}); }, // must never delay the timeout
  }), { headers: { 'content-type': 'text/event-stream' } });
}
function completed(kind: Kind, text = 'done') {
  const data = kind === 'chatgpt' ? [{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: {} }]
    : [{ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'];
  return new Response(data.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

for (const kind of ['chatgpt', 'openai'] as const) {
  test(`${kind}: a chunk followed by silence aborts only this request, even if reader.cancel hangs`, async () => {
    const f = await fixture(kind); let cancelled = 0;
    const signals = intercept(() => stalled(kind, () => cancelled++)), parent = new AbortController(), start = Date.now();
    const error = await f.provider.complete(request, parent.signal).catch(e => e);
    expect(error).toBeInstanceOf(ProviderError); expect(error.retryable).toBe(true); expect(error.message).toContain('stalled');
    expect(Date.now() - start).toBeLessThan(1500); expect(signals[0]?.aborted).toBe(true); expect(parent.signal.aborted).toBe(false); expect(cancelled).toBe(1);
  });
  test(`${kind}: no headers also times out; parent cancellation preserves its reason`, async () => {
    const f = await fixture(kind); const signals = intercept(() => new Promise<Response>(() => {}));
    const error = await f.provider.complete(request, new AbortController().signal).catch(e => e);
    expect(error).toBeInstanceOf(ProviderError); expect(error.retryable).toBe(true); expect(signals[0]?.aborted).toBe(true);
    const parent = new AbortController(), reason = new Error('user cancelled');
    const work = f.provider.complete(request, parent.signal).catch(e => e);
    const timer = setTimeout(() => parent.abort(reason), 10);
    try { expect(await work).toBe(reason); expect(signals[1]?.aborted).toBe(true); } finally { clearTimeout(timer); }
  });
  test(`${kind}: retries a stalled tool turn without ever dispatching its partial tool`, async () => {
    const f = await fixture(kind); let calls = 0, executed = 0; const events: AgentEvent[] = [];
    intercept(() => ++calls === 1 ? stalled(kind) : completed(kind));
    const probe: AgentTool = { schema: { type: 'function', function: { name: 'Probe', description: 'fixture', parameters: { type: 'object' } } }, effect: 'read', run: async () => executed++ };
    const result = await runCodingAgent({ cwd: f.root, prompt: 'go', provider: f.provider, tools: [probe], timeoutMs: 2500, onEvent: e => events.push(e) });
    expect(result.ok).toBe(true); expect(result.text).toBe('done'); expect(calls).toBe(2); expect(executed).toBe(0); expect(result.toolCalls).toBe(0);
    expect(events.filter(e => e.type === 'provider_retry')).toHaveLength(1);
  });
  test(`${kind}: continuous byte heartbeats keep the request alive beyond one idle interval`, async () => {
    const f = await fixture(kind, 180); let timer: ReturnType<typeof setInterval> | undefined;
    const signals = intercept(() => new Response(new ReadableStream<Uint8Array>({
      start(c) {
        let count = 0;
        timer = setInterval(() => {
          if (++count < 5) c.enqueue(enc.encode(': heartbeat\n\n'));
          else { clearInterval(timer); void completed(kind).arrayBuffer().then(data => { c.enqueue(new Uint8Array(data)); c.close(); }); }
        }, 55);
      }, cancel() { clearInterval(timer); },
    }), { headers: { 'content-type': 'text/event-stream' } }));
    try { expect((await f.provider.complete(request, new AbortController().signal)).text).toBe('done'); expect(signals[0]?.aborted).toBe(false); }
    finally { clearInterval(timer); }
    await Bun.sleep(200); expect(signals[0]?.aborted).toBe(false); // successful completion disarms the watchdog
  });
}

test('empty chunks cannot reset the byte inactivity deadline', async () => {
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({ start(c) { timer = setInterval(() => c.enqueue(new Uint8Array()), 8); }, cancel() { clearInterval(timer); } });
  const reader = idleTimeout(body, 50).getReader();
  try {
    const result = await (async () => { for (;;) { const part = await reader.read(); if (part.done) return null; } })().catch(e => e);
    expect(result).toBeInstanceOf(ProviderError); expect(result.retryable).toBe(true);
  } finally { clearInterval(timer); reader.releaseLock(); }
});

test('JSON and HTTP error-body stalls share the same watchdog', async () => {
  const f = await fixture('openai');
  for (const status of [200, 400]) {
    mock?.mockRestore(); intercept(() => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('{')); } }), { status }));
    const error = await f.provider.complete(request, new AbortController().signal).catch(e => e);
    expect(error).toBeInstanceOf(ProviderError); expect(error.retryable).toBe(true);
  }
});

test('retry exhaustion respects maxRecoveryAttempts and the default maximum of three calls', async () => {
  const f = await fixture('openai', 30);
  for (const [budget, expected] of [[0, 1], [1, 2], [undefined, 3]] as const) {
    mock?.mockRestore(); const signals = intercept(() => stalled('openai'));
    const result = await runCodingAgent({ cwd: f.root, prompt: 'go', provider: f.provider, maxRecoveryAttempts: budget, timeoutMs: 2500 });
    expect(result.ok).toBe(false); expect(result.error?.type).toBe('provider'); expect(result.error?.message).toContain('stalled');
    expect(signals).toHaveLength(expected); expect(result.toolCalls).toBe(0);
  }
});

test('agent total timeout takes precedence over the idle budget and cannot retry', async () => {
  const f = await fixture('openai', 300), signals = intercept(() => stalled('openai'));
  const result = await runCodingAgent({ cwd: f.root, prompt: 'go', provider: f.provider, timeoutMs: 40 });
  expect(result.error?.type).toBe('timeout'); expect(signals).toHaveLength(1); expect(signals[0]?.aborted).toBe(true); expect(result.toolCalls).toBe(0);
});

test('settings/model/env precedence configures both providers; invalid limits fail early', async () => {
  const f = await fixture('openai'); const settings = join(f.root, 'settings.json');
  const previous = process.env.FABRICA_STREAM_IDLE_MS;
  try {
    delete process.env.FABRICA_STREAM_IDLE_MS; expect(streamIdleFromEnv()).toBe(DEFAULT_STREAM_IDLE_MS);
    process.env.FABRICA_STREAM_IDLE_MS = '80'; expect(streamIdleFromEnv()).toBe(80); expect(streamIdleFromEnv(0)).toBe(0);
    for (const value of ['invalid', '', '-1', '1.5', '2147483648']) { process.env.FABRICA_STREAM_IDLE_MS = value; expect(() => streamIdleFromEnv()).toThrow('streamIdleMs'); }
    process.env.FABRICA_STREAM_IDLE_MS = 'invalid';
    await writeFile(settings, JSON.stringify({ streamIdleMs: 30, customModels: [{ id: 'custom:c', model: 'fixture', provider: 'chatgpt', authFile: f.auth, streamIdleMs: 35 }] }));
    const config = await loadExecSettings(settings);
    const configured = configuredProviders(config, { model: 'fixture' });
    const signals = intercept(() => stalled('chatgpt'));
    for (const provider of [configured.providers['custom:c']!, configured.providers.fixture!]) {
      const error = await provider.complete(request, new AbortController().signal).catch(e => e); expect(error).toBeInstanceOf(ProviderError);
    }
    expect(signals).toHaveLength(2);
    for (const limit of [-1, 0.5, '30', 2147483648]) {
      await writeFile(settings, JSON.stringify({ streamIdleMs: limit })); await expect(loadExecSettings(settings)).rejects.toThrow('schema');
      await writeFile(settings, JSON.stringify({ customModels: [{ id: 'x', model: 'x', provider: 'openai', streamIdleMs: limit }] })); await expect(loadExecSettings(settings)).rejects.toThrow('model');
    }
  } finally { if (previous === undefined) delete process.env.FABRICA_STREAM_IDLE_MS; else process.env.FABRICA_STREAM_IDLE_MS = previous; }
});

test('TUI separates partial streamed text from retry and successful answer', async () => {
  const f = await fixture('openai'); const cwd = join(f.root, 'workspace'); await mkdir(cwd);
  let attempt = 0;
  intercept(() => {
    if (attempt++) return completed('openai', '# Recuperado');
    return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('data: {"choices":[{"index":0,"delta":{"content":"parcial"},"finish_reason":null}]}\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  let output = ''; const io: ChatIO = { write(t) { output += t; }, async question() { return ''; }, async select() { return undefined; } };
  const app = new ChatController({ cwd, home: join(f.root, 'home'), providerFor: () => f.provider, config: { model: 'fixture', autonomy: 'off', mode: 'auto', theme: 'plain' } }, io);
  await app.submit('go'); expect(output).toContain('parcial\nReintento del proveedor 2/3:'); expect(output).toContain('# Recuperado\n');
});
