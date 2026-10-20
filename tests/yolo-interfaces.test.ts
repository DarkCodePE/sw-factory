import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecRpc, type RpcOptions } from '../src/agent/rpc.ts';
import { ChatController, type ChatIO } from '../src/chat/controller.ts';
import { loadChatConfig } from '../src/chat/config.ts';
import { modeLine } from '../src/chat/chrome.ts';
import type { AgentOptions, ModelTurn } from '../src/agent/types.ts';

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
const done: ModelTurn = { text: 'done', toolCalls: [], finishReason: 'stop' };
const call = (name: string, input: unknown): ModelTurn => ({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
const request = (method: string, params = {}) => ({ jsonrpc: '2.0', type: 'request', id: crypto.randomUUID(), method: 'droid.' + method, params });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'fab-yolo-ui-')); roots.push(root); const cwd = join(root, 'workspace'); await mkdir(cwd); return { cwd, home: join(root, 'home') }; }
async function until(fn: () => boolean) { const end = Date.now() + 3000; while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await Bun.sleep(2); } }
async function harness(turns: ModelTurn[] = [done]) {
  const { cwd, home } = await fixture(), frames: any[] = [];
  const opts: RpcOptions = { cwd, sessionDir: home, providers: { fixture: { id: 'fixture', complete: async () => turns.shift() ?? done } }, defaultModelId: 'fixture', agent: { permissionMode: 'yolo' } };
  const rpc = new ExecRpc(opts, f => frames.push(f));
  return { opts, rpc, frames, async send(method: string, params = {}) { const r = request(method, params); await rpc.accept(r); return frames.find(f => f.id === r.id); } };
}

test('RPC rejects forged authority atomically on init, update and load; YOLO default is high', async () => {
  const h = await harness();
  for (const field of ['permissionMode', 'yolo', 'sandbox', 'networkPolicy', 'executionPolicy', 'fab_execution_policy']) {
    const r = await h.send('initialize_session', { machineId: 'local', [field]: null }); expect(r.error.code).toBe(-32602);
  }
  const init = await h.send('initialize_session', { machineId: 'local' });
  expect(init.result.settings).toMatchObject({ autonomyLevel: 'high', fab_execution_policy: { permissionMode: 'yolo' } });
  for (const method of ['update_session_settings', 'load_session']) {
    for (const field of ['permissionMode', 'yolo', 'sandbox', 'networkPolicy', 'executionPolicy', 'fab_execution_policy']) {
      const before = h.frames.filter(f => f.params?.notification?.type === 'settings_updated').length;
      const r = await h.send(method, { sessionId: init.result.sessionId, interactionMode: 'spec', [field]: 'yolo' });
      expect(r.error.code).toBe(-32602);
      expect(h.frames.filter(f => f.params?.notification?.type === 'settings_updated').length).toBe(before);
    }
  }
  for (const autonomyLevel of ['off', 'low', 'medium']) expect((await h.send('update_session_settings', { autonomyLevel })).error.code).toBe(-32602);
  expect((await h.send('update_session_settings', { autonomyLevel: 'high' })).result).toEqual({});
  const list = await h.send('list_tools'); expect(list.result.tools.find((t: any) => t.llmId === 'Execute').description).toContain('host');
  await h.send('update_session_settings', { interactionMode: 'spec' });
  expect(h.frames.at(-2).params.notification.settings).toMatchObject({ networkPolicy: 'deny', fab_execution_policy: { permissionMode: 'standard' } });
  expect((await h.send('list_tools')).result.tools.find((t: any) => t.llmId === 'Execute').description).toContain('blocked by default');
  await h.send('update_session_settings', { interactionMode: 'auto' });
  expect(h.frames.at(-2).params.notification.settings.fab_execution_policy.permissionMode).toBe('yolo');
  await h.rpc.shutdown();
});

