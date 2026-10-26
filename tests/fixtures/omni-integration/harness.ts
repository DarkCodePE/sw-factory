import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ExecSettings } from '../../../src/agent/settings.ts';
import type { Clock, Profile } from '../../../src/agent/omni/contracts.ts';

export const entry = fileURLToPath(new URL('../../../src/cli.ts', import.meta.url));
export const request = { messages: [{ role: 'user' as const, content: 'fixture' }], tools: [], maxOutputTokens: 16 };
export const done = (text = 'STATUS: done') => Response.json({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
export const tools = (name: string, args = '{}') => Response.json({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id: 'fixture-call', type: 'function', function: { name, arguments: args } }] }, finish_reason: 'tool_calls' }] });
export const failure = (status: number, code?: string, retryAfter?: string) => Response.json({ error: { code, message: 'BODY_SECRET_SENTINEL' } },
  { status, headers: { ...(retryAfter ? { 'retry-after': retryAfter } : {}), 'x-secret': 'HEADER_SECRET_SENTINEL' } });
export const profile = (id: string, priority: number, extra: Partial<Profile> = {}): Profile => ({ modelId: id, providerId: 'fixture',
  accountId: id, quotaGroup: id, costTier: 'free', tos: 'ok', acknowledgeTos: true, supportsTools: true,
  supportsImages: false, contextWindow: 1000000, priority, ...extra });
export function settings(baseUrl: string, profiles = [profile('a', 1), profile('b', 2), profile('c', 3)]): ExecSettings {
  return { modelId: 'omni', customModels: profiles.map(p => ({ id: p.modelId, model: p.modelId,
    provider: 'generic-chat-completion-api', baseUrl: baseUrl + 'v1' })),
    omniRouter: { version: 1, allowPaid: false, maxAttempts: 4, maxWaitMs: 0, requestTimeoutMs: 1000, profiles } };
}
export function fakeClock(): Clock & { waits: number[]; advance(ms: number): void } {
  let now = 1000000;
  const waits: number[] = [];
  return { now: () => now, random: () => 0, waits, advance: ms => { now += ms; },
    async sleep(ms, signal) { signal.throwIfAborted(); waits.push(ms); now += ms; } };
}
export async function temp(roots: string[], git = false) {
  const cwd = await mkdtemp(join(tmpdir(), 'fab-omni-integration-')); roots.push(cwd);
  if (git) {
    await writeFile(join(cwd, 'baseline'), 'fixture');
    for (const args of [['init', '-q'], ['add', '.'], ['commit', '-qm', 'fixture']]) {
      const result = Bun.spawnSync(['git', '-C', cwd, '-c', 'user.name=fixture', '-c', 'user.email=fixture@local', ...args]);
      if (result.exitCode) throw new Error(result.stderr.toString());
    }
  }
  return cwd;
}
export async function cli(cwd: string, config: ExecSettings, env: Record<string, string> = {}, extra: string[] = []) {
  const path = join(cwd, 'settings.json'); await writeFile(path, JSON.stringify(config));
  const child = Bun.spawn([process.execPath, '--no-env-file', entry, 'exec', 'usa la herramienta fixture', '--model', 'omni',
    '--settings', path, '--cwd', cwd, '-o', 'stream-json', ...extra],
    { env: { PATH: process.env.PATH ?? '', HOME: cwd, ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err, events: out.trim() ? out.trim().split('\n').map(line => JSON.parse(line)) : [] };
}
export function mcp(frame: any, onCall: () => void): Response {
  if (frame.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: frame.id,
    result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'omni-fixture', version: '1' } } });
  if (frame.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: frame.id,
    result: { tools: [{ name: 'fixture', inputSchema: { type: 'object', properties: {} } }] } });
  if (frame.method === 'tools/call') { onCall(); return Response.json({ jsonrpc: '2.0', id: frame.id,
    result: { content: [{ type: 'text', text: 'fixture read-only answer' }] } }); }
  return new Response(null, { status: 202 });
}
