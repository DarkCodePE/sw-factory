import { describe, expect, test } from 'bun:test';
import { adfToText, DEFAULT_MAX_DEPTH } from '../src/adf.ts';

describe('ts-locate-depth-limit', () => {
  test('exports DEFAULT_MAX_DEPTH equal to 100', () => {
    expect(DEFAULT_MAX_DEPTH).toBe(100);
  });

  test('respects custom maxDepth parameter', () => {
    const nested = {
      type: 'paragraph',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Profundo' }],
            },
          ],
        },
      ],
    };
    expect(adfToText(nested, 1)).toBe('');
    expect(adfToText(nested, 5)).toContain('Profundo');
    expect(adfToText(nested)).toContain('Profundo');
  });
});
