// Contadores observados en el proveedor. La entrada total incluye ambas categorías de caché.
export interface AgentUsage {
  effectiveModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  priceVersion?: string;
}

export const tokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
export const usd = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
export const modelId = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/.test(value) ? value : undefined;
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// USD por millón de tokens. Instantánea de tarifas API estándar, no cargos de suscripción.
const PRICE_VERSION = '2026-11-21-v1';
const PRICES = new Map([
  // https://platform.claude.com/docs/en/about-claude/pricing (escritura de caché de 5 minutos).
  ['claude-sonnet-4-6', { input: 3, output: 15, read: 0.3, write: 3.75 }],
  ['claude-haiku-4-5-20251001', { input: 1, output: 5, read: 0.1, write: 1.25 }],
  // https://ai.google.dev/gemini-api/docs/pricing (texto estándar, caché implícita).
  ['gemini-2.5-flash', { input: 0.30, output: 2.50, read: 0.03 }],
  // https://openai.com/api/pricing/ (tarifa estándar).
  ['gpt-5.2-codex', { input: 1.75, output: 14, read: 0.175 }],
]);

export function pricedUsage(usage: AgentUsage): AgentUsage {
  const { effectiveModel, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd } = usage;
  const price = effectiveModel && PRICES.get(effectiveModel);
  if (costUsd !== undefined || !price || inputTokens === undefined || outputTokens === undefined ||
      cacheReadTokens === undefined || ('write' in price && cacheWriteTokens === undefined) ||
      (!('write' in price) && (cacheWriteTokens ?? 0) > 0)) return usage;
  const writes = cacheWriteTokens ?? 0;
  const uncached = inputTokens - cacheReadTokens - writes;
  if (uncached < 0) return usage;
  return { ...usage, costUsd: (uncached * price.input + outputTokens * price.output +
    cacheReadTokens * price.read + writes * (price.write ?? 0)) / 1_000_000, priceVersion: PRICE_VERSION };
}

export function readUsage(value: unknown): AgentUsage | undefined {
  const o = record(value);
  if (!o) return undefined;
  const usage: AgentUsage = {};
  const effectiveModel = modelId(o.effectiveModel), costUsd = usd(o.costUsd);
  if (effectiveModel !== undefined) usage.effectiveModel = effectiveModel;
  if (costUsd !== undefined) usage.costUsd = costUsd;
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    const n = tokenCount(o[key]);
    if (n !== undefined) usage[key] = n;
  }
  if (typeof o.priceVersion === 'string' && /^\d{4}-\d{2}-\d{2}-v\d{1,4}$/.test(o.priceVersion) && costUsd !== undefined)
    usage.priceVersion = o.priceVersion;
  return Object.keys(usage).length ? usage : undefined;
}

export interface InferenceAttempt {
  adapter?: string;
  requestedModel?: string;
  remoteDeclared?: true;
  usage?: AgentUsage;
  durationMs?: number;
}

export function readInferenceAttempts(value: unknown): InferenceAttempt[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(item => {
    const o = record(item);
    return {
      adapter: modelId(o?.adapter), requestedModel: modelId(o?.requestedModel),
      usage: readUsage(o?.usage), durationMs: tokenCount(o?.durationMs),
      ...(o?.remoteDeclared === true ? { remoteDeclared: true } : {}),
    };
  });
}
