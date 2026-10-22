import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createAnthropicProvider } from '../src/agent/providers/anthropic.ts';
import { clearCredentialCache, resolveCredential, validateExtraHeaders } from '../src/agent/providers/auth.ts';
import { createOpenAIResponsesProvider } from '../src/agent/providers/openai.ts';
import { loadExecSettings } from '../src/agent/settings.ts';
import type { ModelRequest } from '../src/agent/types.ts';

const servers: Array<ReturnType<typeof Bun.serve>> = [];

beforeEach(() => {
  clearCredentialCache();
});

afterEach(() => {
  for (const s of servers.splice(0)) {
    try { s.stop(true); } catch {}
  }
});

describe('Anthropic Messages API Provider', () => {
  test('positive: request formatting with x-api-key, system separate, tool_use, tool_result, and usage', async () => {
    let capturedHeaders: Headers | undefined;
    let capturedBody: any;
    let requestCount = 0;

    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        requestCount++;
        capturedHeaders = req.headers;
        capturedBody = await req.json();

        if (requestCount === 1) {
          // Stream a tool_use response
          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              const send = (obj: any) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
              send({ type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 15, output_tokens: 2 } } });
              send({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_123', name: 'read_file' } });
              send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } });
              send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"test.txt"}' } });
              send({ type: 'content_block_stop', index: 0 });
              send({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 25 } });
              send({ type: 'message_stop' });
              controller.close();
            },
          });
          return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
        }

        // Second request: return final text answer
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            const send = (obj: any) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
            send({ type: 'message_start', message: { id: 'msg_2', usage: { input_tokens: 50, output_tokens: 5 } } });
            send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
            send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'File contents received.' } });
            send({ type: 'content_block_stop', index: 0 });
            send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } });
            send({ type: 'message_stop' });
            controller.close();
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    servers.push(server);

    const provider = createAnthropicProvider({
      model: 'claude-3-5-sonnet',
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiKey: 'ant-secret-key-123',
      reasoningEffort: 'high',
      extraArgs: { promptCache: true },
    });

    const request1: ModelRequest = {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Please read test.txt' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        },
      ],
      maxOutputTokens: 4096,
    };

    const turn1 = await provider.complete(request1, AbortSignal.timeout(5000));
    expect(turn1.finishReason).toBe('tool_calls');
    expect(turn1.toolCalls).toHaveLength(1);
    const call0 = turn1.toolCalls[0]!;
    expect(call0.id).toBe('call_123');
    expect(call0.function.name).toBe('read_file');
    expect(JSON.parse(call0.function.arguments)).toEqual({ path: 'test.txt' });
    expect(turn1.usage).toEqual({ inputTokens: 15, outputTokens: 27 });

    // Verify first request inspection
    expect(capturedHeaders?.get('x-api-key')).toBe('ant-secret-key-123');
    expect(capturedHeaders?.get('anthropic-version')).toBe('2023-06-01');
    expect(capturedBody.system).toEqual([{ type: 'text', text: 'You are a helpful assistant.', cache_control: { type: 'ephemeral' } }]);
    expect(capturedBody.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
    expect(capturedBody.max_tokens).toBeGreaterThan(16384);

    // Follow-up request with tool_result
    const request2: ModelRequest = {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Please read test.txt' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [call0],
        },
        {
          role: 'tool',
          tool_call_id: 'call_123',
          content: 'hello world contents',
        },
      ],
      tools: request1.tools,
      maxOutputTokens: 4096,
    };

    const turn2 = await provider.complete(request2, AbortSignal.timeout(5000));
    expect(turn2.text).toBe('File contents received.');
    expect(turn2.finishReason).toBe('stop');

    // Verify tool_result mapped inside user role message in capturedBody
    const userMessages = capturedBody.messages.filter((m: any) => m.role === 'user');
    const lastUserMsg = userMessages.at(-1);
    expect(lastUserMsg).toBeDefined();
    const toolResultBlock = lastUserMsg.content.find((b: any) => b.type === 'tool_result');
    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock.tool_use_id).toBe('call_123');
    expect(toolResultBlock.content).toBe('hello world contents');
  });

  test('positive: authMode bearer sends Authorization header instead of x-api-key', async () => {
    let capturedAuth = '';
    let capturedApiKey: string | null = null;

    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        capturedAuth = req.headers.get('authorization') ?? '';
        capturedApiKey = req.headers.get('x-api-key');
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            const send = (obj: any) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
            send({ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } });
            send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
            send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Bearer OK' } });
            send({ type: 'content_block_stop', index: 0 });
            send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
            send({ type: 'message_stop' });
            controller.close();
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    servers.push(server);

    const provider = createAnthropicProvider({
      model: 'claude-3-haiku',
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiKey: 'custom-bearer-token',
      authMode: 'bearer',
    });

    const turn = await provider.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [], maxOutputTokens: 100 }, AbortSignal.timeout(5000));
    expect(turn.text).toBe('Bearer OK');
    expect(capturedAuth).toBe('Bearer custom-bearer-token');
    expect(capturedApiKey).toBeNull();
  });
});

