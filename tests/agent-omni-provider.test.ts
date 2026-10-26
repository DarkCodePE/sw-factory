import { expect, test } from 'bun:test';
import { createOmniProvider } from '../src/agent/providers/omni.ts';
import { ProviderError } from '../src/agent/transport.ts';
import type { AgentEvent, ModelProvider, ModelRequest, ModelTurn } from '../src/agent/types.ts';
import type { Choice, Clock, Lease, Needs, OmniConfig, Profile, SafeFailure, Scheduler } from '../src/agent/omni/contracts.ts';

const turn = (text = 'ok'): ModelTurn => ({ text, toolCalls: [], finishReason: 'stop' });
const toolTurn = (): ModelTurn => ({
  text: '',
  toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'Probe', arguments: '{"path":"a"}' } }],
  finishReason: 'tool_calls',
});
const request = (tools: ModelRequest['tools'] = []): ModelRequest => ({
  messages: [{ role: 'user', content: 'hola' }], tools, maxOutputTokens: 64,
});
const toolRequest = (): ModelRequest => request([
  { type: 'function', function: { name: 'Probe', description: 'read a fixture', parameters: { type: 'object' } } },
]);
const freshSignal = () => new AbortController().signal;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}
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

/** Every scheduler here is a local double: no package B module is imported. */
function scriptedScheduler(choose: (ctx: { attempted: ReadonlySet<string>; remainingAttempts: number }) => Choice) {
  const settled: Array<{ lease: Lease; result: { ok: true } | { ok: false; failure: SafeFailure } }> = [];
  const released: string[] = [];
  const selected: string[] = [];
  const scheduler: Scheduler = {
    select: ctx => {
      const choice = choose(ctx);
      if (choice.kind === 'attempt') selected.push(choice.lease.id);
      return choice;
    },
    settle: (target, result) => { settled.push({ lease: target, result }); },
    release: target => { if (!released.includes(target.id)) released.push(target.id); },
  };
  return { scheduler, settled, released, selected };
}

const queue = (...leases: Lease[]) => {
  let index = 0;
  return (): Choice => index < leases.length
    ? { kind: 'attempt', lease: leases[index++]! }
    : { kind: 'exhausted' };
};

function fakeClock(start = 1_000_000) {
  let now = start;
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => now,
    random: () => 0,
    sleep: async (ms, signal) => {
      if (signal.aborted) throw signal.reason;
      sleeps.push(ms);
      now += ms;
      // Yield a macrotask so unrelated in-flight turns can settle; injecting the
      // timer keeps this clock fake (no real waits are measured).
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    },
  };
  return { clock, sleeps, start };
}

function resolver(providers: Record<string, ModelProvider>) {
  const calls: string[] = [];
  const resolveLeaf = async (modelId: string) => {
    calls.push(modelId);
    const provider = providers[modelId];
    if (!provider) throw new Error(`fixture leaf '${modelId}' is not configured`);
    return provider;
  };
  return { resolveLeaf, calls };
}

test('tools are a hard requirement', async () => {
  const incapable = profile({ modelId: 'free-a', supportsTools: false });
  const capable = profile({ modelId: 'free-b', providerId: 'custom-b', accountId: 'account-b', quotaGroup: 'org-b', priority: 20 });
  const first = scriptedScheduler(queue(lease('lease-a', incapable)));
  const doomed = resolver({});
  const noTools = createOmniProvider(config([incapable]), {
    scheduler: first.scheduler, clock: fakeClock().clock, resolveLeaf: doomed.resolveLeaf, estimateRequest: needsOf,
  });
  const error = await noTools.complete(toolRequest(), freshSignal()).catch(e => e) as ProviderError & { routingHandled?: boolean };

  expect(error).toBeInstanceOf(ProviderError);
  expect(error.routingHandled).toBe(true);
  expect(error.retryable).toBe(false);
  expect(doomed.calls).toEqual([]);
  expect(first.released).toEqual(['lease-a']);

  // A capable profile still serves the same tool turn; the incapable one is never contacted.
  const second = scriptedScheduler(queue(lease('lease-a', incapable), lease('lease-b', capable)));
  const mixed = resolver({ 'free-b': leaf('free-b', async () => toolTurn()) });
  const omni = createOmniProvider(config([incapable, capable]), {
    scheduler: second.scheduler, clock: fakeClock().clock, resolveLeaf: mixed.resolveLeaf, estimateRequest: needsOf,
  });
  const result = await omni.complete(toolRequest(), freshSignal());

  expect(result.toolCalls).toHaveLength(1);
  expect(result.toolCalls[0]!.function.name).toBe('Probe');
  expect(mixed.calls).toEqual(['free-b']);
  expect(second.released).toEqual(['lease-a', 'lease-b']);
});

