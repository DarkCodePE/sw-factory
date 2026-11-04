import { describe, expect, test } from 'bun:test';
import { adfToText, markdownToAdf } from '../src/adf.ts';

describe('ts-locate-strike', () => {
  test('adfToText renders strike mark with double tildes', () => {
    const node = {
      type: 'text',
      text: 'obsoleto',
      marks: [{ type: 'strike' }],
    };
    expect(adfToText(node)).toBe('~~obsoleto~~');
  });

  test('markdownToAdf parses ~~text~~ into strike mark and roundtrips', () => {
    const md = 'Este texto tiene ~~tachado~~ aquí.';
    const adf = markdownToAdf(md) as any;
    expect(adf.content[0].content).toContainEqual({
      type: 'text',
      text: 'tachado',
      marks: [{ type: 'strike' }],
    });
    expect(adfToText(adf)).toContain('~~tachado~~');
  });
});
