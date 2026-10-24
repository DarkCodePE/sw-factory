import { expect, test } from 'bun:test';
import { retryAfterMs } from '../src/agent/transport.ts';

test('retry-after accepts seconds and HTTP dates, capped at two minutes', () => {
  expect(retryAfterMs(null)).toBeUndefined();
  expect(retryAfterMs('2')).toBe(2000);
  expect(retryAfterMs('9999')).toBe(120_000);
  expect(retryAfterMs(new Date(10_000).toUTCString(), 7_000)).toBe(3000);
  expect(retryAfterMs('soon')).toBeUndefined();
});