test('paid requires opt in', async () => {
  const paid = profile({
    modelId: 'paid-c', providerId: 'custom-c', accountId: 'account-c', quotaGroup: 'org-c',
    costTier: 'paid', priority: 30, contextWindow: 65536,
  });
  const deniedScheduler = scriptedScheduler(queue(lease('lease-paid', paid)));
  const deniedCalls = resolver({ 'paid-c': leaf('paid-c', async () => turn('paid')) });
  const denied = createOmniProvider(config([paid], { allowPaid: false }), {
    scheduler: deniedScheduler.scheduler, clock: fakeClock().clock, resolveLeaf: deniedCalls.resolveLeaf, estimateRequest: needsOf,
  });
  const error = await denied.complete(request(), freshSignal()).catch(e => e) as ProviderError & { routingHandled?: boolean };

  expect(error).toBeInstanceOf(ProviderError);
  expect(error.routingHandled).toBe(true);
  expect(error.retryable).toBe(false);
  expect(deniedCalls.calls).toEqual([]);
  expect(deniedScheduler.released).toEqual(['lease-paid']);

  // Opt-in allows exactly one paid attempt.
  const allowedScheduler = scriptedScheduler(queue(lease('lease-paid', paid)));
  const allowedCalls = resolver({ 'paid-c': leaf('paid-c', async () => turn('paid')) });
  const allowed = createOmniProvider(config([paid], { allowPaid: true }), {
    scheduler: allowedScheduler.scheduler, clock: fakeClock().clock, resolveLeaf: allowedCalls.resolveLeaf, estimateRequest: needsOf,
  });
  expect((await allowed.complete(request(), freshSignal())).text).toBe('paid');
  expect(allowedCalls.calls).toEqual(['paid-c']);

  // An empty pool is never widened to unlisted destinations.
  const emptyScheduler = scriptedScheduler(() => ({ kind: 'exhausted' }));
  const emptyCalls = resolver({});
  const empty = createOmniProvider(config([paid], { allowPaid: true }), {
    scheduler: emptyScheduler.scheduler, clock: fakeClock().clock, resolveLeaf: emptyCalls.resolveLeaf, estimateRequest: needsOf,
  });
  const emptyError = await empty.complete(request(), freshSignal()).catch(e => e) as ProviderError & { routingHandled?: boolean };
  expect(emptyError.routingHandled).toBe(true);
  expect(emptyCalls.calls).toEqual([]);
});

test('429 then quota then tool turn', async () => {
  const rateLimited = new ProviderError('Model HTTP 429', true, false, 60_000, {
    status: 429, code: 'rate_limit', retryAt: 1_060_000, contextLimit: false,
  });
  const quotaExhausted = new ProviderError('Model HTTP 402', false, false, undefined, {
    status: 402, code: 'insufficient_quota', contextLimit: false,
  });
  const profiles = [
    profile({ modelId: 'free-a', priority: 10 }),
    profile({ modelId: 'free-b', providerId: 'custom-b', accountId: 'account-b', quotaGroup: 'org-b', priority: 20 }),
    profile({ modelId: 'free-c', providerId: 'custom-c', accountId: 'account-c', quotaGroup: 'org-c', priority: 30, contextWindow: 65536 }),
  ];
  const scheduler = scriptedScheduler(queue(...profiles.map((target, index) => lease(`lease-${index}`, target))));
  const calls: string[] = [];
  const executed: string[] = [];
  const completeTurn = toolTurn();
  const omni = createOmniProvider(config(profiles), {
    scheduler: scheduler.scheduler,
    clock: fakeClock().clock,
    resolveLeaf: async modelId => {
      calls.push(modelId);
      if (modelId === 'free-a') return leaf(modelId, async () => { throw rateLimited; });
      if (modelId === 'free-b') return leaf(modelId, async () => { throw quotaExhausted; });
      return leaf(modelId, async () => completeTurn);
    },
    estimateRequest: needsOf,
  });

  const result = await omni.complete(toolRequest(), freshSignal());

  expect(calls).toEqual(['free-a', 'free-b', 'free-c']);
  expect(scheduler.settled.map(entry => entry.result.ok ? 'ok' : entry.result.failure.kind))
    .toEqual(['rate_limit', 'quota', 'ok']);
  expect(result).toBe(completeTurn);
  expect(result.toolCalls).toHaveLength(1);
  // The router returns the turn; tools are the engine's job, never the router's.
  expect(executed).toEqual([]);
});