test('RPC YOLO executes writes and shell without permission; AskUser still waits; resume standard drops authority', async () => {
  const h = await harness([call('Create', { file_path: 'written', content: 'yes' }), call('Execute', { command: 'printf shell | tr a-z A-Z' }),
    call('AskUser', { questionnaire: '1. [question] Color?\n[topic] Color\n[option] red\n[option] blue' })]);
  const init = await h.send('initialize_session', { machineId: 'local' });
  await h.send('add_user_message', { text: 'write and ask' });
  await until(() => h.frames.some(f => f.method === 'droid.ask_user'));
  expect(h.frames.some(f => f.method === 'droid.request_permission')).toBe(false);
  expect(await Bun.file(join(h.opts.cwd, 'written')).text()).toBe('yes\n');
  const executeId = h.frames.find(f => f.params?.notification?.toolUse?.name === 'Execute').params.notification.toolUse.id;
  const execution = h.frames.find(f => f.params?.notification?.type === 'tool_result' && f.params.notification.toolUseId === executeId).params.notification;
  expect(execution.isError).toBe(false); expect(JSON.parse(execution.content)).toMatchObject({ stdout: 'SHELL', exitCode: 0, sandboxed: false });
  expect(h.frames.some(f => f.params?.notification?.type === 'agent_turn_completed')).toBe(false);
  const question = h.frames.find(f => f.method === 'droid.ask_user');
  await h.rpc.accept({ jsonrpc: '2.0', type: 'response', id: question.id, result: { answers: [{ index: 1, question: 'Color?', answer: 'red' }] } });
  await until(() => h.frames.some(f => f.params?.notification?.type === 'agent_turn_completed'));
  expect(h.frames.some(f => f.params?.notification?.type === 'fab_permission_bypass')).toBe(true);
  expect(h.frames.some(f => f.params?.notification?.type === 'fab_execution_policy')).toBe(true);
  await h.rpc.shutdown();
  const resumeTurns = [call('Create', { file_path: 'must-approve', content: 'no' }), done];
  const frames: any[] = [], standard = new ExecRpc({ ...h.opts, agent: {}, providers: { fixture: { id: 'fixture', complete: async () => resumeTurns.shift() ?? done } } }, f => frames.push(f));
  await standard.accept(request('load_session', { sessionId: init.result.sessionId }));
  expect(frames.at(-1).result.settings.fab_execution_policy.permissionMode).toBe('standard');
  await standard.accept(request('update_session_settings', { interactionMode: 'spec' }));
  await standard.accept(request('update_session_settings', { interactionMode: 'auto' }));
  expect(frames.at(-2).params.notification.settings.fab_execution_policy.permissionMode).toBe('standard');
  await standard.accept(request('add_user_message', { text: 'must ask' }));
  await until(() => frames.some(f => f.method === 'droid.request_permission'));
  const permission = frames.find(f => f.method === 'droid.request_permission');
  await standard.accept({ jsonrpc: '2.0', type: 'response', id: permission.id, result: { selectedOption: 'cancel' } });
  await until(() => frames.some(f => f.params?.notification?.type === 'agent_turn_completed'));
  expect(await Bun.file(join(h.opts.cwd, 'must-approve')).exists()).toBe(false); await standard.shutdown();
});

test('TUI shows YOLO, keeps preferences, rejects conflicting setters, downgrades spec/btw and preserves startup authority', async () => {
  const f = await fixture(), captured: AgentOptions[] = []; let output = '';
  const io: ChatIO = { write: s => { output += s; }, question: async () => '', select: async () => 0 };
  const app = new ChatController({ ...f, config: { model: 'fixture', mode: 'auto', autonomy: 'low', theme: 'plain' },
    agent: { permissionMode: 'yolo' }, providerFor: () => ({ id: 'fixture', complete: async () => done }),
    run: async opts => { captured.push(opts); return { ok: true, sessionId: 'unsaved', text: 'done', turns: 1, toolCalls: 0, durationMs: 1, usage: { inputTokens: 0, outputTokens: 0 } }; } }, io);
  expect(app.status()).toContain('YOLO · sin aprobaciones'); expect(app.permissionLabel).toBe('YOLO');
  expect(modeLine(app.statusState, 180)).toContain('red del equipo');
  for (const cmd of ['/auto low', '/auto', '/settings auto off', '/network deny', '/settings network ask', '/yolo on']) await expect(app.submit(cmd)).rejects.toThrow();
  await app.submit('/auto high'); await app.submit('/model fixture');
  const preferences = await Bun.file(join(f.home, 'chat.json')).text();
  await app.submit('/network auto'); expect(await Bun.file(join(f.home, 'chat.json')).text()).toBe(preferences);
  expect(app.config.autonomy).toBe('low'); expect(loadChatConfig({}, f.home).autonomy).toBe('low');
  expect(JSON.stringify(loadChatConfig({}, f.home))).not.toContain('yolo');
  await app.submit('auto'); expect(captured.at(-1)).toMatchObject({ permissionMode: 'yolo', autonomy: 'high' });
  await app.submit('/mode spec'); expect(app.status()).toContain('YOLO suspendido'); await app.submit('spec');
  expect(captured.at(-1)).toMatchObject({ permissionMode: 'standard', sandbox: 'required', networkPolicy: 'deny', interactionMode: 'spec' });
  await app.submit('/mode auto'); await app.submit('/btw question');
  expect(captured.at(-1)).toMatchObject({ permissionMode: 'standard', sandbox: 'required', networkPolicy: 'deny', autonomy: 'off' });
  await app.submit('/new'); await app.submit('auto again'); expect(captured.at(-1)?.permissionMode).toBe('yolo');
  await app.submit('/yolo'); expect(output).toContain('sin aprobaciones');
  const next = new ChatController({ ...f, providerFor: () => ({ id: 'fixture', complete: async () => done }) }, io);
  expect(next.executionPolicy.permissionMode).toBe('standard');
});
