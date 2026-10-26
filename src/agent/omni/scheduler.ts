import type {
  AttemptContext, Choice, FailureKind, Lease, OmniConfig, Profile, SafeFailure, Scheduler, SchedulerDependencies,
} from './contracts.ts';
import { retryDelayMs } from '../providers/attempt-policy.ts';

/** Declared output budget plus slack that must fit inside the window the destination declares. */
const CONTEXT_MARGIN_TOKENS = 1;
/** Poll interval while every candidate is busy: bounded, so a turn never spins on a lease it cannot take. */
const BUSY_PROBE_MIN_MS = 250;
const BUSY_PROBE_SPAN_MS = 250;
/** A disabled group stays out for every remaining turn of this runtime unless the server announced a reset. */
const NO_KNOWN_RESET = Number.MAX_SAFE_INTEGER;

interface GroupHealth {
  cooldownUntil: number;
  disabledReason?: FailureKind;
  inFlight: number;
  failures: number;
}

interface TurnRules {
  excludedModels: Set<string>;
  terminal: boolean;
}

/** Safe to log: labels, counters and deadlines only. Never keys, URLs, bodies or upstream prose. */
export interface GroupDiagnostic {
  group: string;
  cooldownUntil: number;
  inFlight: number;
  failures: number;
  disabledReason?: FailureKind;
}

/** Frozen `Scheduler` plus turn-scoped waiting and safe diagnostics for the Omni plan. */
export interface OmniScheduler extends Scheduler {
  /** Waits for availability — no HTTP here — until a lease is reserved, or returns a terminal Choice. */
  waitAndSelect(ctx: AttemptContext, signal: AbortSignal): Promise<Choice>;
  diagnose(): GroupDiagnostic[];
}

const costRank = (profile: Profile): number => (profile.costTier === 'free' ? 0 : 1);

const fitsContext = (profile: Profile, ctx: AttemptContext): boolean =>
  profile.contextWindow >= ctx.needs.estimatedInputTokens + ctx.needs.maxOutputTokens + CONTEXT_MARGIN_TOKENS;

/**
 * Per-runtime quota state: at most one lease in flight per quotaGroup, cooldowns that keep the server
 * deadline intact, groups disabled by a recognized quota code, accounts disabled by an unambiguous key
 * failure. Selection state and turn counters belong to the invocation that supplies the AttemptContext.
 */
