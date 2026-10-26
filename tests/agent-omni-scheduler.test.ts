import { describe, expect, test } from 'bun:test';
import { createOmniScheduler, type OmniScheduler } from '../src/agent/omni/scheduler.ts';
import { classifyOmniFailure } from '../src/agent/omni/failures.ts';
import type {
  AttemptContext, Choice, Clock, CreateOmniScheduler, EligibleProfiles, Lease, Needs,
  OmniConfig, Profile, SafeFailure, Scheduler,
} from '../src/agent/omni/contracts.ts';

/** Local doubles for package A: no config.ts or policy.ts import, so B develops before the merge. */
const profile = (modelId: string, over: Partial<Profile> = {}): Profile => ({
  modelId,
  providerId: `custom-${modelId}`,
  accountId: `account-${modelId}`,
  quotaGroup: `quota-${modelId}`,
  costTier: 'free',
  tos: 'ok',
  supportsTools: true,
  supportsImages: false,
  contextWindow: 32_768,
  priority: 10,
  ...over,
});

const configOf = (profiles: Profile[], over: Partial<OmniConfig> = {}): OmniConfig => ({
  version: 1,
  allowPaid: over.allowPaid ?? false,
  maxAttempts: over.maxAttempts ?? 4,
  maxWaitMs: over.maxWaitMs ?? 15_000,
  requestTimeoutMs: over.requestTimeoutMs ?? 30_000,
  profiles,
});

const needs = (over: Partial<Needs> = {}): Needs =>
  ({ tools: false, images: false, estimatedInputTokens: 1_000, maxOutputTokens: 512, ...over });

const context = (over: Partial<AttemptContext> = {}): AttemptContext => ({
  needs: needs(),
  attempted: new Set<string>(),
  remainingAttempts: 4,
  waitRemainingMs: 15_000,
  deadline: 1_000_000_000,
  ...over,
});

/** A's default stand-in: tools are a hard requirement, everything else is capacity-neutral. */
const eligibleDouble = (): EligibleProfiles =>
  (config, turnNeeds) => config.profiles.filter(p => !turnNeeds.tools || p.supportsTools);

interface FakeClock extends Clock {
  now(): number;
  advance(ms: number): void;
  sleeps: number[];
  sleptMs(): number;
  randomValue: number;
}

function fakeClock(start = 1_000): FakeClock {
  let time = start;
  const clock: FakeClock = {
    now: () => time,
    random: () => clock.randomValue,
    randomValue: 1,
    sleeps: [],
    sleptMs: () => clock.sleeps.reduce((total, ms) => total + ms, 0),
    advance: (ms: number) => { time += ms; },
    sleep: async (ms: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      clock.sleeps.push(ms);
      time += ms;
    },
  };
  return clock;
}

/** A sleep that settles only when the turn is aborted: the abort-during-wait case, with no real timer. */
function abortableOnlyClock(start = 1_000): Clock {
  return {
    now: () => start,
    random: () => 1,
    sleep: (_ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      void resolve;
    }),
  };
}

const profileOf = (choice: Choice): Profile => leaseOf(choice).profile;

function leaseOf(choice: Choice): Lease {
  if (choice.kind !== 'attempt') throw new Error(`expected an attempt, got ${choice.kind}`);
  return choice.lease;
}

function schedulerOf(profiles: Profile[], configOver: Partial<OmniConfig> = {}, clock = fakeClock()): { sched: OmniScheduler; clock: FakeClock } {
  return { sched: createOmniScheduler(configOf(profiles, configOver), { clock, eligible: eligibleDouble() }), clock };
}

const health = (sched: OmniScheduler, group: string) => sched.diagnose().find(g => g.group === group);

const transient: SafeFailure = { kind: 'transient', scope: 'group' };
const neverAgain = (kind: 'quota' | 'auth'): SafeFailure => ({ kind, scope: 'group' });

