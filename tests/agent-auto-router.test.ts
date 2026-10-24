import { describe, expect, test } from 'bun:test';
import { createAutoProvider, buildRoutingContext } from '../src/agent/providers/auto.ts';
import { configuredProviders } from '../src/agent/settings.ts';
import { ProviderError } from '../src/agent/provider.ts';
import { listAgentTools } from '../src/agent/engine.ts';
import type { AgentEvent, ModelProvider, ModelRequest, ModelTurn } from '../src/agent/types.ts';
import type { AutoRouterConfig, RoutingContext, RoutingDecision } from '../src/agent/router/types.ts';

const turn: ModelTurn = { text: 'ok', toolCalls: [], finishReason: 'stop' };
const config: AutoRouterConfig = {
  classifierModel: 'cls', retriesPerModel: 3,
  candidates: [
    { modelId: 'cheap', description: 'small', relativeCost: 1, supportsImages: false },
    { modelId: 'mid', description: 'medium', relativeCost: 2, supportsImages: true },
    { modelId: 'big', description: 'large', relativeCost: 3, supportsImages: true },
  ],
};
const req = (content: ModelRequest['messages'][number]['content'] = 'hola', extra: ModelRequest['messages'] = []): ModelRequest =>
  ({ messages: [{ role: 'user', content }, ...extra], tools: [], maxOutputTokens: 100 });
const stub = (id: string, fn: () => Promise<ModelTurn> | ModelTurn = () => turn): ModelProvider & { calls: number; lastRequest?: ModelRequest } => {
  const p = { id, calls: 0, lastRequest: undefined as ModelRequest | undefined, async complete(r: ModelRequest) { p.calls++; p.lastRequest = r; return fn(); } };
  return p;
};
const sig = () => new AbortController().signal;

function setup(opts: { providers?: Record<string, ModelProvider>; decision?: Partial<RoutingDecision>; surface?: RoutingContext['surface'] } = {}) {
  const events: AgentEvent[] = [], contexts: RoutingContext[] = [];
  const providers = { cls: stub('cls'), cheap: stub('cheap'), mid: stub('mid'), big: stub('big'), ...opts.providers };
  const route = async (_c: AutoRouterConfig, _p: ModelProvider | undefined, ctx: RoutingContext): Promise<RoutingDecision> => {
    contexts.push(ctx);
    const base = { modelId: ctx.imagesPresent ? 'mid' : 'cheap', reason: 'routine' as const, fallbacks: ['mid', 'big'].filter(m => m !== (ctx.imagesPresent ? 'mid' : 'cheap')),
      scores: {}, classifierMs: 1, ...opts.decision };
    return base;
  };
  const order = ['cheap', 'mid', 'big'];
  const upgradeTarget = (cur: string, _c: unknown, avail: Set<string>) => order.slice(order.indexOf(cur) + 1).find(m => avail.has(m));
  const auto = createAutoProvider({ config, providers, route, upgradeTarget, surface: opts.surface ?? 'exec', onEvent: e => events.push(e),
    sleep: async () => {}, random: () => 1 });
  return { auto, providers: providers as Record<string, ReturnType<typeof stub>>, events, contexts };
}

