import { expect, test } from 'bun:test';
import type { ModelProvider, ModelRequest, ModelTurn } from '../src/agent/types.ts';
import type { RoutedAttempt, RoutedAttemptPlan } from '../src/agent/omni/contracts.ts';
import { ProviderError, type SafeHttpFailure } from '../src/agent/transport.ts';
import { createRoutedProvider } from '../src/agent/providers/router.ts';
import { createAutoProvider } from '../src/agent/providers/auto.ts';
import { observeAttemptOutput, retryDelayMs } from '../src/agent/providers/attempt-policy.ts';

const request: ModelRequest = { messages: [{ role: 'user', content: 'fixture' }], tools: [], maxOutputTokens: 10 };
const turn: ModelTurn = { text: 'done', finishReason: 'stop', toolCalls: [] };
const signal = () => new AbortController().signal;
const handled = () => Object.assign(new ProviderError('HTTP 429', true), { routingHandled: true as const });
const leaf = (id: string, complete: ModelProvider['complete']): ModelProvider => ({ id, complete });
function fixture(providers: ModelProvider[]) {
  const settled: Array<Parameters<RoutedAttempt['settle']>[0]> = [], released: string[] = [];
  let selected = 0;
  const exhausted = Object.assign(new ProviderError('fixture exhausted'), { routingHandled: true as const });
  const plan: RoutedAttemptPlan = {
    id: 'omni',
    async next() {
      const provider = providers[selected++];
      return provider ? { id: provider.id, provider, settle: result => { settled.push(result); }, release: () => { released.push(provider.id); } } : undefined;
    },
    exhausted: () => exhausted,
  };
  return { provider: createRoutedProvider(plan), settled, released, exhausted, selections: () => selected };
}

test('HTTP metadata is optional and the four legacy error arguments retain their meaning', () => {
  const old = new ProviderError('fixture', true, true, 1200);
  expect([old.retryable, old.contextLimit, old.retryAfterMs, old.http]).toEqual([true, true, 1200, undefined]);
  const http: SafeHttpFailure = { status: 429, code: 'insufficient_quota', retryAt: 3600000, contextLimit: false };
  expect(new ProviderError('fixture', true, false, undefined, http).http).toBe(http);
});

test('observation preserves absent legacy callback and tracks nonempty output privately only when opted in', () => {
  expect(observeAttemptOutput().delta).toBeUndefined();
  const output = observeAttemptOutput(undefined, true);
  output.delta!(''); expect(output.committed).toBe(false);
  output.delta!('partial'); expect(output.committed).toBe(true);
  expect(retryDelayMs(1, () => 0)).toBe(250);
  expect(retryDelayMs(8, () => 1)).toBe(8000);
  expect(retryDelayMs(1, () => 0, 5000)).toBe(5000);
});

test('dynamic hook settles and releases each attempt, forwarding request and output unchanged', async () => {
  const fail = new ProviderError('HTTP 429', true);
  const f = fixture([
    leaf('a', async r => { expect(r).toBe(request); throw fail; }),
    leaf('b', async (r, _s, delta) => { expect(r).toBe(request); delta?.('done'); return turn; }),
  ]);
  const chunks: string[] = [];
  expect(await f.provider.complete(request, signal(), t => chunks.push(t))).toBe(turn);
  expect(f.settled).toEqual([{ ok: false, error: fail, committed: false }, { ok: true }]);
  expect(f.released).toEqual(['a', 'b']); expect(chunks).toEqual(['done']);
});

test('dynamic hook does not select another attempt after private partial output', async () => {
  const fail = new ProviderError('HTTP 503', true);
  const f = fixture([leaf('a', async (_r, _s, delta) => { delta!('partial'); throw fail; }), leaf('b', async () => turn)]);
  await expect(f.provider.complete(request, signal())).rejects.toBe(fail);
  expect(f.selections()).toBe(1); expect(f.released).toEqual(['a']);
  expect(f.settled).toEqual([{ ok: false, error: fail, committed: true }]);
});

test('abort after acquisition releases the lease without invoking or settling upstream', async () => {
  const controller = new AbortController(), reason = new Error('cancel');
  let calls = 0, releases = 0, settles = 0;
  const plan: RoutedAttemptPlan = { id: 'omni', exhausted: () => new Error('unused'), async next() {
    controller.abort(reason);
    return { id: 'a', provider: leaf('a', async () => { calls++; return turn; }), settle: () => { settles++; }, release: () => { releases++; } };
  } };
  await expect(createRoutedProvider(plan).complete(request, controller.signal)).rejects.toBe(reason);
  expect([calls, releases, settles]).toEqual([0, 1, 0]);
});

test('abort during attempt preserves cancellation reason and releases without another selection', async () => {
  const controller = new AbortController(), reason = new Error('cancel');
  const f = fixture([leaf('a', async () => { controller.abort(reason); throw new Error('late failure'); }), leaf('b', async () => turn)]);
  await expect(f.provider.complete(request, controller.signal)).rejects.toBe(reason);
  expect(f.selections()).toBe(1); expect(f.released).toEqual(['a']); expect(f.settled).toEqual([]);
});

for (const rejects of [false, true]) {
  test(`abort during selection preserves cancellation when next ${rejects ? 'rejects' : 'returns no attempt'}`, async () => {
    const controller = new AbortController(), reason = new Error('cancel');
    let exhausted = 0;
    const plan: RoutedAttemptPlan = {
      id: 'omni',
      exhausted: () => { exhausted++; return new Error('exhausted'); },
      async next() {
        controller.abort(reason);
        if (rejects) throw new Error('late selection failure');
        return undefined;
      },
    };
    await expect(createRoutedProvider(plan).complete(request, controller.signal)).rejects.toBe(reason);
    expect(exhausted).toBe(0);
  });
}

test('settlement failure is terminal and still releases the acquired attempt', async () => {
  const failure = new Error('hook failed'); let released = 0, selections = 0;
  const plan: RoutedAttemptPlan = { id: 'omni', exhausted: () => new Error('unused'), async next() {
    selections++;
    return { id: 'a', provider: leaf('a', async () => turn), settle: () => { throw failure; }, release: () => { released++; } };
  } };
  await expect(createRoutedProvider(plan).complete(request, signal())).rejects.toBe(failure);
  expect([released, selections]).toEqual([1, 1]);
});

test('exhausted plan exposes its exact error without creating an upstream attempt', async () => {
  const f = fixture([]);
  await expect(f.provider.complete(request, signal())).rejects.toBe(f.exhausted);
  expect(f.released).toEqual([]);
});

test('terminal delegated errors cannot trigger legacy static or auto fallbacks', async () => {
  const failure = handled(); let fallbackCalls = 0, sleeps = 0;
  const primary = leaf('a', async () => { throw failure; });
  const fallback = leaf('b', async () => { fallbackCalls++; return turn; });
  await expect(createRoutedProvider(primary, [fallback]).complete(request, signal())).rejects.toBe(failure);
  const auto = createAutoProvider({
    config: { classifierModel: 'judge', candidates: ['a', 'b'].map(modelId => ({ modelId, description: '', relativeCost: 1, supportsImages: false })) },
    providers: { a: primary, b: fallback, judge: fallback }, surface: 'exec',
    route: async () => ({ modelId: 'a', fallbacks: ['b'], scores: {}, classifierMs: 0, reason: 'routine' }),
    upgradeTarget: () => undefined, sleep: async () => { sleeps++; },
  });
  await expect(auto.complete(request, signal())).rejects.toBe(failure);
  expect([fallbackCalls, sleeps]).toEqual([0, 0]);
});
