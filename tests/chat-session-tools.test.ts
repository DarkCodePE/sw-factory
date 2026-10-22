import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatController, type ChatIO } from '../src/chat/controller.ts';
import type { AgentOptions, ModelProvider, ModelTurn, ToolCall } from '../src/agent/types.ts';
import { loadChatConfig } from '../src/chat/config.ts';

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
const call = (name: string, input: unknown): ToolCall => ({ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(input) } });
const turn = (...toolCalls: ToolCall[]): ModelTurn => ({ text: toolCalls.length ? '' : 'done', toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop' });
class IO implements ChatIO {
  output = ''; answers: string[] = []; fresh: boolean[] = []; prompts: string[] = [];
  write(s: string) { this.output += s; }
  async question(prompt: string, _?: AbortSignal, opts?: { fresh?: boolean }) { this.prompts.push(prompt); this.fresh.push(!!opts?.fresh); return this.answers.shift() ?? ''; }
  async select() { return undefined; }
}
async function fixture(turns: ModelTurn[], agent: ConstructorParameters<typeof ChatController>[0]['agent'] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fab-chat-staged-')); roots.push(root);
  const cwd = join(root, 'work'), home = join(root, 'home'); await mkdir(cwd);
  const io = new IO(), seen: string[] = [];
  const providerFor = (id: string): ModelProvider => ({ id, async complete() { seen.push(id); return turns.shift() ?? turn(); } });
  const app = new ChatController({ cwd, home, agent, providerFor,
    settings: { customModels: [{ id: 'other', model: 'other', provider: 'generic-chat-completion-api', baseUrl: 'http://localhost:1', apiKey: 'unused' }] },
    config: { model: 'configured', autonomy: 'high', mode: 'auto', networkPolicy: 'auto', theme: 'plain' } }, io);
  return { cwd, home, app, io, seen };
}

test('TUI stages for fresh review, applies atomically only to session, and never persists staged fields through unrelated preferences', async () => {
  const f = await fixture([turn(call('StageSettingsChanges', { modelId: 'other', autonomy: 'low', networkPolicy: 'deny' })), turn(), turn()]);
  f.io.answers = ['aplicar'];
  await f.app.submit('proponer cambios');
  expect(f.seen).toEqual(['configured', 'configured']);
  expect(f.app.config).toMatchObject({ model: 'other', autonomy: 'low', networkPolicy: 'deny' });
  expect(f.io.fresh).toEqual([true]); expect(f.io.output).toContain('solo a esta sesión');
  expect(await Bun.file(join(f.home, 'chat.json')).exists()).toBe(false);
  await f.app.submit('/themes color');
  expect(loadChatConfig({}, f.home)).toMatchObject({ model: 'configured', autonomy: 'high', networkPolicy: 'auto', theme: 'color' });
  await f.app.submit('siguiente tarea'); expect(f.seen.at(-1)).toBe('other');
  await f.app.submit('/model other'); // An explicit host/user choice may persist that field.
  expect(loadChatConfig({}, f.home)).toMatchObject({ model: 'other', autonomy: 'high', networkPolicy: 'auto' });
});

test('TUI discards unattended review, cancellation and side-agent proposals; invalid provider has no partial effect', async () => {
  const changes = { modelId: 'other', autonomy: 'off', networkPolicy: 'deny' };
  const f = await fixture([turn(call('StageSettingsChanges', changes)), turn()]);
  await f.app.submit('proponer'); expect(f.app.config.model).toBe('configured'); expect(f.app.config.autonomy).toBe('high');
  const g = await fixture([turn(call('StageSettingsChanges', changes)), turn()]);
  g.io.answers = ['a'];
  let n = 0;
  g.app.options.providerFor = id => {
    if (id === 'other') throw new Error('invalid provider');
    return { id, async complete() { return n++ ? turn() : turn(call('StageSettingsChanges', changes)); } };
  };
  await expect(g.app.submit('proponer')).rejects.toThrow('invalid provider');
  expect(g.app.config).toMatchObject({ model: 'configured', autonomy: 'high', networkPolicy: 'auto' });
  const h = await fixture([turn(call('StageSettingsChanges', { autonomy: 'off' })), turn()]);
  h.io.question = async () => { h.app.interrupt(); return 'a'; };
  await expect(h.app.submit('proponer')).rejects.toThrow('Interrumpido');
  expect(h.app.config.autonomy).toBe('high');
  const side = await fixture([turn(call('StageSettingsChanges', { autonomy: 'off' })), turn()]);
  side.io.answers = ['a']; await side.app.submit('/btw consulta');
  expect(side.io.prompts).toEqual([]); expect(side.app.config.autonomy).toBe('high');
});

test('switching session IDs restores staged overrides and rewind includes ApplyPatch diffs', async () => {
  const f = await fixture([turn(call('StageSettingsChanges', { modelId: 'other' })), turn(), turn()]);
  f.io.answers = ['a']; await f.app.submit('proponer');
  const first = f.app.sessionId!; expect(f.app.config.model).toBe('other');
  await f.app.submit('/fork'); expect(f.app.sessionId).not.toBe(first); expect(f.app.config.model).toBe('configured');
  await f.app.submit('/sessions ' + first); expect(f.app.config.model).toBe('configured');
  await f.app.submit('/new'); expect(f.app.config.model).toBe('configured');
  const path = join(f.cwd, 'file'); await writeFile(path, 'before\n');
  let n = 0;
  f.app.options.providerFor = id => ({ id, async complete() { return n++ ? turn() : turn(call('ApplyPatch', { patch: '*** Update File: ' + path + '\n@@\n-before\n+after\n' })); } });
  await f.app.submit('patch');
  expect(await readFile(path, 'utf8')).toBe('after\n'); expect(f.io.output).toContain('after');
  await f.app.submit('/rewind'); expect(await readFile(path, 'utf8')).toBe('before\n');
});

test('TUI ExitSpecMode confirms below high, updates mode and keeps scoped permissions across later submissions', async () => {
  const f = await fixture([turn(call('ExitSpecMode', {})), turn(), turn()], { permissionMode: 'yolo' });
  f.app.config.autonomy = 'off'; // Saved preference does not determine effective YOLO autonomy.
  f.app.setMode('spec'); await f.app.submit('salir');
  expect(f.io.prompts).toEqual([]); expect(f.app.config.mode).toBe('auto');
  expect(f.app.executionPolicy).toMatchObject({ permissionMode: 'standard', effectiveAutonomy: 'high', execution: 'sandbox' });
  expect(f.app.executionOptions().networkPolicy).toBe('deny'); expect(f.app.statusState.yoloSuspended).toBe(true);
  await f.app.submit('continuar'); expect(f.app.executionPolicy.permissionMode).toBe('standard');
  expect(f.app.executionPolicy.effectiveAutonomy).toBe('high');
  await f.app.submit('/themes color'); expect(loadChatConfig({}, f.home).autonomy).toBe('off');
  f.app.setMode('auto'); expect(f.app.executionPolicy.permissionMode).toBe('yolo');
  const low = await fixture([turn(call('ExitSpecMode', {})), turn()]);
  low.app.config.autonomy = 'low'; low.app.setMode('spec'); low.io.answers = ['s']; await low.app.submit('salir');
  expect(low.io.fresh).toEqual([true]); expect(low.app.config.mode).toBe('auto'); expect(low.app.executionPolicy.effectiveAutonomy).toBe('low');
});

test('btw scope cannot ExitSpecMode, including an attempted high override', async () => {
  const f = await fixture([turn(call('ExitSpecMode', {})), turn()]);
  f.app.setMode('spec'); await f.app.submit('/btw salir');
  expect(f.app.config.mode).toBe('spec'); expect(f.io.prompts).toEqual([]);
  const captured: AgentOptions[] = [];
  f.app.options.run = async options => { captured.push(options); return { ok: true, sessionId: 'test', text: 'done', turns: 1, toolCalls: 0, durationMs: 1, usage: { inputTokens: 0, outputTokens: 0 } }; };
  await f.app.submit('/btw captura'); expect(captured[0]!.allowExitSpecMode).toBe(false);
});

test('each proposal needs approval against the captured host ceiling, including a later increase after a decrease', async () => {
  const f = await fixture([turn(call('StageSettingsChanges', { autonomy: 'off' }), call('StageSettingsChanges', { autonomy: 'high' })), turn()]);
  f.io.answers = ['a', 'a']; await f.app.submit('dos propuestas');
  expect(f.io.fresh).toEqual([true, true]); expect(f.app.config.autonomy).toBe('high');
  const g = await fixture([turn(call('StageSettingsChanges', { autonomy: 'off' }), call('StageSettingsChanges', { autonomy: 'high' })), turn()]);
  g.io.answers = ['a', 'd']; await g.app.submit('descarta aumento');
  expect(g.app.config.autonomy).toBe('off');
});
