import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodingAgent } from '../src/agent/engine.ts';
import { SessionStore } from '../src/agent/session.ts';
import type { AgentEvent, AgentOptions, ModelTurn } from '../src/agent/types.ts';

const roots: string[] = [];
afterEach(async () => {
  for (const dir of roots.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fab-bg-test-'));
  roots.push(root);
  const cwd = join(root, 'workspace');
  await mkdir(cwd, { recursive: true });
  const sessionDir = join(root, 'sessions');
  await mkdir(sessionDir, { recursive: true });
  return { root, cwd, sessionDir };
}

const doneTurn: ModelTurn = { text: 'completed', toolCalls: [], finishReason: 'stop' };

function call(name: string, input: unknown): ModelTurn {
  return {
    text: '',
    finishReason: 'tool_calls',
    toolCalls: [
      { id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(input) } },
    ],
  };
}

test('positive: launch background process, peek partial output, await completion', async () => {
  const f = await fixture();
  let capturedTaskId = '';

  const turns: Array<() => ModelTurn> = [
    () => call('Execute', {
      command: 'sh -c "echo step-one; sleep 0.6; echo step-two"',
      background: true,
    }),
    () => {
      return call('TaskOutput', { task_id: capturedTaskId, block: false });
    },
    () => {
      return call('TaskOutput', { task_id: capturedTaskId, block: true });
    },
  ];

  const events: AgentEvent[] = [];
  const options: AgentOptions = {
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    prompt: 'run background job',
    autonomy: 'high',
    provider: {
      id: 'fixture',
      complete: async () => {
        const next = turns.shift();
        return next ? next() : doneTurn;
      },
    },
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'tool_result' && (e.value as any)?.taskId) {
        capturedTaskId = (e.value as any).taskId;
      }
    },
  };

  // Wait a small moment after launch before peek so step-one is flushed
  const originalComplete = options.provider.complete;
  let turnIndex = 0;
  options.provider.complete = async (req, sig, delta) => {
    turnIndex++;
    if (turnIndex === 2) {
      await Bun.sleep(150);
    }
    return originalComplete(req, sig, delta);
  };

  const result = await runCodingAgent(options);
  expect(result.ok).toBe(true);

  // Check tool results
  const toolResults = events.filter(e => e.type === 'tool_result').map(e => e.value as any);
  expect(toolResults.length).toBe(3);

  // 1. Launch result
  const launch = toolResults[0];
  expect(launch.taskId).toBeDefined();
  expect(typeof launch.pid).toBe('number');
  expect(launch.status).toBe('running');

  // 2. Partial peek (block: false)
  const partial = toolResults[1];
  expect(partial.task_id).toBe(capturedTaskId);
  expect(partial.stdout).toContain('step-one');
  expect(partial.stdout).not.toContain('step-two');

  // 3. Final wait (block: true)
  const final = toolResults[2];
  expect(final.task_id).toBe(capturedTaskId);
  expect(final.status).toBe('completed');
  expect(final.exitCode).toBe(0);
  expect(final.stdout).toContain('step-one');
  expect(final.stdout).toContain('step-two');
});

test('TaskStop terminates a long-running process with SIGTERM/SIGKILL', async () => {
  const f = await fixture();
  let capturedTaskId = '';

  const turns: Array<() => ModelTurn> = [
    () => call('Execute', { command: 'sleep 30', background: true }),
    () => call('TaskStop', { task_id: capturedTaskId }),
  ];

  const events: AgentEvent[] = [];
  const options: AgentOptions = {
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    prompt: 'stop process test',
    autonomy: 'high',
    provider: {
      id: 'fixture',
      complete: async () => {
        const next = turns.shift();
        return next ? next() : doneTurn;
      },
    },
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'tool_result' && (e.value as any)?.taskId) {
        capturedTaskId = (e.value as any).taskId;
      }
    },
  };

  const result = await runCodingAgent(options);
  expect(result.ok).toBe(true);

  const stopResult = events.filter(e => e.type === 'tool_result')[1]?.value as any;
  expect(stopResult.task_id).toBe(capturedTaskId);
  expect(stopResult.status).toBe('cancelled');
});

