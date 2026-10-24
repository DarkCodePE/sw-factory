import type { AutoRouterConfig, RouterCandidate } from './types.ts';

/**
 * Validates the raw configuration for the `auto` model router.
 *
 * Enforces:
 * - candidates must be a non-empty array with unique modelIds
 * - relativeCost must be positive
 * - classifierModel must be known and cannot be included as a candidate
 * - upgradeTo targets must exist in candidates and cannot form cycles
 * - threshold and routineShare must be in (0, 1]
 */
export function validateAutoRouterConfig(raw: unknown, knownModelIds: Set<string>): AutoRouterConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('AutoRouter configuration must be an object');
  }

  const obj = raw as Record<string, unknown>;

  let classifier: AutoRouterConfig['classifier'];
  if (obj.classifier !== undefined) {
    if (!obj.classifier || typeof obj.classifier !== 'object' || Array.isArray(obj.classifier)) {
      throw new Error('classifier must be an object');
    }
    const rawClassifier = obj.classifier as Record<string, unknown>;
    if (rawClassifier.kind !== 'jev') throw new Error("classifier.kind must be 'jev'");
    if (rawClassifier.model !== undefined && (typeof rawClassifier.model !== 'string' || !rawClassifier.model.trim())) {
      throw new Error('classifier.model must be a non-empty string');
    }
    if (rawClassifier.baseUrl !== undefined && (typeof rawClassifier.baseUrl !== 'string' || !rawClassifier.baseUrl.trim())) {
      throw new Error('classifier.baseUrl must be a non-empty string');
    }
    if (rawClassifier.timeoutMs !== undefined && (typeof rawClassifier.timeoutMs !== 'number' || !Number.isFinite(rawClassifier.timeoutMs) || rawClassifier.timeoutMs <= 0)) {
      throw new Error('classifier.timeoutMs must be a positive number');
    }
    classifier = {
      kind: 'jev',
      ...(typeof rawClassifier.model === 'string' ? { model: rawClassifier.model.trim() } : {}),
      ...(typeof rawClassifier.baseUrl === 'string' ? { baseUrl: rawClassifier.baseUrl.trim() } : {}),
      ...(typeof rawClassifier.timeoutMs === 'number' ? { timeoutMs: rawClassifier.timeoutMs } : {}),
    };
  }

  let classifierModel: string | undefined;
  if (!classifier) {
    if (typeof obj.classifierModel !== 'string' || !obj.classifierModel.trim()) {
      throw new Error('classifierModel must be a non-empty string');
    }
    classifierModel = obj.classifierModel.trim();
    if (!knownModelIds.has(classifierModel)) {
      throw new Error(`classifierModel "${classifierModel}" is unknown`);
    }
  }

  if (!Array.isArray(obj.candidates) || obj.candidates.length === 0) {
    throw new Error('candidates must be a non-empty array');
  }

  const seenIds = new Set<string>();
  const candidates: RouterCandidate[] = [];

  for (const [idx, item] of obj.candidates.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Candidate at index ${idx} must be an object`);
    }
    const cand = item as Record<string, unknown>;

    if (typeof cand.modelId !== 'string' || !cand.modelId.trim()) {
      throw new Error(`Candidate at index ${idx} must have a non-empty string modelId`);
    }
    const modelId = cand.modelId.trim();

    if (seenIds.has(modelId)) {
      throw new Error(`Duplicate candidate modelId: "${modelId}"`);
    }
    seenIds.add(modelId);

    if (modelId === classifierModel) {
      throw new Error(`classifierModel "${classifierModel}" cannot be included as a candidate`);
    }

    if (typeof cand.relativeCost !== 'number' || Number.isNaN(cand.relativeCost) || cand.relativeCost <= 0) {
      throw new Error(`Candidate "${modelId}" must have relativeCost > 0`);
    }

    if (typeof cand.supportsImages !== 'boolean') {
      throw new Error(`Candidate "${modelId}" must have a boolean supportsImages`);
    }

    if (
      cand.reasoningEffort !== undefined &&
      cand.reasoningEffort !== 'low' &&
      cand.reasoningEffort !== 'medium' &&
      cand.reasoningEffort !== 'high'
    ) {
      throw new Error(`Candidate "${modelId}" has invalid reasoningEffort: must be 'low', 'medium', or 'high'`);
    }

    let upgradeTo: string | undefined;
    if (cand.upgradeTo !== undefined) {
      if (typeof cand.upgradeTo !== 'string' || !cand.upgradeTo.trim()) {
        throw new Error(`Candidate "${modelId}" has invalid upgradeTo: must be a non-empty string`);
      }
      upgradeTo = cand.upgradeTo.trim();
    }

    candidates.push({
      modelId,
      description: typeof cand.description === 'string' ? cand.description : '',
      relativeCost: cand.relativeCost,
      supportsImages: cand.supportsImages,
      reasoningEffort: cand.reasoningEffort as 'low' | 'medium' | 'high' | undefined,
      upgradeTo,
    });
  }

  // Validate upgradeTo targets exist
  for (const cand of candidates) {
    if (cand.upgradeTo !== undefined) {
      if (!seenIds.has(cand.upgradeTo)) {
        throw new Error(
          `Candidate "${cand.modelId}" has upgradeTo "${cand.upgradeTo}" which does not exist in candidates`,
        );
      }
    }
  }

  // Validate no upgrade cycles
  for (const start of candidates) {
    const visited = new Set<string>();
    let curr: string | undefined = start.modelId;
    while (curr) {
      if (visited.has(curr)) {
        throw new Error(
          `Cycle detected in upgrade ladder starting from candidate "${start.modelId}" at "${curr}"`,
        );
      }
      visited.add(curr);
      const cand = candidates.find(c => c.modelId === curr);
      curr = cand?.upgradeTo;
    }
  }

  let threshold = 0.7;
  if (obj.threshold !== undefined) {
    if (
      typeof obj.threshold !== 'number' ||
      Number.isNaN(obj.threshold) ||
      obj.threshold <= 0 ||
      obj.threshold > 1
    ) {
      throw new Error('threshold must be a number in (0, 1]');
    }
    threshold = obj.threshold;
  }

  let routineShare = 0.75;
  if (obj.routineShare !== undefined) {
    if (
      typeof obj.routineShare !== 'number' ||
      Number.isNaN(obj.routineShare) ||
      obj.routineShare <= 0 ||
      obj.routineShare > 1
    ) {
      throw new Error('routineShare must be a number in (0, 1]');
    }
    routineShare = obj.routineShare;
  }

  let classifierTimeoutMs = 10_000;
  if (obj.classifierTimeoutMs !== undefined) {
    if (
      typeof obj.classifierTimeoutMs !== 'number' ||
      Number.isNaN(obj.classifierTimeoutMs) ||
      obj.classifierTimeoutMs <= 0
    ) {
      throw new Error('classifierTimeoutMs must be a positive number');
    }
    classifierTimeoutMs = obj.classifierTimeoutMs;
  }

  let retriesPerModel = 3;
  if (obj.retriesPerModel !== undefined) {
    if (
      typeof obj.retriesPerModel !== 'number' ||
      Number.isNaN(obj.retriesPerModel) ||
      obj.retriesPerModel < 0 ||
      !Number.isInteger(obj.retriesPerModel)
    ) {
      throw new Error('retriesPerModel must be a non-negative integer');
    }
    retriesPerModel = obj.retriesPerModel;
  }

  return {
    candidates,
    ...(classifier ? { classifier } : { classifierModel }),
    threshold,
    routineShare,
    classifierTimeoutMs,
    retriesPerModel,
  };
}
