import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAgentTools, runCodingAgent } from '../src/agent/engine.ts';
import { describeTool } from '../src/agent/catalog.ts';
import { validateSettingsChanges } from '../src/agent/staged-settings.ts';
import type { AgentEvent, AgentOptions, ModelProvider, ModelRequest, ModelTurn, ToolCall } from '../src/agent/types.ts';

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
const call = (name: string, input: unknown): ToolCall => ({ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(input) } });
const turn = (...toolCalls: ToolCall[]): ModelTurn => ({ text: toolCalls.length ? '' : 'done', toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop' });
async function fixture(turns: ModelTurn[]) {
  const cwd = await mkdtemp(join(tmpdir(), 'fab-session-tools-')); roots.push(cwd);
  const requests: ModelRequest[] = [], events: AgentEvent[] = [];
  const provider: ModelProvider = { id: 'configured', async complete(request) {
    requests.push(structuredClone(request)); const next = turns.shift(); if (!next) throw new Error('Unexpected extra turn'); return next;
  } };
  const opts: AgentOptions = { prompt: 'test', cwd, provider, sessionDir: join(cwd, '.sessions'), onEvent: e => events.push(e) };
  return { cwd, provider, requests, events, opts };
}
const results = (f: Awaited<ReturnType<typeof fixture>>) => f.events.filter(e => e.type === 'tool_result');
const names = (r: ModelRequest) => r.tools.map(t => t.function.name);

test('ExitSpecMode applies only after the entire batch; next request has auto context and refreshed catalog', async () => {
  const f = await fixture([]);
  await writeFile(join(f.cwd, 'file'), 'before\n');
  f.opts.prompt = `Workspace: ${f.cwd}\nMode: spec; autonomy: high.\nThis user text must stay intact.`;
  const edit = call('Edit', { file_path: 'file', old_str: 'before', new_str: 'after' });
  const turns = [turn(call('ExitSpecMode', { reason: 'plan ready' }), edit), turn(edit), turn()];
  f.provider.complete = async r => { f.requests.push(structuredClone(r)); return turns.shift()!; };
  const result = await runCodingAgent({ ...f.opts, autonomy: 'high', interactionMode: 'spec' });
  expect(result.ok).toBe(true);
  expect(results(f).map(e => e.isError)).toEqual([false, true, false]);
  expect(names(f.requests[0]!)).toContain('ExitSpecMode');
  expect(names(f.requests[1]!)).not.toContain('ExitSpecMode');
  expect(JSON.stringify(f.requests[1]!.messages)).toContain('Mode: auto; autonomy: high');
  expect(f.requests[1]!.messages[2]!.content).toBe(f.opts.prompt);
  expect(JSON.stringify(f.requests[1]!.messages)).toContain('standard permissions, auto mode, high autonomy');
  expect(f.events.filter(e => e.type === 'mode_changed')).toHaveLength(1);
  expect(await readFile(join(f.cwd, 'file'), 'utf8')).toBe('after\n');
  const snapshot = JSON.parse(await readFile(join(f.opts.sessionDir!, result.sessionId + '.json'), 'utf8'));
  expect(snapshot).not.toHaveProperty('permissionMode'); expect(snapshot).not.toHaveProperty('interactionMode');
  const resumed = await runCodingAgent({ ...f.opts, sessionId: result.sessionId, provider: { id: 'configured', async complete(r) {
    expect(names(r)).toContain('ExitSpecMode');
    expect(JSON.stringify(r.messages)).toContain('standard permissions, spec mode, off autonomy');
    return turn();
  } }, interactionMode: 'spec' });
  expect(resumed.ok).toBe(true);
});

test('ExitSpecMode asks below high, rejects unattended/declined/oversize and preserves autonomy', async () => {
  for (const autonomy of ['off', 'low', 'medium'] as const) {
    for (const selected of ['proceed_once', 'cancel', undefined] as const) {
      const f = await fixture([turn(call('ExitSpecMode', {})), turn()]);
      let asked = 0;
      await runCodingAgent({ ...f.opts, autonomy, interactionMode: 'spec',
        permissionHandler: selected ? async request => { asked++; expect(request.toolUses[0]!.confirmationType).toBe('exit_spec_mode'); return selected; } : undefined });
      expect(asked).toBe(selected ? 1 : 0);
      expect(results(f)[0]!.isError).toBe(selected !== 'proceed_once');
      expect(f.events.filter(e => e.type === 'mode_changed')).toHaveLength(selected === 'proceed_once' ? 1 : 0);
      if (selected === 'proceed_once') expect(JSON.stringify(f.requests[1]!.messages)).toContain('auto mode, ' + autonomy + ' autonomy');
    }
  }
  const f = await fixture([turn(call('ExitSpecMode', { reason: 'x'.repeat(8193) })), turn()]);
  let asked = false;
  await runCodingAgent({ ...f.opts, interactionMode: 'spec', permissionHandler: async () => { asked = true; return 'proceed_once'; } });
  expect(asked).toBe(false); expect(results(f)[0]!.isError).toBe(true);
});

test('ExitSpecMode cancellation while awaiting confirmation cannot transition', async () => {
  const f = await fixture([turn(call('ExitSpecMode', {}))]), ac = new AbortController();
  const result = await runCodingAgent({ ...f.opts, interactionMode: 'spec', signal: ac.signal,
    permissionHandler: async () => { ac.abort(new Error('cancel')); return 'proceed_once'; } });
  expect(result.error?.type).toBe('aborted'); expect(f.events.some(e => e.type === 'mode_changed')).toBe(false);
});

test('confined/auto/mission scopes hide Exit from catalog and reject forged/nested invocations', async () => {
  for (const scope of [{ interactionMode: 'auto' }, { interactionMode: 'mission' }, { interactionMode: 'spec', allowExitSpecMode: false }] as const) {
    const f = await fixture([turn(call('ExitSpecMode', {}), call('ToolSearch', { query: 'ExitSpecMode' })), turn()]);
    expect(listAgentTools({ ...f.opts, autonomy: 'high', ...scope }).some(t => t.schema.function.name === 'ExitSpecMode')).toBe(false);
    await runCodingAgent({ ...f.opts, autonomy: 'high', ...scope });
    expect(results(f)[0]!.isError).toBe(true); expect(results(f)[1]!.value).toEqual([]);
    expect(f.events.some(e => e.type === 'mode_changed')).toBe(false);
  }
  const f = await fixture([turn(call('Script', { code: 'return await tools.ExitSpecMode({})' })), turn()]);
  await runCodingAgent({ ...f.opts, interactionMode: 'spec', autonomy: 'high', allowExitSpecMode: false });
  expect(f.events.some(e => e.type === 'mode_changed')).toBe(false);
  expect(JSON.stringify(results(f)[0]!.value)).toMatch(/not a function|Unknown|not defined/);
});

test('catalog IDs, default permissions and removed tools match the bounded contract', async () => {
  const f = await fixture([]);
  const tools = listAgentTools({ ...f.opts, interactionMode: 'spec', removeTools: ['ApplyPatch'] });
  expect(tools.some(t => t.schema.function.name === 'ApplyPatch')).toBe(false);
  const exit = tools.find(t => t.schema.function.name === 'ExitSpecMode')!;
  expect(describeTool(exit, 'off', 'spec')).toMatchObject({ id: 'exit-spec-mode', category: 'read', defaultAllowed: false, conditional: true });
  expect(describeTool(tools.find(t => t.schema.function.name === 'StageSettingsChanges')!)).toMatchObject({ id: 'stage_settings_changes', defaultAllowed: true });
  const patch = listAgentTools(f.opts).find(t => t.schema.function.name === 'ApplyPatch')!;
  expect(describeTool(patch)).toMatchObject({ id: 'apply-patch-cli', category: 'edit', defaultAllowed: false });
});

test('staged settings return structured proposals without changing current or subsequent requests', async () => {
  const f = await fixture([turn(call('StageSettingsChanges', { modelId: 'other', autonomy: 'off', networkPolicy: 'deny' })), turn()]);
  await runCodingAgent({ ...f.opts, autonomy: 'low', networkPolicy: 'ask',
    settingsPolicy: { modelIds: ['configured', 'other'], maxAutonomy: 'low', networkPolicy: 'ask' } });
  const proposal = f.events.find(e => e.type === 'settings_staged')!.proposal;
  expect(proposal).toMatchObject({ applied: false, changes: { modelId: 'other', autonomy: 'off', networkPolicy: 'deny' } });
  expect(results(f)[0]!.value).toEqual(proposal);
  expect(JSON.stringify(f.requests[1]!.messages)).toContain('auto mode, low autonomy');
  expect(f.events.some(e => e.type === 'mode_changed')).toBe(false);
});

test('staged settings reject unknown models, enum errors, privilege increases, unknown keys and size limits', async () => {
  const policy = { modelIds: ['configured'], maxAutonomy: 'low' as const, networkPolicy: 'ask' as const };
  const invalid = [{}, [], null, { modelId: 'missing' }, { modelId: 'x'.repeat(257) }, { autonomy: 'high' }, { autonomy: 'auto-low' },
    { networkPolicy: 'auto' }, { networkPolicy: 'bogus' }, { yolo: true }, { sandbox: 'best-effort' }, { permissionMode: 'yolo' },
    { reason: 'x'.repeat(8193) }, JSON.parse('{"__proto__":{"yolo":true}}')];
  const f = await fixture([turn(...invalid.map(p => call('StageSettingsChanges', p))), turn()]);
  await runCodingAgent({ ...f.opts, autonomy: 'low', settingsPolicy: policy });
  expect(results(f)).toHaveLength(invalid.length); expect(results(f).every(e => e.isError)).toBe(true);
  expect(f.events.some(e => e.type === 'settings_staged')).toBe(false);
  expect(() => validateSettingsChanges({ networkPolicy: 'ask' }, { ...policy, networkPolicy: 'deny' }, undefined)).toThrow('network policy');
});

test('staged settings cancellation before execution does not emit a proposal', async () => {
  const f = await fixture([turn(call('StageSettingsChanges', { autonomy: 'off' }))]), ac = new AbortController();
  await runCodingAgent({ ...f.opts, signal: ac.signal, beforeTool: async () => { ac.abort(); return true; } });
  expect(f.events.some(e => e.type === 'settings_staged')).toBe(false);
});

test('Script ExitSpecMode cannot authorize its own later callback in the same evaluation', async () => {
  const f = await fixture([]);
  const path = join(f.cwd, 'file'); await writeFile(path, 'before\n');
  const turns = [turn(call('Script', { code: 'await tools.ExitSpecMode({}); return await tools.Edit(' + JSON.stringify({ file_path: path, old_str: 'before', new_str: 'after' }) + ')' })), turn()];
  f.provider.complete = async r => { f.requests.push(structuredClone(r)); return turns.shift()!; };
  await runCodingAgent({ ...f.opts, autonomy: 'high', interactionMode: 'spec' });
  expect(await readFile(path, 'utf8')).toBe('before\n');
  expect(JSON.stringify(results(f)[0]!.value)).toContain('Spec mode denies');
  expect(f.events.some(e => e.type === 'mode_changed')).toBe(true);
  expect(names(f.requests[1]!)).not.toContain('ExitSpecMode');
});
