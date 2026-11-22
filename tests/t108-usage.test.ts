import { expect, test } from 'bun:test';
import { getAgent, runAgent } from '../src/agents.ts';

const model = 'claude-sonnet-4-6';
const claude = [
  { type: 'system', subtype: 'init', model: 'sonnet' },
  { type: 'assistant', message: { model, content: [{ type: 'text', text: 'Informe' }] } },
  { type: 'result', subtype: 'success', result: 'STATUS: done\nInforme', usage: {
    input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 400,
  }, modelUsage: { [model]: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 2000, cacheCreationInputTokens: 400 } } },
].map(frame => JSON.stringify(frame)).join('\n');

const codex = [
  { type: 'thread.started', thread_id: 'synthetic-thread' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'STATUS: done\nInforme' } },
  { type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 4 } },
].map(frame => JSON.stringify(frame)).join('\n');

const gemini = [
  { type: 'init', session_id: 'synthetic-session', model: 'gemini-2.5-flash' },
  { type: 'message', role: 'assistant', content: 'STATUS: ', delta: true },
  { type: 'message', role: 'assistant', content: 'done\nInforme', delta: true },
  { type: 'result', status: 'success', stats: { input_tokens: 30, output_tokens: 10, total_tokens: 40, cached: 5, models: { 'gemini-2.5-flash': { input_tokens: 30, output_tokens: 10, total_tokens: 40, cached: 5, input: 25 } } } },
].map(frame => JSON.stringify(frame)).join('\n');

const agy = [
  { event: 'init', conversation_id: 'synthetic-session', init: { cwd: '/tmp/synthetic', tools: [], permission_mode: 'request-review' } },
  { event: 'step_update', step_update: { conversation_id: 'synthetic-session', step_index: 3, state: 'DONE', step_type: 'agent_response' } },
  { event: 'result', result: { conversation_id: 'synthetic-session', status: 'SUCCESS', response: 'STATUS: done\nInforme', duration_seconds: 6.88,
    num_turns: 1, usage: { input_tokens: 10418, output_tokens: 589, thinking_tokens: 551, cache_read_tokens: 8113, total_tokens: 11007 } } },
].map(frame => JSON.stringify(frame)).join('\n');

const native = JSON.stringify({
  ok: true, sessionId: 'synthetic-session', text: 'STATUS: done\nInforme',
  turns: 1, toolCalls: 0, durationMs: 17, usage: { inputTokens: 50, outputTokens: 20 },
  inference: { effectiveModel: 'sin-tarifa', inputTokens: 50, outputTokens: 20, cacheReadTokens: 0 },
});

for (const [name, stdout, usage] of [
  ['claude', claude, { effectiveModel: model, inputTokens: 3400, outputTokens: 100, cacheReadTokens: 2000, cacheWriteTokens: 400, costUsd: 0.0066 }],
  ['codex', codex, { inputTokens: 120, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0 }],
  ['gemini', gemini, { effectiveModel: 'gemini-2.5-flash', inputTokens: 30, outputTokens: 10, cacheReadTokens: 5 }],
  ['agy', agy, { inputTokens: 10418, outputTokens: 589, cacheReadTokens: 8113 }],
  ['native', native, { effectiveModel: 'sin-tarifa', inputTokens: 50, outputTokens: 20, cacheReadTokens: 0 }],
] as const) {
  test(`T108 ${name}: la salida estructurada conserva el informe y la medición`, async () => {
    const adapter = getAgent(name);
    const run = await runAgent({ ...adapter, command: () => ['printf', '%s', stdout] }, 'prompt', process.cwd());
    expect(run.status.kind).toBe('done');
    expect(run.usage).toMatchObject(usage);
    if (name === 'native' || name === 'codex') expect(run.usage?.costUsd).toBeUndefined();
    if (name === 'codex' || name === 'agy') expect(run.usage).not.toHaveProperty('effectiveModel');
  });
}

test('T108: el coste declarado tiene prioridad, el cero explícito se conserva y la caché ausente no se factura como cero', async () => {
  const { parseClaudeJson } = await import('../src/agents.ts');
  const result = (data: object) => parseClaudeJson(JSON.stringify({
    type: 'result', result: 'STATUS: done', modelUsage: { [model]: {} }, ...data,
  }))?.usage;
  expect(result({ total_cost_usd: 0 })).toEqual({ effectiveModel: model, costUsd: 0 });
  expect(result({ usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: -1, cache_creation_input_tokens: 0 } }))
    .toEqual({ effectiveModel: model, inputTokens: 3, outputTokens: 1, cacheWriteTokens: 0 });
  expect(result({ usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })?.costUsd).toBe(0);
  expect(result({ usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 20,
    cache_creation: { ephemeral_1h_input_tokens: 20 } } })?.costUsd).toBeUndefined();
  expect(result({ modelUsage: { [model]: {}, 'sin-tarifa': {} }, usage: { input_tokens: 3, output_tokens: 1 } }))
    .toEqual({ inputTokens: 3, outputTokens: 1 });
});

test('T108: native toma modelo y caché de la respuesta HTTP local, incluso si se pidió un alias', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'fab-t108-native-'));
  writeFileSync(join(dir, 'settings.json'), '{}');
  const loopback = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: async request => {
      expect((await request.json() as { model: string }).model).toBe('alias-pedido');
      const frames = [
        { model: 'servido-2026-01-01', choices: [{ index: 0, delta: { content: 'STATUS: done\nInforme' }, finish_reason: 'stop' }] },
        { model: 'servido-2026-01-01', choices: [], usage: { prompt_tokens: 50, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } } },
      ];
      return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  try {
    const adapter = getAgent('native');
    const run = await runAgent({
      ...adapter,
      env: () => ({ FABRICA_HOME: dir, HOME: dir, FABRICA_LLM_API_KEY: '', FABRICA_LLM_BASE_URL: '' }),
      command: (prompt, options) => [...adapter.command(prompt, options), '--base-url', `http://127.0.0.1:${loopback.port}/v1`,
        '--settings', join(dir, 'settings.json'), '--session-dir', join(dir, 'sessions')],
    }, 'prueba local', dir, 10_000, { model: 'alias-pedido' });
    expect(run.output).toBe('STATUS: done\nInforme');
    expect(run.usage).toEqual({ effectiveModel: 'servido-2026-01-01', inputTokens: 50, outputTokens: 20, cacheReadTokens: 0 });
  } finally {
    loopback.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
