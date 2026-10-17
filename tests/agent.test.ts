import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, symlink, link, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenAICompatibleProvider, ProviderError, runCodingAgent } from '../src/agent/index.ts';
import type { AgentOptions, AgentTool, Message, ModelProvider, ModelTurn, ToolCall } from '../src/agent/types.ts';
import { tool } from '../src/agent/tools.ts';

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
async function workspace() { const dir = await mkdtemp(join(tmpdir(), 'fab-agent-')); roots.push(dir); return dir; }
const call = (name: string, input: unknown, id = crypto.randomUUID()): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(input) } });
const turn = (text = '', toolCalls: ToolCall[] = [], finishReason = toolCalls.length ? 'tool_calls' : 'stop'): ModelTurn => ({ text, toolCalls, finishReason });
function model(responses: ModelTurn[]): ModelProvider & { requests: Message[][] } {
  const requests: Message[][] = [];
  return { id: 'test-model', requests, async complete(r) {
    requests.push(structuredClone(r.messages)); const next = responses.shift(); if (!next) throw new Error('Unexpected extra model call'); return next;
  } };
}

test('read -> edit -> final preserves tool correlation, state and edited bytes', async () => {
  const cwd = await workspace(); await writeFile(join(cwd, 'calc.py'), 'def add(a,b): return a - b\n');
  const read = call('Read', { file_path: join(cwd, 'calc.py') });
  const edit = call('Edit', { file_path: 'calc.py', old_str: 'a - b', new_str: 'a + b' });
  const provider = model([turn('', [read]), turn('', [edit]), turn('STATUS: done')]);
  const result = await runCodingAgent({ prompt: 'Fix addition', cwd, provider, autonomy: 'low', sessionDir: join(cwd, '.sessions') });
  expect(result).toMatchObject({ ok: true, turns: 3, toolCalls: 2, text: 'STATUS: done' });
  expect(await readFile(join(cwd, 'calc.py'), 'utf8')).toContain('a + b');
  expect(provider.requests[2]!.filter(m => m.role === 'tool').map(m => m.tool_call_id)).toEqual([read.id, edit.id]);
  const snapshot = JSON.parse(await readFile(join(cwd, '.sessions', result.sessionId + '.json'), 'utf8'));
  expect(snapshot.status).toBe('completed'); expect(snapshot.pending).toEqual([]);
});

test('tool errors remain in history and the model can recover', async () => {
  const cwd = await workspace();
  const provider = model([turn('', [call('Read', { file_path: 'relative' }), call('Missing', {})]), turn('STATUS: done')]);
  const result = await runCodingAgent({ prompt: 'inspect', cwd, provider });
  expect(result.ok).toBe(true);
  const errors = provider.requests[1]!.filter(m => m.role === 'tool').map(m => m.content as string);
  expect(errors[0]).toContain('absolute'); expect(errors[1]).toContain('Unknown tool');
});

test('writes require authority; spec mode prevents mutations even with high autonomy', async () => {
  for (const opts of [{ autonomy: 'off' }, { autonomy: 'high', interactionMode: 'spec' }] as const) {
    const cwd = await workspace(), provider = model([turn('', [call('Create', { file_path: 'out', content: 'unsafe' })]), turn('denied')]);
    expect((await runCodingAgent({ prompt: 'write', cwd, provider, ...opts })).ok).toBe(true);
    expect(provider.requests[1]!.find(m => m.role === 'tool')!.content as string).toMatch(/autonomy|Spec/);
    expect(await Bun.file(join(cwd, 'out')).exists()).toBe(false);
  }
});

test('path traversal and escaping symlinks are denied', async () => {
  const cwd = await workspace(), outside = await workspace();
  await symlink(outside, join(cwd, 'escape'));
  const provider = model([turn('', [call('Create', { file_path: '../outside', content: 'x' }), call('Create', { file_path: 'escape/pwn', content: 'x' })]), turn('denied')]);
  await runCodingAgent({ prompt: 'write', cwd, provider, autonomy: 'low' });
  const errors = provider.requests[1]!.filter(m => m.role === 'tool').map(m => m.content as string);
  expect(errors[0]).toContain('outside'); expect(errors[1]).toContain('Symlink');
});

