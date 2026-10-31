import type { RouterCandidate, RoutingContext, RoutingDecision, RoutingReason } from './types.ts';

/**
 * Filters candidates based on turn context requirements.
 * When images are present in the turn, candidates without image support are excluded.
 */
export function eligibleCandidates(
  cands: RouterCandidate[],
  ctx: Pick<RoutingContext, 'imagesPresent'>,
): RouterCandidate[] {
  if (ctx.imagesPresent) {
    return cands.filter(c => c.supportsImages);
  }
  return [...cands];
}

/**
 * Selects the optimal candidate model and ordered fallbacks based on classifier scores.
 *
 * Rules:
 * - If only 1 candidate is eligible, select it directly ('single_candidate' or 'vision_required').
 * - If the classifier failed (scores is undefined), fallback to the first candidate ('classifier_failed').
 * - Viables: candidates with score >= threshold.
 * - When viables exist: cheapest viable wins; fallbacks are remaining viables + candidates with 0 < score < threshold.
 *   Reason is 'routine' if viables count >= routineShare * eligible count; otherwise 'task_fit'.
 * - When no viables: highest score wins ('hard'); fallbacks are remaining candidates with score > 0.
 * - Score 0 is never included in fallbacks.
 */
export function selectModel(
  eligible: RouterCandidate[],
  scores: Record<string, number> | undefined,
  opts: { threshold: number; routineShare: number; vision: boolean },
): Omit<RoutingDecision, 'classifierMs'> {
  const firstEligible = eligible[0];
  if (!firstEligible) {
    throw new Error(
      opts.vision
        ? 'No eligible candidates support images'
        : 'No eligible model candidates available',
    );
  }

  // Single candidate: used directly without classification
  if (eligible.length === 1) {
    const rawVal = scores?.[firstEligible.modelId];
    const initialScores: Record<string, number> = {
      [firstEligible.modelId]:
        typeof rawVal === 'number' && !Number.isNaN(rawVal)
          ? Math.max(0, Math.min(1, rawVal))
          : 1,
    };

    return {
      modelId: firstEligible.modelId,
      reasoningEffort: firstEligible.reasoningEffort,
      reason: opts.vision ? 'vision_required' : 'single_candidate',
      fallbacks: [],
      scores: initialScores,
    };
  }

  // Classifier failure: first eligible candidate with no fallbacks
  if (!scores) {
    return {
      modelId: firstEligible.modelId,
      reasoningEffort: firstEligible.reasoningEffort,
      reason: 'classifier_failed',
      fallbacks: [],
      scores: {},
    };
  }

  // Normalize scores for eligible candidates: clamp [0, 1], missing is 0
  const normalizedScores: Record<string, number> = {};
  const scoreMap = new Map<string, number>();

  for (const cand of eligible) {
    const raw = scores[cand.modelId];
    const score =
      typeof raw === 'number' && !Number.isNaN(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    normalizedScores[cand.modelId] = score;
    scoreMap.set(cand.modelId, score);
  }

  const getScore = (c: RouterCandidate): number => scoreMap.get(c.modelId) ?? 0;

  const viables = eligible.filter(c => getScore(c) >= opts.threshold);

  if (viables.length > 0) {
    // Sort viables: cheapest relativeCost ascending, tie-break highest score, tie-break config order
    const sortedViables = [...viables].sort((a, b) => {
      if (a.relativeCost !== b.relativeCost) {
        return a.relativeCost - b.relativeCost;
      }
      const scoreDiff = getScore(b) - getScore(a);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return eligible.indexOf(a) - eligible.indexOf(b);
    });

    const winner = sortedViables[0] ?? firstEligible;

    // Non-viables with 0 < score < threshold sorted by score descending
    const nonViablesWithPositiveScore = eligible
      .filter(c => getScore(c) < opts.threshold && getScore(c) > 0)
      .sort((a, b) => {
        const scoreDiff = getScore(b) - getScore(a);
        if (scoreDiff !== 0) {
          return scoreDiff;
        }
        if (a.relativeCost !== b.relativeCost) {
          return a.relativeCost - b.relativeCost;
        }
        return eligible.indexOf(a) - eligible.indexOf(b);
      });

    const fallbacks = [
      ...sortedViables.slice(1).map(c => c.modelId),
      ...nonViablesWithPositiveScore.map(c => c.modelId),
    ];

    const reason: RoutingReason =
      viables.length >= opts.routineShare * eligible.length ? 'routine' : 'task_fit';

    return {
      modelId: winner.modelId,
      reasoningEffort: winner.reasoningEffort,
      reason,
      fallbacks,
      scores: normalizedScores,
    };
  }

  // No candidates reached the threshold: highest score wins ('hard')
  const sorted = [...eligible].sort((a, b) => {
    const scoreDiff = getScore(b) - getScore(a);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    if (a.relativeCost !== b.relativeCost) {
      return a.relativeCost - b.relativeCost;
    }
    return eligible.indexOf(a) - eligible.indexOf(b);
  });

  const winner = sorted[0] ?? firstEligible;
  const fallbacks = sorted
    .slice(1)
    .filter(c => getScore(c) > 0)
    .map(c => c.modelId);

  return {
    modelId: winner.modelId,
    reasoningEffort: winner.reasoningEffort,
    reason: 'hard',
    fallbacks,
    scores: normalizedScores,
  };
}
