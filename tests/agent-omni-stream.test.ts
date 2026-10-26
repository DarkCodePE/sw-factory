import { expect, test } from 'bun:test';
import { createOmniProvider } from '../src/agent/providers/omni.ts';
import { ProviderError } from '../src/agent/transport.ts';
import type { ModelProvider, ModelRequest, ModelTurn } from '../src/agent/types.ts';
import type { Choice, Clock, Lease, Needs, OmniConfig, Profile, SafeFailure, Scheduler } from '../src/agent/omni/contracts.ts';

const turn = (text = 'ok'): ModelTurn => ({ text, toolCalls: [], finishReason: 'stop' });
const toolTurn = (): ModelTurn => ({
  text: '',
  toolCalls: [
    { id: 'call_1', type: 'function', function: { name: 'Probe', arguments: '{"path":"a"}' } },
    { id: 'call_2', type: 'function', function: { name: 'Probe', arguments: '{"path":"b"}' } },
  ],
  finishReason: 'tool_calls',
});
const request: ModelRequest = { messages: [{ role: 'user', content: 'hola' }], tools: [], maxOutputTokens: 64 };
const toolRequest: ModelRequest = {
  ...request,
  tools: [{ type: 'function', function: { name: 'Probe', description: 'read a fixture', parameters: { type: 'object' } } }],
};
const freshSignal = () => new AbortController().signal;
const needsOf = (req: ModelRequest): Needs => ({
  tools: req.tools.length > 0, images: false, estimatedInputTokens: 10, maxOutputTokens: req.maxOutputTokens,
});
const profile = (over: Partial<Profile> = {}): Profile => ({
  modelId: 'free-a', providerId: 'custom-a', accountId: 'account-a', quotaGroup: 'org-a',
  costTier: 'free', tos: 'ok', acknowledgeTos: true, supportsTools: true, supportsImages: false,
  contextWindow: 32768, priority: 10, ...over,
});
const config = (profiles: Profile[], over: Partial<OmniConfig> = {}): OmniConfig => ({
  version: 1, allowPaid: false, maxAttempts: 4, maxWaitMs: 15000, requestTimeoutMs: 30000, profiles, ...over,
});
const leaf = (id: string, complete: ModelProvider['complete']): ModelProvider => ({ id, complete });
const lease = (id: string, target: Profile): Lease => ({ id, profile: target });

function scriptedScheduler(choose: () => Choice) {
  const settled: Array<{ lease: Lease; result: { ok: true } | { ok: false; failure: SafeFailure } }> = [];
  const released: string[] = [];
  const scheduler: Scheduler = {
    select: choose,
    settle: (target, result) => { settled.push({ lease: target, result }); },
    release: target => { if (!released.includes(target.id)) released.push(target.id); },
  };
  return { scheduler, settled, released };
}

const queue = (...leases: Lease[]) => {
  let index = 0;
  return (): Choice => index < leases.length
    ? { kind: 'attempt', lease: leases[index++]! }
    : { kind: 'exhausted' };
};

const fakeClock = (): Clock => {
  let now = 1_000_000;
  return { now: () => now, random: () => 0, sleep: async (ms, signal) => { if (signal.aborted) throw signal.reason; now += ms; } };
};

const truncated = (): ProviderError => new ProviderError('Model HTTP 503', true, false, undefined, {
  status: 503, contextLimit: false,
});

