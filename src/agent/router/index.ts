import type { ModelProvider } from '../types.ts';
import { classify } from './classifier.ts';
import { eligibleCandidates, selectModel } from './select.ts';
import type { AutoRouterConfig, RoutingContext, RoutingDecision } from './types.ts';

export * from './types.ts';
export * from './config.ts';
export * from './classifier.ts';
export * from './select.ts';
export * from './ladder.ts';

/**
 * End-to-end model router entry point.
 *
 * Steps:
 * 1. Checks external abort signal.
 * 2. Filters eligible candidates (e.g. by image capability).
 * 3. If single candidate, selects immediately with zero classifier latency.
 * 4. Otherwise, executes classification with timeout and signal control.
 * 5. Applies score-based selection rules and returns the decision.
 */
export async function route(
  config: AutoRouterConfig,
  classifierProvider: ModelProvider,
  ctx: RoutingContext,
  signal: AbortSignal,
): Promise<RoutingDecision> {
  if (signal.aborted) {
    throw (signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
  }

  const eligible = eligibleCandidates(config.candidates, ctx);
  const threshold = config.threshold ?? 0.7;
  const routineShare = config.routineShare ?? 0.75;
  const vision = ctx.imagesPresent;

  // Single candidate: no classification needed
  if (eligible.length <= 1) {
    const decision = selectModel(eligible, undefined, { threshold, routineShare, vision });
    return {
      ...decision,
      classifierMs: 0,
    };
  }

  // Classify multiple candidates
  const timeoutMs = config.classifierTimeoutMs ?? 10_000;
  const t0 = Date.now();
  const classification = await classify(classifierProvider, eligible, ctx, { timeoutMs, signal });
  const classifierMs = Date.now() - t0;

  const decision = selectModel(eligible, classification?.scores, {
    threshold,
    routineShare,
    vision,
  });

  return {
    ...decision,
    rationale: classification?.rationale,
    classifierMs,
  };
}
