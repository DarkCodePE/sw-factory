import { describe, expect, test } from 'bun:test';
import { adfToText, markdownToAdf } from '../src/adf.ts';

describe('ts-locate-rule', () => {
  test('adfToText renders rule node as horizontal rule', () => {
    expect(adfToText({ type: 'rule' })).toBe('---');
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Sección 1' }] },
        { type: 'rule' },
        { type: 'paragraph', content: [{ type: 'text', text: 'Sección 2' }] },
      ],
    };
    const text = adfToText(doc);
    expect(text).toContain('Sección 1\n\n---\n\nSección 2');
  });

  test('markdownToAdf parses --- and *** into rule nodes', () => {
    const md = 'Párrafo uno\n\n---\n\nPárrafo dos';
    const adf = markdownToAdf(md) as any;
    expect(adf.type).toBe('doc');
    expect(adf.content.length).toBe(3);
    expect(adf.content[1]).toEqual({ type: 'rule' });

    const mdStar = 'Arriba\n\n***\n\nAbajo';
    const adfStar = markdownToAdf(mdStar) as any;
    expect(adfStar.content[1]).toEqual({ type: 'rule' });
  });
});
