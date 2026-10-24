import { describe, expect, test } from 'bun:test';
import {
  classify,
  parseClassifierOutput,
  route,
  selectModel,
  type AutoRouterConfig,
  type RouterCandidate,
  type RoutingContext,
} from '../src/agent/router/index.ts';
import type { ModelProvider, ModelRequest, ModelTurn } from '../src/agent/types.ts';

function mockProvider(
  id: string,
  handler: (req: ModelRequest, signal: AbortSignal) => Promise<ModelTurn>,
): ModelProvider {
  return {
    id,
    complete: (req, signal) => handler(req, signal),
  };
}

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

const baseContext: RoutingContext = {
  userMessage: 'Solve this algorithm',
  turnNumber: 1,
  surface: 'chat',
  isSubagent: false,
  imagesPresent: false,
  hasFailedToolCalls: false,
  toolNames: ['read_file', 'run_command'],
};

describe('parseClassifierOutput', () => {
  const ids = ['c-cheap', 'c-mid', 'c-expensive'];

  test('parses naked JSON', () => {
    const raw = JSON.stringify({
      scores: { 'c-cheap': 0.85, 'c-mid': 0.9, 'c-expensive': 0.95 },
      reasoning: 'Straightforward coding task',
    });
    const parsed = parseClassifierOutput(raw, ids);
    expect(parsed).toBeDefined();
    expect(parsed?.scores['c-cheap']).toBe(0.85);
    expect(parsed?.scores['c-mid']).toBe(0.9);
    expect(parsed?.scores['c-expensive']).toBe(0.95);
    expect(parsed?.rationale).toBe('Straightforward coding task');
  });

  test('parses markdown code block with ```json', () => {
    const raw = "```json\n{\n  \"scores\": { \"c-cheap\": 0.7 },\n  \"reasoning\": \"ok\"\n}\n```";
    const parsed = parseClassifierOutput(raw, ids);
    expect(parsed).toBeDefined();
    expect(parsed?.scores['c-cheap']).toBe(0.7);
    expect(parsed?.scores['c-mid']).toBe(0);
    expect(parsed?.rationale).toBe('ok');
  });

  test('parses markdown code block without language identifier', () => {
    const raw = "```\n{\n  \"scores\": { \"c-mid\": 0.88 },\n  \"rationale\": \"good\"\n}\n```";
    const parsed = parseClassifierOutput(raw, ids);
    expect(parsed).toBeDefined();
    expect(parsed?.scores['c-mid']).toBe(0.88);
    expect(parsed?.rationale).toBe('good');
  });

  test('handles garbage / conversational text around JSON', () => {
    const raw = "Sure! Here is the routing evaluation:\n{\"scores\": {\"c-cheap\": 0.95}}\nHope that helps!";
    const parsed = parseClassifierOutput(raw, ids);
    expect(parsed).toBeDefined();
    expect(parsed?.scores['c-cheap']).toBe(0.95);
  });

  test('ignores unknown ids and clamps values outside [0, 1]', () => {
    const raw = JSON.stringify({
      scores: {
        'c-cheap': 1.5,
        'c-mid': -0.4,
        'unknown-id': 0.99,
      },
    });
    const parsed = parseClassifierOutput(raw, ids);
    expect(parsed).toBeDefined();
    expect(parsed?.scores['c-cheap']).toBe(1);
    expect(parsed?.scores['c-mid']).toBe(0);
    expect(parsed?.scores['unknown-id']).toBeUndefined();
  });

  test('returns undefined on unparsable output', () => {
    expect(parseClassifierOutput('not a json string', ids)).toBeUndefined();
    expect(parseClassifierOutput('{"scores": "not-an-object"}', ids)).toBeUndefined();
    expect(parseClassifierOutput('', ids)).toBeUndefined();
  });
});