test('read batches overlap and mutating calls form ordering barriers', async () => {
  const cwd = await workspace(), events: string[] = []; let running = 0, peak = 0;
  const readTool = tool('ProbeRead', 'read', {}, [], async () => { running++; peak = Math.max(peak, running); events.push('read-start'); await Bun.sleep(10); running--; events.push('read-end'); return 'ok'; }, 'fixture');
  const writeTool = tool('ProbeWrite', 'write', {}, [], async () => { expect(running).toBe(0); events.push('write'); return 'ok'; }, 'fixture');
  const provider = model([turn('', [call('ProbeRead', {}), call('ProbeRead', {}), call('ProbeWrite', {}), call('ProbeRead', {})]), turn('done')]);
  const result = await runCodingAgent({ prompt: 'schedule', cwd, provider, autonomy: 'low', tools: [readTool, writeTool] });
  expect(result.ok).toBe(true); expect(peak).toBe(2); expect(events.indexOf('write')).toBe(4);
});

test('truncation and empty answers have finite recovery budgets', async () => {
  const cwd = await workspace(), provider = model([turn('partial', [], 'length'), turn(''), turn('complete')]);
  expect((await runCodingAgent({ prompt: 'task', cwd, provider })).text).toBe('complete');
  expect(provider.requests[1]!.at(-1)?.role).toBe('user');
  const exhausted = model([turn('', [], 'length'), turn('', [], 'length')]);
  expect(await runCodingAgent({ prompt: 'task', cwd, provider: exhausted, maxRecoveryAttempts: 1 })).toMatchObject({ ok: false, error: { type: 'limit' } });
});

test('caller validates final reports and repairs them within a finite budget', async () => {
  const cwd = await workspace(), provider = model([turn('Work complete'), turn('STATUS: done\nVerified the change')]);
  const validateFinal = (text: string) => text.startsWith('STATUS:') ? undefined : 'Include the STATUS line';
  expect(await runCodingAgent({ prompt: 'report', cwd, provider, validateFinal })).toMatchObject({ ok: true, turns: 2, text: 'STATUS: done\nVerified the change' });
  expect(provider.requests[1]!.at(-1)!.content).toContain('Include the STATUS line');
  const failure = await runCodingAgent({ prompt: 'report', cwd, provider: model([turn('wrong'), turn('still wrong')]), validateFinal, maxRecoveryAttempts: 1 });
  expect(failure).toMatchObject({ ok: false, error: { type: 'limit', message: 'Final answer repair budget exhausted' } });
});

test('total timeout returns failure even if a provider ignores AbortSignal', async () => {
  const cwd = await workspace(), before = Date.now();
  const result = await runCodingAgent({ prompt: 'task', cwd, timeoutMs: 25, provider: { id: 'hanging', complete: async () => new Promise(() => {}) } });
  expect(result).toMatchObject({ ok: false, error: { type: 'timeout' } }); expect(Date.now() - before).toBeLessThan(1000);
});

test('resume extends history without replaying completed tools', async () => {
  const cwd = await workspace(), sessionDir = join(cwd, '.sessions');
  const provider = model([turn('', [call('Create', { file_path: 'once', content: 'x' })]), turn('first'), turn('second')]);
  const first = await runCodingAgent({ prompt: 'create', cwd, provider, autonomy: 'low', sessionDir });
  const next = await runCodingAgent({ prompt: 'continue', cwd, provider, autonomy: 'low', sessionDir, sessionId: first.sessionId });
  expect(next).toMatchObject({ ok: true, toolCalls: 0, text: 'second', sessionId: first.sessionId });
  expect(provider.requests.at(-1)!.at(-1)?.content).toBe('continue');
});