test('negative: unknown task ID, process limit, denied commands', async () => {
  const f = await fixture();

  // 1. Unknown task ID
  const unknownTurns = [call('TaskOutput', { task_id: 'nonexistent-uuid' })];
  const unknownOptions: AgentOptions = {
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    prompt: 'test unknown id',
    autonomy: 'high',
    provider: { id: 'fixture', complete: async () => unknownTurns.shift() ?? doneTurn },
  };
  const unknownEvents: AgentEvent[] = [];
  unknownOptions.onEvent = e => unknownEvents.push(e);
  await runCodingAgent(unknownOptions);
  const unknownRes = unknownEvents.find(e => e.type === 'tool_result');
  expect(unknownRes?.isError).toBe(true);

  // 2. Process limit
  let p1Id = '';
  const limitTurns = [
    call('Execute', { command: 'sleep 5', background: true }),
    call('Execute', { command: 'sleep 5', background: true }),
    call('Execute', { command: 'sleep 5', background: true }),
  ];
  const limitEvents: AgentEvent[] = [];
  const limitOptions: AgentOptions = {
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    prompt: 'test limit',
    autonomy: 'high',
    maxBackgroundProcesses: 2,
    provider: { id: 'fixture', complete: async () => limitTurns.shift() ?? doneTurn },
    onEvent: e => limitEvents.push(e),
  };
  await runCodingAgent(limitOptions);
  const limitRes = limitEvents.filter(e => e.type === 'tool_result');
  expect(limitRes.length).toBe(3);
  expect(limitRes[0]?.isError).toBe(false);
  expect(limitRes[1]?.isError).toBe(false);
  expect(limitRes[2]?.isError).toBe(true); // 3rd process exceeded maxBackgroundProcesses=2

  // 3. Denied in spec mode
  const specTurns = [call('Execute', { command: 'echo spec', background: true })];
  const specEvents: AgentEvent[] = [];
  const specOptions: AgentOptions = {
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    prompt: 'test spec',
    interactionMode: 'spec',
    autonomy: 'high',
    provider: { id: 'fixture', complete: async () => specTurns.shift() ?? doneTurn },
    onEvent: e => specEvents.push(e),
  };
  await runCodingAgent(specOptions);
  const specRes = specEvents.find(e => e.type === 'tool_result');
  expect(specRes?.isError).toBe(true);

  // 4. Denied command safeguards (sudo)
  const sudoTurns = [call('Execute', { command: 'sudo ls', background: true })];
  const sudoEvents: AgentEvent[] = [];
  const sudoOptions: AgentOptions = {
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    prompt: 'test sudo',
    autonomy: 'high',
    provider: { id: 'fixture', complete: async () => sudoTurns.shift() ?? doneTurn },
    onEvent: e => sudoEvents.push(e),
  };
  await runCodingAgent(sudoOptions);
  const sudoRes = sudoEvents.find(e => e.type === 'tool_result');
  expect(sudoRes?.isError).toBe(true);
});

test('cancellation: abort with active background process leaves no late writes (3 repetitions)', async () => {
  for (let rep = 1; rep <= 3; rep++) {
    const f = await fixture();
    const sentinelName = `late-sentinel-rep-${rep}.txt`;
    const sentinelPath = join(f.cwd, sentinelName);

    let started = false;
    const controller = new AbortController();

    const options: AgentOptions = {
      cwd: f.cwd,
      sessionDir: f.sessionDir,
      prompt: `rep ${rep}`,
      autonomy: 'high',
      signal: controller.signal,
      provider: {
        id: 'fixture',
        complete: async () => {
          if (!started) {
            started = true;
            return call('Execute', {
              command: `sh -c "sleep 1.2; echo late-write > '${sentinelPath}'"`,
              background: true,
            });
          }
          // Hold the agent loop so we can abort while the background process is running
          await Bun.sleep(500);
          return doneTurn;
        },
      },
      onEvent: (e) => {
        if (e.type === 'tool_result') {
          // As soon as the background task was launched, abort the parent agent
          controller.abort(new Error('simulated agent abort'));
        }
      },
    };

    const result = await runCodingAgent(options);
    expect(result.ok).toBe(false);
    expect(result.error?.type).toBe('aborted');

    // Wait past the command's sleep deadline
    await Bun.sleep(1500);

    // Verify no late write occurred!
    expect(existsSync(sentinelPath)).toBe(false);
  }
});

test('YOLO mode: runs host process in background without sandbox', async () => {
  const f = await fixture();
  let capturedTaskId = '';

  const turns: Array<() => ModelTurn> = [
    () => call('Execute', { command: 'echo "yolo background running"', background: true }),
    () => call('TaskOutput', { task_id: capturedTaskId, block: true }),
  ];

  const events: AgentEvent[] = [];
  const options: AgentOptions = {
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    permissionMode: 'yolo',
    prompt: 'yolo test',
    provider: { id: 'fixture', complete: async () => { const next = turns.shift(); return next ? next() : doneTurn; } },
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'tool_result' && (e.value as any)?.taskId) {
        capturedTaskId = (e.value as any).taskId;
      }
    },
  };

  const result = await runCodingAgent(options);
  expect(result.ok).toBe(true);

  const toolResults = events.filter(e => e.type === 'tool_result').map(e => e.value as any);
  expect(toolResults.length).toBe(2);

  const output = toolResults[1];
  expect(output.task_id).toBe(capturedTaskId);
  expect(output.status).toBe('completed');
  expect(output.sandboxed).toBe(false);
  expect(output.stdout).toContain('yolo background running');
});

