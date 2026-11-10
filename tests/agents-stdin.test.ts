import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgent, runAgent, type AgentAdapter } from '../src/agents.ts';

let dir: string;
let fixture: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-stdin-'));
  fixture = join(dir, 'cli.ts');
  writeFileSync(fixture, `import { createHash } from 'node:crypto';
    const input = await Bun.stdin.text();
    console.log(JSON.stringify({ type: 'result', result: 'STATUS: done',
      argv: process.argv.slice(2), bytes: Buffer.byteLength(input),
      digest: createHash('sha256').update(input).digest('hex') }));`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

for (const name of ['claude', 'codex', 'droid', 'native']) {
  test(`${name}: command defaults stay compatible and runAgent sends >200 KiB via stdin`, async () => {
    const base = getAgent(name);
    const prompt = '--untrusted-option\nHU: á🙂\n' + 'x'.repeat(230_000);
    expect(base.command(prompt)).toContain(prompt);
    expect(base.command(prompt, { readOnly: true })).toContain(prompt);
    const argv = base.command(prompt, { readOnly: true, promptStdin: true });
    expect(argv).not.toContain(prompt);
    if (name === 'codex') expect(argv.at(-1)).toBe('-');
    if (name === 'droid') expect(argv.slice(-2)).toEqual(['--file', '/dev/stdin']);

    // Same wrapping pattern as live/claude.ts: spread the adapter and append flags.
    const agent: AgentAdapter = { ...base,
      command: (text, options) => [process.execPath, fixture,
        ...base.command(text, options), '--session-id', 'test-session'],
    };
    const run = await runAgent(agent, prompt, dir, 5000, { readOnly: true });
    expect(run.ok).toBe(true);
    const received = JSON.parse(run.stdout!);
    expect(received.argv).toEqual([...argv, '--session-id', 'test-session']);
    expect(received.bytes).toBe(Buffer.byteLength(prompt));
    expect(received.digest).toBe(createHash('sha256').update(prompt).digest('hex'));
  });
}

test('the pool capture wrapper forwards stdin to the CLI and retains its output', async () => {
  const base = getAgent('claude');
  const capture = new URL('../src/manifest-capture.ts', import.meta.url).pathname;
  const log = join(dir, 'capture.log');
  const prompt = 'HU ' + 'p'.repeat(230_000);
  const agent: AgentAdapter = { ...base, command: (text, options) => [
    process.execPath, capture, log, process.execPath, fixture, ...base.command(text, options),
  ] };
  const run = await runAgent(agent, prompt, dir, 5000);
  expect(run.ok).toBe(true);
  const received = JSON.parse(run.stdout!);
  expect(received.argv).not.toContain(prompt);
  expect(received.bytes).toBe(Buffer.byteLength(prompt));
  expect(received.digest).toBe(createHash('sha256').update(prompt).digest('hex'));
  expect(readFileSync(log, 'utf8')).toContain(received.digest);
});

test('argv-only adapters retain their command contract', async () => {
  const prompt = 'short prompt';
  const agent: AgentAdapter = { name: 'argv-only', command: text => [
    'sh', '-c', 'printf "STATUS: done\\n%s" "$1"', 'fixture', text,
  ] };
  const run = await runAgent(agent, prompt, dir, 5000);
  expect(run.ok).toBe(true);
  expect(run.output).toContain(prompt);
});

test('large stdin does not stall timeout or early process exit', async () => {
  const prompt = 'p'.repeat(500_000);
  const early: AgentAdapter = { name: 'early', promptStdin: true,
    command: () => ['sh', '-c', 'printf "STATUS: done"'],
  };
  expect((await runAgent(early, prompt, dir, 1000)).ok).toBe(true);
  const stalled: AgentAdapter = { ...early, command: () => ['sh', '-c', 'exec sleep 60'] };
  expect((await runAgent(stalled, prompt, dir, 50)).ok).toBe(false);
});
