import type { OmniConfig, Needs, Profile, Tos } from './contracts.ts';
import { isAvoidProvider, isAvoidEndpoint } from './catalog.ts';

/**
 * Determine the effective Terms of Service status for a profile and endpoint.
 *
 * Rules:
 * - Any "avoid" verdict (from catalog ID, alias, endpoint host, or explicit tos) wins permanently.
 *   No user override, acknowledgeTos flag, or priority can bypass "avoid".
 * - "ok" requires explicit operator declaration (acknowledgeTos === true and tos === 'ok').
 *   Unreviewed IDs/hosts without acknowledgeTos are treated as "unknown".
 * - "caution" and "ambiguous" are accepted only with explicit acknowledgeTos === true.
 * - "unknown" is disabled by default.
 */
export function effectiveTos(profile: Profile, endpoint: string): Tos {
  // 1. Any avoid always wins unconditionally
  if (profile.tos === 'avoid') return 'avoid';
  if (isAvoidProvider(profile.providerId)) return 'avoid';
  if (isAvoidProvider(profile.modelId)) return 'avoid';
  if (isAvoidEndpoint(endpoint)) return 'avoid';

  // 2. Non-avoid evaluation based on operator acknowledgement
  switch (profile.tos) {
    case 'ok':
      return profile.acknowledgeTos === true ? 'ok' : 'unknown';
    case 'caution':
      return profile.acknowledgeTos === true ? 'caution' : 'unknown';
    case 'ambiguous':
      return profile.acknowledgeTos === true ? 'ambiguous' : 'unknown';
    case 'unknown':
    default:
      return 'unknown';
  }
}

/**
 * Check whether a profile's ToS is admissible for execution.
 */
export function isTosAdmissible(profile: Profile): boolean {
  if (profile.tos === 'avoid' || profile.tos === 'unknown') return false;
  if (isAvoidProvider(profile.providerId) || isAvoidProvider(profile.modelId)) return false;

  if (profile.tos === 'ok') return profile.acknowledgeTos === true;
  if (profile.tos === 'caution') return profile.acknowledgeTos === true;
  if (profile.tos === 'ambiguous') return profile.acknowledgeTos === true;

  return false;
}

interface IndexedProfile {
  profile: Profile;
  index: number;
}

/**
 * Filter and sort profiles eligible for a given turn's needs.
 *
 * Eligibility requirements:
 * - ToS admissible (not avoid, not unknown, properly acknowledged)
 * - Cost tier authorized (paid profiles require config.allowPaid === true)
 * - Tool calling capability (if needs.tools is true, supportsTools must be true)
 * - Vision capability (if needs.images is true, supportsImages must be true)
 * - Sufficient context window (contextWindow >= estimatedInputTokens + maxOutputTokens)
 *
 * Stable sorting order:
 * 1. Free tiers before paid tiers
 * 2. supportsTools === true before supportsTools === false (even in plain text)
 * 3. Priority ascending (lower priority number first)
 * 4. Declaration index in configuration
 *
 * Never returns profiles outside config.profiles (fails closed if empty).
 */
export function eligibleProfiles(config: OmniConfig, needs: Needs): readonly Profile[] {
  const requiredTokens = (needs.estimatedInputTokens ?? 0) + (needs.maxOutputTokens ?? 0);

  const eligible: IndexedProfile[] = [];

  for (let i = 0; i < config.profiles.length; i++) {
    const profile = config.profiles[i]!;

    // 1. ToS admissibility
    if (!isTosAdmissible(profile)) continue;

    // 2. Paid authorization (PAY-01)
    if (!config.allowPaid && profile.costTier === 'paid') continue;

    // 3. Tool calling requirement (CAP-01)
    if (needs.tools && !profile.supportsTools) continue;

    // 4. Image/vision requirement
    if (needs.images && !profile.supportsImages) continue;

    // 5. Context window capacity
    if (requiredTokens > 0 && profile.contextWindow < requiredTokens) continue;

    eligible.push({ profile, index: i });
  }

  // Stable sort
  eligible.sort((a, b) => {
    // 1. Free tiers before paid tiers
    if (a.profile.costTier !== b.profile.costTier) {
      return a.profile.costTier === 'free' ? -1 : 1;
    }

    // 2. supportsTools === true before false (even in plain text)
    if (a.profile.supportsTools !== b.profile.supportsTools) {
      return a.profile.supportsTools ? -1 : 1;
    }

    // 3. Priority ascending
    if (a.profile.priority !== b.profile.priority) {
      return a.profile.priority - b.profile.priority;
    }

    // 4. Declaration index in config
    return a.index - b.index;
  });

  return Object.freeze(eligible.map(e => Object.freeze({ ...e.profile })));
}
