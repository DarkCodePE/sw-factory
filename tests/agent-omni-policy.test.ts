import { describe, expect, test } from 'bun:test';
import type { OmniConfig, Needs, Profile, LeafDescriptor } from '../src/agent/omni/contracts.ts';
import {
  AVOID_PROVIDERS,
  AVOID_SNAPSHOT_DATE,
  AVOID_SNAPSHOT_REVISION,
  isAvoidEndpoint,
  isAvoidProvider,
  resolveCanonicalProvider,
} from '../src/agent/omni/catalog.ts';
import { effectiveTos, eligibleProfiles, isTosAdmissible } from '../src/agent/omni/policy.ts';
import { validateOmniConfig } from '../src/agent/omni/config.ts';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    modelId: 'test-model',
    providerId: 'test-provider',
    accountId: 'account-1',
    quotaGroup: 'group-1',
    costTier: 'free',
    tos: 'ok',
    acknowledgeTos: true,
    supportsTools: true,
    supportsImages: false,
    contextWindow: 32768,
    priority: 10,
    ...overrides,
  };
}

function makeConfig(profiles: readonly Profile[], overrides: Partial<OmniConfig> = {}): OmniConfig {
  return {
    version: 1,
    allowPaid: false,
    maxAttempts: 4,
    maxWaitMs: 15000,
    requestTimeoutMs: 30000,
    profiles,
    ...overrides,
  };
}

/**
 * Local offline runner double simulating router execution without network or tokens.
 */
function runRouterDouble(config: OmniConfig, needs: Needs, executorMap: Record<string, () => { ok: boolean }>) {
  const candidates = eligibleProfiles(config, needs);
  const calls: string[] = [];

  for (const candidate of candidates) {
    calls.push(candidate.modelId);
    const exec = executorMap[candidate.modelId];
    const res = exec ? exec() : { ok: true };
    if (res.ok) {
      return { success: true, chosen: candidate.modelId, calls };
    }
  }

  return { success: false, chosen: undefined, calls };
}

describe('Omni Catalog & Snapshot', () => {
  test('retains attributed and dated snapshot metadata from OmniRoute', () => {
    expect(AVOID_SNAPSHOT_REVISION).toBe('866c46d2339175a1aafc5455b8c3949910b2bd30');
    expect(AVOID_SNAPSHOT_DATE).toBe('2026-06-05');
    expect(AVOID_PROVIDERS.length).toBe(17);
  });

  test('canonicalizes known avoid provider aliases', () => {
    expect(resolveCanonicalProvider('antigravity')).toBe('agy');
    expect(resolveCanonicalProvider('agy')).toBe('agy');
    expect(resolveCanonicalProvider('xkiro')).toBe('kiro');
    expect(resolveCanonicalProvider('ddg')).toBe('duckduckgo-web');
    expect(resolveCanonicalProvider('fireworks-ai')).toBe('fireworks');
    expect(resolveCanonicalProvider('blackbox-ai')).toBe('blackbox');
    expect(resolveCanonicalProvider('featherless')).toBe('featherless-ai');
  });

  test('identifies avoid providers and prefixes', () => {
    expect(isAvoidProvider('fireworks')).toBe(true);
    expect(isAvoidProvider('fireworks/llama-3')).toBe(true);
    expect(isAvoidProvider('antigravity')).toBe(true);
    expect(isAvoidProvider('modal')).toBe(true);
    expect(isAvoidProvider('coze')).toBe(true);
    expect(isAvoidProvider('groq')).toBe(false);
    expect(isAvoidProvider('mistral')).toBe(false);
  });

  test('identifies avoid hostnames and endpoints', () => {
    expect(isAvoidEndpoint('https://api.fireworks.ai/inference/v1')).toBe(true);
    expect(isAvoidEndpoint('https://fireworks.ai/v1')).toBe(true);
    expect(isAvoidEndpoint('http://api.modal.com/v1')).toBe(true);
    expect(isAvoidEndpoint('https://api.coze.com/open_api/v2/chat')).toBe(true);
    expect(isAvoidEndpoint('https://api.groq.com/openai/v1')).toBe(false);
    expect(isAvoidEndpoint('http://127.0.0.1:20128/v1')).toBe(false);
  });
});

