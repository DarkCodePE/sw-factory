import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecRpc, serveExecRpc } from '../src/agent/rpc.ts';
import type { ModelProvider, ModelTurn } from '../src/agent/types.ts';

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
const request = (id: string, method: string, params = {}) => ({ jsonrpc: '2.0', type: 'request', factoryApiVersion: '1.0.0', id, method: 'droid.' + method, params });
const done = (text: string): ModelTurn => ({ text, toolCalls: [], finishReason: 'stop' });
async function harness(provider: ModelProvider) {
  const cwd = await mkdtemp(join(tmpdir(), 'fab-rpc-')); roots.push(cwd);
  const frames: any[] = [];
  const opts = { cwd, sessionDir: join(cwd, '.sessions'), providers: { fixture: provider }, defaultModelId: 'fixture' };
  const rpc = new ExecRpc(opts, frame => frames.push(frame));
  return { cwd, frames, opts, rpc, async init() { await rpc.accept(request('init', 'initialize_session', { machineId: 'local', modelId: 'fixture', autonomyLevel: 'low' })); } };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) throw new Error('RPC wait timeout'); await Bun.sleep(2); }
}

test('RPC envelope, ack, deltas, correlated tool results, resume and close', async () => {
  let turn = 0;
  const h = await harness({ id: 'fixture', async complete(_, __, delta) {
    turn++;
    if (turn === 1) return { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'edit-1', type: 'function',
      function: { name: 'Edit', arguments: JSON.stringify({ file_path: 'file', old_str: 'before', new_str: 'after' }) } }] };
    delta?.('complete'); return done('complete');
  } });
  await writeFile(join(h.cwd, 'file'), 'before'); await h.init();
  expect(h.frames.find(f => f.id === 'init')).toMatchObject({ type: 'response', factoryApiVersion: '1.0.0', result: { settings: { autonomyMode: 'auto-low' } } });
  await h.rpc.accept(request('message', 'add_user_message', { text: 'edit' }));
  await until(() => h.frames.some(f => f.params?.notification?.type === 'agent_turn_completed'));
  const ack = h.frames.findIndex(f => f.id === 'message'), end = h.frames.findIndex(f => f.params?.notification?.type === 'agent_turn_completed');
  expect(ack).toBeLessThan(end);
  expect(h.frames.some(f => f.params?.notification?.type === 'assistant_text_delta')).toBe(true);
  expect(h.frames.find(f => f.params?.notification?.type === 'tool_call').params.notification.toolUse).toMatchObject({ id: 'edit-1', name: 'Edit' });
  expect(h.frames.find(f => f.params?.notification?.type === 'tool_result').params.notification).toMatchObject({ toolUseId: 'edit-1', isError: false });
  expect(await readFile(join(h.cwd, 'file'), 'utf8')).toBe('after');
  const id = h.frames.find(f => f.id === 'init').result.sessionId;
  await h.rpc.accept(request('close', 'close_session')); expect(h.rpc.closed).toBe(true);
  const second = new ExecRpc(h.opts, frame => h.frames.push(frame));
  await second.accept(request('load', 'load_session', { sessionId: id }));
  expect(h.frames.find(f => f.id === 'load').result.session.messages.length).toBeGreaterThan(2);
  await second.accept(request('followup', 'add_user_message', { text: 'continue' }));
  await until(() => h.frames.filter(f => f.params?.notification?.type === 'agent_turn_completed').length === 2);
  expect(turn).toBe(3); await second.shutdown();
});

test('busy RPC refuses overlap and interrupt cancels the active provider', async () => {
  let started = false, aborted = false;
  const h = await harness({ id: 'fixture', async complete(_, signal) {
    started = true;
    return new Promise((_, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }); });
  } });
  await h.init(); await h.rpc.accept(request('m', 'add_user_message', { text: 'wait' })); await until(() => started);
  await h.rpc.accept(request('overlap', 'add_user_message', { text: 'overlap' }));
  expect(h.frames.find(f => f.id === 'overlap').error.message).toContain('busy');
  await h.rpc.accept(request('interrupt', 'interrupt_session'));
  expect(aborted).toBe(true); expect(h.frames.find(f => f.id === 'interrupt').result).toEqual({});
  expect(h.frames.find(f => f.params?.notification?.type === 'agent_turn_completed').params.notification.reason).toBe('interrupted');
  await h.rpc.shutdown();
});

test('invalid requests, duplicate IDs and unsupported methods fail explicitly', async () => {
  const h = await harness({ id: 'fixture', complete: async () => done('done') });
  await h.rpc.accept({ ...request('n', 'list_models'), id: 1 });
  expect(h.frames.at(-1)).toMatchObject({ id: null, error: { code: -32700 } });
  await h.rpc.accept(request('bad-init', 'initialize_session'));
  expect(h.frames.at(-1).error.message).toContain('machineId');
  await h.rpc.accept(request('unknown', 'not_implemented')); expect(h.frames.at(-1).error.code).toBe(-32601);
  await h.rpc.accept(request('unknown', 'list_models')); expect(h.frames.at(-1).error.code).toBe(-32600);
  await h.rpc.shutdown();
});

