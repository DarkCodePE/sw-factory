import { open } from 'node:fs/promises';
import { createChatGPTProvider } from './chatgpt.ts';
import { validateOAuthOptions } from './mcp-oauth.ts';
import type { McpConfig } from './mcp.ts';
import { createAnthropicProvider } from './providers/anthropic.ts';
import { validateExtraHeaders } from './providers/auth.ts';
import { createOpenAIResponsesProvider } from './providers/openai.ts';
import { createOpenAICompatibleProvider } from './provider.ts';
import type { AgentEvent, ModelProvider } from './types.ts';
import { networkPolicy, type NetworkPolicy } from './network-policy.ts';
import { createRoutedProvider, type FallbackReason } from './providers/router.ts';
import { AUTO_MODEL_ID, createAutoProvider, lazyRouterCore, loadRouterCore, type RouterCore } from './providers/auto.ts';
import type { OmniConfig } from './omni/contracts.ts';
import { configuredOmni, prepareOmniSettings, type ProviderRuntime } from './omni/runtime.ts';
import type { AutoRouterConfig } from './router/types.ts';

export interface ModelRoutingConfig {
  fallback: string[];
  on?: FallbackReason[];
}

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
  modelAliases?: Record<string, string>;
  modelRouting?: Record<string, ModelRoutingConfig>;
  /** Candidates and classifier for `modelId: "auto"`. */
  autoRouter?: AutoRouterConfig;
  omniRouter?: OmniConfig;
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
      raw.mcpServers !== undefined && !object(raw.mcpServers) ||
      raw.modelAliases !== undefined && !object(raw.modelAliases) ||
      raw.modelRouting !== undefined && !object(raw.modelRouting) ||
      raw.autoRouter !== undefined && !object(raw.autoRouter) ||
      raw.omniRouter !== undefined && !object(raw.omniRouter)) {
    throw new Error('Invalid settings schema');
  }

  for (const key of Object.keys(raw)) {
    if (!['modelId', 'customModels', 'mcpServers', 'streamIdleMs', 'sandboxNetwork', 'worktreeDirectory', 'modelAliases', 'modelRouting', 'autoRouter', 'omniRouter'].includes(key)) {
      throw new Error(`Unsupported settings field: ${key}`);
    }
  }

  if (raw.sandboxNetwork !== undefined) networkPolicy(raw.sandboxNetwork);
  const settings = raw as ExecSettings;
  const ids = new Set<string>();
  const omni = prepareOmniSettings(settings, id => resolveModelAlias(id, settings.modelAliases));
  if (omni) settings.omniRouter = omni;
  const omniLeaves = new Set(omni?.profiles.map(p => p.modelId));

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
    if (!omniLeaves.has(model.id)) model.apiKey = envValue(model.apiKey);
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

  if (omni) ids.add('omni');

  if (settings.modelAliases !== undefined) {
    if (!object(settings.modelAliases)) throw new Error('Invalid modelAliases');
    for (const [alias, target] of Object.entries(settings.modelAliases)) {
      if (typeof alias !== 'string' || !alias.trim() || typeof target !== 'string' || !target.trim()) {
        throw new Error('Invalid modelAliases entry');
      }
    }
    for (const [alias] of Object.entries(settings.modelAliases)) {
      const resolved = resolveModelAlias(alias, settings.modelAliases);
      if (!ids.has(resolved)) {
        throw new Error(`Model alias '${alias}' points to unknown model '${resolved}'`);
      }
    }
  }

  const VALID_ROUTING_ON = new Set<FallbackReason>(['rate_limit', 'server_error', 'timeout', 'context_length']);
  if (settings.modelRouting !== undefined) {
    if (!object(settings.modelRouting)) throw new Error('Invalid modelRouting');
    for (const [key, config] of Object.entries(settings.modelRouting)) {
      if (typeof key !== 'string' || !key.trim()) throw new Error('Invalid modelRouting key');
      const resolvedKey = resolveModelAlias(key, settings.modelAliases);
      if (!ids.has(resolvedKey)) {
        throw new Error(`Model routing key '${key}' points to unknown model '${resolvedKey}'`);
      }
      if (!object(config) || !Array.isArray(config.fallback) || config.fallback.length === 0) {
        throw new Error(`Invalid modelRouting fallback for '${key}'`);
      }
      for (const fb of config.fallback) {
        if (typeof fb !== 'string' || !fb.trim()) {
          throw new Error(`Invalid modelRouting fallback entry in '${key}'`);
        }
        const resolvedFb = resolveModelAlias(fb, settings.modelAliases);
        if (!ids.has(resolvedFb)) {
          throw new Error(`Model routing fallback '${fb}' points to unknown model '${resolvedFb}'`);
        }
      }
      if (config.on !== undefined) {
        if (!Array.isArray(config.on) || config.on.length === 0 || config.on.some((r: any) => !VALID_ROUTING_ON.has(r))) {
          throw new Error(`Invalid model routing 'on' reason in '${key}'`);
        }
      }
    }
  }

  if (settings.autoRouter !== undefined) {
    const known = new Set(ids);
    for (const alias of Object.keys(settings.modelAliases ?? {})) known.add(alias);
    settings.autoRouter = (await loadRouterCore()).validateAutoRouterConfig(settings.autoRouter, known);
  }

  return settings;
}

