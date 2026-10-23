import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecRpc } from '../src/agent/rpc.ts';
import type { ModelProvider, ModelTurn } from '../src/agent/types.ts';

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
const request = (id: string, method: string, params = {}) => ({ jsonrpc: '2.0', type: 'request', id, method: 'droid.' + method, params });
const call = (name: string, input: unknown): ModelTurn => ({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
const done = (): ModelTurn => ({ text: 'done', toolCalls: [], finishReason: 'stop' });
const command = (out: unknown) => `printf '%s' '${JSON.stringify(out).replaceAll("'", "'\\''")}'`;
async function fixture(provider: ModelProvider) {
  const cwd = await mkdtemp(join(tmpdir(), 'fab-rpc-hooks-')); roots.push(cwd); await mkdir(join(cwd, '.fab'));
  const frames: any[] = [], rpc = new ExecRpc({ cwd, sessionDir: join(cwd, 'sessions'), defaultModelId: 'fixture', providers: { fixture: provider } }, frame => frames.push(frame));
  const send = (id: string, method: string, params = {}) => rpc.accept(request(id, method, params));
  return { cwd, frames, rpc, send, async init(hooks = true) { await send('init', 'initialize_session', { machineId: 'test', modelId: 'fixture', autonomyLevel: 'high', hooks }); } };
}
async function until(check: () => boolean) { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw new Error('RPC hook test timed out'); await Bun.sleep(5); } }

test('RPC hooks run SessionStart, prompt, tool denial, Stop, and SessionEnd through one session lifecycle', async () => {
  let calls = 0;
  const h = await fixture({ id: 'fixture', async complete() { return ++calls === 1 ? call('Create', { file_path: 'denied', content: 'no' }) : done(); } });
  await writeFile(join(h.cwd, '.fab/hooks.json'), JSON.stringify({
    SessionStart: [{ hooks: [{ type: 'command', command: 'touch session-started' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'printf prompt-context' }] }],
    PreToolUse: [{ matcher: 'Create', hooks: [{ type: 'command', command: command({ hookSpecificOutput: { permissionDecision: 'deny' } }) }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'if [ ! -e stop-once ]; then touch stop-once; ' + command({ decision: 'block', reason: 'continue once' }) + '; fi' }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'touch session-ended' }] }],
  }));
  await h.init();
  expect(await Bun.file(join(h.cwd, 'session-started')).exists()).toBe(true);
  await h.send('m', 'add_user_message', { text: 'exercise hooks' });
  await until(() => h.frames.some(f => f.params?.notification?.type === 'agent_turn_completed'));
  expect(calls).toBe(3);
  expect(await Bun.file(join(h.cwd, 'denied')).exists()).toBe(false);
  expect(h.frames.filter(f => f.params?.notification?.type === 'hook_executed').map(f => f.params.notification.event)).toEqual(
    expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']));
  await h.send('close', 'close_session');
  expect(await Bun.file(join(h.cwd, 'session-ended')).exists()).toBe(true);
});

test('RPC hooks are opt-in and a blocked UserPromptSubmit prevents provider calls', async () => {
  let calls = 0;
  const h = await fixture({ id: 'fixture', async complete() { calls++; return done(); } });
  await writeFile(join(h.cwd, '.fab/hooks.json'), '{broken');
  await h.init(false);
  expect(h.frames.find(f => f.id === 'init').result.sessionId).toBeTruthy();
  await h.rpc.shutdown();
  const blocked = await fixture({ id: 'fixture', async complete() { calls++; return done(); } });
  await writeFile(join(blocked.cwd, '.fab/hooks.json'), JSON.stringify({ UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 2' }] }] }));
  await blocked.init(); await blocked.send('m', 'add_user_message', { text: 'must be blocked' });
  await until(() => blocked.frames.some(f => f.params?.notification?.type === 'agent_turn_completed'));
  expect(calls).toBe(0);
  await blocked.rpc.shutdown();
});
