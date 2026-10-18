import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { PromptHistory, MAX_HISTORY_BYTES } from '../src/chat/history.ts';
import { PasteDecoder } from '../src/chat/paste.ts';
import { TerminalInput } from '../src/chat/terminal.ts';
import { ChatController } from '../src/chat/controller.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const path = await mkdtemp(join(tmpdir(), 'fab-input-')); roots.push(path); return path; }
test('persistent history is bounded, workspace scoped, private and reloadable', async () => {
  const dir = await root(), history = new PromptHistory(dir, '/workspace/a');
  await history.load(); expect(history.entries).toEqual([]);
  for (let i = 0; i < 105; i++) await history.add(`prompt ${i}`);
  await history.add('prompt 104'); await history.add('/auto high');
  const reloaded = new PromptHistory(dir, '/workspace/a'); await reloaded.load();
  expect(reloaded.entries.length).toBe(100); expect(reloaded.entries[0]).toBe('prompt 5');
  expect(await new PromptHistory(dir, '/workspace/b').load()).toEqual([]);
  expect((await Bun.file(history.path).stat()).mode & 0o777).toBe(0o600);
  for (let i = 0; i < 15; i++) await history.add(String(i) + 'x'.repeat(30 * 1024));
  expect((await readFile(history.path)).length).toBeLessThanOrEqual(MAX_HISTORY_BYTES);
  await writeFile(history.path, 'null'); expect(await history.load()).toEqual([]);
});

test('paste framing survives all byte boundaries, embedded Ctrl+C and overflow without submitting', () => {
  const decoder = new PasteDecoder(); const events = [];
  for (const byte of Buffer.from('x\x1b[200~línea 1\r\nlínea 2\x03\x1b[201~\r')) events.push(...decoder.feed(Buffer.from([byte])));
  expect(events.filter(e => e.type === 'paste')).toEqual([{ type: 'paste', text: 'línea 1\nlínea 2\x03' }]);
  expect(Buffer.concat(events.flatMap(e => e.type === 'data' ? [e.data] : [])).toString()).toBe('x\r');
  const small = new PasteDecoder(4); expect(small.feed(Buffer.from('\x1b[200~12345\n/exit\x1b[201~'))).toEqual([{ type: 'overflow' }]);
  small.feed(Buffer.from('\x1b[200~incomplete\n')); expect(small.end().length).toBe(0);
});

test('terminal submits pasted multiline once, preserves edit prefix, and arrows recall prompts without permission answers', async () => {
  const dir = await root(); const cwd = join(dir, 'workspace'); await mkdir(cwd);
  const input = new PassThrough(), output = new PassThrough(); let text = ''; output.on('data', b => text += b);
  const io = new TerminalInput(input, output, true);
  io.controller = new ChatController({ cwd, home: dir, config: { model: 'fixture', autonomy: 'off', mode: 'auto', theme: 'plain' } }, io);
  io.setHistory(['prompt anterior']);
  try {
    const question = io.question('fab › '); let submitted = false; void question.then(() => submitted = true);
    input.write('prefijo '); input.write('\x1b[20'); input.write('0~primera\nsegunda\x03\x1b[201~');
    await Bun.sleep(20); expect(submitted).toBe(false); input.write('\r');
    expect(await question).toBe('prefijo primera\nsegunda');
    const permission = io.question('¿Permitir? '); input.write('respuesta-secreta\r'); expect(await permission).toBe('respuesta-secreta');
    const next = io.question('fab › '); input.write('\x1b[A\r'); expect(await next).toBe('prompt anterior');
    expect((io.rl as unknown as { history: string[] }).history).not.toContain('respuesta-secreta');
    expect(text).not.toContain('\x1b');
  } finally { io.close(); input.destroy(); output.destroy(); }
});

test('status refresh and terminal resize preserve typed input; readline cannot erase the reserved rows', async () => {
  const dir = await root(), cwd = join(dir, 'workspace'); await mkdir(cwd);
  const input = new PassThrough(), output = new PassThrough(); let text = ''; output.on('data', b => text += b);
  const shape = { columns: 96, rows: 18 }; Object.assign(output, shape);
  let refreshes = 0;
  Object.assign(output, { _refreshSize() {
    refreshes++; if ((output as any).rows !== shape.rows) { Object.assign(output, shape); output.emit('resize'); }
  } });
  const io = new TerminalInput(input, output, true);
  io.controller = new ChatController({ cwd, home: dir, config: { model: 'offline', autonomy: 'off', mode: 'auto', theme: 'color' } }, io);
  try {
    io.update(io.controller.statusState); const q = io.question('fab [auto/off] › ');
    input.write('trabajo sin perder'); shape.rows = 14;
    io.work('Modelo'); await Bun.sleep(170); io.update({ ...io.controller.statusState, inputTokens: 42 });
    expect(refreshes).toBeGreaterThan(0); expect(text).toContain('\x1b[1;11r');
    expect(text).not.toContain('\x1b[0J'); expect(text).toContain('in 42');
    input.write('\r'); expect(await q).toBe('trabajo sin perder');
    io.controller.config.theme = 'plain'; io.update(io.controller.statusState);
    const end = text.length; io.assistant('**plano**\n', true); expect(text.slice(end)).toBe('plano\n');
  } finally { io.close(); input.destroy(); output.destroy(); }
});

test('permission replies must be fresh; stdin errors reject the waiter and close cleanly', async () => {
  const input = new PassThrough(), output = new PassThrough(); output.resume();
  const io = new TerminalInput(input, output, true); let closed = false; io.onClose = () => closed = true;
  try {
    input.write('s\r'); input.write('s\x01');
    let settled = false; const permission = io.question('¿Permitir? ', undefined, { fresh: true });
    void permission.then(() => settled = true); await Bun.sleep(15); expect(settled).toBe(false);
    input.write('n\r'); expect(await permission).toBe('n');
    const pending = io.question('¿Permitir? ', undefined, { fresh: true });
    const rejection = pending.then(() => undefined, e => e);
    input.emit('error', new Error('synthetic stdin failure'));
    expect((await rejection)?.message).toBe('synthetic stdin failure');
    expect(closed).toBe(true);
  } finally { io.close(); input.destroy(); output.destroy(); }
  const pipe = new PassThrough(), sink = new PassThrough(); sink.resume(); const unattended = new TerminalInput(pipe, sink, false);
  try { pipe.write('s\n'); expect(await unattended.question('permiso', undefined, { fresh: true })).toBe(''); }
  finally { unattended.close(); pipe.destroy(); sink.destroy(); }
});
