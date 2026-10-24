import { describe, expect, test } from 'bun:test';
import {
  eligibleCandidates,
  upgradeTarget,
  validateAutoRouterConfig,
  type RouterCandidate,
} from '../src/agent/router/index.ts';

const baseCandidates: RouterCandidate[] = [
  {
    modelId: 'c-cheap',
    description: 'Fast cheap model',
    relativeCost: 1,
    supportsImages: false,
    reasoningEffort: 'low',
    upgradeTo: 'c-mid',
  },
  {
    modelId: 'c-mid',
    description: 'Balanced medium model',
    relativeCost: 5,
    supportsImages: true,
    reasoningEffort: 'medium',
    upgradeTo: 'c-expensive',
  },
  {
    modelId: 'c-expensive',
    description: 'High capability model',
    relativeCost: 20,
    supportsImages: true,
    reasoningEffort: 'high',
  },
];

describe('validateAutoRouterConfig', () => {
  const known = new Set(['classifier-hermes', 'c-cheap', 'c-mid', 'c-expensive']);

  test('valid config returns normalized defaults', () => {
    const raw = {
      classifierModel: 'classifier-hermes',
      candidates: baseCandidates,
    };
    const valid = validateAutoRouterConfig(raw, known);
    expect(valid.classifierModel).toBe('classifier-hermes');
    expect(valid.candidates.length).toBe(3);
    expect(valid.threshold).toBe(0.7);
    expect(valid.routineShare).toBe(0.75);
    expect(valid.classifierTimeoutMs).toBe(10_000);
    expect(valid.retriesPerModel).toBe(3);
  });

  test('valid config with explicit fields preserves them', () => {
    const raw = {
      classifierModel: 'classifier-hermes',
      candidates: baseCandidates,
      threshold: 0.8,
      routineShare: 0.6,
      classifierTimeoutMs: 5000,
      retriesPerModel: 5,
    };
    const valid = validateAutoRouterConfig(raw, known);
    expect(valid.threshold).toBe(0.8);
    expect(valid.routineShare).toBe(0.6);
    expect(valid.classifierTimeoutMs).toBe(5000);
    expect(valid.retriesPerModel).toBe(5);
  });

  test('Jev classifier replaces classifierModel and accepts optional settings', () => {
    const valid = validateAutoRouterConfig({
      classifier: { kind: 'jev', model: 'jev-latest', baseUrl: 'https://example.test', timeoutMs: 2500 },
      candidates: baseCandidates,
    }, known);
    expect(valid.classifier).toEqual({ kind: 'jev', model: 'jev-latest', baseUrl: 'https://example.test', timeoutMs: 2500 });
    expect(valid.classifierModel).toBeUndefined();
  });

  test('validates Jev classifier configuration', () => {
    for (const classifier of [null, [], { kind: 'other' }, { kind: 'jev', model: '' }, { kind: 'jev', baseUrl: '' }, { kind: 'jev', timeoutMs: 0 }]) {
      expect(() => validateAutoRouterConfig({ classifier, candidates: baseCandidates }, known)).toThrow(/classifier/i);
    }
  });

  test('throws on non-object config', () => {
    expect(() => validateAutoRouterConfig(null, known)).toThrow(/must be an object/i);
    expect(() => validateAutoRouterConfig([], known)).toThrow(/must be an object/i);
    expect(() => validateAutoRouterConfig('string', known)).toThrow(/must be an object/i);
  });

  test('throws on empty or unknown classifierModel', () => {
    expect(() =>
      validateAutoRouterConfig({ classifierModel: '', candidates: baseCandidates }, known),
    ).toThrow(/classifierModel must be a non-empty string/i);
    expect(() =>
      validateAutoRouterConfig(
        { classifierModel: 'unknown-classifier', candidates: baseCandidates },
        known,
      ),
    ).toThrow(/is unknown/i);
  });

  test('throws when candidates is empty or not an array', () => {
    expect(() =>
      validateAutoRouterConfig({ classifierModel: 'classifier-hermes', candidates: [] }, known),
    ).toThrow(/non-empty array/i);
    expect(() =>
      validateAutoRouterConfig({ classifierModel: 'classifier-hermes', candidates: null }, known),
    ).toThrow(/non-empty array/i);
  });

  test('throws on duplicate candidate modelIds', () => {
    const dupes = [
      { modelId: 'm1', relativeCost: 1, supportsImages: false, description: '' },
      { modelId: 'm1', relativeCost: 2, supportsImages: false, description: '' },
    ];
    expect(() =>
      validateAutoRouterConfig({ classifierModel: 'classifier-hermes', candidates: dupes }, known),
    ).toThrow(/duplicate candidate/i);
  });

  test('throws when classifierModel is included as a candidate', () => {
    const cand = [
      {
        modelId: 'classifier-hermes',
        relativeCost: 1,
        supportsImages: false,
        description: '',
      },
    ];
    expect(() =>
      validateAutoRouterConfig({ classifierModel: 'classifier-hermes', candidates: cand }, known),
    ).toThrow(/cannot be included as a candidate/i);
  });

  test('throws on invalid relativeCost', () => {
    const badCost = [
      { modelId: 'c1', relativeCost: 0, supportsImages: false, description: '' },
    ];
    expect(() =>
      validateAutoRouterConfig(
        { classifierModel: 'classifier-hermes', candidates: badCost },
        known,
      ),
    ).toThrow(/relativeCost > 0/i);

    const negCost = [
      { modelId: 'c1', relativeCost: -5, supportsImages: false, description: '' },
    ];
    expect(() =>
      validateAutoRouterConfig(
        { classifierModel: 'classifier-hermes', candidates: negCost },
        known,
      ),
    ).toThrow(/relativeCost > 0/i);
  });

  test('throws on non-existent upgradeTo target', () => {
    const missingUpgrade = [
      {
        modelId: 'c1',
        relativeCost: 1,
        supportsImages: false,
        description: '',
        upgradeTo: 'does-not-exist',
      },
    ];
    expect(() =>
      validateAutoRouterConfig(
        { classifierModel: 'classifier-hermes', candidates: missingUpgrade },
        known,
      ),
    ).toThrow(/does not exist in candidates/i);
  });

  test('throws on upgrade cycle', () => {
    const selfCycle = [
      { modelId: 'c1', relativeCost: 1, supportsImages: false, description: '', upgradeTo: 'c1' },
    ];
    expect(() =>
      validateAutoRouterConfig(
        { classifierModel: 'classifier-hermes', candidates: selfCycle },
        known,
      ),
    ).toThrow(/cycle detected/i);

    const cycle2 = [
      { modelId: 'c1', relativeCost: 1, supportsImages: false, description: '', upgradeTo: 'c2' },
      { modelId: 'c2', relativeCost: 2, supportsImages: false, description: '', upgradeTo: 'c1' },
    ];
    expect(() =>
      validateAutoRouterConfig(
        { classifierModel: 'classifier-hermes', candidates: cycle2 },
        known,
      ),
    ).toThrow(/cycle detected/i);
  });

  test('throws on threshold or routineShare out of (0, 1]', () => {
    expect(() =>
      validateAutoRouterConfig(
        { classifierModel: 'classifier-hermes', candidates: baseCandidates, threshold: 0 },
        known,
      ),
    ).toThrow(/threshold/i);
    expect(() =>
      validateAutoRouterConfig(
        { classifierModel: 'classifier-hermes', candidates: baseCandidates, threshold: 1.1 },
        known,
      ),
    ).toThrow(/threshold/i);
    expect(() =>
      validateAutoRouterConfig(
        { classifierModel: 'classifier-hermes', candidates: baseCandidates, routineShare: 0 },
        known,
      ),
    ).toThrow(/routineShare/i);
    expect(() =>
      validateAutoRouterConfig(
        { classifierModel: 'classifier-hermes', candidates: baseCandidates, routineShare: 1.5 },
        known,
      ),
    ).toThrow(/routineShare/i);
  });
});

