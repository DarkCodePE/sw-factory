import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCodingAgent } from '../src/agent/engine.ts';
import { Hooks } from '../src/agent/hooks.ts';
import { resolveExecutionPolicy } from '../src/agent/execution-policy.ts';
import { createOpenAICompatibleProvider } from '../src/agent/provider.ts';
import { mockModel } from './agent-stream-input-fixture.test.ts';
import type { AgentOptions, AgentEvent, ModelTurn } from '../src/agent/types.ts';
const savedHome = process.env.FABRICA_HOME;
const roots: string[] = [], live: Array<() => Promise<void>> = [];
afterEach(async () => { if (savedHome === undefined) delete process.env.FABRICA_HOME; else process.env.FABRICA_HOME = savedHome; for (const close of live.splice(0)) await close(); for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
const done = (): ModelTurn => ({ text: 'done', toolCalls: [], finishReason: 'stop' });
const call = (name: string, input: unknown): ModelTurn => ({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
const output = (v: unknown) => "printf '%s' '" + JSON.stringify(v).replaceAll("'", "'\\''") + "'";
async function fixture(config: unknown, turns: ModelTurn[] = []) {
  const cwd = await mkdtemp(join(tmpdir(), 'fab-hooks-')); roots.push(cwd); process.env.FABRICA_HOME = join(cwd, 'private-home'); await mkdir(join(cwd, '.fab')); await writeFile(join(cwd, '.fab/hooks.json'), JSON.stringify(config));
  const events: AgentEvent[] = [], controller = new AbortController(), requests: any[] = [];
  const options: AgentOptions = { cwd, sessionDir: join(cwd, 'sessions'), prompt: 'hooks test', hooks: true, autonomy: 'high', signal: controller.signal,
    provider: { id: 'fixture', async complete(r) { requests.push(structuredClone(r)); return turns.shift() ?? done(); } }, onEvent: e => events.push(structuredClone(e)) };
  return { cwd, events, controller, requests, options, run() { const work = runCodingAgent(options); live.push(async () => { controller.abort(); await work; }); return work; } };
}
const group = (command: string, extra = {}) => [{ ...extra, hooks: [{ type: 'command', command }] }];

test('PreToolUse deny, allow and ask; updatedInput is validated and shown to caller policy', async () => {
  for (const decision of ['deny', 'allow', 'ask']) {
    const f = await fixture({ PreToolUse: group(output({ hookSpecificOutput: { permissionDecision: decision, updatedInput: { file_path: 'after', content: 'actual' } } }), { matcher: 'Create' }) }, [call('Create', { file_path: 'before', content: 'wrong' })]);
    f.options.autonomy = 'off'; let approvals = 0, seen: any;
    f.options.beforeTool = async c => { seen = JSON.parse(c.function.arguments); return true; };
    f.options.permissionHandler = async req => { approvals++; expect(req.toolUses[0]!.toolUse.input).toEqual({ file_path: 'after', content: 'actual' }); return 'proceed_once'; };
    expect((await f.run()).ok).toBe(true); expect(await Bun.file(join(f.cwd, 'before')).exists()).toBe(false);
    expect(await Bun.file(join(f.cwd, 'after')).exists()).toBe(decision !== 'deny');
    expect(approvals).toBe(decision === 'ask' ? 1 : 0);
    if (decision !== 'deny') expect(seen.file_path).toBe('after');
    expect(f.events.find(e => e.type === 'hook')).toMatchObject({ event: 'PreToolUse', decision });
  }
  const f = await fixture({ PreToolUse: group(output({ hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { file_path: 2, content: false } } })) }, [call('Create', { file_path: 'bad', content: 'no' })]);
  await f.run(); expect(await Bun.file(join(f.cwd, 'bad')).exists()).toBe(false);
});

test('PostToolUse block feeds reason; UserPromptSubmit/SessionStart context and bounded Stop blocks', async () => {
  const f = await fixture({ SessionStart: group('printf "session:$FAB_PROJECT_DIR:$FAB_SESSION_ID"'), UserPromptSubmit: group(output({ hookSpecificOutput: { additionalContext: 'prompt-context' } })),
    PostToolUse: group(output({ decision: 'block', reason: 'Inspect observed output again' })), Stop: group(output({ decision: 'block', reason: 'one more look' })),
    SessionEnd: group('printf "%s" "$FAB_PROJECT_DIR" > end-marker') }, [call('LS', {})]);
  expect((await f.run()).ok).toBe(true);
  expect(f.events.filter(e => e.type === 'hook' && e.event === 'Stop')).toHaveLength(2);
  expect(JSON.stringify(f.requests)).toContain('Inspect observed output again'); expect(JSON.stringify(f.requests)).toContain('prompt-context'); expect(JSON.stringify(f.requests)).toContain('session:' + f.cwd);
  expect(await readFile(join(f.cwd, 'end-marker'), 'utf8')).toBe(f.cwd);
});

test('hooks are opt-in; strict config, invalid regex group ignored, nine hooks rejected', async () => {
  const f = await fixture({ UnknownEvent: true }); f.options.hooks = false; expect((await f.run()).ok).toBe(true);
  f.options.hooks = true; expect((await f.run()).ok).toBe(false);
  const g = await fixture({ PreToolUse: [{ matcher: '[', hooks: [{ type: 'command', command: 'touch forbidden' }] }] }, [call('LS', {})]);
  expect((await g.run()).ok).toBe(true); expect(await Bun.file(join(g.cwd, 'forbidden')).exists()).toBe(false);
  const h = await fixture({ Stop: [{ hooks: Array.from({ length: 9 }, () => ({ type: 'command', command: 'true' })) }] }); expect((await h.run()).ok).toBe(false);
});

test('allow cannot bypass network deny, spec writes, caller policy or settings ceilings; Script callbacks excluded', async () => {
  const allow = { PreToolUse: group(output({ hookSpecificOutput: { permissionDecision: 'allow' } })) };
  const f = await fixture(allow, [call('Execute', { command: 'touch nope', network: true })]); f.options.networkPolicy = 'deny'; await f.run(); expect(await Bun.file(join(f.cwd, 'nope')).exists()).toBe(false);
  const g = await fixture(allow, [call('Create', { file_path: 'nope', content: 'no' })]); g.options.interactionMode = 'spec'; await g.run(); expect(await Bun.file(join(g.cwd, 'nope')).exists()).toBe(false);
  const h = await fixture(allow, [call('StageSettingsChanges', { autonomy: 'high' })]); h.options.autonomy = 'low'; h.options.settingsPolicy = { modelIds: ['fixture'], maxAutonomy: 'low', networkPolicy: 'deny' }; await h.run(); expect(h.events.some(e => e.type === 'settings_staged')).toBe(false);
  const s = await fixture({ PreToolUse: group(output({ hookSpecificOutput: { permissionDecision: 'deny' } }), { matcher: 'Create' }) }, [call('Script', { code: "return await tools.Create({file_path:'inside',content:'yes'});" })]);
  await s.run(); expect(await Bun.file(join(s.cwd, 'inside')).exists()).toBe(true); expect(s.events.some(e => e.type === 'hook' && e.event === 'PreToolUse')).toBe(false);
});

test('hook timeout and 64KiB stdout truncation do not block; sandbox denies curl network', async () => {
  const f = await fixture({ UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'sleep 10', timeout: 0.05 }] }] });
  const start = Date.now(); expect((await f.run()).ok).toBe(true); expect(Date.now() - start).toBeLessThan(2000);
  const g = await fixture({ UserPromptSubmit: group('head -c 100000 /dev/zero | tr "\\000" x') }); g.options.maxContextTokens = 1000000;
  await g.run(); const context = g.requests[0].messages.find((m: any) => String(m.content).startsWith('Hook context (data): ')); expect(Buffer.byteLength(context.content)).toBeLessThan(65600);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response('unexpected'); } });
  try { const h = await fixture({ UserPromptSubmit: group(`curl --max-time 1 --fail --noproxy '*' ${server.url.href}`) }); await h.run(); expect(h.events.find(e => e.type === 'hook' && e.event === 'UserPromptSubmit')!.exitCode).not.toBe(0); } finally { server.stop(true); }
});

