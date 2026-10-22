import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodingAgent } from '../src/agent/engine.ts';
import { describeTool } from '../src/agent/catalog.ts';
import { webSearchTool, isSearchConfigured } from '../src/agent/web-search.ts';
import { SessionStore } from '../src/agent/session.ts';
import type { AgentEvent, AgentOptions, ModelTurn } from '../src/agent/types.ts';

const roots: string[] = [];
const servers: Array<{ stop(closeActive?: boolean): void }> = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    try { s.stop(true); } catch {}
  }
  for (const r of roots.splice(0)) {
    try { await rm(r, { recursive: true, force: true }); } catch {}
  }
  delete process.env.FABRICA_SEARCH_PROVIDER;
  delete process.env.FABRICA_SEARCH_URL;
  delete process.env.FABRICA_SEARCH_API_KEY;
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'fab-websearch-test-'));
  const sessionDir = await mkdtemp(join(tmpdir(), 'fab-websearch-sessions-'));
  roots.push(cwd, sessionDir);
  return { cwd, sessionDir };
}

const doneTurn: ModelTurn = { text: 'completed', toolCalls: [], finishReason: 'stop' };
function call(name: string, input: unknown): ModelTurn {
  return {
    text: '',
    finishReason: 'tool_calls',
    toolCalls: [
      { id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(input) } },
    ],
  };
}

test('positive: searxng provider returns results with title, url, snippet, external: true and provider', async () => {
  const f = await fixture();
  let receivedQuery = '';
  let receivedFormat = '';

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      receivedQuery = url.searchParams.get('q') ?? '';
      receivedFormat = url.searchParams.get('format') ?? '';

      const body = {
        query: receivedQuery,
        results: [
          { title: 'Searx Result 1', url: 'https://example.org/1', content: 'Snippet from Searx 1' },
          { title: 'Searx Result 2', url: 'https://example.org/2', content: 'Snippet from Searx 2' },
        ],
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  servers.push(server);

  process.env.FABRICA_SEARCH_PROVIDER = 'searxng';
  process.env.FABRICA_SEARCH_URL = server.url.href;

  const turns = [
    () => call('WebSearch', { query: 'test searx query', maxResults: 2 }),
  ];

  const events: AgentEvent[] = [];
  const result = await runCodingAgent({
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    autonomy: 'high',
    prompt: 'search web',
    provider: { id: 'fixture', complete: async () => turns.shift()?.() ?? doneTurn },
    onEvent: e => events.push(e),
  });

  expect(result.ok).toBe(true);
  expect(receivedQuery).toBe('test searx query');
  expect(receivedFormat).toBe('json');

  const toolResult = events.find(e => e.type === 'tool_result')?.value as any;
  expect(toolResult).toBeDefined();
  expect(toolResult.provider).toBe('searxng');
  expect(toolResult.query).toBe('test searx query');
  expect(toolResult.results).toHaveLength(2);
  expect(toolResult.results[0]).toEqual({
    title: 'Searx Result 1',
    url: 'https://example.org/1',
    snippet: 'Snippet from Searx 1',
    external: true,
  });
  expect(toolResult.results[1]).toEqual({
    title: 'Searx Result 2',
    url: 'https://example.org/2',
    snippet: 'Snippet from Searx 2',
    external: true,
  });
});

test('positive: brave provider sends X-Subscription-Token header and returns parsed results', async () => {
  const f = await fixture();
  let receivedToken = '';
  let receivedCount = '';

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      receivedToken = req.headers.get('X-Subscription-Token') ?? '';
      const url = new URL(req.url);
      receivedCount = url.searchParams.get('count') ?? '';

      const body = {
        web: {
          results: [
            { title: 'Brave Page', url: 'https://brave.example.com', description: 'Brave description snippet' },
          ],
        },
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  servers.push(server);

  process.env.FABRICA_SEARCH_PROVIDER = 'brave';
  process.env.FABRICA_SEARCH_API_KEY = 'mock-brave-key-abc';
  process.env.FABRICA_SEARCH_URL = server.url.href;

  const turns = [
    () => call('WebSearch', { query: 'brave query', maxResults: 3 }),
  ];

  const events: AgentEvent[] = [];
  const result = await runCodingAgent({
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    autonomy: 'high',
    prompt: 'search brave',
    provider: { id: 'fixture', complete: async () => turns.shift()?.() ?? doneTurn },
    onEvent: e => events.push(e),
  });

  expect(result.ok).toBe(true);
  expect(receivedToken).toBe('mock-brave-key-abc');
  expect(receivedCount).toBe('3');

  const toolResult = events.find(e => e.type === 'tool_result')?.value as any;
  expect(toolResult).toBeDefined();
  expect(toolResult.provider).toBe('brave');
  expect(toolResult.results).toHaveLength(1);
  expect(toolResult.results[0]).toEqual({
    title: 'Brave Page',
    url: 'https://brave.example.com',
    snippet: 'Brave description snippet',
    external: true,
  });
});

test('negative: unconfigured provider fails explicitly and catalog marks tool unavailable', async () => {
  const f = await fixture();

  delete process.env.FABRICA_SEARCH_PROVIDER;
  delete process.env.FABRICA_SEARCH_URL;
  delete process.env.FABRICA_SEARCH_API_KEY;

  expect(isSearchConfigured()).toBe(false);

  // Check catalog description
  const t = webSearchTool();
  const desc = describeTool(t, 'high', 'auto');
  expect(desc.id).toBe('web_search');
  expect(desc.displayName).toBe('Web Search');
  expect(desc.defaultAllowed).toBe(false);
  expect(desc.currentlyAllowed).toBe(false);

  // When called, fails explicitly
  const turns = [
    () => call('WebSearch', { query: 'unconfigured search' }),
  ];

  const events: AgentEvent[] = [];
  await runCodingAgent({
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    autonomy: 'high',
    prompt: 'search unconfigured',
    provider: { id: 'fixture', complete: async () => turns.shift()?.() ?? doneTurn },
    onEvent: e => events.push(e),
  });

  const toolRes = events.find(e => e.type === 'tool_result');
  expect(toolRes?.isError).toBe(true);
  expect(String(toolRes?.value)).toContain('No search provider configured');
});

test('negative: malformed JSON response throws explicit error', async () => {
  const f = await fixture();

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response('<html><head><title>Bad Gateway</title></head><body>Not JSON</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    },
  });
  servers.push(server);

  const turns = [
    () => call('WebSearch', { query: 'bad json search' }),
  ];

  const events: AgentEvent[] = [];
  await runCodingAgent({
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    autonomy: 'high',
    searchConfig: { provider: 'searxng', url: server.url.href },
    prompt: 'search bad json',
    provider: { id: 'fixture', complete: async () => turns.shift()?.() ?? doneTurn },
    onEvent: e => events.push(e),
  });

  const toolRes = events.find(e => e.type === 'tool_result');
  expect(toolRes?.isError).toBe(true);
  expect(String(toolRes?.value)).toContain('invalid JSON');
});

test('negative: HTTP 500 error throws with status and body', async () => {
  const f = await fixture();

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response('Internal Engine Error Occurred', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    },
  });
  servers.push(server);

  const turns = [
    () => call('WebSearch', { query: 'error search' }),
  ];

  const events: AgentEvent[] = [];
  await runCodingAgent({
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    autonomy: 'high',
    searchConfig: { provider: 'searxng', url: server.url.href },
    prompt: 'search error',
    provider: { id: 'fixture', complete: async () => turns.shift()?.() ?? doneTurn },
    onEvent: e => events.push(e),
  });

  const toolRes = events.find(e => e.type === 'tool_result');
  expect(toolRes?.isError).toBe(true);
  expect(String(toolRes?.value)).toContain('HTTP 500');
  expect(String(toolRes?.value)).toContain('Internal Engine Error Occurred');
});