describe('omni scheduler selection', () => {
  test('free tier is tried before authorized paid capacity, then by priority', () => {
    const { sched } = schedulerOf([
      profile('paid-c', { costTier: 'paid', priority: 5 }),
      profile('free-b', { priority: 20 }),
      profile('free-a', { priority: 10 }),
    ], { allowPaid: true });
    const order: string[] = [];
    const attempted = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const choice = sched.select(context({ attempted, remainingAttempts: 3 - i }));
      if (choice.kind !== 'attempt') break;
      order.push(choice.lease.profile.modelId);
      attempted.add(choice.lease.profile.modelId);
      sched.release(choice.lease);
    }
    expect(order).toEqual(['free-a', 'free-b', 'paid-c']);
  });

  test('a paid destination never receives traffic without opt in and waiting cannot authorize it', () => {
    const { sched } = schedulerOf([profile('paid-c', { costTier: 'paid' })]);
    expect(sched.select(context())).toEqual({ kind: 'exhausted' });
    expect(sched.select(context({ deadline: 5_000_000 })).kind).not.toBe('wait');
  });

  test('a tool turn only reaches profiles that declare tools, and text prefers them anyway', () => {
    const { sched } = schedulerOf([profile('weak', { supportsTools: false, priority: 1 }), profile('strong', { priority: 90 })]);
    const toolTurn = leaseOf(sched.select(context({ needs: needs({ tools: true }) })));
    expect(toolTurn.profile.modelId).toBe('strong');
    sched.release(toolTurn);
    const textTurn = leaseOf(sched.select(context()));
    expect(textTurn.profile.modelId).toBe('strong');
    sched.release(textTurn);
    const { sched: incapable } = schedulerOf([profile('weak', { supportsTools: false })]);
    // The pool is never widened: an incapable pool exhausts instead of falling back.
    expect(incapable.select(context({ needs: needs({ tools: true }) }))).toEqual({ kind: 'exhausted' });
  });

  test('a declared window too small for the turn excludes that model without truncating the request', () => {
    const { sched } = schedulerOf([
      profile('small', { quotaGroup: 'g1' }),
      profile('large', { quotaGroup: 'g2', priority: 40, contextWindow: 65_536 }),
    ]);
    expect(profileOf(sched.select(context())).modelId).toBe('small');
    expect(profileOf(sched.select(context({ needs: needs({ estimatedInputTokens: 40_000 }) }))).modelId).toBe('large');
  });

  test('selection consults package A eligibility each time and never widens an empty pool', () => {
    let allow = false;
    const eligible: EligibleProfiles = config => (allow ? config.profiles : []);
    const sched = createOmniScheduler(configOf([profile('a')]), { clock: fakeClock(), eligible });
    expect(sched.select(context())).toEqual({ kind: 'exhausted' });
    allow = true;
    expect(profileOf(sched.select(context())).modelId).toBe('a');
  });

  test('an attempted model is never dispatched twice in one turn', () => {
    const { sched } = schedulerOf([profile('a'), profile('b')]);
    expect(profileOf(sched.select(context({ attempted: new Set(['a']) }))).modelId).toBe('b');
    expect(sched.select(context({ attempted: new Set(['a', 'b']) }))).toEqual({ kind: 'exhausted' });
  });

  test('no dispatch happens once the attempt counter reaches zero', () => {
    const { sched } = schedulerOf([profile('a')]);
    expect(sched.select(context({ remainingAttempts: 0 }))).toEqual({ kind: 'exhausted' });
  });

  test('the frozen scheduler contract still describes this factory', () => {
    const asContract: CreateOmniScheduler = createOmniScheduler;
    const sched: Scheduler = asContract(configOf([profile('a')]), { clock: fakeClock(), eligible: eligibleDouble() });
    expect([typeof sched.select, typeof sched.settle, typeof sched.release]).toEqual(['function', 'function', 'function']);
  });
});