describe('Effective ToS Determination', () => {
  test('avoid always wins even with explicit user ok and acknowledgeTos', () => {
    const profile = makeProfile({
      providerId: 'fireworks',
      tos: 'ok',
      acknowledgeTos: true,
    });
    expect(effectiveTos(profile, 'https://api.fireworks.ai/v1')).toBe('avoid');
    expect(isTosAdmissible(profile)).toBe(false);
  });

  test('avoid endpoint overrides non-avoid provider name', () => {
    const profile = makeProfile({
      providerId: 'my-custom-endpoint',
      tos: 'ok',
      acknowledgeTos: true,
    });
    expect(effectiveTos(profile, 'https://api.fireworks.ai/v1')).toBe('avoid');
  });

  test('requires acknowledgeTos: true for ok, caution, ambiguous', () => {
    // ok
    expect(effectiveTos(makeProfile({ tos: 'ok', acknowledgeTos: true }), 'https://api.example.com/v1')).toBe('ok');
    expect(effectiveTos(makeProfile({ tos: 'ok', acknowledgeTos: false }), 'https://api.example.com/v1')).toBe('unknown');
    expect(effectiveTos(makeProfile({ tos: 'ok', acknowledgeTos: undefined }), 'https://api.example.com/v1')).toBe('unknown');

    // caution
    expect(effectiveTos(makeProfile({ tos: 'caution', acknowledgeTos: true }), 'https://api.example.com/v1')).toBe('caution');
    expect(effectiveTos(makeProfile({ tos: 'caution', acknowledgeTos: false }), 'https://api.example.com/v1')).toBe('unknown');

    // ambiguous
    expect(effectiveTos(makeProfile({ tos: 'ambiguous', acknowledgeTos: true }), 'https://api.example.com/v1')).toBe('ambiguous');
    expect(effectiveTos(makeProfile({ tos: 'ambiguous', acknowledgeTos: false }), 'https://api.example.com/v1')).toBe('unknown');

    // unknown
    expect(effectiveTos(makeProfile({ tos: 'unknown', acknowledgeTos: true }), 'https://api.example.com/v1')).toBe('unknown');
  });
});

