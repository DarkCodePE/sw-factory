import { expect, test } from 'bun:test';
import { boundedAgentOutput, runAgent, type AgentAdapter } from '../src/agents.ts';

test('D3: boundedAgentOutput does not invent a STATUS line when none is present', () => {
  const longWithoutStatus = 'A'.repeat(24_000);
  const boundedWithout = boundedAgentOutput(longWithoutStatus);
  expect(boundedWithout.length).toBeLessThanOrEqual(20_000);
  expect(boundedWithout).not.toContain('STATUS: blocked');
  expect(boundedWithout).toContain('[Report body truncated]');

  const longBlocked = `STATUS: blocked - error detail\n${'B'.repeat(24_000)}`;
  const boundedBlocked = boundedAgentOutput(longBlocked);
  expect(boundedBlocked.length).toBeLessThanOrEqual(20_000);
  expect(boundedBlocked.startsWith('STATUS: blocked - error detail\n')).toBe(true);

  const longDone = `STATUS: done\n${'C'.repeat(24_000)}`;
  const boundedDone = boundedAgentOutput(longDone);
  expect(boundedDone.length).toBeLessThanOrEqual(20_000);
  expect(boundedDone.startsWith('STATUS: done\n')).toBe(true);
});

test('D3: runAgent classifies status before truncation', async () => {
  const makeAgent = (output: string): AgentAdapter => ({
    name: 'test-agent',
    command: () => ['sh', '-c', `cat << 'EOF'\n${output}\nEOF`],
  });

  // 1. 24 000 chars without STATUS -> status missing, output does not contain STATUS: blocked
  const longWithoutStatus = 'x'.repeat(24_000);
  const run1 = await runAgent(makeAgent(longWithoutStatus), 'prompt', process.cwd());
  expect(run1.status.kind).toBe('missing');
  expect(run1.status.reason).toBe('report has no STATUS line');
  expect(run1.output).not.toContain('STATUS: blocked');
  expect(run1.output.length).toBeLessThanOrEqual(20_000);

  // 2. Real STATUS: blocked - x -> blocked
  const longBlocked = `STATUS: blocked - cannot reproduce bug\n${'y'.repeat(24_000)}`;
  const run2 = await runAgent(makeAgent(longBlocked), 'prompt', process.cwd());
  expect(run2.status.kind).toBe('blocked');
  expect(run2.status.reason).toBe('blocked - cannot reproduce bug');
  expect(run2.output.startsWith('STATUS: blocked - cannot reproduce bug\n')).toBe(true);

  // 3. STATUS done at beginning with long output -> done
  const longDone = `STATUS: done\n${'z'.repeat(24_000)}`;
  const run3 = await runAgent(makeAgent(longDone), 'prompt', process.cwd());
  expect(run3.status.kind).toBe('done');
  expect(run3.status.reason).toBe('');
  expect(run3.output.startsWith('STATUS: done\n')).toBe(true);
  expect(run3.output.length).toBeLessThanOrEqual(20_000);
});