test('settings updates are notified before ack and restrictive tool IDs apply', async () => {
  let n = 0;
  const h = await harness({ id: 'fixture', async complete() {
    return n++ === 0 ? { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'denied', type: 'function', function: { name: 'Create', arguments: '{"file_path":"no","content":"no"}' } }] } : done('done');
  } });
  await h.init(); await h.rpc.accept(request('settings', 'update_session_settings', { restrictToolIds: ['read-cli'], interactionMode: 'spec' }));
  expect(h.frames.at(-1)).toMatchObject({ id: 'settings', result: {} });
  expect(h.frames.at(-2).params.notification).toMatchObject({ type: 'settings_updated', settings: { autonomyMode: 'spec' } });
  await h.rpc.accept(request('m', 'add_user_message', { text: 'inspect' }));
  await until(() => h.frames.some(f => f.params?.notification?.type === 'agent_turn_completed'));
  const result = h.frames.find(f => f.params?.notification?.type === 'tool_result').params.notification;
  expect(result.isError).toBe(true); expect(result.content).toContain('disabled');
  expect(await Bun.file(join(h.cwd, 'no')).exists()).toBe(false); await h.rpc.shutdown();
});

test('NDJSON handles split UTF-8, parse errors, and clean close', async () => {
  const h = await harness({ id: 'fixture', complete: async () => done('done') });
  const output: any[] = [], bytes = new TextEncoder().encode('bad-json\n' + JSON.stringify(request('é', 'list_models')) + '\n' + JSON.stringify(request('close', 'close_session')) + '\n');
  async function* input() { for (const b of bytes) yield Uint8Array.of(b); }
  await serveExecRpc(input(), line => output.push(JSON.parse(line)), h.opts);
  expect(output[0]).toMatchObject({ id: null, error: { code: -32700 } });
  expect(output[1].id).toBe('é'); expect(output[2]).toMatchObject({ id: 'close', result: {} });
});

test('bidirectional permissions grant one call and cancellation denies the next', async () => {
  let n = 0;
  const h = await harness({ id: 'fixture', async complete() {
    if (n >= 2) return done('complete');
    const name = ++n === 1 ? 'allowed' : 'denied';
    return { text: '', finishReason: 'tool_calls', toolCalls: [{ id: name, type: 'function', function: { name: 'Create', arguments: JSON.stringify({ file_path: name, content: name }) } }] };
  } });
  await h.init(); await h.rpc.accept(request('off', 'update_session_settings', { autonomyLevel: 'off' }));
  await h.rpc.accept(request('m', 'add_user_message', { text: 'write with approval' }));
  for (const selectedOption of ['proceed_once', 'cancel']) {
    await until(() => h.frames.some(f => f.type === 'request' && f.method === 'droid.request_permission' && !f.answered));
    const req = h.frames.find(f => f.type === 'request' && !f.answered); req.answered = true;
    expect(req.params.toolUses[0].confirmationType).toBe('create');
    await h.rpc.accept({ jsonrpc: '2.0', type: 'response', id: req.id, result: { selectedOption } });
  }
  await until(() => h.frames.some(f => f.params?.notification?.type === 'agent_turn_completed'));
  expect(await Bun.file(join(h.cwd, 'allowed')).text()).toBe('allowed\n');
  expect(await Bun.file(join(h.cwd, 'denied')).exists()).toBe(false); await h.rpc.shutdown();
});

test('AskUser uses the observed questionnaire and response protocol', async () => {
  let n = 0;
  const h = await harness({ id: 'fixture', async complete(request) {
    if (!n++) return { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'question', type: 'function', function: { name: 'AskUser', arguments: JSON.stringify({ questionnaire: '1. [question] Color?\n[topic] Color\n[option] red\n[option] blue' }) } }] };
    expect(request.messages.at(-1)!.content).toBe('1. [question] Color?\n[answer] red');
    return done('red');
  } });
  await h.init(); await h.rpc.accept(request('m', 'add_user_message', { text: 'ask' }));
  await until(() => h.frames.some(f => f.method === 'droid.ask_user'));
  const req = h.frames.find(f => f.method === 'droid.ask_user');
  expect(req.params.toolCallId).toBe('question'); expect(req.params.questions[0].index).toBe(1);
  await h.rpc.accept({ jsonrpc: '2.0', type: 'response', id: req.id, result: { answers: [{ index: 1, question: 'Color?', answer: 'red' }] } });
  await until(() => h.frames.some(f => f.params?.notification?.type === 'agent_turn_completed')); await h.rpc.shutdown();
});

test('malformed tool arguments remain a recoverable RPC result', async () => {
  let n = 0;
  const h = await harness({ id: 'fixture', async complete(request) {
    if (!n++) return { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'bad', type: 'function', function: { name: 'Read', arguments: '{' } }] };
    expect(request.messages.at(-1)!.content).toContain('Error:'); return done('recovered');
  } });
  await h.init(); await h.rpc.accept(request('m', 'add_user_message', { text: 'recover' }));
  await until(() => h.frames.some(f => f.params?.notification?.type === 'agent_turn_completed'));
  expect(h.frames.find(f => f.params?.notification?.type === 'tool_result').params.notification.isError).toBe(true);
  expect(h.frames.find(f => f.params?.notification?.type === 'agent_turn_completed').params.notification.reason).toBe('completed');
  await h.rpc.shutdown();
});