describe('Acceptance Criteria (Section 8)', () => {
  /**
   * TOS-01 avoid is never contacted
   * avoid primero, alias avoid y usuario intentando sobreescribirlo: 0 llamadas a resolver/HTTP; permitido sí se ejecuta.
   */
  test('TOS-01 avoid is never contacted', () => {
    const rawConfig = {
      version: 1,
      profiles: [
        // 1. Direct avoid provider with user trying to override with tos: ok
        {
          modelId: 'avoid-direct',
          providerId: 'fireworks',
          accountId: 'acc-1',
          quotaGroup: 'qg-1',
          costTier: 'free',
          tos: 'ok',
          acknowledgeTos: true,
          supportsTools: true,
          supportsImages: false,
          contextWindow: 32768,
          priority: 5,
        },
        // 2. Avoid alias (antigravity -> agy)
        {
          modelId: 'avoid-alias',
          providerId: 'antigravity',
          accountId: 'acc-2',
          quotaGroup: 'qg-2',
          costTier: 'free',
          tos: 'ok',
          acknowledgeTos: true,
          supportsTools: true,
          supportsImages: false,
          contextWindow: 32768,
          priority: 8,
        },
        // 3. Avoid endpoint host with generic provider name
        {
          modelId: 'avoid-host',
          providerId: 'custom-endpoint',
          accountId: 'acc-3',
          quotaGroup: 'qg-3',
          costTier: 'free',
          tos: 'ok',
          acknowledgeTos: true,
          supportsTools: true,
          supportsImages: false,
          contextWindow: 32768,
          priority: 9,
        },
        // 4. Permitted provider
        {
          modelId: 'permitted-local',
          providerId: 'local-ollama',
          accountId: 'acc-4',
          quotaGroup: 'qg-4',
          costTier: 'free',
          tos: 'ok',
          acknowledgeTos: true,
          supportsTools: true,
          supportsImages: false,
          contextWindow: 32768,
          priority: 20,
        },
      ],
    };

    const leaves: LeafDescriptor[] = [
      { id: 'avoid-direct', provider: 'generic-chat-completion-api', baseUrl: 'https://api.fireworks.ai/v1', model: 'm1', apiKey: '${FW_KEY}' } as any,
      { id: 'avoid-alias', provider: 'generic-chat-completion-api', baseUrl: 'https://api.agy.internal/v1', model: 'm2', apiKey: '${AGY_KEY}' } as any,
      { id: 'avoid-host', provider: 'generic-chat-completion-api', baseUrl: 'https://api.modal.com/v1', model: 'm3', apiKey: '${MODAL_KEY}' } as any,
      { id: 'permitted-local', provider: 'generic-chat-completion-api', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama-3' },
    ];

    const config = validateOmniConfig(rawConfig, leaves);

    // Verify config normalized avoid profiles to tos: 'avoid'
    expect(config.profiles.find(p => p.modelId === 'avoid-direct')!.tos).toBe('avoid');
    expect(config.profiles.find(p => p.modelId === 'avoid-alias')!.tos).toBe('avoid');
    expect(config.profiles.find(p => p.modelId === 'avoid-host')!.tos).toBe('avoid');
    expect(config.profiles.find(p => p.modelId === 'permitted-local')!.tos).toBe('ok');

    // Run eligibleProfiles
    const needs: Needs = { tools: true, images: false, estimatedInputTokens: 100, maxOutputTokens: 200 };
    const eligible = eligibleProfiles(config, needs);

    // Only permitted-local must be eligible; none of the avoid targets
    expect(eligible.map(p => p.modelId)).toEqual(['permitted-local']);

    // Run router double: 0 calls to avoid targets, exactly 1 call to permitted
    const executors: Record<string, () => { ok: boolean }> = {
      'avoid-direct': () => { throw new Error('Avoid target must NEVER be called'); },
      'avoid-alias': () => { throw new Error('Avoid target must NEVER be called'); },
      'avoid-host': () => { throw new Error('Avoid target must NEVER be called'); },
      'permitted-local': () => ({ ok: true }),
    };

    const result = runRouterDouble(config, needs, executors);
    expect(result.success).toBe(true);
    expect(result.chosen).toBe('permitted-local');
    expect(result.calls).toEqual(['permitted-local']);
  });

  /**
   * CAP-01 tools are a hard requirement
   * peticiones con tools no alcanzan false/unknown; todos incapaces → agotado con 0 llamadas. Texto simple prioriza tools.
   */
  test('CAP-01 tools are a hard requirement', () => {
    const noToolsProfile = makeProfile({
      modelId: 'model-no-tools',
      supportsTools: false,
      priority: 5,
    });
    const toolsProfile = makeProfile({
      modelId: 'model-with-tools',
      supportsTools: true,
      priority: 15,
    });

    const config = makeConfig([noToolsProfile, toolsProfile]);

    // 1. Request with tools: false is not reached, only toolsProfile is eligible
    const needsWithTools: Needs = { tools: true, images: false, estimatedInputTokens: 50, maxOutputTokens: 50 };
    const eligibleWithTools = eligibleProfiles(config, needsWithTools);
    expect(eligibleWithTools.map(p => p.modelId)).toEqual(['model-with-tools']);

    const execMap: Record<string, () => { ok: boolean }> = {
      'model-no-tools': () => { throw new Error('Model without tools must not be called when tools are required'); },
      'model-with-tools': () => ({ ok: true }),
    };
    const resWithTools = runRouterDouble(config, needsWithTools, execMap);
    expect(resWithTools.success).toBe(true);
    expect(resWithTools.calls).toEqual(['model-with-tools']);

    // 2. All incapable -> exhausted with 0 calls
    const incapableConfig = makeConfig([noToolsProfile]);
    const eligibleIncapable = eligibleProfiles(incapableConfig, needsWithTools);
    expect(eligibleIncapable).toEqual([]);

    const resIncapable = runRouterDouble(incapableConfig, needsWithTools, execMap);
    expect(resIncapable.success).toBe(false);
    expect(resIncapable.calls).toEqual([]);

    // 3. Simple text (tools: false) prioritizes models with supportsTools: true
    // Even though model-no-tools has higher priority (priority: 5) than model-with-tools (priority: 15),
    // within the tier, supportsTools: true is prioritized!
    const needsSimpleText: Needs = { tools: false, images: false, estimatedInputTokens: 50, maxOutputTokens: 50 };
    const eligibleSimpleText = eligibleProfiles(config, needsSimpleText);
    expect(eligibleSimpleText.map(p => p.modelId)).toEqual(['model-with-tools', 'model-no-tools']);
  });

  /**
   * PAY-01 paid requires opt in
   * gratuitos agotados, pago disponible: 0 llamadas paid con false; exactamente una con true. Pool vacío no se amplía.
   */
  test('PAY-01 paid requires opt in', () => {
    const freeProfile = makeProfile({
      modelId: 'free-model',
      costTier: 'free',
      priority: 10,
    });
    const paidProfile = makeProfile({
      modelId: 'paid-model',
      costTier: 'paid',
      priority: 20,
    });

    const needs: Needs = { tools: true, images: false, estimatedInputTokens: 50, maxOutputTokens: 50 };

    // 1. allowPaid: false -> 0 calls to paid; free model fails -> exhausted with 0 paid calls
    const configNoPaid = makeConfig([freeProfile, paidProfile], { allowPaid: false });
    const eligibleNoPaid = eligibleProfiles(configNoPaid, needs);
    expect(eligibleNoPaid.map(p => p.modelId)).toEqual(['free-model']);

    let paidCalls = 0;
    const execMap: Record<string, () => { ok: boolean }> = {
      'free-model': () => ({ ok: false }),
      'paid-model': () => { paidCalls++; return { ok: true }; },
    };

    const resNoPaid = runRouterDouble(configNoPaid, needs, execMap);
    expect(resNoPaid.success).toBe(false);
    expect(resNoPaid.calls).toEqual(['free-model']);
    expect(paidCalls).toBe(0);

    // Pool vacío no se amplía: only paid available and allowPaid: false -> empty pool
    const onlyPaidConfig = makeConfig([paidProfile], { allowPaid: false });
    expect(eligibleProfiles(onlyPaidConfig, needs)).toEqual([]);
    const resOnlyPaid = runRouterDouble(onlyPaidConfig, needs, execMap);
    expect(resOnlyPaid.success).toBe(false);
    expect(resOnlyPaid.calls).toEqual([]);
    expect(paidCalls).toBe(0);

    // 2. allowPaid: true -> free attempted first, then exactly one call to paid
    const configWithPaid = makeConfig([freeProfile, paidProfile], { allowPaid: true });
    const eligibleWithPaid = eligibleProfiles(configWithPaid, needs);
    expect(eligibleWithPaid.map(p => p.modelId)).toEqual(['free-model', 'paid-model']);

    const resWithPaid = runRouterDouble(configWithPaid, needs, execMap);
    expect(resWithPaid.success).toBe(true);
    expect(resWithPaid.chosen).toBe('paid-model');
    expect(resWithPaid.calls).toEqual(['free-model', 'paid-model']);
    expect(paidCalls).toBe(1);
  });

  test('context window capacity excludes insufficient models', () => {
    const smallModel = makeProfile({ modelId: 'small', contextWindow: 4096 });
    const largeModel = makeProfile({ modelId: 'large', contextWindow: 65536 });
    const config = makeConfig([smallModel, largeModel]);

    // Needs 8000 tokens total (6000 + 2000)
    const needs: Needs = { tools: false, images: false, estimatedInputTokens: 6000, maxOutputTokens: 2000 };
    const eligible = eligibleProfiles(config, needs);
    expect(eligible.map(p => p.modelId)).toEqual(['large']);
  });

  test('images requirement filters models without vision support', () => {
    const textOnly = makeProfile({ modelId: 'text-only', supportsImages: false });
    const vision = makeProfile({ modelId: 'vision', supportsImages: true });
    const config = makeConfig([textOnly, vision]);

    const needs: Needs = { tools: false, images: true, estimatedInputTokens: 100, maxOutputTokens: 100 };
    const eligible = eligibleProfiles(config, needs);
    expect(eligible.map(p => p.modelId)).toEqual(['vision']);
  });

  test('stable tie breaking preserves original declaration index', () => {
    const p1 = makeProfile({ modelId: 'p1', priority: 10, costTier: 'free', supportsTools: true });
    const p2 = makeProfile({ modelId: 'p2', priority: 10, costTier: 'free', supportsTools: true });
    const p3 = makeProfile({ modelId: 'p3', priority: 10, costTier: 'free', supportsTools: true });

    const config = makeConfig([p1, p2, p3]);
    const needs: Needs = { tools: true, images: false, estimatedInputTokens: 10, maxOutputTokens: 10 };
    const eligible = eligibleProfiles(config, needs);
    expect(eligible.map(p => p.modelId)).toEqual(['p1', 'p2', 'p3']);
  });
});