test('abort during live hook kills it without late writes, skips Stop and closes SessionEnd', async () => {
  const f = await fixture({ UserPromptSubmit: group('touch started; sleep 1; touch late'), Stop: group('touch stop'), SessionEnd: group('sleep 10') });
  const work = f.run(); for (let i = 0; i < 500 && !await Bun.file(join(f.cwd, 'started')).exists(); i++) await Bun.sleep(2);
  const start = Date.now(); f.controller.abort(new Error('abort hook')); const result = await work;
  expect(result.error?.type).toBe('aborted'); expect(Date.now() - start).toBeLessThan(1800);
  await Bun.sleep(1100); expect(await Bun.file(join(f.cwd, 'late')).exists()).toBe(false); expect(await Bun.file(join(f.cwd, 'stop')).exists()).toBe(false);
});

test('allow or ask on Script cannot grant its callbacks higher autonomy', async () => {
  for (const decision of ['allow', 'ask']) {
    const f = await fixture({ PreToolUse: group(output({ hookSpecificOutput: { permissionDecision: decision } }), { matcher: 'Script' }) }, [call('Script', { code: "return await tools.Create({file_path:'nested',content:'no'});" })]);
    f.options.autonomy = 'off'; const permissions: string[] = [];
    f.options.permissionHandler = async req => { const name = req.toolUses[0]!.toolUse.name; permissions.push(name); return name === 'Script' ? 'proceed_once' : 'cancel'; };
    await f.run(); expect(await Bun.file(join(f.cwd, 'nested')).exists()).toBe(false); expect(permissions).toContain('Create');
  }
});

