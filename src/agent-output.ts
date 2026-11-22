import { modelId, pricedUsage, readUsage, record, tokenCount, usd, type AgentUsage } from './inference-usage.ts';

export type AgentOutput = { text: string; usage?: AgentUsage };

function json(text: string) {
  try { return record(JSON.parse(text)); } catch { return undefined; }
}

function* frames(stdout: string) {
  for (const line of stdout.split('\n')) {
    const frame = json(line);
    if (frame) yield frame;
  }
}

function output(text: unknown, data: AgentUsage = {}, price = true): AgentOutput {
  const usage = readUsage(data);
  return { text: typeof text === 'string' ? text : '', ...(usage ? { usage: price ? pricedUsage(usage) : usage } : {}) };
}

export function parseClaudeJson(stdout: string, observedModel?: string): AgentOutput | null {
  const r = json(stdout);
  if (r?.type !== 'result') return null;
  const u = record(r.usage), models = Object.keys(record(r.modelUsage) ?? {});
  const effectiveModel = models.length === 1 ? modelId(models[0]) : models.length > 1 ? undefined : observedModel;
  const input = tokenCount(u?.input_tokens), read = tokenCount(u?.cache_read_input_tokens), write = tokenCount(u?.cache_creation_input_tokens);
  const writesAtOneHour = tokenCount(record(u?.cache_creation)?.ephemeral_1h_input_tokens) ?? 0;
  // La salida antigua omitía campos de caché. Conserva su entrada conocida sin afirmar que hubo cero caché.
  return output(r.result, { effectiveModel, costUsd: usd(r.total_cost_usd),
    inputTokens: input === undefined ? undefined : tokenCount(input + (read ?? 0) + (write ?? 0)),
    outputTokens: tokenCount(u?.output_tokens), cacheReadTokens: read, cacheWriteTokens: write }, writesAtOneHour === 0);
}

export function parseClaudeStream(stdout: string): { result: AgentOutput | null; line: string; hasFrame: boolean } {
  let result: AgentOutput | null = null, line = '', hasFrame = false;
  const models = new Set<string>();
  for (const current of stdout.split('\n')) {
    const frame = json(current);
    if (typeof frame?.type === 'string') hasFrame = true;
    if (frame?.type === 'assistant') {
      const model = modelId(record(frame.message)?.model);
      if (model && model !== '<synthetic>') models.add(model);
    }
    if (frame?.type === 'result') {
      if (result) return { result: null, line: '', hasFrame: true };
      line = current;
      result = parseClaudeJson(current, models.size === 1 ? [...models][0] : undefined);
    }
  }
  return { result, line, hasFrame };
}

export function parseCodexJsonl(stdout: string): AgentOutput | null {
  let text = '', structured = false, turnOpen = false, usage: AgentUsage | undefined;
  for (const frame of frames(stdout)) {
    if (frame.type === 'thread.started') structured = true;
    if (!structured) continue;
    if (frame.type === 'item.completed') {
      const item = record(frame.item);
      if (item?.type === 'agent_message' && typeof item.text === 'string') text = item.text;
    }
    if (frame.type === 'turn.started') turnOpen = true;
    if (frame.type === 'turn.failed') turnOpen = false;
    if (frame.type === 'turn.completed') {
      if (!turnOpen) return { text: '' };
      turnOpen = false;
      const counters = record(frame.usage);
      if (!counters) continue;
      const measured = {
        inputTokens: tokenCount(counters.input_tokens), outputTokens: tokenCount(counters.output_tokens),
        cacheReadTokens: tokenCount(counters.cached_input_tokens), cacheWriteTokens: tokenCount(counters.cache_write_input_tokens),
      };
      if (!usage) { usage = measured; continue; }
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
        const total = usage[key], increment = measured[key];
        usage[key] = total === undefined || increment === undefined ? undefined : tokenCount(total + increment);
      }
    }
  }
  return structured ? output(text, usage) : null;
}

export function parseGoogleJsonl(stdout: string): AgentOutput | null {
  let text = '', started = false, agyStarted = false, stats: Record<string, unknown> | undefined;
  let agyResult: AgentOutput | undefined, agyEnded = false, geminiEnded = false;
  for (const frame of frames(stdout)) {
    if (frame.event === 'init') agyStarted = true;
    if (agyStarted && frame.event === 'result') {
      if (agyEnded) return { text: '' };
      agyEnded = true;
      const result = record(frame.result);
      if (result && typeof result.status === 'string') {
        const usage = record(result.usage);
        agyResult = output(result.response, { inputTokens: tokenCount(usage?.input_tokens),
          outputTokens: tokenCount(usage?.output_tokens), cacheReadTokens: tokenCount(usage?.cache_read_tokens) });
      }
    }
    if (frame.type === 'init') started = true;
    if (!started) continue;
    if (frame.type === 'message' && frame.role === 'assistant' && typeof frame.content === 'string')
      text = frame.delta === true ? text + frame.content : frame.content;
    if (frame.type === 'message' && frame.role === 'user') text = '';
    if (frame.type === 'result') {
      if (geminiEnded) return { text: '' };
      geminiEnded = true;
      stats = record(frame.stats);
    }
  }
  if (agyStarted) return started ? { text: '' } : agyResult ?? { text: '' };
  const models = Object.keys(record(stats?.models) ?? {});
  const effectiveModel = models.length === 1 ? modelId(models[0]) : undefined;
  const inputTokens = tokenCount(stats?.input_tokens), outputTokens = tokenCount(stats?.output_tokens);
  // El CLI publica candidatos. Si el total incluye otras categorías, no asumimos su tarifa.
  const complete = inputTokens !== undefined && outputTokens !== undefined && tokenCount(stats?.total_tokens) === inputTokens + outputTokens;
  return started ? output(text, { effectiveModel, inputTokens, outputTokens, cacheReadTokens: tokenCount(stats?.cached) }, complete)
    : null;
}

export function parseNativeJson(stdout: string): AgentOutput | null {
  const r = json(stdout);
  if (typeof r?.ok !== 'boolean' || typeof r.sessionId !== 'string' || typeof r.text !== 'string') return null;
  const usage = readUsage(r.inference);
  const error = record(r.error);
  return output(r.ok ? r.text : error?.message, usage);
}
