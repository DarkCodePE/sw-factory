import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSdkMcpServer, createSession, resumeSession, tool } from '../src/sdk/index.ts';
import type { SdkMcpServer } from '../src/sdk/index.ts';

const roots: string[] = [], servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(async () => { for (const server of servers.splice(0)) server.stop(true); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const path = await mkdtemp(join(tmpdir(), 'fab-sdk-')); roots.push(path); return path; }
function fakeProvider() {
  const seen: any[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as any; seen.push(body);
    const toolName = body.tools?.find((item: any) => item.function.name === 'sdk___greet')?.function.name;
    const used = body.messages?.some((message: any) => message.role === 'tool');
    const message = used ? { role: 'assistant', content: 'greeted Ada' }
      : toolName ? { role: 'assistant', content: null, tool_calls: [{ id: 'greet-call', type: 'function', function: { name: toolName, arguments: JSON.stringify({ name: 'Ada' }) } }] }
        : { role: 'assistant', content: 'fixture response' };
    return Response.json({ choices: [{ message, finish_reason: used || !toolName ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 2, completion_tokens: 1 } });
  } });
  servers.push(server); return { server, seen };
}
async function settings(path: string, baseUrl: string) {
  const file = join(path, 'settings.json');
  await writeFile(file, JSON.stringify({ modelId: 'custom:fixture', customModels: [{ id: 'custom:fixture', model: 'fixture', provider: 'generic-chat-completion-api', baseUrl }] }));
  return file;
}
async function fabWrapper(path: string) {
  const file = join(path, 'fab-test');
  const cli = resolve(import.meta.dir, '../src/cli.ts');
  await writeFile(file, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${cli}' "$@"\n`);
  await chmod(file, 0o700); return file;
}
function greeting(handler: (input: any) => any = input => `hello ${input.name}`): SdkMcpServer {
  return createSdkMcpServer({ name: 'sdk', tools: [tool('greet', 'Greet someone', {
    type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false,
  }, handler)] });
}

test('SDK MCP requires bearer token, validates input, and maps handler exceptions to isError', async () => {
  const server = greeting(() => { throw new Error('handler exploded'); });
  const config = await server.start();
  try {
    const url = new URL(config.url!);
    const noToken = await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(noToken.status).toBe(401);
    const headers = { ...config.headers, 'content-type': 'application/json' };
    const invalid = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'greet', arguments: {} } }) }).then(r => r.json()) as any;
    expect(invalid.result).toMatchObject({ isError: true }); expect(invalid.result.content[0].text).toContain('required');
    const thrown = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'greet', arguments: { name: 'Ada' } } }) }).then(r => r.json()) as any;
    expect(thrown.result).toMatchObject({ isError: true }); expect(thrown.result.content[0].text).toBe('handler exploded');
  } finally { await server.close(); }
});

test('SDK session calls an in-process MCP tool through fab exec and resumes with a newly supplied server', async () => {
  const dir = await root(), model = fakeProvider(), settingsPath = await settings(dir, model.server.url.href + 'v1');
  const opts = { cwd: dir, settingsPath, sessionDir: join(dir, 'sessions'), execPath: await fabWrapper(dir), modelId: 'custom:fixture', autonomy: 'high' as const };
  const invoked: unknown[] = [], sdkServer = greeting(input => { invoked.push(input); return `hello ${input.name}`; });
  const session = await createSession({ ...opts, mcpServers: [sdkServer] });
  expect(await session.listMcpTools()).toEqual(expect.arrayContaining([expect.objectContaining({ server: 'sdk', name: 'greet' })]));
  const result = await session.send('greet Ada');
  expect(result).toMatchObject({ text: 'greeted Ada', reason: 'completed' }); expect(invoked).toEqual([{ name: 'Ada' }]);
  const oldId = session.sessionId; await session.close();
  const replacement = greeting(input => `hello ${input.name}`);
  const resumed = await resumeSession(oldId, { ...opts, mcpServers: [replacement] });
  expect(resumed.sessionId).toBe(oldId);
  expect(await resumed.listMcpTools()).toEqual(expect.arrayContaining([expect.objectContaining({ server: 'sdk', name: 'greet' })]));
  await resumed.close();
});

test('SDK close cancels an active tool and shuts down its child and loopback server across three sessions', async () => {
  const dir = await root(), model = fakeProvider(), settingsPath = await settings(dir, model.server.url.href + 'v1'), execPath = await fabWrapper(dir);
  for (let i = 0; i < 3; i++) {
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const sdkServer = greeting(() => { markStarted(); return new Promise(() => {}); });
    const config = await sdkServer.start(), session = await createSession({ cwd: dir, settingsPath, sessionDir: join(dir, `s${i}`), execPath, modelId: 'custom:fixture', autonomy: 'high', mcpServers: [sdkServer] });
    const pending = session.send('hang in a tool'); await started;
    await session.close(); await session.close();
    await pending;
    await expect(fetch(config.url!)).rejects.toThrow();
  }
});

test('SDK MCP tool call times out after 60 seconds', async () => {
  const server = greeting(async () => { await Bun.sleep(60_050); return 'late'; });
  const config = await server.start();
  try {
    const response = await fetch(config.url!, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'greet', arguments: { name: 'Ada' } } }) });
    const result = await response.json() as any;
    expect(result.result).toMatchObject({ isError: true }); expect(result.result.content[0].text).toContain('timed out');
  } finally { await server.close(); }
}, 70_000);
