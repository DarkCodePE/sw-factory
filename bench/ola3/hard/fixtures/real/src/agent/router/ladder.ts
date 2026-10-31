import type { RouterCandidate } from './types.ts';

/**
 * Determines the target model when escalating a session.
 *
 * Evaluation:
 * 1. Checks explicit `upgradeTo` on the current candidate.
 *    If that destination is not in `available`, walks subsequent `upgradeTo` links
 *    (skipping unconfigured/unavailable models and avoiding infinite cycles).
 * 2. If no explicit `upgradeTo` is defined or none in the chain are available,
 *    picks the next candidate with a higher `relativeCost` (ascending order)
 *    that is present in `available`.
 * 3. Returns `undefined` if the candidate is already at the top or no available upgrade exists.
 */
export function upgradeTarget(
  current: string,
  cands: RouterCandidate[],
  available: Set<string>,
): string | undefined {
  const currentCand = cands.find(c => c.modelId === current);
  if (!currentCand) {
    return undefined;
  }

  // 1. Follow explicit upgradeTo ladder chain
  if (currentCand.upgradeTo) {
    const visited = new Set<string>([current]);
    let nextTarget: string | undefined = currentCand.upgradeTo;

    while (nextTarget) {
      if (visited.has(nextTarget)) {
        // Cycle detected, break to prevent infinite loops
        break;
      }
      visited.add(nextTarget);

      if (available.has(nextTarget)) {
        return nextTarget;
      }

      // Skip unconfigured / unavailable destinations
      const nextCand = cands.find(c => c.modelId === nextTarget);
      nextTarget = nextCand?.upgradeTo;
    }
  }

  // 2. Fallback: next higher relativeCost candidate that is available
  const higherCostCands = cands
    .filter(
      c =>
        c.relativeCost > currentCand.relativeCost &&
        available.has(c.modelId) &&
        c.modelId !== current,
    )
    .sort((a, b) => {
      if (a.relativeCost !== b.relativeCost) {
        return a.relativeCost - b.relativeCost;
      }
      return cands.indexOf(a) - cands.indexOf(b);
    });

  const first = higherCostCands[0];
  if (first) {
    return first.modelId;
  }

  return undefined;
}