describe('auto provider', () => {
  test('id is auto and the decision is fixed on turn 2', async () => {
    const { auto, events, contexts, providers } = setup();
    expect(auto.id).toBe('auto');
    await auto.complete(req(), sig());
    await auto.complete(req(), sig());
    expect(contexts).toHaveLength(1);
    expect(providers.cheap!.calls).toBe(2);
    expect(auto.currentModelId).toBe('cheap');
    expect(events.filter(e => e.type === 'model_routed')).toHaveLength(1);
  });

  test('429 retries N times then rotates with retry_exhausted', async () => {
    const cheap = stub('cheap', () => { throw new ProviderError('Model HTTP 429', true); });
    const { auto, events, providers } = setup({ providers: { cheap } });
    await auto.complete(req(), sig());
    expect(cheap.calls).toBe(3);
    expect(providers.mid!.calls).toBe(1);
    expect(auto.currentModelId).toBe('mid');
    expect(events.find(e => e.type === 'model_transition')).toMatchObject({ from: 'cheap', to: 'mid', source: 'retry_exhausted' });
    await auto.complete(req(), sig());
    expect(cheap.calls).toBe(3); // rotation sticks
  });

  test('400 rotates immediately', async () => {
    const cheap = stub('cheap', () => { throw new ProviderError('Model HTTP 400'); });
    const { auto, events } = setup({ providers: { cheap } });
    await auto.complete(req(), sig());
    expect(cheap.calls).toBe(1);
    expect(events.find(e => e.type === 'model_transition')).toMatchObject({ source: 'model_specific' });
  });

  test('context limit and auth errors propagate without rotating', async () => {
    for (const err of [new ProviderError('Model HTTP 400', false, true), new ProviderError('Model HTTP 401')]) {
      const cheap = stub('cheap', () => { throw err; });
      const { auto, providers } = setup({ providers: { cheap } });
      await expect(auto.complete(req(), sig())).rejects.toBe(err);
      expect(providers.mid!.calls).toBe(0);
    }
  });

  test('a cut after a delta is an error without retry or rotation', async () => {
    const cheap: ModelProvider & { calls: number } = { id: 'cheap', calls: 0, async complete(_r, _s, delta) {
      cheap.calls++; delta?.('par'); throw new ProviderError('Model stream stalled', true);
    } };
    const { auto, providers } = setup({ providers: { cheap } });
    await expect(auto.complete(req(), sig(), () => {})).rejects.toThrow(/stream cut/);
    expect(cheap.calls).toBe(1);
    expect(providers.mid!.calls).toBe(0);
  });

  test('exhausting every model yields a non retryable error', async () => {
    const fail = () => { throw new ProviderError('Model HTTP 500', true); };
    const { auto } = setup({ providers: { cheap: stub('cheap', fail), mid: stub('mid', fail), big: stub('big', fail) } });
    const err = await auto.complete(req(), sig()).catch(e => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
  });

  test('images with a non-vision model reclassify with source vision', async () => {
    const { auto, events, contexts } = setup();
    await auto.complete(req(), sig());
    await auto.complete(req([{ type: 'text', text: 'mira' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }]), sig());
    expect(contexts).toHaveLength(2);
    expect(contexts[1]!.imagesPresent).toBe(true);
    expect(auto.currentModelId).toBe('mid');
    expect(events.find(e => e.type === 'model_transition')).toMatchObject({ from: 'cheap', to: 'mid', source: 'vision' });
  });

  test('upgrade climbs the ladder and canUpgrade turns false at the top', async () => {
    const { auto, events } = setup();
    expect(auto.canUpgrade()).toBe(false); // nothing routed yet
    await auto.complete(req(), sig());
    expect(auto.canUpgrade()).toBe(true);
    expect(auto.upgrade()).toEqual({ from: 'cheap', to: 'mid' });
    expect(auto.upgrade()).toEqual({ from: 'mid', to: 'big' });
    expect(auto.canUpgrade()).toBe(false);
    expect(auto.upgrade()).toBeUndefined();
    expect(events.filter(e => e.type === 'model_transition').map(e => e.source)).toEqual(['self_upgrade', 'self_upgrade']);
  });

  test('UpgradeSessionModel is visible only while an upgrade exists', async () => {
    const { auto, providers } = setup();
    const names = () => listAgentTools({ prompt: '', cwd: process.cwd(), provider: auto }).map(t => t.schema.function.name);
    // Offered before the router decides
    expect(auto.currentModelId).toBeUndefined();
    expect(names()).toContain('UpgradeSessionModel');

    const toolWithUpgrade = { type: 'function' as const, function: { name: 'UpgradeSessionModel', description: '', parameters: {} } };
    const readTool = { type: 'function' as const, function: { name: 'Read', description: '', parameters: {} } };
    const reqWithUpgrade: ModelRequest = {
      messages: [{ role: 'user', content: 'hola' }],
      tools: [toolWithUpgrade, readTool],
      maxOutputTokens: 100,
    };

    // Offered after routing to a model that can upgrade
    await auto.complete(reqWithUpgrade, sig());
    expect(auto.currentModelId).toBe('cheap');
    expect(auto.canUpgrade()).toBe(true);
    expect(names()).toContain('UpgradeSessionModel');
    expect(providers.cheap!.lastRequest?.tools?.map(t => t.function.name)).toContain('UpgradeSessionModel');

    // Reaching the top tier
    auto.upgrade(); auto.upgrade();
    expect(auto.currentModelId).toBe('big');
    expect(auto.canUpgrade()).toBe(false);

    // Registry drops it once at top
    expect(names()).not.toContain('UpgradeSessionModel');

    // And provider drops it from request.tools sent to the top model
    await auto.complete(reqWithUpgrade, sig());
    expect(providers.big!.lastRequest?.tools?.map(t => t.function.name)).not.toContain('UpgradeSessionModel');
    expect(providers.big!.lastRequest?.tools?.map(t => t.function.name)).toContain('Read');

    expect(listAgentTools({ prompt: '', cwd: process.cwd(), provider: stub('x') }).map(t => t.schema.function.name)).not.toContain('UpgradeSessionModel');
  });

  test('a subagent provider classifies on its own with surface subagent', async () => {
    const { auto, contexts } = setup();
    await auto.complete(req(), sig());
    const child = auto.forSubagent();
    expect(child.currentModelId).toBeUndefined();
    await child.complete(req('hijo'), sig());
    expect(contexts).toHaveLength(2);
    expect(contexts[1]).toMatchObject({ surface: 'subagent', isSubagent: true, userMessage: 'hijo' });
  });

  test('routing context reflects turn number, tools and failed tool calls', () => {
    const ctx = buildRoutingContext({ messages: [
      { role: 'user', content: 'a' }, { role: 'assistant', content: null }, { role: 'user', content: 'b' },
      { role: 'tool', tool_call_id: '1', content: 'Error: boom' }], tools: [{ type: 'function', function: { name: 'Read', description: '', parameters: {} } }], maxOutputTokens: 1 }, 'chat', false);
    expect(ctx).toMatchObject({ userMessage: 'b', turnNumber: 2, surface: 'chat', hasFailedToolCalls: true, toolNames: ['Read'], imagesPresent: false });
  });

  test('turnNumber counts user turns rather than individual user messages', () => {
    // Initial turn with workspace setup user message + prompt user message: turnNumber must be 1
    const ctx1 = buildRoutingContext({
      messages: [
        { role: 'system', content: 'system instructions' },
        { role: 'user', content: 'Workspace: /home/repo\nMode: auto; autonomy: high.' },
        { role: 'user', content: 'List files in current directory' },
      ],
      tools: [],
      maxOutputTokens: 100,
    }, 'exec', false);
    expect(ctx1.turnNumber).toBe(1);
    expect(ctx1.userMessage).toBe('List files in current directory');

    // Turn 2 after assistant response: turnNumber must be 2
    const ctx2 = buildRoutingContext({
      messages: [
        { role: 'system', content: 'system instructions' },
        { role: 'user', content: 'Workspace: /home/repo' },
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'Files listed.' },
        { role: 'user', content: 'Now delete file.txt' },
      ],
      tools: [],
      maxOutputTokens: 100,
    }, 'exec', false);
    expect(ctx2.turnNumber).toBe(2);
    expect(ctx2.userMessage).toBe('Now delete file.txt');
  });
});

describe('settings wiring', () => {
  const settings = {
    customModels: ['cls', 'cheap', 'mid', 'big'].map(id => ({ id, model: id, provider: 'generic-chat-completion-api' as const })),
  };
  const core = { route: async () => { throw new Error('unused'); }, upgradeTarget: () => undefined };

  test('-m auto without autoRouter fails with a clear error', () => {
    expect(() => configuredProviders({ ...settings, modelId: 'auto' }, { model: 'auto' }, undefined, core)).toThrow(/autoRouter/);
  });

  test('-m auto with autoRouter creates the auto provider', () => {
    const { providers, defaultModelId } = configuredProviders({ ...settings, modelId: 'auto', autoRouter: config }, { model: 'auto' }, undefined, core);
    expect(defaultModelId).toBe('auto');
    expect(providers.auto!.id).toBe('auto');
  });

  test('autoRouter naming an unconfigured model is rejected', () => {
    const bad = { ...config, candidates: [...config.candidates, { modelId: 'ghost', description: '', relativeCost: 9, supportsImages: false }] };
    expect(() => configuredProviders({ ...settings, modelId: 'auto', autoRouter: bad }, { model: 'auto' }, undefined, core)).toThrow(/ghost/);
  });
});