test('Stop blocks once then passes with stop_hook_active; prompt exit2 blocks before provider', async () => {
  const command = 'payload=$(cat); case "$payload" in *\'"stop_hook_active":false\'*) ' + output({ decision: 'block', reason: 'Review once' }) + ";; *) printf '{}';; esac";
  const f = await fixture({ Stop: group(command) }); expect((await f.run()).ok).toBe(true);
  const stops = f.events.filter(e => e.type === 'hook' && e.event === 'Stop'); expect(stops).toHaveLength(2); expect(stops[0]!.decision).toBe('block'); expect(stops[1]!.decision).toBeUndefined();
  const g = await fixture({ UserPromptSubmit: group('printf "denied prompt" >&2; exit 2') }); expect((await g.run()).ok).toBe(false); expect(g.requests).toHaveLength(0);
});

test('hostile commandRegex is matched in a killable worker without blocking timers', async () => {
  const f = await fixture({ PreToolUse: group('touch forbidden', { matcher: 'Execute', commandRegex: '(a+)+$' }) }, [call('Execute', { command: 'a'.repeat(16000) + '!' })]);
  let ticks = 0; const timer = setInterval(() => ticks++, 20), start = Date.now();
  try { await f.run(); } finally { clearInterval(timer); }
  expect(ticks).toBeGreaterThan(5); expect(Date.now() - start).toBeLessThan(2000); expect(await Bun.file(join(f.cwd, 'forbidden')).exists()).toBe(false);
});

test('PostToolUse feedback preserves nested Loop Execute shape', async () => {
  const f = await fixture({ PostToolUse: group('printf "Review loop evidence" >&2; exit 2', { matcher: 'Execute' }) }, [call('Loop', { command: 'echo evidence', until: 'exit_zero', maxIterations: 1 })]);
  expect((await f.run()).ok).toBe(true); expect(JSON.stringify(f.requests)).toContain('Review loop evidence');
  expect(f.events.find(e => e.type === 'tool_result')!.isError).toBe(false);
});

test('hook allow cannot make a protected-path mutation pass mission validation; children do not inherit hooks', async () => {
  const f = await fixture({ PreToolUse: group(output({ hookSpecificOutput: { permissionDecision: 'allow' } })), UserPromptSubmit: group('printf parent-only-hook') });
  const persistence = await mkdtemp(join(tmpdir(), 'fab-hook-mission-')); roots.push(persistence); f.options.sessionDir = join(persistence, 'sessions');
  await writeFile(join(f.cwd, 'contract.txt'), 'intact\n');
  const { server, requests } = mockModel('printf tampered > contract.txt');
  try {
    f.options.provider = createOpenAICompatibleProvider({ model: 'fixture', baseUrl: server.url.href + 'v1' });
    f.options.prompt = 'mission-crash'; f.options.interactionMode = 'mission';
    const result = await f.run(); expect(result.mission?.state).toBe('paused');
    expect(f.events.find(e => e.type === 'mission_paused')).toMatchObject({ reason: 'protected_paths_changed' });
    expect(f.events.filter(e => e.type === 'hook' && e.event === 'UserPromptSubmit')).toHaveLength(1);
    const childRequests = requests.filter(r => r.messages.some((m: any) => typeof m.content === 'string' && m.content.startsWith('Assigned mission feature')));
    expect(childRequests.length).toBeGreaterThan(0); expect(JSON.stringify(childRequests)).not.toContain('parent-only-hook');
  } finally { server.stop(true); }
});

test('spec hooks cannot write the workspace; suppressOutput hides additional context', async () => {
  const f = await fixture({ SessionStart: group('touch forbidden'), UserPromptSubmit: group(output({ suppressOutput: true, hookSpecificOutput: { additionalContext: 'hidden-context' } })), SessionEnd: group('touch forbidden-end') });
  f.options.interactionMode = 'spec'; expect((await f.run()).ok).toBe(true);
  expect(await Bun.file(join(f.cwd, 'forbidden')).exists()).toBe(false); expect(await Bun.file(join(f.cwd, 'forbidden-end')).exists()).toBe(false);
  expect(JSON.stringify(f.requests)).not.toContain('hidden-context');
});