describe('omni scheduler quota state', () => {
  test('QUOTA-01 keys share quota group', () => {
    const { sched, clock } = schedulerOf([
      profile('free-a1', { quotaGroup: 'org-a', accountId: 'acc-a' }),
      profile('free-a2', { quotaGroup: 'org-a', accountId: 'acc-a-2', priority: 20 }),
      profile('free-b', { quotaGroup: 'org-b', priority: 30 }),
    ]);
    const first = leaseOf(sched.select(context()));
    sched.settle(first, { ok: false, failure: { ...neverAgain('quota'), status: 429, code: 'insufficient_quota' } });
    sched.release(first);

    const dispatched: string[] = [];
    const attempted = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const choice = sched.select(context({ attempted, remainingAttempts: 6 - i }));
      if (choice.kind !== 'attempt') break;
      dispatched.push(choice.lease.profile.modelId);
      attempted.add(choice.lease.profile.modelId);
      sched.release(choice.lease);
      clock.advance(1_000);
    }
    // The second key of the exhausted group is the same quota: only the independent group serves.
    expect(dispatched).toEqual(['free-b']);
    expect(health(sched, 'org-a')).toMatchObject({ disabledReason: 'quota', inFlight: 0 });
    // Time passing never re-enables it: that needs a deliberate runtime rebuild.
    clock.advance(86_400_000);
    expect(sched.select(context({ attempted: new Set(['free-b']) }))).toEqual({ kind: 'exhausted' });
  });

  test('an announced quota reset reopens the group at its deadline and no earlier', () => {
    const clock = fakeClock(1_000);
    const { sched } = schedulerOf([profile('a', { quotaGroup: 'g' })], {}, clock);
    const lease = leaseOf(sched.select(context()));
    sched.settle(lease, { ok: false, failure: { ...neverAgain('quota'), code: 'insufficient_quota', retryAt: 61_000 } });
    sched.release(lease);
    clock.advance(29_000);
    expect(sched.select(context())).toEqual({ kind: 'exhausted', retryAt: 61_000 });
    clock.advance(31_000);
    expect(profileOf(sched.select(context())).modelId).toBe('a');
    expect(health(sched, 'g')?.disabledReason).toBeUndefined();
  });

  test('429 cooldowns only its own group and the other group keeps serving', () => {
    const { sched, clock } = schedulerOf([
      profile('free-a', { quotaGroup: 'org-a' }),
      profile('free-b', { quotaGroup: 'org-b', priority: 20 }),
    ]);
    const cooled = leaseOf(sched.select(context()));
    sched.settle(cooled, { ok: false, failure: { kind: 'rate_limit', scope: 'group', status: 429 } });
    sched.release(cooled);
    expect(profileOf(sched.select(context())).modelId).toBe('free-b');
    clock.advance(10_000);
    expect(profileOf(sched.select(context())).modelId).toBe('free-a');
  });

  test('an absent Retry-After falls back to bounded jittered backoff capped at eight seconds', () => {
    const clock = fakeClock(0);
    const { sched } = schedulerOf([profile('a', { quotaGroup: 'g' })], {}, clock);
    const cooldowns: number[] = [];
    for (let i = 0; i < 6; i++) {
      const choice = sched.select(context());
      if (choice.kind === 'attempt') {
        sched.settle(choice.lease, { ok: false, failure: transient });
        sched.release(choice.lease);
      }
      cooldowns.push(health(sched, 'g')!.cooldownUntil);
      clock.advance(60_000);
    }
    // retryDelayMs with random() = 1: 500, 1000, 2000, 4000, then the 8 s ceiling forever after.
    expect(cooldowns).toEqual([500, 61_000, 122_000, 184_000, 248_000, 308_000]);
    expect(health(sched, 'g')?.failures).toBe(6);
  });

  test('a server deadline is never shortened by the local backoff ceiling', () => {
    const { sched } = schedulerOf([profile('a', { quotaGroup: 'g' })]);
    const lease = leaseOf(sched.select(context()));
    sched.settle(lease, { ok: false, failure: { kind: 'rate_limit', scope: 'group', retryAt: 125_000 } });
    expect(health(sched, 'g')?.cooldownUntil).toBe(125_000);
  });

  test('a successful turn clears the cooldown and the failure count of its group', () => {
    const { sched } = schedulerOf([profile('a', { quotaGroup: 'g' })]);
    const lease = leaseOf(sched.select(context()));
    sched.settle(lease, { ok: false, failure: { kind: 'transient', scope: 'group', retryAt: 9_000 } });
    sched.settle(lease, { ok: true });
    sched.release(lease);
    expect(sched.diagnose()).toEqual([{ group: 'g', cooldownUntil: 0, inFlight: 0, failures: 0 }]);
    expect(profileOf(sched.select(context())).modelId).toBe('a');
  });

  test('ERR-01 refusal does not rotate', () => {
    const refusal = classifyOmniFailure({ message: 'Model HTTP 403', status: 403 }, 1_000);
    expect(refusal).toMatchObject({ kind: 'fatal', scope: 'turn' });
    const { sched } = schedulerOf([
      profile('a', { quotaGroup: 'g1' }), profile('b', { quotaGroup: 'g2' }), profile('c', { quotaGroup: 'g3' }),
    ]);
    const attempted = new Set<string>();
    const first = leaseOf(sched.select(context({ attempted })));
    sched.settle(first, { ok: false, failure: refusal });
    sched.release(first);
    // A denial never walks the remaining accounts of the turn.
    expect(sched.select(context({ attempted }))).toEqual({ kind: 'exhausted' });

    // An unambiguous invalid key disables its account, and another account still serves.
    const invalidKey = classifyOmniFailure({ message: 'Model HTTP 401', http: { status: 401, code: 'invalid_api_key', contextLimit: false } }, 1_000);
    expect(invalidKey).toMatchObject({ kind: 'auth', scope: 'account' });
    const { sched: auth } = schedulerOf([
      profile('acc1-a', { accountId: 'acc-1', quotaGroup: 'g1' }),
      profile('acc1-b', { accountId: 'acc-1', quotaGroup: 'g2', priority: 20 }),
      profile('acc2-a', { accountId: 'acc-2', quotaGroup: 'g3', priority: 30 }),
    ]);
    const rejected = leaseOf(auth.select(context()));
    expect(rejected.profile.modelId).toBe('acc1-a');
    auth.settle(rejected, { ok: false, failure: invalidKey });
    auth.release(rejected);
    const dispatched: string[] = [];
    const tried = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const choice = auth.select(context({ attempted: tried, remainingAttempts: 4 - i }));
      if (choice.kind !== 'attempt') break;
      dispatched.push(choice.lease.profile.modelId);
      tried.add(choice.lease.profile.modelId);
      auth.release(choice.lease);
    }
    // The sibling profile of the rejected account is never tried again; the other account serves.
    expect(dispatched).toEqual(['acc2-a']);
  });

  test('a context failure excludes only that model for this turn', () => {
    const { sched } = schedulerOf([profile('a', { quotaGroup: 'g1' }), profile('b', { quotaGroup: 'g2', priority: 20 })]);
    const attempted = new Set<string>();
    const first = leaseOf(sched.select(context({ attempted })));
    sched.settle(first, { ok: false, failure: { kind: 'context', scope: 'model', status: 413 } });
    sched.release(first);
    expect(profileOf(sched.select(context({ attempted }))).modelId).toBe('b');
    // A later turn re-evaluates: the exclusion is scoped to the turn, not to the model forever.
    expect(profileOf(sched.select(context())).modelId).toBe('a');
  });

  test('a turn failure marks only that turn terminal', () => {
    const { sched } = schedulerOf([profile('a', { quotaGroup: 'g' })]);
    const attempted = new Set<string>();
    const first = leaseOf(sched.select(context({ attempted })));
    sched.settle(first, { ok: false, failure: { kind: 'fatal', scope: 'turn', status: 400 } });
    sched.release(first);
    expect(sched.select(context({ attempted }))).toEqual({ kind: 'exhausted' });
    expect(sched.select(context()).kind).toBe('attempt');
  });
});

