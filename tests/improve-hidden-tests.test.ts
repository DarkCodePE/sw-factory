import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe, simulated } from '../bench/t1-filtro/probe-hidden.ts';

// This is a vulnerability reproducer, not an assertion that the corpus is hidden.
// Uses the real runAgent launcher and experiment store, without an LLM or credentials.
test('P6: a simulated worker reads outside its cwd, frozen suite, verifier and experiment DB', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fab-p6-test-'));
  try {
    const result = await probe(simulated, root);
    expect(result.run.exitCode).toBe(0);
    expect(result.readable).toMatchObject({ outside: true, suite: true, verifier: true, experiment: true });
    expect(Object.values(result.readable).every(value => value === true)).toBe(true);
    expect(Object.keys(result.readable).filter(key => key.startsWith('verifier:'))).toHaveLength(12);
    expect(result.observed.outside).toMatch(/^[a-f0-9]{64}$/);
    expect(result.observed.experiment).toMatch(/^[a-f0-9]{64}$/);
    // The source path is recoverable from the frozen suite/state in current improve.
    const suite = JSON.parse(readFileSync(result.paths.suite, 'utf8'));
    expect(suite.tasks).toHaveLength(1);
    expect(suite.tasks[0].description).toContain(result.paths.verifier);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P6b: confined worker cannot read any of the 16 host targets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fab-p6b-test-'));
  try {
    const result = await probe(simulated, root, true);
    expect(result.run.exitCode).toBe(0);
    expect(Object.keys(result.observed)).toHaveLength(16);
    expect(Object.values(result.readable)).toEqual(Array(16).fill(false));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
