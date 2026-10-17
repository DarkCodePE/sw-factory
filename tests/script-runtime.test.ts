// Contract tests for the Script runtime: protocol behaviour, limits and isolation guarantees.
import { describe, expect, test } from 'bun:test';

import { detectSandbox } from '../src/sandbox/index.ts';
import { runScript } from '../src/script-runtime/index.ts';

const T = 30_000;

describe('protocol', () => {
  test('returns the program value and forwards tool calls to the host', async () => {
    const calls: unknown[] = [];
    const r = await runScript({
      code: "const c = await tools.Read({ file_path: 'calc.py' }); text('len=' + c.length); return c.toUpperCase();",
      tools: { Read: async (input) => (calls.push(input), 'def add') },
    });
    expect(r).toMatchObject({ ok: true, output: 'DEF ADD', content: [{ type: 'text', text: 'len=7' }] });
    expect(calls).toEqual([{ file_path: 'calc.py' }]);
  }, T);

  test('a tool error reaches the program as a rejected promise', async () => {
    const r = await runScript({
      code: "try { await tools.Read({}); return 'no'; } catch (e) { return 'caught: ' + String(e.message ?? e); }",
      tools: { Read: async () => { throw new Error('missing file_path'); } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(String(r.output)).toContain('missing file_path');
  }, T);

  test('notify() is collected separately from content', async () => {
    const r = await runScript({ code: "notify('started'); text('a'); return 1;", tools: {} });
    expect(r).toMatchObject({ ok: true, output: 1, notifications: ['started'] });
  }, T);

  test('a thrown error is reported with origin "program"', async () => {
    const r = await runScript({ code: "throw new Error('boom');", tools: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ origin: 'program' });
  }, T);

  test('calling an unbound tool fails instead of reaching the host', async () => {
    let reached = false;
    const r = await runScript({ code: 'return await tools.Write({});', tools: { Read: async () => ((reached = true), '') } });
    expect(r.ok).toBe(false);
    expect(reached).toBe(false);
  }, T);
});

describe('limits', () => {
  test('a program that never finishes is stopped at the timeout', async () => {
    const start = Date.now();
    const r = await runScript({ code: 'while (true) {}', tools: {}, timeoutMs: 1500 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.origin).toBe('timeout');
    expect(Date.now() - start).toBeLessThan(10_000);
  }, T);

  test('output beyond the limit is cut off with origin "output_limit"', async () => {
    const r = await runScript({
      code: "for (let i = 0; i < 100; i++) text('x'.repeat(1000)); return 'done';",
      tools: {},
      limits: { maxOutputBytes: 10_000 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.origin).toBe('output_limit');
  }, T);

  test('a result larger than the limit is rejected', async () => {
    const r = await runScript({ code: "return 'y'.repeat(50_000);", tools: {}, limits: { maxResultBytes: 1_000 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.origin).toBe('output_limit');
  }, T);
});

describe('isolation', () => {
  test('host-only globals are not defined inside the program', async () => {
    const r = await runScript({
      code: "return [typeof process, typeof require, typeof Bun, typeof fetch, typeof WebAssembly, typeof SharedArrayBuffer];",
      tools: {},
    });
    expect(r).toMatchObject({ ok: true, output: Array(6).fill('undefined') });
  }, T);

  test('the worker runs inside the OS sandbox when it is available', async () => {
    const sandbox = await detectSandbox();
    const r = await runScript({ code: 'return 1;', tools: {} });
    expect(r.ok).toBe(true);
    expect(r.sandboxed).toBe(sandbox.available);
  }, T);

  test("sandbox 'required' refuses to run unisolated", async () => {
    const sandbox = await detectSandbox();
    const r = await runScript({ code: 'return 1;', tools: {}, sandbox: 'required' });
    if (sandbox.available) expect(r).toMatchObject({ ok: true, sandboxed: true });
    else expect(r.ok).toBe(false);
  }, T);
});