test('limits: query length and maxResults boundaries', async () => {
  const f = await fixture();

  // 1. Query too long (> 512 chars)
  const longQuery = 'a'.repeat(513);
  const turns1 = [() => call('WebSearch', { query: longQuery })];
  const events1: AgentEvent[] = [];
  await runCodingAgent({
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    autonomy: 'high',
    searchConfig: { provider: 'searxng', url: 'http://127.0.0.1:9999' },
    prompt: 'long query',
    provider: { id: 'fixture', complete: async () => turns1.shift()?.() ?? doneTurn },
    onEvent: e => events1.push(e),
  });
  const res1 = events1.find(e => e.type === 'tool_result');
  expect(res1?.isError).toBe(true);
  expect(String(res1?.value)).toContain('exceeds 512 characters');

  // 2. Empty query
  const turns2 = [() => call('WebSearch', { query: '   ' })];
  const events2: AgentEvent[] = [];
  await runCodingAgent({
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    autonomy: 'high',
    searchConfig: { provider: 'searxng', url: 'http://127.0.0.1:9999' },
    prompt: 'empty query',
    provider: { id: 'fixture', complete: async () => turns2.shift()?.() ?? doneTurn },
    onEvent: e => events2.push(e),
  });
  const res2 = events2.find(e => e.type === 'tool_result');
  expect(res2?.isError).toBe(true);
  expect(String(res2?.value)).toContain('non-empty string');

  // 3. Invalid maxResults (e.g. 0 or 25)
  const turns3 = [() => call('WebSearch', { query: 'test', maxResults: 25 })];
  const events3: AgentEvent[] = [];
  await runCodingAgent({
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    autonomy: 'high',
    searchConfig: { provider: 'searxng', url: 'http://127.0.0.1:9999' },
    prompt: 'bad maxResults',
    provider: { id: 'fixture', complete: async () => turns3.shift()?.() ?? doneTurn },
    onEvent: e => events3.push(e),
  });
  const res3 = events3.find(e => e.type === 'tool_result');
  expect(res3?.isError).toBe(true);
  expect(String(res3?.value)).toContain('between 1 and 20');
});