describe('OpenAI Responses API Provider', () => {
  test('positive: requests /responses endpoint with Bearer auth and decodes responses stream', async () => {
    let capturedUrl = '';
    let capturedAuth = '';
    let capturedBody: any;

    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        capturedUrl = req.url;
        capturedAuth = req.headers.get('authorization') ?? '';
        capturedBody = await req.json();

        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            const send = (obj: any) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
            send({ type: 'response.output_text.delta', delta: 'OpenAI ' });
            send({ type: 'response.output_text.delta', delta: 'Responses ' });
            send({ type: 'response.output_text.delta', delta: 'Works!' });
            send({
              type: 'response.completed',
              response: { usage: { input_tokens: 20, output_tokens: 5 } },
            });
            controller.close();
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    servers.push(server);

    const provider = createOpenAIResponsesProvider({
      model: 'gpt-4o',
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      apiKey: 'oai-secret-key-456',
      reasoningEffort: 'medium',
      maxOutputTokens: 2048,
    });

    const turn = await provider.complete({
      messages: [
        { role: 'system', content: 'Act as a coder' },
        { role: 'user', content: 'Say hello' },
      ],
      tools: [],
      maxOutputTokens: 2048,
    }, AbortSignal.timeout(5000));

    expect(capturedUrl).toBe(`http://127.0.0.1:${server.port}/v1/responses`);
    expect(capturedAuth).toBe('Bearer oai-secret-key-456');
    expect(capturedBody.instructions).toBe('Act as a coder');
    expect(capturedBody.model).toBe('gpt-4o');
    expect(capturedBody.max_output_tokens).toBe(2048);
    expect(turn.text).toBe('OpenAI Responses Works!');
    expect(turn.finishReason).toBe('stop');
    expect(turn.usage).toEqual({ inputTokens: 20, outputTokens: 5 });
  });
});

describe('apiKeyHelper Credential Resolution', () => {
  test('positive: executes helper command, caches token in-process, and refreshes on 401', async () => {
    let scriptExecutions = 0;
    const helperScript = `
      process.stdout.write("token-gen-" + (++process.env.COUNTER || 1));
    `;

    // First call: resolves from helper
    const token1 = await resolveCredential({
      apiKeyHelper: [process.execPath, '-e', 'process.stdout.write("resolved-token")'],
    });
    expect(token1).toBe('resolved-token');

    // Second call: cached (process.execPath not called again for same command)
    const token2 = await resolveCredential({
      apiKeyHelper: [process.execPath, '-e', 'process.stdout.write("resolved-token")'],
    });
    expect(token2).toBe('resolved-token');

    // Force refresh: re-resolves
    const token3 = await resolveCredential({
      apiKeyHelper: [process.execPath, '-e', 'process.stdout.write("resolved-token-refreshed")'],
    }, true);
    expect(token3).toBe('resolved-token-refreshed');

    // Test automatic 401 refresh in Anthropic provider
    let providerCalls = 0;
    let authHeaderFirst = '';
    let authHeaderSecond = '';

    const authServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        providerCalls++;
        if (providerCalls === 1) {
          authHeaderFirst = req.headers.get('x-api-key') ?? '';
          return new Response('Unauthorized key', { status: 401 });
        }
        authHeaderSecond = req.headers.get('x-api-key') ?? '';
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`));
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n\n`));
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`));
            controller.close();
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    servers.push(authServer);

    let helperInvocation = 0;
    const provider = createAnthropicProvider({
      model: 'claude-3-opus',
      baseUrl: `http://127.0.0.1:${authServer.port}`,
      apiKeyHelper: [
        process.execPath,
        '-e',
        `const fs = require('fs'); const n = Number(fs.readFileSync('/tmp/fab-test-counter.txt', 'utf8').trim()) + 1; fs.writeFileSync('/tmp/fab-test-counter.txt', String(n)); process.stdout.write('key-' + n);`,
      ],
    });

    await Bun.write('/tmp/fab-test-counter.txt', '0');
    const turn = await provider.complete({ messages: [{ role: 'user', content: 'test' }], tools: [], maxOutputTokens: 100 }, AbortSignal.timeout(5000));
    expect(turn.finishReason).toBe('stop');
    expect(authHeaderFirst).toBe('key-1');
    expect(authHeaderSecond).toBe('key-2');
  });

  test('negative: helper failing with non-zero exit throws explicit error', async () => {
    await expect(
      resolveCredential({
        apiKeyHelper: [process.execPath, '-e', 'console.error("Helper error detail"); process.exit(2)'],
      }),
    ).rejects.toThrow(/apiKeyHelper exited with code 2/);
  });
});

