import { open } from 'node:fs/promises';
import { createChatGPTProvider } from './chatgpt.ts';
import { validateOAuthOptions } from './mcp-oauth.ts';
import type { McpConfig } from './mcp.ts';
import { createAnthropicProvider } from './providers/anthropic.ts';
import { validateExtraHeaders } from './providers/auth.ts';
import { createOpenAIResponsesProvider } from './providers/openai.ts';
import { createOpenAICompatibleProvider } from './provider.ts';
import type { ModelProvider } from './types.ts';
import { networkPolicy, type NetworkPolicy } from './network-policy.ts';

export interface CustomModelConfig {
  id: string;
  model: string;
  provider: 'generic-chat-completion-api' | 'openai' | 'chatgpt' | 'anthropic';
  baseUrl?: string;
  apiKey?: string;
  apiKeyHelper?: string | string[];
  authMode?: 'provider-default' | 'bearer';
  extraArgs?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  maxOutputTokens?: number;
  authFile?: string;
  streamIdleMs?: number;
  displayName?: string;
}

export interface ExecSettings {
  sandboxNetwork?: NetworkPolicy;
  modelId?: string;
  streamIdleMs?: number;
  worktreeDirectory?: string;
  customModels?: CustomModelConfig[];
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
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    let size = 0;
    for (;;) {
      const read = await file.read(bytes, size, bytes.length - size, null);
      size += read.bytesRead;
      if (size === bytes.length) throw new Error('Settings file exceeds 1 MiB');
      if (!read.bytesRead) break;
    }
    try {
      raw = JSON.parse(bytes.subarray(0, size).toString('utf8'));
    } catch {
      throw new Error('Invalid settings JSON');
    }
  } finally {
    await file.close();
  }

  if (!object(raw) ||
      raw.modelId !== undefined && typeof raw.modelId !== 'string' ||
      raw.streamIdleMs !== undefined && (!Number.isSafeInteger(raw.streamIdleMs) || raw.streamIdleMs < 0 || raw.streamIdleMs > 2147483647) ||
      raw.worktreeDirectory !== undefined && (typeof raw.worktreeDirectory !== 'string' || !raw.worktreeDirectory.trim()) ||
      raw.customModels !== undefined && (!Array.isArray(raw.customModels) || raw.customModels.length > 32) ||
      raw.mcpServers !== undefined && !object(raw.mcpServers)) {
    throw new Error('Invalid settings schema');
  }

  for (const key of Object.keys(raw)) {
    if (!['modelId', 'customModels', 'mcpServers', 'streamIdleMs', 'sandboxNetwork', 'worktreeDirectory'].includes(key)) {
      throw new Error(`Unsupported settings field: ${key}`);
    }
  }

  if (raw.sandboxNetwork !== undefined) networkPolicy(raw.sandboxNetwork);
  const settings = raw as ExecSettings;
  const ids = new Set<string>();

  for (const model of settings.customModels ?? []) {
    if (!object(model) || typeof model.id !== 'string' || !model.id || ids.has(model.id) ||
        typeof model.model !== 'string' || !model.model ||
        !['generic-chat-completion-api', 'openai', 'chatgpt', 'anthropic'].includes(model.provider) ||
        model.baseUrl !== undefined && typeof model.baseUrl !== 'string' ||
        model.provider === 'chatgpt' && (model.apiKey !== undefined || model.baseUrl !== undefined || model.apiKeyHelper !== undefined || model.authMode !== undefined) ||
        model.authFile !== undefined && typeof model.authFile !== 'string' ||
        model.displayName !== undefined && (typeof model.displayName !== 'string' || !model.displayName.trim() || model.displayName.length > 200) ||
        model.streamIdleMs !== undefined && (!Number.isSafeInteger(model.streamIdleMs) || model.streamIdleMs < 0 || model.streamIdleMs > 2147483647) ||
        model.apiKey !== undefined && typeof model.apiKey !== 'string' ||
        model.maxOutputTokens !== undefined && (!Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens < 1 || model.maxOutputTokens > 1_000_000)) {
      throw new Error('Invalid or unsupported custom model');
    }

    if (model.authMode !== undefined) {
      if (model.provider !== 'anthropic') {
        throw new Error('authMode is only supported for anthropic provider');
      }
      if (!['provider-default', 'bearer'].includes(model.authMode)) {
        throw new Error('Invalid authMode');
      }
    }

    if (model.apiKeyHelper !== undefined) {
      if (Array.isArray(model.apiKeyHelper)) {
        if (model.apiKeyHelper.length === 0 || model.apiKeyHelper.some(h => typeof h !== 'string' || !h.trim())) {
          throw new Error('Invalid apiKeyHelper');
        }
      } else if (typeof model.apiKeyHelper !== 'string' || !model.apiKeyHelper.trim()) {
        throw new Error('Invalid apiKeyHelper');
      }
    }

    if (model.extraHeaders !== undefined) {
      validateExtraHeaders(model.extraHeaders);
    }

    if (model.extraArgs !== undefined && !object(model.extraArgs)) {
      throw new Error('Invalid extraArgs');
    }

    ids.add(model.id);
    model.apiKey = envValue(model.apiKey);
  }

  for (const server of Object.values(settings.mcpServers ?? {})) {
    if (!object(server)) throw new Error('Invalid MCP server configuration');
    if (server.oauth !== undefined) {
      validateOAuthOptions(server.oauth);
    }
    for (const key of ['env', 'headers'] as const) {
      if (server[key]) {
        if (!object(server[key]) || Object.values(server[key]!).some(v => typeof v !== 'string')) {
          throw new Error('Invalid MCP environment/headers');
        }
        for (const [name, value] of Object.entries(server[key]!)) {
          server[key]![name] = envValue(value)!;
        }
      }
    }
  }

  return settings;
}