test('partial output never rotates', async () => {
  const profiles = [
    profile({ modelId: 'free-a', priority: 10 }),
    profile({ modelId: 'free-b', providerId: 'custom-b', accountId: 'account-b', quotaGroup: 'org-b', priority: 20 }),
  ];
  const scoped = scriptedScheduler(queue(lease('lease-a', profiles[0]!), lease('lease-b', profiles[1]!)));
  const calls: string[] = [];
  const chunks: string[] = [];
  const omni = createOmniProvider(config(profiles), {
    scheduler: scoped.scheduler,
    clock: fakeClock(),
    resolveLeaf: async modelId => {
      calls.push(modelId);
      if (modelId === 'free-a') {
        return leaf(modelId, async (_req, _signal, delta) => { delta?.('partial answer'); throw truncated(); });
      }
      return leaf(modelId, async () => turn('second model'));
    },
    estimateRequest: needsOf,
  });

  const error = await omni.complete(request, freshSignal(), text => chunks.push(text)).catch(e => e) as ProviderError & { routingHandled?: boolean };

  expect(error).toBeInstanceOf(ProviderError);
  expect(error.routingHandled).toBe(true);
  expect(error.retryable).toBe(false);
  expect(calls).toEqual(['free-a']);
  expect(chunks).toEqual(['partial answer']);
  expect(error.message).not.toContain('partial answer');
  expect(scoped.released).toEqual(['lease-a']);

  // Even without a caller callback the private observation blocks the fallback.
  const silentScheduler = scriptedScheduler(queue(lease('lease-c', profile({ modelId: 'free-c' })), lease('lease-d', profile({ modelId: 'free-d' }))));
  const silentCalls: string[] = [];
  const silent = createOmniProvider(config([profile({ modelId: 'free-c' }), profile({ modelId: 'free-d' })]), {
    scheduler: silentScheduler.scheduler,
    clock: fakeClock(),
    resolveLeaf: async modelId => {
      silentCalls.push(modelId);
      if (modelId === 'free-c') {
        return leaf(modelId, async (_req, _signal, delta) => { delta?.('cut'); throw truncated(); });
      }
      return leaf(modelId, async () => turn('must not run'));
    },
    estimateRequest: needsOf,
  });
  const silentError = await silent.complete(request, freshSignal()).catch(e => e) as ProviderError & { routingHandled?: boolean };
  expect(silentError.routingHandled).toBe(true);
  expect(silentCalls).toEqual(['free-c']);
});

test('partial tools never execute', async () => {
  const executed: string[] = [];
  const engine = {
    /** Stand-in for the engine: the only component allowed to run a validated tool batch. */
    run(result: ModelTurn) { for (const call of result.toolCalls) executed.push(call.function.name); },
  };
  const profiles = [
    profile({ modelId: 'free-a', priority: 10 }),
    profile({ modelId: 'free-b', providerId: 'custom-b', accountId: 'account-b', quotaGroup: 'org-b', priority: 20 }),
  ];
  const scoped = scriptedScheduler(queue(lease('lease-a', profiles[0]!), lease('lease-b', profiles[1]!)));
  const calls: string[] = [];
  const omni = createOmniProvider(config(profiles), {
    scheduler: scoped.scheduler,
    clock: fakeClock(),
    resolveLeaf: async modelId => {
      calls.push(modelId);
      if (modelId === 'free-a') {
        // A partially assembled batch is discarded by the decoder; nothing is published.
        return leaf(modelId, async () => {
          throw new ProviderError('Incomplete tool batch: tools without tool_calls finish reason');
        });
      }
      return leaf(modelId, async () => toolTurn());
    },
    estimateRequest: needsOf,
  });

  const result = await omni.complete(toolRequest, freshSignal());

  expect(calls).toEqual(['free-a', 'free-b']);
  expect(result.toolCalls).toHaveLength(2);
  // The router never executes tools, and the discarded batch never reached the engine.
  expect(executed).toEqual([]);
  engine.run(result);
  expect(executed).toEqual(['Probe', 'Probe']);

  // Invalid transport JSON is terminal: it must not tour accounts or reach the executor.
  const invalidProfiles = [
    profile({ modelId: 'free-c', priority: 10 }),
    profile({ modelId: 'free-d', providerId: 'custom-d', accountId: 'account-d', quotaGroup: 'org-d', priority: 20 }),
  ];
  const invalidScheduler = scriptedScheduler(queue(lease('lease-c', invalidProfiles[0]!), lease('lease-d', invalidProfiles[1]!)));
  const invalidCalls: string[] = [];
  const invalid = createOmniProvider(config(invalidProfiles), {
    scheduler: invalidScheduler.scheduler,
    clock: fakeClock(),
    resolveLeaf: async modelId => {
      invalidCalls.push(modelId);
      if (modelId === 'free-c') {
        return leaf(modelId, async () => { throw new ProviderError('Malformed model SSE JSON'); });
      }
      return leaf(modelId, async () => toolTurn());
    },
    estimateRequest: needsOf,
  });
  const invalidError = await invalid.complete(toolRequest, freshSignal()).catch(e => e) as ProviderError & { routingHandled?: boolean };

  expect(invalidError).toBeInstanceOf(ProviderError);
  expect(invalidError.routingHandled).toBe(true);
  expect(invalidCalls).toEqual(['free-c']);
});
