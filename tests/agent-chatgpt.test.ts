import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createChatGPTProvider, decodeResponses, readCodexCredentials, responsesBody } from '../src/agent/chatgpt.ts';
import type { AgentTool } from '../src/agent/types.ts';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
async function authFile(claims: object, tokens: object = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fab-chatgpt-')); dirs.push(dir);
  const file = join(dir, 'auth.json');
  await writeFile(file, JSON.stringify({ tokens: { access_token: jwt(claims), refresh_token: 'r', account_id: 'acct-1', ...tokens } }));
  return file;
}
const stream = (events: object[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')).body!;

test('history becomes a Responses body: system as instructions, tool calls and results as items', () => {
  const body = responsesBody('gpt-test', {
    maxOutputTokens: 100,
    tools: [{ type: 'function', function: { name: 'Read', description: 'read a file', parameters: { type: 'object' } } }],
    messages: [
      { role: 'system', content: 'be careful' },
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/a"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'file text' },
    ],
  }, 'low');
  expect(body).toMatchObject({ model: 'gpt-test', instructions: 'be careful', stream: true, store: false, reasoning: { effort: 'low' } });
  expect(body.input).toEqual([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix it' }] },
    { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{"file_path":"/a"}' },
    { type: 'function_call_output', call_id: 'c1', output: 'file text' },
  ]);
  expect(body.tools).toEqual([{ type: 'function', name: 'Read', description: 'read a file', parameters: { type: 'object' }, strict: false }]);
});

test('the stream decoder assembles text, completed tool calls and usage', async () => {
  const deltas: string[] = [];
  const turn = await decodeResponses(stream([
    { type: 'response.output_text.delta', delta: 'Rea' }, { type: 'response.output_text.delta', delta: 'ding' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"file' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'c9', name: 'Read', arguments: '{"file_path":"/a"}' } },
    { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 3 } } },
  ]), 1 << 20, d => deltas.push(d));
  expect(turn).toEqual({ text: 'Reading', finishReason: 'tool_calls', usage: { inputTokens: 12, outputTokens: 3 },
    toolCalls: [{ id: 'c9', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/a"}' } }] });
  expect(deltas).toEqual(['Rea', 'ding']);
});

test('a stream that never completes, or fails, is an error, not a partial answer', async () => {
  await expect(decodeResponses(stream([{ type: 'response.output_text.delta', delta: 'half' }]), 1 << 20)).rejects.toThrow('before completion');
  await expect(decodeResponses(stream([{ type: 'response.failed', response: { error: { message: 'boom' } } }]), 1 << 20)).rejects.toThrow('boom');
  expect((await decodeResponses(stream([{ type: 'response.incomplete', response: {} }]), 1 << 20)).finishReason).toBe('length');
});

test('credentials are read from a Codex login without exposing or rewriting them', async () => {
  const file = await authFile({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_compute_residency: 'us' } });
  const before = await Bun.file(file).text();
  const creds = await readCodexCredentials(file);
  expect(creds).toMatchObject({ accountId: 'acct-1', residency: 'us' });
  expect(await Bun.file(file).text()).toBe(before);
  await expect(readCodexCredentials(join(tmpdir(), 'missing-auth.json'))).rejects.toThrow('codex login');
  await expect(readCodexCredentials(await authFile({ exp: 1 }, { account_id: '' }))).rejects.toThrow('not a ChatGPT subscription login');
});

test('an expired access token asks for a Codex refresh instead of calling the network', async () => {
  const file = await authFile({ exp: Math.floor(Date.now() / 1000) - 10 });
  const provider = createChatGPTProvider({ model: 'gpt-test', authFile: file, baseUrl: 'http://127.0.0.1:9' });
  await expect(provider.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [], maxOutputTokens: 10 }, new AbortController().signal))
    .rejects.toThrow('run any `codex` command');
});

// Review R-01/R-02/R-09: tools from an incomplete or malformed turn never reach a dispatcher.
test('R-01: tools from an incomplete, failed, unterminated or over-long stream are never executed', async () => {
  const { runCodingAgent } = await import('../src/agent/engine.ts');
  const call = { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'Probe', arguments: '{}' } };
  const cases: object[][] = [
    [call, { type: 'response.incomplete', response: {} }],
    [call],
    [call, { type: 'response.failed', response: { error: { message: 'x' } } }],
    [call, { type: 'response.completed', response: {} }, { type: 'response.output_text.delta', delta: 'late' }],
  ];
  const executionsFor = async (events: object[]) => {
    let executions = 0, turn = 0;
    const dir = await mkdtemp(join(tmpdir(), 'fab-r01-')); dirs.push(dir);
    const probe: AgentTool = { schema: { type: 'function', function: { name: 'Probe', description: 'probe', parameters: { type: 'object' } } },
      effect: 'read', run: async () => (executions++, 'ok') };
    await runCodingAgent({ prompt: 'go', cwd: dir, autonomy: 'high', sessionDir: join(dir, 's'), maxRecoveryAttempts: 0, tools: [probe],
      provider: { id: 'r01', async complete() { if (turn++) return { text: 'done', toolCalls: [], finishReason: 'stop' }; return decodeResponses(stream(events), 1 << 20); } } });
    return executions;
  };
  // Control: the same tool call in a properly completed response is executed exactly once.
  expect(await executionsFor([call, { type: 'response.completed', response: {} }])).toBe(1);
  for (const events of cases) {
    await expect(decodeResponses(stream(events), 1 << 20)).rejects.toThrow();
    expect(await executionsFor(events)).toBe(0);
  }
});

test('R-02: duplicate tool call IDs are rejected before dispatch, whatever the provider', async () => {
  const { validateTurn } = await import('../src/agent/provider.ts');
  const c = { id: 'same', type: 'function' as const, function: { name: 'Read', arguments: '{}' } };
  expect(() => validateTurn({ text: '', finishReason: 'tool_calls', toolCalls: [c, c] })).toThrow('duplicate');
  expect(() => validateTurn({ text: '', finishReason: 'length', toolCalls: [c] })).toThrow('Incomplete tool batch');
});

test('R-09: a tool at output index 0 is not overwritten by later items', async () => {
  const item = (i: number, id: string) => ({ type: 'response.output_item.done', output_index: i, item: { type: 'function_call', call_id: id, name: 'Read', arguments: '{}' } });
  const turn = await decodeResponses(stream([item(0, 'a'), item(1, 'b'), { type: 'response.completed', response: {} }]), 1 << 20);
  expect(turn.toolCalls.map(c => c.id)).toEqual(['a', 'b']);
  await expect(decodeResponses(stream([item(0, 'a'), item(0, 'b'), { type: 'response.completed', response: {} }]), 1 << 20)).rejects.toThrow('Duplicate');
});