export function resolveModelAlias(name: string, aliases?: Record<string, string>): string {
  if (!aliases || !Object.hasOwn(aliases, name)) return name;
  let current = name;
  const visited = new Set<string>([current]);
  let hops = 0;
  while (Object.hasOwn(aliases, current)) {
    hops++;
    if (hops > 8) throw new Error('Model alias chain exceeds 8 hops');
    current = aliases[current]!;
    if (visited.has(current)) throw new Error(`Cycle detected in model alias '${current}'`);
    visited.add(current);
  }
  return current;
}

export function configuredProviders(
  settings: ExecSettings,
  fallback: { model: string; baseUrl?: string; apiKey?: string; reasoningEffort?: string },
  onEvent?: (event: AgentEvent) => void,
  core: Pick<RouterCore, 'route' | 'upgradeTarget'> = lazyRouterCore(),
  runtime: ProviderRuntime = {},
): {
  providers: Record<string, ModelProvider>;
  defaultModelId: string;
} {
  const providers: Record<string, ModelProvider> = Object.create(null);
  const omni = prepareOmniSettings(settings, id => resolveModelAlias(id, settings.modelAliases));
  if (omni) {
    const current = configuredOmni(settings, omni, fallback.reasoningEffort, onEvent, undefined, runtime.omni?.health);
    runtime.omni ??= current;
    providers.omni = current.provider;
  }

  for (const model of settings.customModels ?? []) {
    if (omni?.profiles.some(p => p.modelId === model.id)) continue;
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

  const rawSelected = settings.modelId ?? fallback.model;
  const resolvedSelected = resolveModelAlias(rawSelected, settings.modelAliases);
  if (omni?.profiles.some(p => p.modelId === resolvedSelected)) {
    throw new Error('Omni profile leaves are private; select omni or an alias of omni');
  }
  if (resolvedSelected === 'omni' && !omni) {
    throw new Error("Model 'omni' requires an omniRouter section in the settings file");
  }
  if (resolvedSelected === AUTO_MODEL_ID && !settings.autoRouter) {
    throw new Error("Model 'auto' requires an autoRouter section in the settings file");
  }
  if (!Object.hasOwn(providers, resolvedSelected) && resolvedSelected !== AUTO_MODEL_ID) {
    if (resolvedSelected.startsWith('custom:')) throw new Error('Unknown configured custom model');
    if (resolvedSelected.startsWith('chatgpt:')) {
      providers[resolvedSelected] = createChatGPTProvider({
        model: resolvedSelected.slice('chatgpt:'.length),
        reasoningEffort: fallback.reasoningEffort,
        streamIdleMs: settings.streamIdleMs,
      });
    } else if (resolvedSelected.startsWith('anthropic:')) {
      providers[resolvedSelected] = createAnthropicProvider({
        model: resolvedSelected.slice('anthropic:'.length),
        reasoningEffort: fallback.reasoningEffort,
        streamIdleMs: settings.streamIdleMs,
        apiKey: fallback.apiKey,
      });
    } else if (resolvedSelected.startsWith('openai:')) {
      providers[resolvedSelected] = createOpenAIResponsesProvider({
        model: resolvedSelected.slice('openai:'.length),
        reasoningEffort: fallback.reasoningEffort,
        streamIdleMs: settings.streamIdleMs,
        apiKey: fallback.apiKey,
      });
    } else {
      providers[resolvedSelected] = createOpenAICompatibleProvider({
        ...fallback,
        model: resolvedSelected,
        streamIdleMs: settings.streamIdleMs,
      });
    }
  }

  if (settings.modelRouting) {
    for (const [routeKey, routeConfig] of Object.entries(settings.modelRouting)) {
      const primaryId = resolveModelAlias(routeKey, settings.modelAliases);
      const primaryProvider = providers[primaryId];
      if (!primaryProvider) continue;

      const fallbackTargets = routeConfig.fallback.map(fb => {
        const resolvedFb = resolveModelAlias(fb, settings.modelAliases);
        const fbProv = providers[resolvedFb];
        if (!fbProv) throw new Error(`Fallback model '${fb}' (resolved: '${resolvedFb}') not found`);
        return { id: resolvedFb, provider: fbProv };
      });

      const routed = createRoutedProvider(primaryProvider, fallbackTargets, { on: routeConfig.on }, onEvent);
      providers[primaryId] = routed;
      if (routeKey !== primaryId) {
        providers[routeKey] = routed;
      }
    }
  }

  if (settings.modelAliases) {
    for (const [alias] of Object.entries(settings.modelAliases)) {
      const targetId = resolveModelAlias(alias, settings.modelAliases);
      if (providers[targetId]) {
        providers[alias] = providers[targetId]!;
      }
    }
  }

  if (settings.autoRouter) {
    const config = settings.autoRouter;
    const resolve = (id: string) => resolveModelAlias(id, settings.modelAliases);
    // Candidates and classifier may be named by alias; the router sees configured IDs only.
    const normalized: AutoRouterConfig = { ...config, ...(config.classifierModel ? { classifierModel: resolve(config.classifierModel) } : {}),
      candidates: config.candidates.map(c => ({ ...c, modelId: resolve(c.modelId), ...(c.upgradeTo ? { upgradeTo: resolve(c.upgradeTo) } : {}) })) };
    const referencedModels = [...(normalized.classifierModel ? [normalized.classifierModel] : []), ...normalized.candidates.map(c => c.modelId)];
    for (const id of referencedModels) {
      if (!Object.hasOwn(providers, id)) throw new Error(`autoRouter references unconfigured model '${id}'`);
    }
    providers[AUTO_MODEL_ID] = createAutoProvider({ config: normalized, providers, ...core, surface: 'exec', onEvent });
  }

  return { providers, defaultModelId: rawSelected };
}
