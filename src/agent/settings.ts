import { open } from 'node:fs/promises';
import { createOpenAICompatibleProvider } from './provider.ts';
import type { McpConfig } from './mcp.ts';
import type { ModelProvider } from './types.ts';

export interface ExecSettings {
  modelId?: string;
  customModels?: Array<{ id: string; model: string; provider: 'generic-chat-completion-api' | 'openai';
    baseUrl?: string; apiKey?: string; maxOutputTokens?: number }>;
  mcpServers?: Record<string, McpConfig>;
}
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
function envValue(value: string | undefined): string | undefined {
  if (value === undefined) return;
  const variable = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  if (!variable) return value;
  const result = process.env[variable[1]!];
  if (result === undefined) throw new Error(`Missing configured environment variable ${variable[1]}`);
  return result;
}
export async function loadExecSettings(path?: string): Promise<ExecSettings> {
  if (!path) return {};
  const file = await open(path, 'r');
  let raw: unknown;
  try {
    const bytes = Buffer.alloc(1024 * 1024 + 1); let size = 0;
    for (;;) {
      const read = await file.read(bytes, size, bytes.length - size, null); size += read.bytesRead;
      if (size === bytes.length) throw new Error('Settings file exceeds 1 MiB');
      if (!read.bytesRead) break;
    }
    try { raw = JSON.parse(bytes.subarray(0, size).toString('utf8')); } catch { throw new Error('Invalid settings JSON'); }
  } finally { await file.close(); }
  if (!object(raw) || raw.modelId !== undefined && typeof raw.modelId !== 'string' ||
      raw.customModels !== undefined && (!Array.isArray(raw.customModels) || raw.customModels.length > 32) ||
      raw.mcpServers !== undefined && !object(raw.mcpServers)) throw new Error('Invalid settings schema');
  for (const key of Object.keys(raw)) if (!['modelId', 'customModels', 'mcpServers'].includes(key)) throw new Error(`Unsupported settings field: ${key}`);
  const settings = raw as ExecSettings;
  const ids = new Set<string>();
  for (const model of settings.customModels ?? []) {
    if (!object(model) || typeof model.id !== 'string' || !model.id || ids.has(model.id) || typeof model.model !== 'string' || !model.model ||
        !['generic-chat-completion-api', 'openai'].includes(model.provider) || model.baseUrl !== undefined && typeof model.baseUrl !== 'string' ||
        model.apiKey !== undefined && typeof model.apiKey !== 'string' || model.maxOutputTokens !== undefined &&
        (!Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens < 1 || model.maxOutputTokens > 1_000_000)) throw new Error('Invalid or unsupported custom model');
    ids.add(model.id); model.apiKey = envValue(model.apiKey);
  }
  for (const server of Object.values(settings.mcpServers ?? {})) {
    if (!object(server)) throw new Error('Invalid MCP server configuration');
    for (const key of ['env', 'headers'] as const) if (server[key]) {
      if (!object(server[key]) || Object.values(server[key]!).some(v => typeof v !== 'string')) throw new Error('Invalid MCP environment/headers');
      for (const [name, value] of Object.entries(server[key]!)) server[key]![name] = envValue(value)!;
    }
  }
  return settings;
}

export function configuredProviders(settings: ExecSettings, fallback: { model: string; baseUrl?: string; apiKey?: string; reasoningEffort?: string }): {
  providers: Record<string, ModelProvider>; defaultModelId: string;
} {
  const providers: Record<string, ModelProvider> = Object.create(null);
  for (const model of settings.customModels ?? []) providers[model.id] = createOpenAICompatibleProvider({
    model: model.model, baseUrl: model.baseUrl ?? (model.provider === 'openai' ? 'https://api.openai.com/v1' : undefined),
    apiKey: model.apiKey, maxOutputTokens: model.maxOutputTokens, reasoningEffort: fallback.reasoningEffort,
  });
  const selected = settings.modelId ?? fallback.model;
  if (!Object.hasOwn(providers, selected)) {
    if (selected.startsWith('custom:')) throw new Error('Unknown configured custom model');
    providers[selected] = createOpenAICompatibleProvider({ ...fallback, model: selected });
  }
  return { providers, defaultModelId: selected };
}