test('refusal does not rotate', async () => {
  const refusal = new ProviderError('Model refused the request', false, false, undefined, {
    status: 403, code: 'content_policy', contextLimit: false,
  });
  const refusalScheduler = scriptedScheduler(queue(lease('lease-a', profile())));
  const refusalCalls = resolver({ 'free-a': leaf('free-a', async () => { throw refusal; }) });
  const refusing = createOmniProvider(config([profile()]), {
    scheduler: refusalScheduler.scheduler, clock: fakeClock().clock, resolveLeaf: refusalCalls.resolveLeaf, estimateRequest: needsOf,
  });
  const refusalError = await refusing.complete(request(), freshSignal()).catch(e => e) as ProviderError & { routingHandled?: boolean };
  expect(refusalError).toBeInstanceOf(ProviderError);
  expect(refusalError.routingHandled).toBe(true);
  expect(refusalCalls.calls).toEqual(['free-a']);
  expect(refusalError.message).not.toContain('refused');

  // A malformed request is final too: no account tour to dodge the rejection.
  const invalid = new ProviderError('Model HTTP 400', false, false, undefined, {
    status: 400, code: 'invalid_request_error', contextLimit: false,
  });
  const invalidProfiles = [profile(), profile({ modelId: 'free-b', providerId: 'custom-b', accountId: 'account-b', quotaGroup: 'org-b' })];
  const invalidScheduler = scriptedScheduler(queue(lease('lease-a', invalidProfiles[0]!), lease('lease-b', invalidProfiles[1]!)));
  const invalidCalls = resolver({
    'free-a': leaf('free-a', async () => { throw invalid; }),
    'free-b': leaf('free-b', async () => turn('should not run')),
  });
  const invalidProvider = createOmniProvider(config(invalidProfiles), {
    scheduler: invalidScheduler.scheduler, clock: fakeClock().clock, resolveLeaf: invalidCalls.resolveLeaf, estimateRequest: needsOf,
  });
  const invalidError = await invalidProvider.complete(request(), freshSignal()).catch(e => e) as ProviderError & { routingHandled?: boolean };
  expect(invalidError.routingHandled).toBe(true);
  expect(invalidCalls.calls).toEqual(['free-a']);

  // 401 disables only that account; another authorized account still serves.
  const first = profile({ modelId: 'free-a', accountId: 'account-a', quotaGroup: 'org-a' });
  const second = profile({ modelId: 'free-b', providerId: 'custom-b', accountId: 'account-b', quotaGroup: 'org-b' });
  const disabled: string[] = [];
  const authScheduler: Scheduler = {
    select: ctx => ctx.attempted.has('free-a')
      ? { kind: 'attempt', lease: lease('lease-b', second) }
      : { kind: 'attempt', lease: lease('lease-a', first) },
    settle: (target, result) => {
      if (!result.ok && result.failure.scope === 'account') disabled.push(target.profile.accountId);
    },
    release: () => {},
  };
  const authCalls = resolver({
    'free-a': leaf('free-a', async () => {
      throw new ProviderError('Model HTTP 401', false, false, undefined, {
        status: 401, code: 'invalid_api_key', contextLimit: false,
      });
    }),
    'free-b': leaf('free-b', async () => turn('authorized')),
  });
  const authorized = createOmniProvider(config([first, second]), {
    scheduler: authScheduler, clock: fakeClock().clock, resolveLeaf: authCalls.resolveLeaf, estimateRequest: needsOf,
  });
  expect((await authorized.complete(request(), freshSignal())).text).toBe('authorized');
  expect(authCalls.calls).toEqual(['free-a', 'free-b']);
  expect(disabled).toEqual(['account-a']);
});

