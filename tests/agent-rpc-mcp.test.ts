import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ExecRpc } from '../src/agent/rpc.ts';
import { McpRuntime } from '../src/agent/mcp.ts';
import type { ModelProvider } from '../src/agent/types.ts';

const roots: string[] = [], procs: Array<ReturnType<typeof Bun.spawn>> = [];
const savedHome = process.env.FABRICA_HOME;
afterEach(async () => {
  McpRuntime.clear();
  if (savedHome === undefined) delete process.env.FABRICA_HOME; else process.env.FABRICA_HOME = savedHome;
  for (const proc of procs.splice(0)) { try { proc.kill(); } catch {} }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const request = (id: string, method: string, params = {}) => ({ jsonrpc: '2.0', type: 'request', id, method: 'droid.' + method, params });
const provider: ModelProvider = { id: 'fixture', async complete() { return { text: 'done', toolCalls: [], finishReason: 'stop' }; } };
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'fab-rpc-mcp-')); roots.push(cwd);
  const frames: any[] = [], rpc = new ExecRpc({ cwd, sessionDir: join(cwd, 'sessions'), defaultModelId: 'fixture', providers: { fixture: provider } }, frame => frames.push(frame));
  return { cwd, frames, rpc, init: (params = {}) => rpc.accept(request('init', 'initialize_session', { machineId: 'test', modelId: 'fixture', autonomyLevel: 'high', ...params })),
    send: (id: string, method: string, params = {}) => rpc.accept(request(id, method, params)) };
}
async function oauthFixture() {
  const path = fileURLToPath(new URL('../scripts/mcp-fixture.ts', import.meta.url));
  const proc = Bun.spawn([process.execPath, path, '--oauth'], { stdout: 'pipe', stderr: 'ignore' }); procs.push(proc);
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader(), decoder = new TextDecoder(); let buffer = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) throw new Error('OAuth fixture exited');
    buffer += decoder.decode(value); const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(buffer);
    if (match) { reader.releaseLock(); return Number(match[1]); }
  }
}
async function until(check: () => boolean) { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error('MCP RPC wait timed out'); await Bun.sleep(10); } }

test('RPC discovers configured stdio MCP servers and tools', async () => {
  McpRuntime.clear();
  const h = await fixture(), fixturePath = fileURLToPath(new URL('../scripts/mcp-fixture.ts', import.meta.url));
  await h.init({ mcpServers: { fixture: { command: process.execPath, args: ['--no-env-file', fixturePath], readOnlyTools: ['echo'] } } });
  await h.send('servers', 'list_mcp_servers');
  expect(h.frames.find(f => f.id === 'servers').result).toMatchObject({ summary: { connected: 1, failed: 0, needsAuth: 0 }, servers: [{ server: 'fixture', state: 'connected' }] });
  await h.send('tools', 'list_mcp_tools');
  expect(h.frames.find(f => f.id === 'tools').result).toEqual(expect.arrayContaining([expect.objectContaining({ server: 'fixture', name: 'echo' })]));
  await h.rpc.shutdown();
});

test('RPC reports OAuth URL and notifies while authentication completes on callback', async () => {
  McpRuntime.clear();
  const root = await mkdtemp(join(tmpdir(), 'fab-rpc-auth-home-')); roots.push(root); process.env.FABRICA_HOME = root;
  const port = await oauthFixture(), h = await fixture();
  await h.init({ mcpServers: { oauthfixture: { url: `http://127.0.0.1:${port}/mcp` } } });
  await h.send('servers', 'list_mcp_servers');
  expect(h.frames.find(f => f.id === 'servers').result.summary.needsAuth).toBe(1);
  await h.send('auth', 'authenticate_mcp_server', { serverName: 'oauthfixture' });
  const auth = h.frames.find(f => f.id === 'auth').result.authorizeUrl;
  expect(auth).toContain('/authorize');
  expect(h.frames.some(f => f.params?.notification?.type === 'mcp_auth_required' && f.params.notification.authorizeUrl === auth)).toBe(true);
  const callback = await fetch(auth, { redirect: 'follow' }); expect(callback.ok).toBe(true);
  await until(() => McpRuntime.status().find(s => s.server === 'oauthfixture')?.state === 'connected');
  await h.send('servers-after', 'list_mcp_servers');
  expect(h.frames.find(f => f.id === 'servers-after').result.summary.connected).toBe(1);
  await h.rpc.shutdown();
});

test('fab exec stream-jsonrpc stdin exposes hooks and connected MCP status', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'fab-rpc-cli-')); roots.push(cwd);
  const home = join(cwd, 'home'); process.env.FABRICA_HOME = home;
  await mkdir(join(cwd, '.fab'), { recursive: true });
  const fixturePath = fileURLToPath(new URL('../scripts/mcp-fixture.ts', import.meta.url));
  const settingsPath = join(cwd, 'settings.json'), sessionDir = join(cwd, 'sessions');
  await writeFile(settingsPath, JSON.stringify({ modelId: 'custom:fixture',
    customModels: [{ id: 'custom:fixture', model: 'fixture', provider: 'generic-chat-completion-api', baseUrl: 'http://127.0.0.1:1/v1' }],
    mcpServers: { local: { command: process.execPath, args: ['--no-env-file', fixturePath], readOnlyTools: ['echo'] } } }));
  await writeFile(join(cwd, '.fab/hooks.json'), JSON.stringify({ SessionStart: [{ hooks: [{ type: 'command', command: 'printf session-start' }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'printf session-end' }] }] }));
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const child = Bun.spawn([process.execPath, '--no-env-file', cli, 'exec', '--cwd', cwd, '--settings', settingsPath,
    '--session-dir', sessionDir, '--input-format', 'stream-jsonrpc', '-o', 'stream-jsonrpc'],
  { env: { ...process.env, FABRICA_HOME: home }, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
  procs.push(child);
  const frames = (async () => {
    const output = await new Response(child.stdout).text();
    return output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  })();
  const input = [
    request('init', 'initialize_session', { machineId: 'cli-fixture', modelId: 'custom:fixture', autonomyLevel: 'high', hooks: true }),
    request('servers', 'list_mcp_servers'),
    request('close', 'close_session'),
  ].map(frame => JSON.stringify(frame)).join('\n') + '\n';
  child.stdin.write(input); child.stdin.end();
  const [result, exitCode] = await Promise.all([frames, child.exited]);
  expect(exitCode).toBe(0);
  expect(result.find(frame => frame.id === 'servers').result.summary.connected).toBe(1);
  expect(result.some(frame => frame.params?.notification?.type === 'hook_executed' && frame.params.notification.event === 'SessionStart')).toBe(true);
  expect(result.some(frame => frame.params?.notification?.type === 'hook_executed' && frame.params.notification.event === 'SessionEnd')).toBe(true);
});
