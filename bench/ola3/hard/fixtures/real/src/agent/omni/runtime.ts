import type { AgentEvent, ModelProvider } from '../types.ts';
import type { CustomModelConfig, ExecSettings } from '../settings.ts';
import type { Clock, OmniConfig, OmniProvider, Scheduler } from './contracts.ts';
import { validateOmniConfig } from './config.ts';
import { eligibleProfiles } from './policy.ts';
import { createOmniScheduler } from './scheduler.ts';
import { classifyOmniFailure } from './failures.ts';
import { createOmniProvider } from '../providers/omni.ts';
import { readHttpFailure } from '../providers/http-failure.ts';
import { createOpenAICompatibleProvider, estimatedTokens } from '../provider.ts';
import { abortable } from '../cancellation.ts';
import { ProviderError } from '../transport.ts';

interface OmniHealth {
  clock: Clock; scheduler: Scheduler;
  resolvedKeys: Map<string, { accountId: string; quotaGroup: string }>;
}
export interface ProviderRuntime {
  omni?: { provider: OmniProvider; health: OmniHealth };
}

/** Pure preparation: aliases and policy are validated before any credential is read. */
export function prepareOmniSettings(settings: ExecSettings, resolve: (id: string) => string): OmniConfig | undefined {
  if (settings.customModels?.some(m => typeof m?.id === 'string' && m.id.toLowerCase() === 'omni') ||
      Object.keys(settings.modelAliases ?? {}).some(id => id.toLowerCase() === 'omni')) {
    throw new Error("Model ID 'omni' is reserved");
  }
  if (settings.omniRouter === undefined) return;
  if (settings.autoRouter !== undefined || settings.modelRouting !== undefined) {
    throw new Error('omniRouter cannot be combined with autoRouter or modelRouting');
  }
  const raw = settings.omniRouter;
  const normalized = { ...raw, profiles: Array.isArray(raw.profiles)
    ? raw.profiles.map(p => p && typeof p.modelId === 'string' ? { ...p, modelId: resolve(p.modelId) } : p)
    : raw.profiles };
  const config = validateOmniConfig(normalized, settings.customModels ?? []);
  const credentials = new Map<string, { accountId: string; quotaGroup: string }>();
  for (const profile of config.profiles) {
    const reference = settings.customModels!.find(m => m.id === profile.modelId)!.apiKey;
    if (!reference) continue;
    const previous = credentials.get(reference);
    if (previous && (previous.accountId !== profile.accountId || previous.quotaGroup !== profile.quotaGroup)) {
      throw new Error('Omni profiles sharing credentials must share accountId and quotaGroup');
    }
    credentials.set(reference, profile);
  }
  return config;
}

/** A total per-attempt deadline, independent of byte activity/stream idle timeout. */
export function withOmniTimeout(provider: ModelProvider, timeoutMs: number): ModelProvider {
  return { id: provider.id, async complete(request, signal, delta) {
    signal.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new ProviderError('Omni request timed out', true)), timeoutMs);
    const combined = AbortSignal.any([signal, timeout.signal]);
    try { return await abortable(provider.complete(request, combined, text => { if (!combined.aborted) delta?.(text); }), combined); }
    finally { clearTimeout(timer); }
  } };
}

const clock: Clock = {
  now: Date.now, random: Math.random,
  async sleep(ms, signal) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(finish, ms);
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
    });
  },
};

/** One scheduler per execution; facades/role models share its health but never its event sink. */
export function configuredOmni(settings: ExecSettings, config: OmniConfig,
  reasoningEffort?: string, emit?: (event: AgentEvent) => void, injectedClock = clock, shared?: OmniHealth): NonNullable<ProviderRuntime['omni']> {
  const health = shared ?? { clock: injectedClock,
    scheduler: createOmniScheduler(config, { clock: injectedClock, eligible: eligibleProfiles }),
    resolvedKeys: new Map<string, { accountId: string; quotaGroup: string }>(),
  };
  injectedClock = health.clock;
  const models = new Map((settings.customModels ?? []).map(m => [m.id, Object.freeze({ ...m })]));
  const profiles = new Map(config.profiles.map(p => [p.modelId, p]));
  const resolvedKeys = health.resolvedKeys;
  const resolve = (model: CustomModelConfig): ModelProvider => {
    // Read only after the scheduler has selected an eligible profile. Never cache credentials on settings.
    const variable = model.apiKey && /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(model.apiKey);
    const apiKey = variable ? process.env[variable[1]!] : undefined;
    if (variable && !apiKey?.trim()) throw new ProviderError('Omni credential unavailable', false, false, undefined,
      { status: 401, contextLimit: false });
    if (apiKey) {
      const profile = profiles.get(model.id)!;
      const previous = resolvedKeys.get(apiKey);
      if (previous && (previous.accountId !== profile.accountId || previous.quotaGroup !== profile.quotaGroup)) {
        throw new ProviderError('Omni duplicate credential has inconsistent quota identity', false, false, undefined,
          { status: 401, contextLimit: false });
      }
      resolvedKeys.set(apiKey, profile);
    }
    return createOpenAICompatibleProvider({ model: model.model, baseUrl: model.baseUrl, apiKey,
      maxOutputTokens: model.maxOutputTokens, reasoningEffort,
      streamIdleMs: model.streamIdleMs ?? settings.streamIdleMs,
      readHttpFailure: (response) => readHttpFailure(response, injectedClock.now()) });
  };
  const provider = createOmniProvider(config, {
    clock: injectedClock, scheduler: health.scheduler,
    classify: classifyOmniFailure, eligible: eligibleProfiles, emit,
    async resolveLeaf(id, signal) {
      signal.throwIfAborted();
      return withOmniTimeout(resolve(models.get(id)!), config.requestTimeoutMs);
    },
    estimateRequest(request) {
      const images = request.messages.some(m => Array.isArray(m.content) && m.content.some(part => part.type === 'image_url'));
      // Engine estimate is bytes / 4. Use full serialized byte count plus 256 tokens of slack here.
      // Image token cost is unknown: exclude before credentials/HTTP instead of guessing.
      return { tools: request.tools.length > 0, images, maxOutputTokens: request.maxOutputTokens,
        estimatedInputTokens: images ? Infinity : estimatedTokens(request.messages, request.tools) * 4 + 256 };
    },
  });
  return { provider, health };
}