describe('eligibleCandidates', () => {
  test('returns all candidates when imagesPresent is false', () => {
    const res = eligibleCandidates(baseCandidates, { imagesPresent: false });
    expect(res.length).toBe(3);
  });

  test('filters candidates without supportsImages when imagesPresent is true', () => {
    const res = eligibleCandidates(baseCandidates, { imagesPresent: true });
    expect(res.length).toBe(2);
    expect(res.map(c => c.modelId)).toEqual(['c-mid', 'c-expensive']);
  });
});

describe('upgradeTarget', () => {
  const cands: RouterCandidate[] = [
    {
      modelId: 'm1',
      relativeCost: 1,
      supportsImages: false,
      description: '',
      upgradeTo: 'm2',
    },
    {
      modelId: 'm2',
      relativeCost: 5,
      supportsImages: false,
      description: '',
      upgradeTo: 'm3',
    },
    {
      modelId: 'm3',
      relativeCost: 15,
      supportsImages: false,
      description: '',
    },
    {
      modelId: 'm4-expensive',
      relativeCost: 30,
      supportsImages: false,
      description: '',
    },
  ];

  test('follows explicit upgradeTo when destination is available', () => {
    const available = new Set(['m1', 'm2', 'm3']);
    expect(upgradeTarget('m1', cands, available)).toBe('m2');
  });

  test('skips unavailable destination in upgradeTo chain to find next available', () => {
    const available = new Set(['m1', 'm3']);
    expect(upgradeTarget('m1', cands, available)).toBe('m3');
  });

  test('safely terminates and falls back when cycle exists in upgradeTo chain', () => {
    const cycleCands: RouterCandidate[] = [
      { modelId: 'c1', relativeCost: 1, supportsImages: false, description: '', upgradeTo: 'c2' },
      { modelId: 'c2', relativeCost: 2, supportsImages: false, description: '', upgradeTo: 'c1' },
      { modelId: 'c3', relativeCost: 10, supportsImages: false, description: '' },
    ];
    const available = new Set(['c3']);
    expect(upgradeTarget('c1', cycleCands, available)).toBe('c3');
  });

  test('falls back to next higher relativeCost candidate when upgradeTo is absent', () => {
    const available = new Set(['m1', 'm2', 'm3', 'm4-expensive']);
    expect(upgradeTarget('m3', cands, available)).toBe('m4-expensive');
  });

  test('returns undefined when candidate is already at the top', () => {
    const available = new Set(['m1', 'm2', 'm3', 'm4-expensive']);
    expect(upgradeTarget('m4-expensive', cands, available)).toBeUndefined();
  });
});