describe('omni scheduler budget and concurrency', () => {
  test('TIME-01 server reset is not shortened', () => {
    const clock = fakeClock(2_000);
    const failure = classifyOmniFailure(
      { message: 'Model HTTP 429', http: { status: 429, code: 'rate_limit_exceeded', retryAt: 3_602_000, contextLimit: false } },
      clock.now(),
    );
    expect(failure.retryAt).toBe(3_602_000);
    const { sched } = schedulerOf([profile('a', { quotaGroup: 'org-a' })], { maxWaitMs: 0 }, clock);
    const lease = leaseOf(sched.select(context()));
    sched.settle(lease, { ok: false, failure });
    sched.release(lease);
    // No 120 s clamp: the real reset is reported intact and no early call is allowed.
    expect(sched.select(context({ waitRemainingMs: 0 }))).toEqual({ kind: 'exhausted', retryAt: 3_602_000 });
    clock.advance(120_000);
    expect(sched.select(context({ waitRemainingMs: 0 })).kind).toBe('exhausted');
    clock.advance(3_600_000);
    expect(profileOf(sched.select(context())).modelId).toBe('a');
  });

  test('TIME-01 another independent group answers while the reset is pending', () => {
    const { sched } = schedulerOf([profile('a', { quotaGroup: 'org-a' }), profile('b', { quotaGroup: 'org-b', priority: 20 })]);
    const lease = leaseOf(sched.select(context()));
    sched.settle(lease, { ok: false, failure: { kind: 'rate_limit', scope: 'group', retryAt: 3_602_000 } });
    sched.release(lease);
    expect(profileOf(sched.select(context())).modelId).toBe('b');
  });

  test('TIME-02 bounded retry and abort', async () => {
    const { sched, clock } = schedulerOf([
      profile('a', { quotaGroup: 'g1' }), profile('b', { quotaGroup: 'g2' }),
      profile('c', { quotaGroup: 'g3' }), profile('d', { quotaGroup: 'g4' }),
    ]);
    const signal = new AbortController().signal;
    const attempted = new Set<string>();
    const dispatched: string[] = [];
    for (let i = 0; i < 6; i++) {
      const choice = await sched.waitAndSelect(context({ attempted, remainingAttempts: 4 - dispatched.length }), signal);
      if (choice.kind !== 'attempt') break;
      dispatched.push(choice.lease.profile.modelId);
      attempted.add(choice.lease.profile.modelId);
      sched.settle(choice.lease, { ok: false, failure: { kind: 'rate_limit', scope: 'group', retryAt: clock.now() + 9_000 } });
      sched.release(choice.lease);
    }
    // Exactly the default four dispatches, and every finally released its lease.
    expect(dispatched).toEqual(['a', 'b', 'c', 'd']);
    expect(clock.sleeps).toEqual([]);
    expect(sched.diagnose().every(g => g.inFlight === 0)).toBe(true);

    // The next turn waits for the announced reset instead of skipping it, inside the 15 s budget.
    const secondAttempted = new Set<string>();
    const served: string[] = [];
    for (let i = 0; i < 4; i++) {
      const choice = await sched.waitAndSelect(context({ attempted: secondAttempted, remainingAttempts: 4 - i }), signal);
      if (choice.kind !== 'attempt') break;
      served.push(choice.lease.profile.modelId);
      secondAttempted.add(choice.lease.profile.modelId);
      sched.release(choice.lease);
    }
    expect(served).toEqual(['a', 'b', 'c', 'd']);
    expect(clock.sleptMs()).toBe(9_000);
    expect(clock.sleptMs()).toBeLessThanOrEqual(15_000);

    // The scheduler also refuses to dispatch when the caller stopped lowering the counter.
    expect(await sched.waitAndSelect(context({ remainingAttempts: 0 }), signal)).toEqual({ kind: 'exhausted' });
  });

  test('TIME-02 abort during the injected sleep ends the turn without another dispatch', async () => {
    const sched = createOmniScheduler(configOf([profile('a', { quotaGroup: 'g1' })]), { clock: abortableOnlyClock(), eligible: eligibleDouble() });
    const held = leaseOf(sched.select(context()));
    const controller = new AbortController();
    const reason = new Error('user cancelled');
    const waiting = sched.waitAndSelect(context(), controller.signal);
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    // The busy group is untouched: the waiting turn acquired nothing and left no pending sleep.
    expect(sched.diagnose()).toEqual([{ group: 'g1', cooldownUntil: 0, inFlight: 1, failures: 0 }]);
    sched.release(held);
    sched.release(held);
    expect(sched.diagnose()).toEqual([{ group: 'g1', cooldownUntil: 0, inFlight: 0, failures: 0 }]);
  });

  test('CONC-01 one lease per quota group', async () => {
    const { sched } = schedulerOf([
      profile('a1', { quotaGroup: 'org-a', accountId: 'acc-1' }),
      profile('a2', { quotaGroup: 'org-a', accountId: 'acc-2' }),
    ]);
    const turnA = context();
    const turnB = context();
    const first = leaseOf(sched.select(turnA));
    expect(first.profile.modelId).toBe('a1');
    // The other key of the same group is the same quota: the concurrent turn waits instead of dispatching.
    expect(sched.select(turnB).kind).toBe('wait');
    expect(sched.diagnose().map(g => `${g.group}:${g.inFlight}`)).toEqual(['org-a:1']);
    sched.release(first);
    sched.release(first);
    expect(sched.diagnose().map(g => `${g.group}:${g.inFlight}`)).toEqual(['org-a:0']);
    const retry = await sched.waitAndSelect(turnB, new AbortController().signal);
    expect(['a1', 'a2']).toContain(profileOf(retry).modelId);
    if (retry.kind === 'attempt') sched.release(retry.lease);
    expect(sched.diagnose().every(g => g.inFlight === 0)).toBe(true);
  });

  test('CONC-01 independent groups each hold one lease while both turns run', () => {
    const { sched } = schedulerOf([
      profile('a1', { quotaGroup: 'org-a' }),
      profile('a2', { quotaGroup: 'org-a', priority: 20 }),
      profile('b1', { quotaGroup: 'org-b', priority: 30 }),
    ]);
    const turnA = leaseOf(sched.select(context()));
    const turnB = leaseOf(sched.select(context()));
    expect([turnA.profile.modelId, turnB.profile.modelId]).toEqual(['a1', 'b1']);
    expect(sched.diagnose().map(g => `${g.group}:${g.inFlight}`).sort()).toEqual(['org-a:1', 'org-b:1']);
    // A third concurrent turn finds no free group and only waits.
    expect(sched.select(context()).kind).toBe('wait');
    sched.release(turnA);
    sched.release(turnB);
    expect(sched.diagnose().every(g => g.inFlight === 0)).toBe(true);
  });

  test('releasing without settling frees the group and a repeated release is a no-op', () => {
    const { sched } = schedulerOf([profile('a', { quotaGroup: 'g' })]);
    const lease = leaseOf(sched.select(context()));
    sched.release(lease);
    expect(health(sched, 'g')?.inFlight).toBe(0);
    sched.release(lease);
    expect(health(sched, 'g')?.inFlight).toBe(0);
  });

  test('the wait budget is consumed by the waits actually taken and never overspent', async () => {
    const clock = fakeClock(1_000);
    const { sched } = schedulerOf([profile('a', { quotaGroup: 'g' })], {}, clock);
    const lease = leaseOf(sched.select(context()));
    sched.settle(lease, { ok: false, failure: { kind: 'rate_limit', scope: 'group', retryAt: 1_300 } });
    sched.release(lease);
    const ctx = context({ waitRemainingMs: 500 });
    const choice = await sched.waitAndSelect(ctx, new AbortController().signal);
    expect(clock.sleeps).toEqual([300]);
    expect(ctx.waitRemainingMs).toBe(200);
    expect(profileOf(choice).modelId).toBe('a');
    sched.release(leaseOf(choice));
  });

  test('a reset outside the turn budget yields a terminal choice without sleeping minutes', async () => {
    const clock = fakeClock(1_000);
    const { sched } = schedulerOf([profile('a', { quotaGroup: 'g' })], {}, clock);
    const lease = leaseOf(sched.select(context()));
    sched.settle(lease, { ok: false, failure: { kind: 'rate_limit', scope: 'group', retryAt: 4_000_000 } });
    sched.release(lease);
    expect(await sched.waitAndSelect(context({ waitRemainingMs: 15_000 }), new AbortController().signal))
      .toEqual({ kind: 'exhausted', retryAt: 4_000_000 });
    expect(clock.sleeps).toEqual([]);
  });

  test('an impossible Retry-After leaves the destination out for the turn instead of retrying at once', () => {
    const { sched } = schedulerOf([profile('a', { quotaGroup: 'g' })]);
    const lease = leaseOf(sched.select(context()));
    sched.settle(lease, { ok: false, failure: { kind: 'rate_limit', scope: 'group', retryAt: Number.MAX_SAFE_INTEGER } });
    sched.release(lease);
    const choice = sched.select(context());
    expect(choice.kind).toBe('exhausted');
    if (choice.kind === 'exhausted') expect(choice.retryAt).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('a busy group is polled with a bounded wait instead of an immediate re-dispatch', () => {
    const clock = fakeClock(1_000);
    const { sched } = schedulerOf([profile('a', { quotaGroup: 'g' })], {}, clock);
    const held = leaseOf(sched.select(context()));
    const choice = sched.select(context({ deadline: 1_000_000 }));
    expect(choice.kind).toBe('wait');
    if (choice.kind === 'wait') expect(choice.until).toBe(1_500);
    sched.release(held);
  });
});

describe('omni scheduler safe state', () => {
  test('SEC-01 routing logs redact secrets', () => {
    const key = 'sk-decoy-key-DO-NOT-LOG';
    const host = 'api-a.example.invalid';
    const clock = fakeClock(5_000);
    const failure = classifyOmniFailure({
      message: `Model HTTP 429: key ${key} rejected at https://user:${key}@${host}/v1?access_token=${key}`,
      http: { status: 429, code: 'rate_limit_exceeded', retryAt: 6_000, contextLimit: false },
    }, clock.now());
    const { sched } = schedulerOf([profile('free-a', { quotaGroup: 'org-a' })], {}, clock);
    const lease = leaseOf(sched.select(context()));
    sched.settle(lease, { ok: false, failure });
    const printed = JSON.stringify({
      diagnose: sched.diagnose(),
      failure,
      lease: { id: lease.id, modelId: lease.profile.modelId },
      choice: sched.select(context({ attempted: new Set(['free-a']) })),
    });
    sched.release(lease);
    expect(printed).not.toContain(key);
    expect(printed).not.toContain(host);
    expect(printed).not.toContain('access_token');
    expect(printed).not.toContain('rejected');
    // Only safe labels, reason and deadline survive.
    expect(printed).toContain('org-a');
    expect(printed).toContain('rate_limit');
    expect(printed).toContain('6000');
  });

  test('the failure of an unknown shape yields no prose at all', () => {
    const failure = classifyOmniFailure('Model HTTP 429 leaked secret', 1_000);
    expect(failure).toEqual({ kind: 'rate_limit', scope: 'group', status: 429 });
  });
});
