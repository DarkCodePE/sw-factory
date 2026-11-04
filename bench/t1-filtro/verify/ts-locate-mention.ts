import { describe, expect, test } from 'bun:test';
import { adfToText } from '../src/adf.ts';

describe('ts-locate-mention', () => {
  test('renders mention with explicit text', () => {
    const node = { type: 'mention', attrs: { id: 'user-42', text: '@alice' } };
    expect(adfToText(node)).toBe('@alice');
  });

  test('renders mention with id fallback when text is missing', () => {
    const node = { type: 'mention', attrs: { id: 'bob-99' } };
    expect(adfToText(node)).toBe('@bob-99');
  });

  test('renders @unknown when neither text nor id is present', () => {
    expect(adfToText({ type: 'mention', attrs: {} })).toBe('@unknown');
    expect(adfToText({ type: 'mention' })).toBe('@unknown');
  });

  test('renders mentions inside paragraphs', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Notificar a ' },
            { type: 'mention', attrs: { text: '@carol' } },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toBe('Notificar a @carol');
  });
});