export function createOmniScheduler(config: OmniConfig, deps: SchedulerDependencies): OmniScheduler {
  const clock = deps.clock;
  const groups = new Map<string, GroupHealth>();
  const disabledAccounts = new Set<string>();
  const liveLeases = new Map<string, { group: string; turn: TurnRules }>();
  const turnRules = new WeakMap<object, TurnRules>();
  const known = new Set<string>();
  // Configuration order is the tie-breaker of record; a repeated modelId never enlarges a pool.
  const pool = config.profiles.filter(profile =>
    known.has(profile.modelId) ? false : (known.add(profile.modelId), true));
  const position = new Map(pool.map((profile, index) => [profile.modelId, index]));
  let sequence = 0;

  const health = (group: string): GroupHealth => {
    const existing = groups.get(group);
    if (existing) return existing;
    const created: GroupHealth = { cooldownUntil: 0, inFlight: 0, failures: 0 };
    groups.set(group, created);
    return created;
  };

  const rulesFor = (ctx: AttemptContext): TurnRules => {
    const key = ctx.attempted as unknown as object;
    const existing = turnRules.get(key);
    if (existing) return existing;
    const created: TurnRules = { excludedModels: new Set(), terminal: false };
    turnRules.set(key, created);
    return created;
  };

  const orderedCandidates = (ctx: AttemptContext): Profile[] => {
    const seen = new Set<string>();
    return deps.eligible(config, ctx.needs)
      .filter(profile => (seen.has(profile.modelId) ? false : (seen.add(profile.modelId), true)))
      .filter(profile => position.has(profile.modelId))
      .sort((a, b) => costRank(a) - costRank(b)
        || Number(b.supportsTools) - Number(a.supportsTools)
        || a.priority - b.priority
        || (position.get(a.modelId) ?? 0) - (position.get(b.modelId) ?? 0));
  };

  const select = (ctx: AttemptContext): Choice => {
    const now = clock.now();
    const turn = rulesFor(ctx);
    if (turn.terminal || ctx.remainingAttempts <= 0) return { kind: 'exhausted' };
    const candidates = orderedCandidates(ctx);
    if (!candidates.length) return { kind: 'exhausted' };
    let earliest: number | undefined;
    const blocked = (at: number) => { earliest = earliest === undefined || at < earliest ? at : earliest; };
    for (const profile of candidates) {
      if (ctx.attempted.has(profile.modelId) || turn.excludedModels.has(profile.modelId)) continue;
      if (disabledAccounts.has(profile.accountId)) continue;
      if (!fitsContext(profile, ctx)) { turn.excludedModels.add(profile.modelId); continue; }
      const group = health(profile.quotaGroup);
      if (group.disabledReason) continue;
      // An unauthorized paid destination never receives traffic, and waiting cannot authorize it.
      if (costRank(profile) === 1 && !config.allowPaid) continue;
      if (group.inFlight > 0) { blocked(now + BUSY_PROBE_MIN_MS + clock.random() * BUSY_PROBE_SPAN_MS); continue; }
      if (group.cooldownUntil > now) { blocked(group.cooldownUntil); continue; }
      const lease: Lease = { id: `${profile.modelId}:${++sequence}`, profile };
      liveLeases.set(lease.id, { group: profile.quotaGroup, turn });
      group.inFlight++;
      return { kind: 'attempt', lease };
    }
    if (earliest === undefined) return { kind: 'exhausted' };
    const cap = Math.min(ctx.deadline, now + Math.max(0, ctx.waitRemainingMs));
    // The real reset is reported intact even when it falls outside the turn: no shortening, no early call.
    if (earliest <= now || earliest > cap) return { kind: 'exhausted', retryAt: earliest };
    return { kind: 'wait', until: earliest };
  };

  const settle = (lease: Lease, result: { ok: true } | { ok: false; failure: SafeFailure }): void => {
    const live = liveLeases.get(lease.id);
    if (!live) return;
    const profile = lease.profile;
    const group = health(profile.quotaGroup);
    if (result.ok) {
      group.cooldownUntil = 0;
      group.disabledReason = undefined;
      group.failures = 0;
      return;
    }
    const failure = result.failure;
    const now = clock.now();
    if (failure.scope === 'model') live.turn.excludedModels.add(profile.modelId);
    if (failure.scope === 'turn') live.turn.terminal = true;
    if (failure.scope === 'account') disabledAccounts.add(profile.accountId);
    if (failure.scope !== 'group') return;
    if (failure.kind === 'quota' || failure.kind === 'auth') {
      // Another key of the exhausted group is the same quota, and a rejected key is the same account.
      // Without an announced reset the group stays out for this whole runtime; with one, only its deadline gates it.
      if (failure.retryAt === undefined) {
        group.disabledReason = failure.kind;
        group.cooldownUntil = NO_KNOWN_RESET;
        return;
      }
      group.cooldownUntil = Math.max(group.cooldownUntil, failure.retryAt);
      return;
    }
    group.failures++;
    // A server deadline is kept in full; only an absent hint falls back to bounded jittered backoff.
    group.cooldownUntil = Math.max(group.cooldownUntil, failure.retryAt ?? now + retryDelayMs(group.failures, () => clock.random()));
  };

  const release = (lease: Lease): void => {
    const live = liveLeases.get(lease.id);
    if (!live) return;
    liveLeases.delete(lease.id);
    const group = health(live.group);
    if (group.inFlight > 0) group.inFlight--;
  };

  const waitAndSelect = async (ctx: AttemptContext, signal: AbortSignal): Promise<Choice> => {
    for (;;) {
      signal.throwIfAborted();
      const choice = select(ctx);
      if (choice.kind !== 'wait') return choice;
      const now = clock.now();
      const remaining = Math.min(ctx.waitRemainingMs, ctx.deadline - now);
      if (remaining <= 0) return { kind: 'exhausted', retryAt: choice.until };
      const ms = Math.min(Math.max(choice.until - now, 0), remaining);
      ctx.waitRemainingMs -= ms;
      await clock.sleep(ms, signal);
    }
  };

  const diagnose = (): GroupDiagnostic[] => [...groups].map(([group, state]) => ({
    group,
    cooldownUntil: state.cooldownUntil,
    inFlight: state.inFlight,
    failures: state.failures,
    ...(state.disabledReason ? { disabledReason: state.disabledReason } : {}),
  }));

  return { select, settle, release, waitAndSelect, diagnose };
}