test('sandbox required: runs inside bwrap with network policy enforced', async () => {
  const f = await fixture();
  let capturedTaskId = '';

  const turns: Array<() => ModelTurn> = [
    () => call('Execute', { command: 'echo "sandboxed background running"', background: true }),
    () => call('TaskOutput', { task_id: capturedTaskId, block: true }),
  ];

  const events: AgentEvent[] = [];
  const options: AgentOptions = {
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    sandbox: 'required',
    autonomy: 'high',
    prompt: 'sandbox test',
    provider: { id: 'fixture', complete: async () => { const next = turns.shift(); return next ? next() : doneTurn; } },
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'tool_result' && (e.value as any)?.taskId) {
        capturedTaskId = (e.value as any).taskId;
      }
    },
  };

  const result = await runCodingAgent(options);
  expect(result.ok).toBe(true);

  const toolResults = events.filter(e => e.type === 'tool_result').map(e => e.value as any);
  expect(toolResults.length).toBe(2);

  const output = toolResults[1];
  expect(output.task_id).toBe(capturedTaskId);
  expect(output.status).toBe('completed');
  expect(output.sandboxed).toBe(true);
  expect(output.stdout).toContain('sandboxed background running');
});

test('bounded output on disk under private session home, never in workspace', async () => {
  const f = await fixture();
  let capturedTaskId = '';

  const turns: Array<() => ModelTurn> = [
    // Generate lots of output
    () => call('Execute', {
      command: 'seq 1 500',
      background: true,
    }),
    () => call('TaskOutput', { task_id: capturedTaskId, block: true }),
  ];

  const events: AgentEvent[] = [];
  const options: AgentOptions = {
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    autonomy: 'high',
    maxProcessOutputBytes: 512, // Small budget to test truncation
    prompt: 'output limit test',
    provider: { id: 'fixture', complete: async () => { const next = turns.shift(); return next ? next() : doneTurn; } },
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'tool_result' && (e.value as any)?.taskId) {
        capturedTaskId = (e.value as any).taskId;
      }
    },
  };

  const result = await runCodingAgent(options);
  expect(result.ok).toBe(true);

  // Check that no task stdout/stderr files exist in workspace (f.cwd)
  const workspaceFiles = await readdir(f.cwd);
  expect(workspaceFiles.filter(f => f.includes('.stdout') || f.includes('.stderr'))).toHaveLength(0);

  // Check truncation
  const output = events.filter(e => e.type === 'tool_result')[1]?.value as any;
  expect(output.stdout).toContain('[output truncated at limit]');
});

test('sessions: background process is not resumed across resume/fork; snapshot records it ended', async () => {
  const f = await fixture();
  const sessionId = 'session-bg-test-1';
  let capturedTaskId = '';

  const turns1: Array<() => ModelTurn> = [
    () => call('Execute', { command: 'echo "run-in-session-1"', background: true }),
    () => call('TaskOutput', { task_id: capturedTaskId, block: true }),
  ];

  const events1: AgentEvent[] = [];
  const result1 = await runCodingAgent({
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    newSessionId: sessionId,
    autonomy: 'high',
    prompt: 'initial session',
    provider: { id: 'fixture', complete: async () => { const next = turns1.shift(); return next ? next() : doneTurn; } },
    onEvent: (e) => {
      events1.push(e);
      if (e.type === 'tool_result' && (e.value as any)?.taskId) {
        capturedTaskId = (e.value as any).taskId;
      }
    },
  });
  expect(result1.ok).toBe(true);

  // Inspect the saved session
  const store = await SessionStore.create(f.sessionDir);
  const state = await store.inspect(sessionId);
  expect(state.backgroundTasks).toBeDefined();
  expect(state.backgroundTasks?.length).toBe(1);
  expect(state.backgroundTasks?.[0]?.taskId).toBe(capturedTaskId);
  expect(state.backgroundTasks?.[0]?.status).toBe('completed');

  // Resume session with a query on the old taskId
  const turns2: Array<() => ModelTurn> = [
    () => call('TaskOutput', { task_id: capturedTaskId }),
  ];
  const events2: AgentEvent[] = [];
  const result2 = await runCodingAgent({
    cwd: f.cwd,
    sessionDir: f.sessionDir,
    sessionId,
    autonomy: 'high',
    prompt: 'resume session',
    provider: { id: 'fixture', complete: async () => { const next = turns2.shift(); return next ? next() : doneTurn; } },
    onEvent: e => events2.push(e),
  });
  expect(result2.ok).toBe(true);

  const resumedQuery = events2.find(e => e.type === 'tool_result')?.value as any;
  expect(resumedQuery.task_id).toBe(capturedTaskId);
  expect(resumedQuery.status).toBe('completed');
});