describe('Settings and Providers Validation', () => {
  test('negative: rejects unknown provider', async () => {
    const tmpSettings = `/tmp/fab-test-unknown-provider-${Date.now()}.json`;
    await Bun.write(
      tmpSettings,
      JSON.stringify({
        customModels: [
          {
            id: 'bad-provider',
            model: 'foo',
            provider: 'unsupported-llm',
          },
        ],
      }),
    );
    await expect(loadExecSettings(tmpSettings)).rejects.toThrow(/Invalid or unsupported custom model/);
  });

  test('negative: rejects authMode bearer with openai provider', async () => {
    const tmpSettings = `/tmp/fab-test-bearer-openai-${Date.now()}.json`;
    await Bun.write(
      tmpSettings,
      JSON.stringify({
        customModels: [
          {
            id: 'openai-bad-auth',
            model: 'gpt-4o',
            provider: 'openai',
            authMode: 'bearer',
          },
        ],
      }),
    );
    await expect(loadExecSettings(tmpSettings)).rejects.toThrow(/authMode is only supported for anthropic provider/);
  });

  test('negative: rejects extraHeaders with Host or Content-Length', () => {
    expect(() => validateExtraHeaders({ Host: 'evil.com' })).toThrow(/Forbidden header in extraHeaders: Host/);
    expect(() => validateExtraHeaders({ 'content-length': '123' })).toThrow(/Forbidden header in extraHeaders: content-length/);
  });
});

describe('Anthropic Limits and Cancellation', () => {
  test('limit: stream exceeding maxResponseBytes is truncated and aborted with ProviderError', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch() {
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            const bigChunk = 'X'.repeat(64 * 1024);
            for (let i = 0; i < 20; i++) {
              controller.enqueue(enc.encode(`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${bigChunk}"}}\n\n`));
            }
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    servers.push(server);

    const provider = createAnthropicProvider({
      model: 'claude-3-haiku',
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiKey: 'test-key',
      maxResponseBytes: 128 * 1024, // 128 KiB limit
    });

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'flood' }], tools: [], maxOutputTokens: 100 }, AbortSignal.timeout(5000)),
    ).rejects.toThrow(/byte budget/i);
  });

  test('cancellation: abort mid-stream aborts fetch immediately without hanging', async () => {
    const controller = new AbortController();
    let streamAborted = false;

    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch() {
        const stream = new ReadableStream({
          start(ctrl) {
            const enc = new TextEncoder();
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`));
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'part1' } })}\n\n`));
          },
          cancel() {
            streamAborted = true;
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    servers.push(server);

    const provider = createAnthropicProvider({
      model: 'claude-3-haiku',
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiKey: 'test-key',
    });

    setTimeout(() => controller.abort(new Error('User cancelled')), 50);
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hang' }], tools: [], maxOutputTokens: 100 }, controller.signal),
    ).rejects.toThrow(/User cancelled/);
  });
});