test('bounded retry and abort', async () => {
  // Four default sends, then a terminal non-retryable exhausted error.
  const five = Array.from({ length: 5 }, (_, index) => profile({
    modelId: `model-${index}`, providerId: `custom-${index}`, accountId: `account-${index}`,
    quotaGroup: `org-${index}`, priority: index,
  }));
  const refused = new ProviderError('Model HTTP 429', true, false, 1_000, {
    status: 429, code: 'rate_limit', contextLimit: false,
  });
  const retryScheduler = scriptedScheduler(queue(...five.map((target, index) => lease(`lease-${index}`, target))));
  const retryCalls: string[] = [];
  const { clock } = fakeClock();
  const bounded = createOmniProvider(config(five), {
    scheduler: retryScheduler.scheduler, clock,
    resolveLeaf: async modelId => {
      retryCalls.push(modelId);
      return leaf(modelId, async () => { throw refused; });
    },
    estimateRequest: needsOf,
  });
  const exhausted = await bounded.complete(request(), freshSignal()).catch(e => e) as ProviderError & { routingHandled?: boolean };
  expect(retryCalls).toHaveLength(4);
  expect(exhausted).toBeInstanceOf(ProviderError);
  expect(exhausted.routingHandled).toBe(true);
  expect(exhausted.retryable).toBe(false);

  // Wait budget is cumulative and fake: it never exceeds maxWaitMs.
  const waiting = fakeClock();
  const waitScheduler = scriptedScheduler(() => ({ kind: 'wait', until: waiting.clock.now() + 6_000 }));
  const waitCalls: string[] = [];
  const waitingProvider = createOmniProvider(config([profile()], { maxWaitMs: 15_000 }), {
    scheduler: waitScheduler.scheduler, clock: waiting.clock,
    resolveLeaf: async modelId => { waitCalls.push(modelId); return leaf(modelId, async () => turn()); },
    estimateRequest: needsOf,
  });
  const waitError = await waitingProvider.complete(request(), freshSignal()).catch(e => e) as ProviderError & { routingHandled?: boolean };
  expect(waiting.sleeps).toEqual([6_000, 6_000]);
  expect(waiting.sleeps.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(15_000);
  expect(waitError.routingHandled).toBe(true);
  expect(waitCalls).toEqual([]);

  // Abort cuts the in-flight attempt, releases the lease and never falls back.
  const abortScheduler = scriptedScheduler(queue(lease('lease-a', profile()), lease('lease-b', profile({ modelId: 'free-b' }))));
  const controller = new AbortController();
  const reason = new Error('user stop');
  const abortCalls: string[] = [];
  const abortStarted = deferred();
  const aborting = createOmniProvider(config([profile()]), {
    scheduler: abortScheduler.scheduler, clock: fakeClock().clock,
    resolveLeaf: async modelId => {
      abortCalls.push(modelId);
      return leaf(modelId, (_req, signal) => new Promise<ModelTurn>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        abortStarted.resolve();
      }));
    },
    estimateRequest: needsOf,
  });
  const pending = aborting.complete(request(), controller.signal).catch(e => e);
  await abortStarted.promise;
  controller.abort(reason);
  expect(await pending).toBe(reason);
  expect(abortCalls).toEqual(['free-a']);
  expect(abortScheduler.released).toEqual(['lease-a']);

  // Abort also cuts a wait, without inventing a lease or a fallback attempt.
  const waitAbort = new AbortController();
  const waitReason = new Error('stop waiting');
  const waitOnly: Scheduler = {
    select: () => ({ kind: 'wait', until: 1_001_000 }),
    settle: () => {},
    release: () => {},
  };
  const abortableClock: Clock = {
    now: () => 1_000_000,
    random: () => 0,
    sleep: (_ms, signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  };
  const waitingAbort = createOmniProvider(config([profile()]), {
    scheduler: waitOnly,
    clock: abortableClock,
    resolveLeaf: async modelId => { waitCalls.push(modelId); return leaf(modelId, async () => turn()); },
    estimateRequest: needsOf,
  });
  const pendingWait = waitingAbort.complete(request(), waitAbort.signal).catch(e => e);
  await tick();
  waitAbort.abort(waitReason);
  expect(await pendingWait).toBe(waitReason);
  expect(waitCalls).toEqual([]);
});

