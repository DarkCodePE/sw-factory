import { expect, test } from 'bun:test';
import { pricedUsage } from '../src/inference-usage.ts';

test.each([
  ['claude-sonnet-4-6', 1_000_000, 22.05],
  ['claude-haiku-4-5-20251001', 1_000_000, 7.35],
  ['gemini-2.5-flash', 0, 2.83],
  ['gpt-5.2-codex', 0, 15.925],
])('T108 H6: tarifa y versión de %s', (effectiveModel, cacheWriteTokens, costUsd) => {
  const usage = pricedUsage({ effectiveModel, inputTokens: 2_000_000 + cacheWriteTokens,
    outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens });
  expect(usage.priceVersion).toBe('2026-11-21-v1');
  expect(usage.costUsd).toBeCloseTo(costUsd, 8);
});

test('T108 H6: el coste declarado gana aunque exista una tarifa aplicable', () => {
  const declared = { effectiveModel: 'claude-sonnet-4-6', inputTokens: 500, outputTokens: 10,
    cacheReadTokens: 40, cacheWriteTokens: 20, costUsd: 0 };
  expect(pricedUsage(declared)).toEqual(declared);
});
