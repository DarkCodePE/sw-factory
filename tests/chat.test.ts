import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { ChatController, type ChatIO } from '../src/chat/controller.ts';
import { commandFor, completions, parseInput } from '../src/chat/commands.ts';
import { loadChatConfig } from '../src/chat/config.ts';
import { listSessions } from '../src/chat/sessions.ts';
import { TerminalInput } from '../src/chat/terminal.ts';
import { SessionStore } from '../src/agent/session.ts';
import type { AgentOptions, AgentResult, ModelProvider, ModelTurn } from '../src/agent/types.ts';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
class IO implements ChatIO {
  output = ''; answers: string[] = []; selection?: number;
  write(s: string) { this.output += s; }
  async question(_prompt: string, signal?: AbortSignal) { signal?.throwIfAborted(); return this.answers.shift() ?? ''; }
  async select(_prompt: string, _choices: string[], signal?: AbortSignal) { signal?.throwIfAborted(); return this.selection; }
}
const final = (text = 'Listo'): ModelTurn => ({ text, toolCalls: [], finishReason: 'stop' });
const call = (id: string, name: string, input: unknown): ModelTurn => ({ text: '', finishReason: 'tool_calls', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
async function fixture(turns: ModelTurn[] = [final()]) {
  const dir = await mkdtemp(join(tmpdir(), 'fab-chat-test-')); dirs.push(dir);
  const cwd = join(dir, 'workspace'), home = join(dir, 'home'); await mkdir(cwd);
  const requests: any[] = [];
  const provider: ModelProvider = { id: 'offline', async complete(request) { requests.push(structuredClone(request)); return turns.shift() ?? final(); } };
  const io = new IO();
  const app = new ChatController({ cwd, home, providerFor: () => provider,
    config: { model: 'fixture', autonomy: 'off', mode: 'auto', theme: 'plain' } }, io);
  return { dir, cwd, home, requests, io, app, provider };
}

test('command registry exposes local capabilities, aliases and explicit backend gaps', () => {
  expect(parseInput('/')).toEqual({ kind: 'command', name: 'help', arg: '' });
  expect(parseInput('/rename  título con espacios')).toEqual({ kind: 'command', name: 'rename', arg: 'título con espacios' });
  expect(commandFor('resume')?.name).toBe('sessions'); expect(commandFor('compact')?.name).toBe('compress');
  expect(completions('/res')[0]).toContain('/resume'); expect(completions('/model c', ['custom:local'])[0]).toEqual(['/model custom:local']);
  expect(commandFor('share')?.unavailable).toBeTruthy();
});

test('invalid saved preferences recover and settings select the configured model', async () => {
  const f = await fixture(); await mkdir(f.home);
  await writeFile(join(f.home, 'chat.json'), 'null');
  const previous = process.env.FABRICA_LLM_MODEL; delete process.env.FABRICA_LLM_MODEL;
  try {
    expect(loadChatConfig({ modelId: 'custom:local' }, f.home)).toMatchObject({ model: 'custom:local', autonomy: 'off' });
    await writeFile(join(f.home, 'chat.json'), JSON.stringify({ model: 'custom:old-profile' }));
    expect(loadChatConfig({ modelId: 'custom:local' }, f.home).model).toBe('custom:local');
  }
  finally { if (previous === undefined) delete process.env.FABRICA_LLM_MODEL; else process.env.FABRICA_LLM_MODEL = previous; }
});

test('session UI resumes, renames, pins, forks and archives actual snapshots without replay', async () => {
  const f = await fixture();
  await f.app.submit('primera'); const original = f.app.sessionId!;
  expect(original).toBeTruthy(); expect(f.io.output).toContain('Listo');
  await f.app.submit('/rename Arreglo de cálculo'); await f.app.submit('/pin');
  await f.app.submit('/fork'); const fork = f.app.sessionId!; expect(fork).not.toBe(original);
  const store = await SessionStore.create(f.app.sessionDir);
  expect(await store.load(fork)).toMatchObject({ parentSessionId: original, pinned: false, archived: false });
  await f.app.submit('segunda'); expect(f.requests.at(-1).messages.some((m: any) => m.content === 'primera')).toBe(true);
  await f.app.submit('/archive'); expect(f.app.sessionId).toBeUndefined();
  expect((await listSessions(f.app.sessionDir, f.cwd)).sessions.map(s => s.id)).toEqual([original]);
  await f.app.submit('/search segunda'); expect(f.io.output).toContain('[archivada]');
  await f.app.submit('/resume ' + fork); expect(f.app.sessionId).toBe(fork);
  const other = join(f.dir, 'other'); await mkdir(other);
  await f.app.submit('/cd ' + other); expect(f.app.cwd).toBe(other); expect(f.app.sessionId).toBeUndefined();
  await expect(f.app.submit('/resume ' + original)).rejects.toThrow('otra carpeta');
});

test('mode changes preserve explicit mission authority and spec denies writes', async () => {
  const f = await fixture([call('write', 'Create', { file_path: 'no.txt', content: 'denied' }), final()]);
  await expect(f.app.submit('/mode mission')).rejects.toThrow('high');
  await f.app.submit('/mode spec'); await f.app.submit('revisar');
  expect(await Bun.file(join(f.cwd, 'no.txt')).exists()).toBe(false);
  expect(f.requests.at(-1).messages.some((m: any) => m.role === 'tool' && m.content.includes('Spec mode denies'))).toBe(true);
  await f.app.submit('/auto high'); await f.app.submit('/mode mission'); expect(f.app.config.mode).toBe('mission');
  await f.app.submit('/auto low'); expect(f.app.config.mode).toBe('auto');
});

test('interactive approval is once per call; the next denial leaves its file absent', async () => {
  const f = await fixture([call('a', 'Create', { file_path: 'a.txt', content: 'a' }), call('b', 'Create', { file_path: 'b.txt', content: 'b' }), final()]);
  f.io.answers = ['s', 'n']; await f.app.submit('dos cambios');
  expect(await Bun.file(join(f.cwd, 'a.txt')).text()).toBe('a\n');
  expect(await Bun.file(join(f.cwd, 'b.txt')).exists()).toBe(false);
  expect(f.app.config.autonomy).toBe('off'); expect(f.io.output).toContain('file_path');
});

test('AskUser returns real selected answers to the model', async () => {
  const f = await fixture([call('q', 'AskUser', { questionnaire: '1. [question] ¿Qué color?\n[topic] Color\n[option] Azul\n[option] Verde' }), final()]);
  f.io.answers = ['2']; await f.app.submit('pregunta');
  expect(f.requests.at(-1).messages.some((m: any) => m.role === 'tool' && m.content.includes('Verde'))).toBe(true);
});

test('MCP config and filters reach AgentOptions without revealing keys in settings', async () => {
  const f = await fixture(); let captured!: AgentOptions;
  const result: AgentResult = { ok: true, text: 'ok', sessionId: 'not-persisted', turns: 1, toolCalls: 0, durationMs: 1, usage: { inputTokens: 0, outputTokens: 0 } };
  const app = new ChatController({ cwd: f.cwd, home: f.home, providerFor: () => f.provider,
    settings: { mcpServers: { local: { command: 'unused', env: { KEY: 'synthetic-secret' } } } },
    config: { ...f.app.config }, run: async opts => { captured = opts; return result; } }, f.io);
  await app.submit('first'); expect(Object.keys(captured.mcpServers!)).toEqual(['local']);
  expect(captured.askUserHandler).toBeFunction(); expect(captured.permissionHandler).toBeFunction();
  await app.submit('/mcp disable local'); await app.submit('second'); expect(captured.mcpServers).toEqual({});
  await app.submit('/settings'); expect(f.io.output).not.toContain('synthetic-secret');
});

test('network settings persist policy without grants and the TUI displays the real scope before approval', async () => {
  const f = await fixture([call('net', 'Execute', { command: 'pwd', network: true }), final()]);
  await f.app.submit('/network ask'); expect(f.app.config.networkPolicy).toBe('ask');
  expect(loadChatConfig({}, f.home).networkPolicy).toBe('ask');
  f.io.answers = ['s']; await f.app.submit('command with network');
  expect(f.io.output).toContain('Acceso de red del equipo');
  expect(f.io.output).toContain('No se limita la conexión a un dominio concreto');
  expect(f.io.output).toContain(f.cwd); expect(f.io.output).toContain('sin autorización permanente');
  const saved = JSON.parse(await readFile(join(f.home, 'chat.json'), 'utf8'));
  expect(saved.networkPolicy).toBe('ask'); expect(saved.networkAccess).toBeUndefined();
  await f.app.submit('/settings network deny'); expect(f.app.config.networkPolicy).toBe('deny');
  expect(completions('/network a')[0]).toEqual(['/network auto', '/network ask']);
  await expect(f.app.submit('/network allow')).rejects.toThrow('Network policy');
  await writeFile(join(f.home, 'chat.json'), JSON.stringify({ networkPolicy: 'invalid' }));
  expect(loadChatConfig({}, f.home).networkPolicy).toBe('deny');
  expect(loadChatConfig({ sandboxNetwork: 'ask' }, f.home).networkPolicy).toBe('ask');
});

test('TUI network auto at high is visible and does not ask for confirmation', async () => {
  const f = await fixture([call('net-auto', 'Execute', { command: 'pwd', network: true }), final()]);
  f.app.config.autonomy = 'high';
  f.io.question = async () => { throw new Error('Automatic high network must not prompt'); };
  await f.app.submit('command with network');
  expect(f.io.output).toContain('Red autorizada automáticamente');
  expect(f.requests.at(-1).messages.some((m: any) => m.role === 'tool' && JSON.parse(m.content).network.enabled === true)).toBe(true);
});

test('Ctrl+C during approval conserves blocked snapshot but next prompt gets a new session', async () => {
  const f = await fixture([call('a', 'Create', { file_path: 'never.txt', content: 'no' }), final()]);
  let started!: () => void; const waiting = new Promise<void>(resolve => { started = resolve; });
  f.io.question = (_prompt, signal) => new Promise((_resolve, reject) => { started(); signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
  const first = f.app.submit('write'); await waiting; f.app.interrupt(); await first;
  expect(f.app.sessionId).toBeUndefined(); expect(await Bun.file(join(f.cwd, 'never.txt')).exists()).toBe(false);
  const blocked = (await listSessions(f.app.sessionDir, f.cwd)).sessions[0]!; expect(blocked.blocked).toBe(true);
  await expect(f.app.submit('/resume ' + blocked.id)).rejects.toThrow('reconciliation');
  await f.app.submit('continue safely'); expect(f.app.sessionId).toBeTruthy(); expect(f.app.sessionId).not.toBe(blocked.id);
});

test('btw is readonly and does not change the main session or its bytes', async () => {
  const f = await fixture(); await f.app.submit('main'); const id = f.app.sessionId!;
  const file = join(f.app.sessionDir, id + '.json'), before = await readFile(file, 'utf8');
  await f.app.submit('/btw side question'); expect(f.app.sessionId).toBe(id);
  expect(await readFile(file, 'utf8')).toBe(before);
  expect(f.requests.at(-1).messages.some((m: any) => typeof m.content === 'string' && m.content.includes('Mode: spec; autonomy: off'))).toBe(true);
});

test('compression and handoff summarize every fragment, retain requirements and preserve original fork', async () => {
  const f = await fixture([final('Large completed evidence '.repeat(1500)), final('Resumen útil'), final('Resumen de relevo')]);
  await f.app.submit('mantener requisito literal'); const original = f.app.sessionId!;
  await f.app.submit('/compress');
  const store = await SessionStore.create(f.app.sessionDir), state = await store.load(original);
  expect(state.messages.some(m => m.content === 'mantener requisito literal')).toBe(true);
  expect(state.messages.some(m => m.contextKind === 'summary')).toBe(true);
  expect(f.requests.filter(r => r.tools.length === 0).map(r => r.messages[1].content).join('')).toContain('Large completed evidence');
  // Grow again, so a shorter second summary is meaningful.
  f.provider.complete = async () => final('x'.repeat(10000)); await f.app.submit('más evidencia');
  const before = await readFile(join(f.app.sessionDir, original + '.json'), 'utf8');
  f.provider.complete = async () => final('Relevo'); await f.app.submit('/handoff');
  expect(f.app.sessionId).not.toBe(original); expect(await readFile(join(f.app.sessionDir, original + '.json'), 'utf8')).toBe(before);
});

test('custom prompts use workspace files and preserve arguments; services never become model prompts', async () => {
  const f = await fixture(); await mkdir(join(f.cwd, '.agents', 'commands'), { recursive: true });
  await writeFile(join(f.cwd, '.agents', 'commands', 'review.md'), 'Revisar $ARGUMENTS'); await f.app.refreshCommands();
  await f.app.submit('/review src/main.ts'); expect(f.requests[0].messages.at(-1).content).toBe('Revisar src/main.ts');
  const count = f.requests.length; await f.app.submit('/share'); expect(f.requests).toHaveLength(count); expect(f.io.output).toContain('no lo implementa');
});

test('terminal cancels an old question and keeps queued lines for distinct prompts', async () => {
  const input = new PassThrough(), output = new PassThrough(); input.pause();
  const terminal = new TerminalInput(input, output, false);
  try {
    const controller = new AbortController(), first = terminal.question('permission', controller.signal);
    const rejected = first.catch(e => e as Error); controller.abort();
    expect((await rejected as Error).message).toContain('cancelada');
    const next = terminal.question('next'); input.write('new prompt\n'); expect(await next).toBe('new prompt');
    input.write('/status\n/exit\n'); input.end(); await Bun.sleep(5);
    expect(await terminal.question('a')).toBe('/status'); expect(await terminal.question('b')).toBe('/exit');
    await expect(terminal.question('closed')).rejects.toThrow('cerrada');
  } finally { terminal.close(); output.destroy(); }
});

test('terminal shortcuts preserve the next command and parse split Shift+Tab without inserting a slash', async () => {
  const f = await fixture(), input = new PassThrough(), output = new PassThrough();
  let transcript = ''; output.on('data', chunk => { transcript += chunk.toString(); });
  const terminal = new TerminalInput(input, output, true); terminal.controller = f.app;
  try {
    const next = terminal.question('fab [auto/off] › ');
    input.write('\x1b'); input.write('[Z'); await Bun.sleep(5);
    expect(f.app.config.mode).toBe('spec');
    expect(transcript).toContain('fab [spec/off]');
    input.write('/status\r'); expect(await next).toBe('/status');
    const root = terminal.question('fab [spec/off] › '); input.write('\x0c'); await Bun.sleep(5);
    expect(f.app.config.autonomy).toBe('low');
    expect(transcript).toContain('fab [spec/low]');
    input.write('/exit\r'); expect(await root).toBe('/exit');
    input.write('\x1b'); input.end(); await Bun.sleep(60);
    await expect(terminal.question('closed')).rejects.toThrow('cerrada');
  } finally { terminal.close(); input.destroy(); output.destroy(); }
});
