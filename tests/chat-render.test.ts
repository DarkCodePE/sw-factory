import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { terminalText } from '../src/chat/config.ts';
import { cellWidth, MarkdownStream, renderDiff, renderMarkdown } from '../src/chat/render.ts';
import { statusLine, TerminalPresentation, type StatusState } from '../src/chat/presentation.ts';

const markdown = '# Resultado\n**Correcto** y `código`\n- uno\n1. dos\n```ts\nconst x = 42;\n```\n| Nombre | Valor |\n| --- | --- |\n| café | 42 |\n';
test('Markdown plain snapshot and byte-split streaming agree, including aligned tables', () => {
  const expected = 'Resultado\nCorrecto y código\n• uno\n1. dos\n┌──────────────────────────────\n│ const x = 42;\n└──────────────────────────────\nNombre │ Valor\ncafé   │ 42   \n';
  expect(renderMarkdown(markdown, false, 32)).toBe(expected);
  const stream = new MarkdownStream(false, 32); let output = '';
  for (const character of markdown) output += stream.push(character);
  output += stream.push('', true); expect(output).toBe(expected);
  const color = renderMarkdown(markdown + '\x1b[2J\x1b]0;unsafe\x07', true, 32);
  expect(color).toContain('\x1b[1;36m'); expect(color).toContain('\x1b[48;5;236;37m');
  expect(color).not.toContain('\x1b[2J'); expect(color).not.toContain('unsafe');
  expect(terminalText(color)).toBe(expected);
});

test('diff snapshot, line numbers, color, compact truncation and expanded bounds', () => {
  const change = { path: 'a.ts', before: { data: Buffer.from('same\nold\ntail\n'), mode: 0o644 }, after: Buffer.from('same\nnew\ntail\n'), mode: 0o644 };
  expect(renderDiff(change)).toBe('a.ts  +1 -1\n-    2 │ old\n+    2 │ new\n');
  expect(renderDiff(change, true)).toContain('\x1b[31m-    2');
  const large = { path: 'new.ts', after: Buffer.from(Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n')), mode: 0o644 };
  expect(renderDiff(large)).toContain('18 líneas omitidas · Ctrl+O');
  expect(renderDiff(large, false, true)).toContain('+   30 │ line29');
  expect(renderDiff({ ...large, after: Buffer.from('a'.repeat(200)) }, false, true, 30).split('\n')[1]!.length).toBeLessThanOrEqual(30);
});

const status: StatusState = { model: 'offline', mode: 'auto', autonomy: 'low', inputTokens: 120, outputTokens: 42, contextTokens: 8000, maxContextTokens: 32000 };
test('fixed-width status terminal reserves bottom rows, pauses spinner on text and releases on theme/close', async () => {
  const out = new PassThrough(); let output = ''; out.on('data', s => output += s);
  let color = true; const size = { columns: 96, rows: 16 };
  const ui = new TerminalPresentation(out, () => size, () => color);
  try {
    expect(statusLine(status, 96)).toBe('offline · auto/low · in 120 / out 42 · ctx ~25%');
    expect(cellWidth(statusLine({ ...status, model: '界'.repeat(80) }, 40))).toBeLessThan(40);
    ui.update(status); ui.work('Modelo'); await Bun.sleep(115);
    expect(output).toContain('\x1b[1;14r'); expect(output).toContain('\x1b[16;1H'); expect(output).toContain('Modelo · 0.');
    ui.assistant('# Texto\n', true); const end = output.length; await Bun.sleep(120);
    expect(output.length).toBe(end); expect(output).toContain('Texto');
    size.columns = 55; size.rows = 12; ui.resize(); expect(output).toContain('\x1b[1;10r');
    color = false; ui.update(status); const plain = output.length;
    ui.work('tool'); ui.assistant('**sin ANSI**', true); await Bun.sleep(110);
    expect(output.slice(plain)).toBe('sin ANSI\n');
    ui.close(); const closed = output.length; color = true;
    ui.work('late'); ui.update(status); ui.assistant('late', true); ui.resize();
    await Bun.sleep(120); expect(output.length).toBe(closed);
  } finally { ui.close(); out.destroy(); }
});