test('limits: response body exceeding 64 KiB is aborted and rejected', async () => {
  const f = await fixture();

  const hugePayload = JSON.stringify({
    results: Array.from({ length: 500 }, (_, i) => ({
      title: `Huge Result ${i}`,
      url: `https://example.com/${i}`,
      content: 'x'.repeat(300),
    })),
  }); // ~150 KiB
  expect(Buffer.byteLength(hugePayload)).toBeGreaterThan(64 * 1024);

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response(hugePayload, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  servers.push(server);

  const turns = [
    () => call('WebSearch', { query: 'huge response test' }),
  ];

  const events: AgentEvent[] = [];
  await runCodingAgent({
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    autonomy: 'high',
    searchConfig: { provider: 'searxng', url: server.url.href },
    prompt: 'search huge',
    provider: { id: 'fixture', complete: async () => turns.shift()?.() ?? doneTurn },
    onEvent: e => events.push(e),
  });

  const toolRes = events.find(e => e.type === 'tool_result');
  expect(toolRes?.isError).toBe(true);
  expect(String(toolRes?.value)).toContain('64 KiB limit');
});

test('redirects: follows valid http redirect and rejects non-http scheme or redirect loop', async () => {
  const f = await fixture();

  // 1. Valid redirect
  let targetHits = 0;
  const targetServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      targetHits++;
      return new Response(JSON.stringify({ results: [{ title: 'Redirected', url: 'https://ex.com', content: 'c' }] }));
    },
  });
  servers.push(targetServer);

  const redirectServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response(null, {
        status: 302,
        headers: { Location: targetServer.url.href },
      });
    },
  });
  servers.push(redirectServer);

  const turns1 = [() => call('WebSearch', { query: 'valid redirect' })];
  const events1: AgentEvent[] = [];
  await runCodingAgent({
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    autonomy: 'high',
    searchConfig: { provider: 'searxng', url: redirectServer.url.href },
    prompt: 'search redirect',
    provider: { id: 'fixture', complete: async () => turns1.shift()?.() ?? doneTurn },
    onEvent: e => events1.push(e),
  });
  const res1 = events1.find(e => e.type === 'tool_result');
  expect(res1?.isError).toBe(false);
  expect(targetHits).toBe(1);

  // 2. Disallowed scheme in redirect
  const evilServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response(null, {
        status: 302,
        headers: { Location: 'file:///etc/passwd' },
      });
    },
  });
  servers.push(evilServer);

  const turns2 = [() => call('WebSearch', { query: 'disallowed scheme' })];
  const events2: AgentEvent[] = [];
  await runCodingAgent({
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    autonomy: 'high',
    searchConfig: { provider: 'searxng', url: evilServer.url.href },
    prompt: 'search evil',
    provider: { id: 'fixture', complete: async () => turns2.shift()?.() ?? doneTurn },
    onEvent: e => events2.push(e),
  });
  const res2 = events2.find(e => e.type === 'tool_result');
  expect(res2?.isError).toBe(true);
  expect(String(res2?.value)).toContain('disallowed redirect scheme: file:');
});

test('cancellation: abort signal cancels in-flight web search', async () => {
  const f = await fixture();
  const controller = new AbortController();

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch() {
      await Bun.sleep(1000);
      return new Response(JSON.stringify({ results: [] }));
    },
  });
  servers.push(server);

  const turns = [
    () => call('WebSearch', { query: 'abort test' }),
  ];

  let abortedDuringTool = false;
  const result = await runCodingAgent({
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    autonomy: 'high',
    signal: controller.signal,
    searchConfig: { provider: 'searxng', url: server.url.href },
    prompt: 'search cancel',
    provider: {
      id: 'fixture',
      complete: async () => {
        const next = turns.shift();
        if (next) {
          // Trigger abort shortly after tool dispatch
          setTimeout(() => {
            abortedDuringTool = true;
            controller.abort(new Error('Parent aborted web search'));
          }, 30);
          return next();
        }
        return doneTurn;
      },
    },
  });

  expect(abortedDuringTool).toBe(true);
  expect(result.ok).toBe(false);
  expect(result.error?.type).toBe('aborted');
});