test('one lease per quota group', async () => {
  const sharedGroup = [profile({ modelId: 'free-a1', accountId: 'account-1' }), profile({ modelId: 'free-a2', accountId: 'account-2' })];
  const { clock } = fakeClock();
  const inflight = new Map<string, number>();
  const released = new Set<string>();
  let active = 0, peak = 0, sequence = 0;
  const scheduler: Scheduler = {
    select: ctx => {
      if (ctx.remainingAttempts <= 0) return { kind: 'exhausted' };
      const free = sharedGroup.find(target =>
        (inflight.get(target.quotaGroup) ?? 0) === 0 && !ctx.attempted.has(target.modelId));
      if (!free) return { kind: 'wait', until: clock.now() + 50 };
      const next = lease(`lease-${sequence++}`, free);
      inflight.set(free.quotaGroup, 1);
      active += 1;
      peak = Math.max(peak, active);
      return { kind: 'attempt', lease: next };
    },
    settle: () => {},
    release: target => {
      if (released.has(target.id)) return;
      released.add(target.id);
      active -= 1;
      inflight.set(target.profile.quotaGroup, 0);
    },
  };
  const gate = deferred();
  let served = 0;
  const omni = createOmniProvider(config(sharedGroup), {
    scheduler, clock,
    resolveLeaf: async modelId => leaf(modelId, async () => {
      served += 1;
      const current = served;
      if (current === 1) await gate.promise;
      return turn(`served-${current}`);
    }),
    estimateRequest: needsOf,
  });

  const first = omni.complete(request(), freshSignal());
  await tick();
  const second = omni.complete(request(), freshSignal());
  await tick();
  expect(peak).toBe(1);
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);

  expect([a.text, b.text].sort()).toEqual(['served-1', 'served-2']);
  expect(peak).toBe(1);
  expect(active).toBe(0);
  expect(released.size).toBe(2);
});

test('subagent routing stays scoped', async () => {
  const profiles = [
    profile({ modelId: 'free-a', priority: 10 }),
    profile({ modelId: 'free-b', providerId: 'custom-b', accountId: 'account-b', quotaGroup: 'org-b', priority: 20 }),
    profile({ modelId: 'free-c', providerId: 'custom-c', accountId: 'account-c', quotaGroup: 'org-c', priority: 30 }),
  ];
  const scoped = scriptedScheduler(queue(...profiles.map((target, index) => lease(`lease-${index}`, target))));
  const defaultEvents: AgentEvent[] = [];
  const parentEvents: AgentEvent[] = [];
  const childEvents: AgentEvent[] = [];
  const parent = createOmniProvider(config(profiles), {
    scheduler: scoped.scheduler,
    clock: fakeClock().clock,
    resolveLeaf: async modelId => leaf(modelId, async () => turn(modelId)),
    estimateRequest: needsOf,
    emit: event => defaultEvents.push(event),
  });
  const child = parent.forSubagent();
  // The engine binds each session sink; the tag simulates the session id it adds.
  parent.bindEvents(event => parentEvents.push({ ...event, sessionId: 'parent-session' }));
  child.bindEvents(event => childEvents.push({ ...event, sessionId: 'child-session' }));

  expect((await child.complete(request(), freshSignal())).text).toBe('free-a');
  expect((await parent.complete(request(), freshSignal())).text).toBe('free-b');
  expect(childEvents).toHaveLength(1);
  expect(childEvents[0]!.sessionId).toBe('child-session');
  expect(childEvents[0]!.to).toBe('free-a');
  expect(parentEvents).toHaveLength(1);
  expect(parentEvents[0]!.sessionId).toBe('parent-session');
  expect(parentEvents[0]!.to).toBe('free-b');
  // The inherited/default sink never receives child traffic.
  expect(defaultEvents).toEqual([]);
  // Parent and child share one scheduler ledger (quota/cooldown state).
  expect(scoped.selected).toEqual(['lease-0', 'lease-1']);

  // A child that its engine has not bound yet keeps no inherited sink.
  const unbound = parent.forSubagent();
  expect((await unbound.complete(request(), freshSignal())).text).toBe('free-c');
  expect(defaultEvents).toEqual([]);
  expect(scoped.settled.map(entry => entry.result.ok)).toEqual([true, true, true]);
});
