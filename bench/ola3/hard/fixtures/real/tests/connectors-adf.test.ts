import { describe, expect, test } from 'bun:test';
import { adfToText, markdownToAdf } from '../src/connectors/adf.ts';

describe('connector ADF conversion', () => {
  test('nested lists, headings, code, links and unknown nodes remain readable', () => {
    const text = adfToText({ type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Criterios' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Padre' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hijo' }] }] }] },
      ] }] },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const x = 1;' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'sitio', marks: [{ type: 'link', attrs: { href: 'https://example.test' } }] }] },
      { type: 'futureNode', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Conocido dentro' }] }] },
      { type: 'unknown', content: 'invalid' }, null, 42,
    ] });
    expect(text).toContain('Criterios');
    expect(text).toMatch(/- Padre[\s\S]*  - Hijo/);
    expect(text).toContain('```ts\nconst x = 1;\n```');
    expect(text).toContain('[sitio](https://example.test)');
    expect(text).toContain('Conocido dentro');
    expect(adfToText({ type: 'bad', content: {} })).toBe('');
    expect(adfToText(undefined)).toBe('');
  });

  test('Markdown roundtrip retains lists, paragraphs, code and links', () => {
    const md = '# Título\n\nTexto con `código` y [enlace](https://example.test/a).\nOtra línea.\n\n- Uno\n  - Dos\n- Tres\n\n```sh\nprintf "$()"\n```';
    const adf = markdownToAdf(md) as any;
    expect(adf.type).toBe('doc');
    expect(adf.version).toBe(1);
    expect(adf.content[0].attrs.level).toBe(1);
    const text = adfToText(adf);
    for (const part of ['Título', '`código`', '[enlace](https://example.test/a)', 'Otra línea.', '- Uno', '- Dos', '- Tres', 'printf "$()"']) expect(text).toContain(part);
    expect(adfToText(markdownToAdf(''))).toBe('');
    expect(adfToText(markdownToAdf('```\nunclosed'))).toContain('unclosed');
  });
});