test('interrupted tool snapshots are refused instead of replayed', async () => {
  const cwd = await workspace(), sessionDir = join(cwd, '.sessions');
  const provider = model([turn('', [call('Hang', {})])]);
  const hang = tool('Hang', 'write', {}, [], async (_, c) => new Promise((_, reject) => c.signal.addEventListener('abort', () => reject(c.signal.reason), { once: true })), 'fixture');
  const first = await runCodingAgent({ prompt: 'start', cwd, provider, autonomy: 'low', sessionDir, timeoutMs: 40, tools: [hang] });
  const resumed = await runCodingAgent({ prompt: 'continue', cwd, provider, sessionDir, sessionId: first.sessionId });
  expect(resumed.ok).toBe(false); expect(resumed.error?.message).toMatch(/reconciliation|Unresolved/);
});

test('SSE splits UTF-8 and interleaved tool arguments without partial execution', async () => {
  const frames = [
    { choices: [{ index: 0, delta: { content: 'café ', tool_calls: [{ index: 0, id: 'one', type: 'function', function: { name: 'Read', arguments: '{"file_' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'two', type: 'function', function: { name: 'LS', arguments: '{}' } }, { index: 0, function: { arguments: 'path":"/tmp/a"}' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const bytes = new TextEncoder().encode(frames.map(f => 'data: ' + JSON.stringify(f) + '\r\n\r\n').join('') + 'data: [DONE]\n\n');
  const server = Bun.serve({ port: 0, fetch: () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } }) });
  try {
    const p = createOpenAICompatibleProvider({ model: 'fixture', baseUrl: server.url.href + 'v1' });
    const response = await p.complete({ messages: [], tools: [], maxOutputTokens: 100 }, new AbortController().signal);
    expect(response.text).toBe('café '); expect(response.toolCalls.map(c => c.id)).toEqual(['one', 'two']);
    expect(JSON.parse(response.toolCalls[0]!.function.arguments)).toEqual({ file_path: '/tmp/a' });
  } finally { server.stop(true); }
});

test('malformed and incomplete model streams are failures, not tool execution', async () => {
  for (const data of ['data: not-json\n\n', 'data: {"choices":[]}\n\n', 'data: [DONE]\n\n']) {
    const server = Bun.serve({ port: 0, fetch: () => new Response(data, { headers: { 'content-type': 'text/event-stream' } }) });
    try { const p = createOpenAICompatibleProvider({ model: 'fixture', baseUrl: server.url.href + 'v1' });
      await expect(p.complete({ messages: [], tools: [], maxOutputTokens: 100 }, new AbortController().signal)).rejects.toBeInstanceOf(ProviderError);
    } finally { server.stop(true); }
  }
});

test('unrelated HTTP 400 is not a context error and provider bodies stay private', async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response('{"error":{"message":"secret-key invalid model"}}', { status: 400 }) });
  try {
    const p = createOpenAICompatibleProvider({ model: 'fixture', baseUrl: server.url.href + 'v1' });
    const error = await p.complete({ messages: [], tools: [], maxOutputTokens: 100 }, new AbortController().signal).catch(e => e);
    expect(error.contextLimit).toBe(false); expect(error.message).toBe('Model HTTP 400');
  } finally { server.stop(true); }
});


test('Script nested writes use the shared gate and retain both edits', async () => {
  const cwd = await workspace(); await writeFile(join(cwd, 'file'), 'alpha beta');
  const provider = model([turn('', [call('Script', { code: 'await Promise.all([tools.Edit({file_path:"file",old_str:"alpha",new_str:"A"}),tools.Edit({file_path:"file",old_str:"beta",new_str:"B"})]); return "ok";' })]), turn('done')]);
  const result = await runCodingAgent({ prompt: 'edit', cwd, provider, autonomy: 'low' });
  expect(result.ok).toBe(true); expect(await readFile(join(cwd, 'file'), 'utf8')).toBe('A B');
});

test('Script failure cancels and drains unawaited host mutations', async () => {
  const cwd = await workspace(); let started = false, settled = false, mutated = false;
  const slow = tool('Slow', 'write', {}, [], async (_, c) => {
    started = true;
    await new Promise<void>(resolve => { const timer = setTimeout(() => { mutated = true; resolve(); }, 200);
      const cancel = () => { clearTimeout(timer); resolve(); }; c.signal.addEventListener('abort', cancel, { once: true }); if (c.signal.aborted) cancel(); });
    settled = true;
  }, 'fixture');
  const provider = model([turn('', [call('Script', { code: 'tools.Slow({}); await new Promise(r=>setTimeout(r,20)); throw new Error("stop");' })]), turn('complete')]);
  expect((await runCodingAgent({ prompt: 'cancel', cwd, provider, autonomy: 'low', tools: [slow] })).ok).toBe(true);
  expect(started).toBe(true); expect(settled).toBe(true); expect(mutated).toBe(false);
});

test('total abort keeps workspace ownership until a cooperative tool has settled', async () => {
  const cwd = await workspace(); let settled = false;
  const slow = tool('Slow', 'write', {}, [], async (_, c) => {
    await new Promise<void>(resolve => c.signal.addEventListener('abort', () => { setTimeout(() => { settled = true; resolve(); }, 30); }, { once: true }));
  }, 'fixture');
  const result = await runCodingAgent({ prompt: 'cancel', cwd, provider: model([turn('', [call('Slow', {})])]), autonomy: 'low', tools: [slow], timeoutMs: 50 });
  expect(result.error?.type).toBe('timeout'); expect(settled).toBe(true);
});

test('atomic editing never mutates an outside hardlink alias', async () => {
  const cwd = await workspace(), outside = await workspace();
  await writeFile(join(outside, 'alias'), 'old'); await link(join(outside, 'alias'), join(cwd, 'file'));
  const provider = model([turn('', [call('Edit', { file_path: 'file', old_str: 'old', new_str: 'new' })]), turn('done')]);
  expect((await runCodingAgent({ prompt: 'edit', cwd, provider, autonomy: 'low' })).ok).toBe(true);
  expect(await readFile(join(outside, 'alias'), 'utf8')).toBe('old'); expect(await readFile(join(cwd, 'file'), 'utf8')).toBe('new');
});

test('anchored writes survive replacement of the lexical parent by an escaping symlink', async () => {
  const { withWorkspaceFile, atomicReplace } = await import('../src/agent/files.ts');
  const cwd = await workspace(), outside = await workspace(); await mkdir(join(cwd, 'dir'));
  await withWorkspaceFile(cwd, 'dir/file', false, async (parent, name) => {
    await rename(join(cwd, 'dir'), join(cwd, 'original')); await symlink(outside, join(cwd, 'dir'));
    await atomicReplace(parent, name, 'safe', new AbortController().signal);
  });
  expect(await Bun.file(join(outside, 'file')).exists()).toBe(false);
  expect(await readFile(join(cwd, 'original/file'), 'utf8')).toBe('safe');
});

test('read autonomy cannot write via git diff output flags', async () => {
  const cwd = await workspace();
  const provider = model([turn('', [call('Execute', { command: 'git diff --output=escaped' })]), turn('denied')]);
  await runCodingAgent({ prompt: 'inspect', cwd, provider, autonomy: 'off' });
  expect(provider.requests[1]!.find(m=>m.role==='tool')!.content as string).toContain('autonomy');
  expect(await Bun.file(join(cwd, 'escaped')).exists()).toBe(false);
});

test('compaction covers every fragment and retains early user clarification verbatim', async () => {
  const cwd = await workspace(), sessionDir = join(cwd, '.sessions');
  const first = await runCodingAgent({ prompt: 'start', cwd, sessionDir, provider: model([turn('initial')]) });
  const path = join(sessionDir, first.sessionId + '.json'), snapshot = JSON.parse(await readFile(path, 'utf8'));
  const marker = 'Keep the database schema unchanged';
  snapshot.messages.push({role:'user',content:marker},{role:'assistant',content:'BEGIN-EVIDENCE ' + 'x'.repeat(60_000) + ' END-EVIDENCE'},
    {role:'user',content:'recent instruction'},{role:'assistant',content:'recent response'});
  await writeFile(path, JSON.stringify(snapshot));
  const fragments: string[] = []; let final: Message[] = [];
  const provider: ModelProvider = { id:'test-model', async complete(request) {
    if (!request.tools.length) { fragments.push(request.messages[1]!.content as string); return turn('Preserved history fragment'); }
    final = request.messages; return turn('done');
  } };
  const result = await runCodingAgent({ prompt:'finish', cwd, provider, sessionDir, sessionId:first.sessionId, maxContextTokens:10_000, maxOutputTokens:1024 });
  expect(result.ok).toBe(true); expect(fragments.length).toBeGreaterThan(2);
  expect(fragments.join('')).toContain('BEGIN-EVIDENCE'); expect(fragments.join('')).toContain('END-EVIDENCE');
  expect(final.some(m=>m.content===marker)).toBe(true);
});

test('medium Execute accepts cd to the current workspace before tests without granting an outside cwd', async () => {
  const cwd = await workspace(), outside = await workspace();
  await writeFile(join(cwd,'sample.test.ts'), "import {test,expect} from 'bun:test'; test('fixture',()=>expect(2+3).toBe(5));");
  const provider = model([turn('',[call('Execute',{command:`cd "${cwd}" && bun test`}),call('Execute',{command:`cd "${outside}" && bun test`})]),turn('done')]);
  expect((await runCodingAgent({prompt:'run tests',cwd,provider,autonomy:'medium'})).ok).toBe(true);
  const results = provider.requests[1]!.filter(m=>m.role==='tool');
  expect(JSON.parse(results[0]!.content as string).exitCode).toBe(0);
  expect(results[1]!.content).toContain('autonomy');
});

test('read-only Git inserts helper restrictions before revision and path operands', async () => {
  const cwd = await workspace();
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd });
    if (r.exitCode) throw new Error(r.stderr.toString());
  };
  git('init', '-q'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@local');
  await writeFile(join(cwd, 'calc.ts'), 'before\n'); git('add', '.'); git('commit', '-qm', 'fixture baseline');
  await writeFile(join(cwd, 'calc.ts'), 'after\n');
  const provider = model([turn('', [call('Execute', { command: 'git status --short && git diff calc.ts' }),
    call('Execute', { command: 'git log HEAD -- calc.ts' }), call('Execute', { command: 'git show HEAD:calc.ts' })]), turn('done')]);
  expect((await runCodingAgent({ prompt: 'inspect', cwd, provider, autonomy: 'off' })).ok).toBe(true);
  const results = provider.requests[1]!.filter(m => m.role === 'tool').map(m => JSON.parse(m.content as string));
  expect(results.map(r => r.exitCode)).toEqual([0, 0, 0]);
  expect(results[0].stdout).toContain('+after'); expect(results[2].stdout).toBe('before\n');
});

test('medium sequences are admitted as a whole and stop after the first failed command', async () => {
  const cwd = await workspace();
  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd });
  git('init', '-q'); await writeFile(join(cwd, 'calc.ts'), 'fixture\n');
  await writeFile(join(cwd, 'fails.test.ts'), "import {test,expect} from 'bun:test'; test('failure',()=>expect(false).toBe(true));");
  const provider = model([turn('', [call('Execute', { command: 'git add calc.ts && curl https://example.invalid' }),
    call('Execute', { command: 'bun test fails.test.ts && git add calc.ts' })]), turn('done')]);
  expect((await runCodingAgent({ prompt: 'verify sequence policies', cwd, provider, autonomy: 'medium' })).ok).toBe(true);
  const results = provider.requests[1]!.filter(m => m.role === 'tool');
  expect(results[0]!.content).toContain('simple commands');
  expect(JSON.parse(results[1]!.content as string).exitCode).toBe(1);
  expect(git('diff', '--cached', '--name-only').stdout.toString()).toBe('');
});
