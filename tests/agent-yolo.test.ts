import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodingAgent } from '../src/agent/engine.ts';
import { resolveExecutionPolicy, scopedExecutionOptions } from '../src/agent/execution-policy.ts';
import { executeHost } from '../src/agent/execute-host.ts';
import type { AgentEvent, AgentOptions, ModelTurn, ToolContext } from '../src/agent/types.ts';

const roots: string[] = [];
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fab-yolo-')); roots.push(root);
  const cwd = join(root, 'workspace'); await mkdir(cwd);
  return { root, cwd, sessionDir: join(root, 'sessions') };
}
const done: ModelTurn = { text: 'done', toolCalls: [], finishReason: 'stop' };
const call = (name: string, input: unknown): ModelTurn => ({ text: '', finishReason: 'tool_calls', toolCalls: [
  { id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
function options(f: Awaited<ReturnType<typeof fixture>>, turns: ModelTurn[], extra: Partial<AgentOptions> = {}) {
  const events: AgentEvent[] = [];
  return { opts: { ...f, prompt: 'test', permissionMode: 'yolo' as const, timeoutMs: 4000,
    provider: { id: 'fixture', complete: async () => turns.shift() ?? done },
    permissionHandler: async () => { throw new Error('unexpected permission request'); },
    onEvent: (e: AgentEvent) => events.push(e), ...extra }, events };
}
function context(cwd: string, signal = new AbortController().signal): ToolContext {
  return { cwd, signal, autonomy: 'high', interactionMode: 'auto', sandbox: 'required', executionPolicy: resolveExecutionPolicy({ permissionMode: 'yolo' }) };
}

test('YOLO validates conflicts, frozen policy and scope reductions', () => {
  for (const autonomy of ['off', 'low', 'medium'] as const) expect(() => resolveExecutionPolicy({ permissionMode: 'yolo', autonomy })).toThrow('conflicts');
  for (const sandbox of ['required', 'best-effort'] as const) expect(() => resolveExecutionPolicy({ permissionMode: 'yolo', sandbox })).toThrow('conflicts');
  for (const networkPolicy of ['ask', 'deny'] as const) expect(() => resolveExecutionPolicy({ permissionMode: 'yolo', networkPolicy })).toThrow('--sandbox-network auto');
  expect(() => resolveExecutionPolicy({ permissionMode: 'yolo', interactionMode: 'spec' })).toThrow('conflicts');
  expect(() => resolveExecutionPolicy({ permissionMode: 'bogus' as any })).toThrow();
  expect(() => resolveExecutionPolicy({ permissionMode: 'yolo', interactionMode: 'invalid' as any })).toThrow('Invalid interactionMode');
  const policy = resolveExecutionPolicy({ permissionMode: 'yolo' }); expect(Object.isFrozen(policy)).toBe(true);
  expect(policy).toMatchObject({ effectiveAutonomy: 'high', execution: 'host', network: 'host' });
  expect(scopedExecutionOptions(context('/tmp'), true)).toMatchObject({ permissionMode: 'standard', sandbox: 'required', networkPolicy: 'deny', interactionMode: 'spec' });
  expect(scopedExecutionOptions({ autonomy: 'high', sandbox: 'required' }, false).permissionMode).toBe('standard');
});

test('host shell preserves pipelines, redirects, &&, outside files and scrubbed environment', async () => {
  const f = await fixture(), outside = join(f.root, 'outside');
  process.env.FAB_YOLO_SECRET_SENTINEL = 'must-not-inherit';
  try {
    const { opts, events } = options(f, [call('Execute', { command: `printf abc | tr a-z A-Z > '${outside}' && cat '${outside}'; printf ':env=%s' "$FAB_YOLO_SECRET_SENTINEL"` })]);
    const result = await runCodingAgent(opts); expect(result.ok).toBe(true);
    expect(await readFile(outside, 'utf8')).toBe('ABC');
    const value = events.find(e => e.type === 'tool_result')!;
    expect(value.isError).toBe(false); expect(value.value).toMatchObject({ stdout: 'ABC:env=', sandboxed: false, permissionMode: 'yolo', network: { requested: false, enabled: true, access: 'host' } });
    expect(events.some(e => e.type === 'permission_bypass')).toBe(true);
    expect(result.executionPolicy?.permissionMode).toBe('yolo');
  } finally { delete process.env.FAB_YOLO_SECRET_SENTINEL; }
});

test('host network works with absent, false and true network fields, invalid types fail', async () => {
  const f = await fixture(), server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('local-network-ok') });
  try {
    for (const network of [undefined, false, true]) {
      const r = await executeHost({ command: `curl -fsS http://127.0.0.1:${server.port}`, ...(network === undefined ? {} : { network }) }, context(f.cwd));
      expect(r.stdout).toBe('local-network-ok'); expect(r.network.enabled).toBe(true);
    }
    for (const input of [{ command: 'pwd', network: 'false' }, { command: 'a\0b' }, { command: 1 }, { command: 'x'.repeat(16385) }]) {
      await expect(executeHost(input, context(f.cwd))).rejects.toThrow();
    }
  } finally { server.stop(true); }
});

test('YOLO keeps tool filters, caller policy, AskUser, journal and anchored file boundary', async () => {
  const f = await fixture(); let asked = 0, barriers = 0;
  const { opts, events } = options(f, [call('Create', { file_path: '../escape', content: 'no' }), call('Create', { file_path: 'allowed', content: 'yes' }),
    call('Execute', { command: 'printf host' }), call('AskUser', { questionnaire: '1. [question] Color?\n[topic] Color\n[option] red\n[option] blue' })], {
    askUserHandler: async () => { asked++; return { answers: [{ index: 1, question: 'Color?', answer: 'red' }] }; },
    fileJournal: { prepare: async () => async () => {}, barrier: async () => { barriers++; } },
  });
  expect((await runCodingAgent(opts)).ok).toBe(true); expect(asked).toBe(1); expect(barriers).toBe(1);
  expect(await readFile(join(f.cwd, 'allowed'), 'utf8')).toBe('yes\n');
  expect(events.filter(e => e.type === 'tool_result')[0]!.isError).toBe(true);
  for (const extra of [{ onlyTools: ['Read'] }, { beforeTool: async () => false }]) {
    const r = options(f, [call('Create', { file_path: 'denied', content: 'no' })], extra);
    await runCodingAgent(r.opts); expect(r.events.find(e => e.type === 'tool_result')?.isError).toBe(true);
    expect(await Bun.file(join(f.cwd, 'denied')).exists()).toBe(false);
  }
});

test('resume and fork do not recover YOLO from session metadata or history', async () => {
  const f = await fixture(), first = await runCodingAgent(options(f, [done]).opts);
  for (const fork of [false, true]) {
    const r = options(f, [call('Create', { file_path: 'denied', content: 'no', permissionMode: 'yolo' })],
      { permissionMode: 'standard', sessionId: first.sessionId, fork, permissionHandler: undefined });
    const result = await runCodingAgent(r.opts);
    expect(result.executionPolicy?.permissionMode).toBe('standard');
    expect(r.events.find(e => e.type === 'tool_result')?.isError).toBe(true);
    expect(await Bun.file(join(f.cwd, 'denied')).exists()).toBe(false);
  }
});

test('host output and cancellation limits, and normal exit clean up ordinary descendants', async () => {
  const f = await fixture();
  await expect(executeHost({ command: 'yes output' }, context(f.cwd))).rejects.toThrow('output limit');
  const controller = new AbortController(), started = Date.now();
  const work = executeHost({ command: 'sleep 60 & wait' }, context(f.cwd, controller.signal));
  setTimeout(() => controller.abort(), 50); await expect(work).rejects.toThrow('aborted');
  expect(Date.now() - started).toBeLessThan(1500);
  const result = await executeHost({ command: 'sleep 0.3 && printf orphan > orphan & printf leader' }, context(f.cwd));
  expect(result.stdout).toBe('leader'); await Bun.sleep(400);
  expect(await Bun.file(join(f.cwd, 'orphan')).exists()).toBe(false);
  const r = options(f, [call('Execute', { command: 'sleep 60' })], { timeoutMs: 100 });
  expect((await runCodingAgent(r.opts)).error?.type).toBe('timeout');
});

test('Script VM stays isolated while its Execute callback inherits YOLO', async () => {
  const f = await fixture();
  const r = options(f, [call('Script', { code: 'const result = await tools.Execute({command:"printf callback | tr a-z A-Z"}); return {result, process:typeof process, Bun:typeof Bun};' })]);
  expect((await runCodingAgent(r.opts)).ok).toBe(true);
  const value = r.events.find(e => e.type === 'tool_result')?.value as any;
  expect(value).toMatchObject({ ok: true, output: { process: 'undefined', Bun: 'undefined', result: { stdout: 'CALLBACK', sandboxed: false } } });
});