export function configuredProviders(
  settings: ExecSettings,
  fallback: { model: string; baseUrl?: string; apiKey?: string; reasoningEffort?: string },
): {
  providers: Record<string, ModelProvider>;
  defaultModelId: string;
} {
  const providers: Record<string, ModelProvider> = Object.create(null);

  for (const model of settings.customModels ?? []) {
    if (model.provider === 'chatgpt') {
      providers[model.id] = createChatGPTProvider({
        model: model.model,
        authFile: model.authFile,
        reasoningEffort: fallback.reasoningEffort,
        streamIdleMs: model.streamIdleMs ?? settings.streamIdleMs,
      });
    } else if (model.provider === 'anthropic') {
      providers[model.id] = createAnthropicProvider({
        model: model.model,
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        apiKeyHelper: model.apiKeyHelper,
        authMode: model.authMode,
        reasoningEffort: fallback.reasoningEffort,
        maxOutputTokens: model.maxOutputTokens,
        streamIdleMs: model.streamIdleMs ?? settings.streamIdleMs,
        extraArgs: model.extraArgs,
        extraHeaders: model.extraHeaders,
      });
    } else if (model.provider === 'openai') {
      providers[model.id] = createOpenAIResponsesProvider({
        model: model.model,
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        apiKeyHelper: model.apiKeyHelper,
        reasoningEffort: fallback.reasoningEffort,
        maxOutputTokens: model.maxOutputTokens,
        streamIdleMs: model.streamIdleMs ?? settings.streamIdleMs,
        extraArgs: model.extraArgs,
        extraHeaders: model.extraHeaders,
      });
    } else {
      providers[model.id] = createOpenAICompatibleProvider({
        model: model.model,
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        maxOutputTokens: model.maxOutputTokens,
        reasoningEffort: fallback.reasoningEffort,
        streamIdleMs: model.streamIdleMs ?? settings.streamIdleMs,
      });
    }
  }

  const selected = settings.modelId ?? fallback.model;
  if (!Object.hasOwn(providers, selected)) {
    if (selected.startsWith('custom:')) throw new Error('Unknown configured custom model');
    if (selected.startsWith('chatgpt:')) {
      providers[selected] = createChatGPTProvider({
        model: selected.slice('chatgpt:'.length),
        reasoningEffort: fallback.reasoningEffort,
        streamIdleMs: settings.streamIdleMs,
      });
    } else if (selected.startsWith('anthropic:')) {
      providers[selected] = createAnthropicProvider({
        model: selected.slice('anthropic:'.length),
        reasoningEffort: fallback.reasoningEffort,
        streamIdleMs: settings.streamIdleMs,
        apiKey: fallback.apiKey,
      });
    } else if (selected.startsWith('openai:')) {
      providers[selected] = createOpenAIResponsesProvider({
        model: selected.slice('openai:'.length),
        reasoningEffort: fallback.reasoningEffort,
        streamIdleMs: settings.streamIdleMs,
        apiKey: fallback.apiKey,
      });
    } else {
      providers[selected] = createOpenAICompatibleProvider({
        ...fallback,
        model: selected,
        streamIdleMs: settings.streamIdleMs,
      });
    }
  }

  return { providers, defaultModelId: selected };
}