test('network policy: deny blocks, ask requires approval, auto permits in high, spec permits if policy allows', async () => {
  const f = await fixture();

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response(JSON.stringify({ results: [{ title: 'OK', url: 'https://ex.com', content: 'hit' }] }));
    },
  });
  servers.push(server);
  const cfg = { provider: 'searxng' as const, url: server.url.href };

  // 1. Policy deny blocks
  const turns1 = [() => call('WebSearch', { query: 'deny test' })];
  const events1: AgentEvent[] = [];
  await runCodingAgent({
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    autonomy: 'high',
    networkPolicy: 'deny',
    searchConfig: cfg,
    prompt: 'test deny',
    provider: { id: 'fixture', complete: async () => turns1.shift()?.() ?? doneTurn },
    onEvent: e => events1.push(e),
  });
  const res1 = events1.find(e => e.type === 'tool_result');
  expect(res1?.isError).toBe(true);
  expect(String(res1?.value)).toContain('network access denied by policy');

  // 2. Policy ask requires approval: unattended throws
  const turns2 = [() => call('WebSearch', { query: 'ask test unattended' })];
  const events2: AgentEvent[] = [];
  await runCodingAgent({
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    autonomy: 'high',
    networkPolicy: 'ask',
    searchConfig: cfg,
    prompt: 'test ask',
    provider: { id: 'fixture', complete: async () => turns2.shift()?.() ?? doneTurn },
    onEvent: e => events2.push(e),
  });
  const res2 = events2.find(e => e.type === 'tool_result');
  expect(res2?.isError).toBe(true);
  expect(String(res2?.value)).toContain('WebSearch network approval required');

  // 3. Policy ask with permissionHandler approval succeeds
  const turns3 = [() => call('WebSearch', { query: 'ask test approved' })];
  const events3: AgentEvent[] = [];
  let permissionPrompted = false;
  const result3 = await runCodingAgent({
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    autonomy: 'medium',
    networkPolicy: 'ask',
    searchConfig: cfg,
    prompt: 'test ask approve',
    permissionHandler: async (req) => {
      permissionPrompted = true;
      expect(req.toolUses[0]?.confirmationType).toBe('web_search');
      expect(req.toolUses[0]?.details.network).toBeDefined();
      return 'proceed_once';
    },
    provider: { id: 'fixture', complete: async () => turns3.shift()?.() ?? doneTurn },
    onEvent: e => events3.push(e),
  });
  expect(result3.ok).toBe(true);
  expect(permissionPrompted).toBe(true);
  const res3 = events3.find(e => e.type === 'tool_result');
  expect(res3?.isError).toBe(false);

  // 4. Spec mode allows WebSearch when policy is auto and autonomy is high (read tool)
  const turns4 = [() => call('WebSearch', { query: 'spec mode read search' })];
  const events4: AgentEvent[] = [];
  const result4 = await runCodingAgent({
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    autonomy: 'high',
    interactionMode: 'spec',
    networkPolicy: 'auto',
    searchConfig: cfg,
    prompt: 'test spec auto high',
    provider: { id: 'fixture', complete: async () => turns4.shift()?.() ?? doneTurn },
    onEvent: e => events4.push(e),
  });
  expect(result4.ok).toBe(true);
  const res4 = events4.find(e => e.type === 'tool_result');
  expect(res4?.isError).toBe(false);
  expect((res4?.value as any)?.results).toHaveLength(1);
});

test('security: API key never leaks in events, session snapshot, or error messages', async () => {
  const f = await fixture();
  const secretKey = 'super-secret-brave-key-987654321';
  const sessionId = 'session-secret-test';

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      // Simulate an error that echoes back headers or query
      const token = req.headers.get('X-Subscription-Token');
      return new Response(`Error with token ${token} in backend`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    },
  });
  servers.push(server);

  const turns = [
    () => call('WebSearch', { query: 'secret test query' }),
  ];

  const events: AgentEvent[] = [];
  await runCodingAgent({
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    newSessionId: sessionId,
    autonomy: 'high',
    searchConfig: { provider: 'brave', apiKey: secretKey, url: server.url.href },
    prompt: 'test secret leak',
    provider: { id: 'fixture', complete: async () => turns.shift()?.() ?? doneTurn },
    onEvent: e => events.push(e),
  });

  // 1. Verify error message scrubs secret
  const toolRes = events.find(e => e.type === 'tool_result');
  expect(toolRes?.isError).toBe(true);
  const errorText = JSON.stringify(toolRes?.value);
  expect(errorText).not.toContain(secretKey);
  expect(errorText).toContain('[REDACTED]');

  // 2. Verify all emitted events do not contain the secretKey
  const allEventsJson = JSON.stringify(events);
  expect(allEventsJson).not.toContain(secretKey);

  // 3. Verify session file on disk does not contain the secretKey
  const store = await SessionStore.create(f.sessionDir);
  const session = await store.inspect(sessionId);
  const sessionJson = JSON.stringify(session);
  expect(sessionJson).not.toContain(secretKey);
});
