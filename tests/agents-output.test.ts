import { expect, test } from 'bun:test';
import { boundedAgentOutput, getAgent, runAgent, type AgentAdapter } from '../src/agents.ts';

// Literal pre-confinement allowlist: host runs must retain it byte for byte.
const originalClaudeTools = 'Read,Edit,Write,Glob,Grep,Bash(git:*),Bash(python3:*),Bash(python:*),Bash(pytest:*),Bash(npm ci:*),Bash(npm test:*),Bash(npm run test:*),Bash(npm run lint:*),Bash(npx vitest:*),Bash(npx tsc:*),Bash(bun test:*),Bash(ls:*),Bash(cat:*),Bash(rtk:*)';

test('claude host allowlist stays literally unchanged without confinement', () => {
  const agent = getAgent('claude');
  const expected = ['claude', '-p', 'prompt', '--permission-mode', 'acceptEdits', '--allowedTools', originalClaudeTools, '--output-format', 'json'];
  expect(agent.command('prompt')).toEqual(expected);
  expect(agent.command('prompt', {})).toEqual(expected);
  expect(agent.command('prompt', { confine: false })).toEqual(expected);
  expect(agent.command('prompt', { readOnly: true, confine: false })).toEqual(expected);
});

test('claude confined allowlist adds only environment and scratch commands', () => {
  const agent = getAgent('claude');
  const extra = ',Bash(PYTHONPATH=*),Bash(cd:*),Bash(mkdir:*),Bash(cp:*),Bash(rm:*)';
  for (const readOnly of [false, true]) {
    const argv = agent.command('prompt', { confine: true, readOnly });
    expect(argv).toEqual(['claude', '-p', 'prompt', '--permission-mode', 'acceptEdits', '--allowedTools', originalClaudeTools + extra, '--output-format', 'json']);
  }
  // A confined call must not mutate the shared adapter's host policy.
  expect(agent.command('prompt')[6]).toBe(originalClaudeTools);
});

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

test('claude --output-format json: el informe sale de result y el coste de total_cost_usd', async () => {
  const { parseClaudeJson } = await import('../src/agents.ts');
  const json = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'STATUS: done\n\nhecho', total_cost_usd: 0.0421,
    usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7 } });
  expect(parseClaudeJson(json)).toEqual({ text: 'STATUS: done\n\nhecho', usage: { costUsd: 0.0421, inputTokens: 115, outputTokens: 7 } });
  expect(parseClaudeJson('STATUS: done texto plano')).toBeNull();
  expect(parseClaudeJson(JSON.stringify({ type: 'result', result: 'x' }))).toEqual({ text: 'x' });
  expect(parseClaudeJson(JSON.stringify({ type: 'result', result: 'x', total_cost_usd: -1 }))).toEqual({ text: 'x' });

  const agent: AgentAdapter = { name: 'json-agent', command: () => ['sh', '-c', `cat << 'EOF'\n${json}\nEOF`], parse: parseClaudeJson };
  const run = await runAgent(agent, 'prompt', process.cwd());
  expect(run.status.kind).toBe('done');
  expect(run.output).toBe('STATUS: done\n\nhecho');
  expect(run.usage).toEqual({ costUsd: 0.0421, inputTokens: 115, outputTokens: 7 });
});