describe('classify', () => {
  test('resolves promptly and returns parsed scores on successful provider response', async () => {
    const provider = mockProvider('hermes', async () => ({
      text: JSON.stringify({
        scores: { 'c-cheap': 0.95, 'c-mid': 0.8 },
        reasoning: 'routine task',
      }),
      toolCalls: [],
      finishReason: 'stop',
    }));

    const res = await classify(provider, baseCandidates, baseContext, {
      timeoutMs: 2000,
      signal: new AbortController().signal,
    });
    expect(res).toBeDefined();
    expect(res?.scores['c-cheap']).toBe(0.95);
    expect(res?.rationale).toBe('routine task');
  });

  test('resolves in ~timeoutMs without hanging when provider never responds', async () => {
    const provider = mockProvider('unresponsive', () => new Promise(() => {}));
    const t0 = Date.now();
    const res = await classify(provider, baseCandidates, baseContext, {
      timeoutMs: 200,
      signal: new AbortController().signal,
    });
    const elapsed = Date.now() - t0;
    expect(res).toBeUndefined();
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(1000);
  });

  test('returns undefined when provider throws an error', async () => {
    const provider = mockProvider('failing', async () => {
      throw new Error('Connection refused');
    });
    const res = await classify(provider, baseCandidates, baseContext, {
      timeoutMs: 2000,
      signal: new AbortController().signal,
    });
    expect(res).toBeUndefined();
  });

  test('rethrows when external signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('User cancelled'));

    const provider = mockProvider('cancelled', async () => ({
      text: '{}',
      toolCalls: [],
      finishReason: 'stop',
    }));

    await expect(
      classify(provider, baseCandidates, baseContext, {
        timeoutMs: 2000,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/User cancelled/i);
  });
});

describe('selectModel', () => {
  test('sonda case: 0.95 vs 0.75 with cheaper candidate winning -> task_fit', () => {
    const scores = {
      'c-expensive': 0.95,
      'c-mid': 0.75,
      'c-cheap': 0.2,
    };
    const decision = selectModel(baseCandidates, scores, {
      threshold: 0.7,
      routineShare: 0.75,
      vision: false,
    });

    expect(decision.modelId).toBe('c-mid');
    expect(decision.reason).toBe('task_fit');
    expect(decision.fallbacks).toEqual(['c-expensive', 'c-cheap']);
    expect(decision.reasoningEffort).toBe('medium');
  });

  test('routine case: 6 of 7 viables (>= routineShare * eligible) -> routine', () => {
    const sevenCandidates: RouterCandidate[] = Array.from({ length: 7 }, (_, i) => ({
      modelId: `cand-${i + 1}`,
      relativeCost: (i + 1) * 10,
      supportsImages: false,
      description: `cand ${i + 1}`,
    }));

    const scores: Record<string, number> = {
      'cand-1': 0.8,
      'cand-2': 0.85,
      'cand-3': 0.9,
      'cand-4': 0.75,
      'cand-5': 0.7,
      'cand-6': 0.72,
      'cand-7': 0.1,
    };

    const decision = selectModel(sevenCandidates, scores, {
      threshold: 0.7,
      routineShare: 0.75,
      vision: false,
    });

    expect(decision.reason).toBe('routine');
    expect(decision.modelId).toBe('cand-1');
    expect(decision.fallbacks).toContain('cand-7');
  });

  test('hard case: no candidate meets threshold -> highest score wins with reason hard', () => {
    const scores = {
      'c-cheap': 0.3,
      'c-mid': 0.65,
      'c-expensive': 0.5,
    };
    const decision = selectModel(baseCandidates, scores, {
      threshold: 0.7,
      routineShare: 0.75,
      vision: false,
    });

    expect(decision.reason).toBe('hard');
    expect(decision.modelId).toBe('c-mid');
    expect(decision.fallbacks).toEqual(['c-expensive', 'c-cheap']);
  });

  test('score 0 never enters fallbacks (both viable and hard paths)', () => {
    const scoresViables = {
      'c-cheap': 0.8,
      'c-mid': 0.75,
      'c-expensive': 0.0,
    };
    const dec1 = selectModel(baseCandidates, scoresViables, {
      threshold: 0.7,
      routineShare: 0.75,
      vision: false,
    });
    expect(dec1.fallbacks).not.toContain('c-expensive');

    const scoresHard = {
      'c-cheap': 0.5,
      'c-mid': 0.2,
      'c-expensive': 0.0,
    };
    const dec2 = selectModel(baseCandidates, scoresHard, {
      threshold: 0.7,
      routineShare: 0.75,
      vision: false,
    });
    expect(dec2.modelId).toBe('c-cheap');
    expect(dec2.fallbacks).toEqual(['c-mid']);
    expect(dec2.fallbacks).not.toContain('c-expensive');
  });

  test('single eligible candidate without vision gives single_candidate', () => {
    const decision = selectModel([baseCandidates[0]!], undefined, {
      threshold: 0.7,
      routineShare: 0.75,
      vision: false,
    });
    expect(decision.modelId).toBe('c-cheap');
    expect(decision.reason).toBe('single_candidate');
    expect(decision.fallbacks).toEqual([]);
  });

  test('single eligible candidate with vision gives vision_required', () => {
    const decision = selectModel([baseCandidates[1]!], undefined, {
      threshold: 0.7,
      routineShare: 0.75,
      vision: true,
    });
    expect(decision.modelId).toBe('c-mid');
    expect(decision.reason).toBe('vision_required');
    expect(decision.fallbacks).toEqual([]);
  });

  test('classifier failure gives first candidate and classifier_failed reason', () => {
    const decision = selectModel(baseCandidates, undefined, {
      threshold: 0.7,
      routineShare: 0.75,
      vision: false,
    });
    expect(decision.modelId).toBe('c-cheap');
    expect(decision.reason).toBe('classifier_failed');
    expect(decision.fallbacks).toEqual([]);
    expect(decision.scores).toEqual({});
  });

  test('empty eligible list throws error', () => {
    expect(() =>
      selectModel([], undefined, { threshold: 0.7, routineShare: 0.75, vision: false }),
    ).toThrow(/No eligible model candidates available/i);
    expect(() =>
      selectModel([], undefined, { threshold: 0.7, routineShare: 0.75, vision: true }),
    ).toThrow(/No eligible candidates support images/i);
  });
});

describe('route end-to-end', () => {
  const config: AutoRouterConfig = {
    classifierModel: 'classifier-hermes',
    candidates: baseCandidates,
    threshold: 0.7,
    routineShare: 0.75,
    classifierTimeoutMs: 1000,
  };

  test('selects cheapest viable candidate using classifier scores', async () => {
    const provider = mockProvider('hermes', async () => ({
      text: JSON.stringify({
        scores: { 'c-cheap': 0.9, 'c-mid': 0.8, 'c-expensive': 0.95 },
        reasoning: 'easy query',
      }),
      toolCalls: [],
      finishReason: 'stop',
    }));

    const decision = await route(config, provider, baseContext, new AbortController().signal);
    expect(decision.modelId).toBe('c-cheap');
    expect(decision.reason).toBe('routine');
    expect(decision.rationale).toBe('easy query');
    expect(decision.classifierMs).toBeGreaterThanOrEqual(0);
  });

  test('single candidate turn skips classifier call', async () => {
    let called = false;
    const provider = mockProvider('hermes', async () => {
      called = true;
      return { text: '{}', toolCalls: [], finishReason: 'stop' };
    });

    const singleCandConfig: AutoRouterConfig = {
      classifierModel: 'classifier-hermes',
      candidates: [baseCandidates[0]!],
    };

    const decision = await route(
      singleCandConfig,
      provider,
      baseContext,
      new AbortController().signal,
    );
    expect(called).toBe(false);
    expect(decision.modelId).toBe('c-cheap');
    expect(decision.reason).toBe('single_candidate');
    expect(decision.classifierMs).toBe(0);
  });

  test('vision turn with only one vision-capable candidate skips classifier', async () => {
    let called = false;
    const provider = mockProvider('hermes', async () => {
      called = true;
      return { text: '{}', toolCalls: [], finishReason: 'stop' };
    });

    const customCands: RouterCandidate[] = [
      { modelId: 'text-only', relativeCost: 1, supportsImages: false, description: '' },
      { modelId: 'vision-one', relativeCost: 5, supportsImages: true, description: '' },
    ];
    const cfg: AutoRouterConfig = {
      classifierModel: 'classifier-hermes',
      candidates: customCands,
    };

    const decision = await route(
      cfg,
      provider,
      { ...baseContext, imagesPresent: true },
      new AbortController().signal,
    );
    expect(called).toBe(false);
    expect(decision.modelId).toBe('vision-one');
    expect(decision.reason).toBe('vision_required');
    expect(decision.classifierMs).toBe(0);
  });

  test('falls back cleanly on classifier timeout', async () => {
    const provider = mockProvider('timeout', () => new Promise(() => {}));
    const quickConfig: AutoRouterConfig = {
      ...config,
      classifierTimeoutMs: 150,
    };

    const decision = await route(quickConfig, provider, baseContext, new AbortController().signal);
    expect(decision.modelId).toBe('c-cheap');
    expect(decision.reason).toBe('classifier_failed');
    expect(decision.fallbacks).toEqual([]);
  });
});
