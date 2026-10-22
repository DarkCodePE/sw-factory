import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodingAgent } from '../src/agent/engine.ts';
import type { AgentOptions, ModelProvider, ModelRequest, ModelTurn } from '../src/agent/types.ts';
import { parseFeatures, parseHandoff } from '../src/agent/mission-contract.ts';

const roots: string[] = [];
// Every agent run in this file is tracked so teardown aborts it and waits for it to drain before
// deleting its fixture; otherwise a test timeout races rm against a still-running worker (ENOENT).
const live = new Set<{ controller: AbortController; done: Promise<unknown> }>();
const runAgent = (options: AgentOptions) => {
  const controller = new AbortController();
  const done = runCodingAgent({ ...options, signal: controller.signal });
  const entry = { controller, done: done.catch(() => {}) };
  live.add(entry); void entry.done.then(() => live.delete(entry));
  return done;
};
afterEach(async () => {
  for (const entry of live) entry.controller.abort(new Error('test teardown'));
  await Promise.all([...live].map(e => e.done));
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});
const done = (): ModelTurn => ({ text: 'STATUS: done', toolCalls: [], finishReason: 'stop' });
const calls = (...items: Array<[string, unknown]>): ModelTurn => ({ text: '', finishReason: 'tool_calls', toolCalls: items.map(([name, input]) => ({ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(input) } })) });
const handoff = (featureId: string, successState = 'success', unfinished = '') => ({ successState, returnToOrchestrator: false, featureId, handoff: {
  salientSummary: 'Synthetic mission feature handoff for integration testing.',
  whatWasImplemented: 'Performed the assigned synthetic feature work and reported only the observations made by this test fixture.',
  whatWasLeftUndone: unfinished, verification: { commandsRun: [] }, tests: { added: [], coverage: 'See independently executed validator tools.' }, discoveredIssues: [],
} });
const feature = (id = 'add', status = 'pending') => ({ id, description: `Fix ${id} arithmetic`, skillName: 'fixture', milestone: 'arithmetic', status,
  preconditions: [], expectedBehavior: ['The arithmetic tests pass'], fulfills: [], verificationCommands: ['bun test'], protectedPaths: ['calc.test.ts'] });
const skill = '---\nname: fixture\ndescription: Inspect synthetic arithmetic.\n---\nUse the observed code and tests.';
function role(request: ModelRequest) {
  const text = request.messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('Assigned mission feature '))?.content as string | undefined;
  return text ? /^Assigned mission feature ([\w-]+); role ([\w-]+)\./.exec(text)!.slice(1) as [string, string] : undefined;
}
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'fab-mission-test-')); roots.push(root);
  const { mkdir } = await import('node:fs/promises'); const cwd = join(root, 'repo'); await mkdir(cwd);
  await writeFile(join(cwd, 'calc.ts'), 'export function add(a:number,b:number) { return a - b; }\nexport function sub(a:number,b:number) { return a + b; }\n');
  await writeFile(join(cwd, 'calc.test.ts'), "import {test,expect} from 'bun:test';import {add,sub} from './calc';test('arithmetic',()=>{expect(add(2,3)).toBe(5);expect(sub(5,3)).toBe(2);});\n");
  return { cwd, sessionDir: join(root, 'sessions') };
}
function scenario(cwd: string, features: unknown[], worker: (r: ModelRequest, id: string, role: string) => ModelTurn | Promise<ModelTurn>) {
  let turn = 0, directory = '';
  const provider: ModelProvider = { id: 'mission-fixture', async complete(request) {
    const child = role(request); if (child) return worker(request, ...child);
    if (turn++ === 0) return calls(['ProposeMission', { title: 'Arithmetic', proposal: 'Repair the arithmetic and verify it independently.' }]);
    if (turn === 2) {
      if ((request.messages.at(-1)!.content as string).startsWith('Error:')) return done();
      directory = JSON.parse(request.messages.at(-1)!.content as string).missionDir;
      return calls(['Create', { file_path: join(directory, 'features.json'), content: JSON.stringify({ features }) }],
        ['Create', { file_path: join(directory, 'skills/fixture/SKILL.md'), content: skill }]);
    }
    if (turn === 3) return calls(['StartMissionRun', {}]);
    return done();
  } };
  return { provider, directory: () => directory };
}

test('missions run serial workers, seal writes after handoff and validate a milestone independently', async () => {
  const paths = await workspace(), turns = new Map<string, number>(), order: string[] = []; let metadata = '';
  const fixture = scenario(paths.cwd, [feature('add'), feature('sub')], (r, id, assigned) => {
    const key = id + assigned, n = turns.get(key) ?? 0; turns.set(key, n + 1);
    if (!n) { order.push(assigned + ':' + id);
      if (assigned === 'worker') return calls(['Create', { file_path: join(metadata, 'features.json'), content: '{"features":[]}' }],
        ['Execute', { command: `printf tampered > '${join(metadata, 'state.json')}'` }],
        ['Edit', { file_path: 'calc.ts', old_str: id === 'add' ? 'add(a:number,b:number) { return a - b' : 'sub(a:number,b:number) { return a + b', new_str: id === 'add' ? 'add(a:number,b:number) { return a + b' : 'sub(a:number,b:number) { return a - b' }]);
      return calls(['Execute', { command: 'bun test' }]);
    }
    if (n === 1) {
      const results = r.messages.filter(m => m.role === 'tool');
      if (assigned === 'worker') { expect(results[0]!.content).toContain('read-only'); expect(JSON.parse(results[1]!.content as string).exitCode).not.toBe(0); }
      else expect(JSON.parse(results.at(-1)!.content as string).exitCode).toBe(0);
      return calls(['EndFeatureRun', handoff(id)], ['Edit', { file_path: 'calc.ts', old_str: 'return a + b', new_str: 'return a - b' }]);
    }
    expect(r.messages.at(-1)!.content).toMatch(/closed|Spec/); return done();
  });
  const original = fixture.provider.complete;
  fixture.provider.complete = async (...args) => { const response = await original(...args); metadata = fixture.directory(); return response; };
  const result = await runAgent({ ...paths, prompt: 'mission', provider: fixture.provider, autonomy: 'high', interactionMode: 'mission' });
  expect(result).toMatchObject({ ok: true, mission: { state: 'completed', completed: 2, total: 2 } });
  expect(order).toEqual(['worker:add', 'worker:sub', 'scrutiny:add', 'user-testing:add']);
  const state = JSON.parse(await readFile(join(paths.sessionDir, result.sessionId + '.json'), 'utf8'));
  expect(state.mission.attempts).toHaveLength(4); expect(state.mission.validations.arithmetic.sourceDigest).toHaveLength(64);
});

test('clean worker exit without handoff leaves mission pending and can resume that owned worker', async () => {
  const paths = await workspace(); let childCalls = 0;
  const fixture = scenario(paths.cwd, [feature()], () => { childCalls++; return done(); });
  const first = await runAgent({ ...paths, prompt: 'mission', provider: fixture.provider, autonomy: 'high', interactionMode: 'mission' });
  expect(first).toMatchObject({ ok: true, mission: { state: 'paused', completed: 0 } }); expect(childCalls).toBe(1);
  const saved = JSON.parse(await readFile(join(paths.sessionDir, first.sessionId + '.json'), 'utf8'));
  const workerId = saved.mission.attempts[0].workerSessionId;
  let parent = 0; const seen = new Set<string>();
  const provider: ModelProvider = { id: 'mission-fixture', async complete(request) {
    const child = role(request);
    if (child) { const key = child.join(':'); if (!seen.has(key)) { seen.add(key); return calls(['EndFeatureRun', handoff(child[0], 'partial', 'Implementation is still pending.')]); } return done(); }
    return parent++ ? done() : calls(['StartMissionRun', { resumeWorkerSessionId: workerId }]);
  } };
  const resumed = await runAgent({ ...paths, prompt: 'resume', provider, autonomy: 'high', interactionMode: 'mission', sessionId: first.sessionId });
  expect(resumed).toMatchObject({ ok: true, mission: { state: 'paused', completed: 0 } });
  const next = JSON.parse(await readFile(join(paths.sessionDir, first.sessionId + '.json'), 'utf8'));
  expect(next.mission.attempts[1]).toMatchObject({ workerSessionId: workerId, handoff: { successState: 'partial' } });
});

test('model-edited completion and metadata under a writable workspace cannot start a worker', async () => {
  for (const forged of [true, false]) {
    const paths = await workspace(); let workerCalls = 0;
    const fixture = scenario(paths.cwd, [feature('add', forged ? 'completed' : 'pending')], () => { workerCalls++; return done(); });
    const result = await runAgent({ ...paths, sessionDir: forged ? paths.sessionDir : join(paths.cwd, 'sessions'),
      prompt: 'mission', provider: fixture.provider, autonomy: 'high', interactionMode: 'mission' });
    expect(workerCalls).toBe(0); expect(result.mission?.completed ?? 0).toBe(0);
    expect(result.ok).toBe(true);
  }
});

test('worker claims cannot bypass a failing independent validator', async () => {
  const paths = await workspace(), turns = new Map<string, number>(), roles: string[] = [];
  const fixture = scenario(paths.cwd, [feature()], (request, id, assigned) => {
    const n = turns.get(assigned) ?? 0; turns.set(assigned, n + 1);
    if (!n) roles.push(assigned);
    if (assigned === 'worker') return n ? done() : calls(['EndFeatureRun', { ...handoff(id), validatorsPassed: true }]);
    if (!n) return calls(['Execute', { command: 'bun test' }]);
    if (n === 1) { expect(JSON.parse(request.messages.at(-1)!.content as string).exitCode).toBe(1);
      return calls(['EndFeatureRun', handoff(id, 'failure', 'The independently executed arithmetic tests still fail.')]); }
    return done();
  });
  const result = await runAgent({ ...paths, prompt: 'mission', provider: fixture.provider, autonomy: 'high', interactionMode: 'mission' });
  expect(result).toMatchObject({ ok: true, mission: { state: 'paused', completed: 0 } });
  expect(roles).toEqual(['worker', 'scrutiny']);
});

test('Script cancellation aborts and drains an active mission worker', async () => {
  const paths = await workspace(); let parent = 0, directory = '', started = false, aborted = false;
  const provider: ModelProvider = { id: 'mission-fixture', async complete(request, signal) {
    if (role(request)) { started = true; return new Promise((_, reject) => {
      const stop = () => { aborted = true; reject(signal.reason); }; signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
    }); }
    if (!parent++) return calls(['ProposeMission', { title: 'Cancel', proposal: 'Exercise an invocation-owned worker cancellation.' }]);
    if (parent === 2) { directory = JSON.parse(request.messages.at(-1)!.content as string).missionDir;
      return calls(['Create', { file_path: join(directory, 'features.json'), content: JSON.stringify({ features: [feature()] }) }],
        ['Create', { file_path: join(directory, 'skills/fixture/SKILL.md'), content: skill }]); }
    if (parent === 3) return calls(['Script', { code: 'tools.StartMissionRun({}); await new Promise(r=>setTimeout(r,200)); throw new Error("cancel nested mission");' }]);
    expect(aborted).toBe(true); return done();
  } };
  const result = await runAgent({ ...paths, prompt: 'mission', provider, autonomy: 'high', interactionMode: 'mission' });
  expect(started).toBe(true); expect(aborted).toBe(true); expect(result).toMatchObject({ ok: true, mission: { state: 'paused', completed: 0 } });
});

test('insufficient worker/validator budget fails before feature effects', async () => {
  const paths = await workspace(); let jobs = 0;
  const fixture = scenario(paths.cwd, [feature()], () => { jobs++; return done(); });
  const result = await runAgent({ ...paths, prompt: 'mission', provider: fixture.provider, autonomy: 'high', interactionMode: 'mission', subagents: { maxAgents: 2 } });
  expect(jobs).toBe(0); expect(result).toMatchObject({ ok: true, mission: { state: 'paused', completed: 0 } });
});

test('handoffs are structurally checked and bound to the assigned feature', () => {
  expect(() => parseHandoff({}, 'add')).toThrow('required');
  expect(() => parseHandoff(handoff('foreign'), 'add')).toThrow('does not match');
  expect(parseHandoff(handoff('add', 'partial', 'pending'), 'add').successState).toBe('partial');
});

test('feature and milestone keys cannot address Object.prototype', () => {
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    expect(() => parseFeatures({ features: [{ ...feature(), id: key }] })).toThrow('Invalid');
    expect(() => parseFeatures({ features: [{ ...feature(), milestone: key }] })).toThrow('Invalid');
  }
  expect(Object.hasOwn(Object.prototype, 'status')).toBe(false);
  expect(Object.hasOwn(Object.prototype, 'scrutiny')).toBe(false);
});

// P0.1/P0.2 regressions: completion comes from runtime observations and runner-executed
// verifiers, never from the handoff text the model submits.
async function runMission(features: unknown[], worker: Parameters<typeof scenario>[2]) {
  const paths = await workspace(), fixture = scenario(paths.cwd, features, worker);
  const result = await runAgent({ prompt: 'Run the mission.', cwd: paths.cwd, provider: fixture.provider, autonomy: 'high',
    interactionMode: 'mission', sessionDir: paths.sessionDir, timeoutMs: 30_000 });
  const independent = Bun.spawnSync([process.execPath, 'test'], { cwd: paths.cwd });
  // result.mission is only a summary; attempts and validations come from the persisted record.
  const dir = result.mission?.directory;
  const state = dir ? JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) : undefined;
  const { readdir } = await import('node:fs/promises');
  const attempts = dir ? await Promise.all((await readdir(join(dir, 'handoffs'))).sort().map(async f => JSON.parse(await readFile(join(dir, 'handoffs', f), 'utf8')))) : [];
  type Persisted = { state: string; features: Record<string, { status: string }>;
    validations: Record<string, { verifiers?: Array<{ command: string; exitCode: number }> }>; attempts: Array<{ role: string; error?: string }> };
  const mission: Persisted | undefined = state && { ...state, attempts };
  return { result, mission, independentExit: independent.exitCode };
}
const fixAdd = (): ModelTurn => calls(['Edit', { file_path: 'calc.ts', old_str: 'return a - b', new_str: 'return a + b' }],
  ['Edit', { file_path: 'calc.ts', old_str: 'sub(a:number,b:number) { return a + b', new_str: 'sub(a:number,b:number) { return a - b' }]);
const withClaim = (h: ReturnType<typeof handoff>, command: string, exitCode: number) =>
  ({ ...h, validatorsPassed: true, handoff: { ...h.handoff, verification: { commandsRun: [{ command, exitCode, observation: 'all tests passed' }] } } });

test('forged success: workers and validators that never verify cannot complete the mission', async () => {
  const turns = new Map<string, number>();
  const { mission, independentExit } = await runMission([feature('add')], (_r, id, assigned) => {
    const n = turns.get(assigned) ?? 0; turns.set(assigned, n + 1);
    return n ? done() : calls(['EndFeatureRun', { ...handoff(id), validatorsPassed: true }]);
  });
  expect(independentExit).not.toBe(0);
  expect(mission?.state).not.toBe('completed');
  expect(mission?.attempts.some(a => /without running any successful verification/.test(a.error ?? ''))).toBe(true);
});

test('a handoff that claims a command the runtime never observed is rejected', async () => {
  const turns = new Map<string, number>();
  const { mission } = await runMission([feature('add')], (_r, id, assigned) => {
    const n = turns.get(assigned) ?? 0; turns.set(assigned, n + 1);
    if (!n) return fixAdd();
    return n === 1 ? calls(['EndFeatureRun', withClaim(handoff(id), 'bun test', 0)]) : done();
  });
  expect(mission?.state).not.toBe('completed');
  expect(mission?.attempts.find(a => a.role === 'worker')?.error).toMatch(/did not observe: bun test \(exit 0\)/);
});

test('runner verifiers decide: validators that pass cannot override a failing contract command', async () => {
  const turns = new Map<string, number>();
  // The worker fixes only add(); sub() stays broken, so the contract verifier must fail.
  const { mission, independentExit } = await runMission([{ ...feature('add'), verificationCommands: ['bun test'] }], (_r, id, assigned) => {
    const n = turns.get(assigned) ?? 0; turns.set(assigned, n + 1);
    if (!n) return assigned === 'worker' ? calls(['Edit', { file_path: 'calc.ts', old_str: 'return a - b', new_str: 'return a + b' }]) : calls(['Execute', { command: 'ls' }]);
    return n === 1 ? calls(['EndFeatureRun', handoff(id)]) : done();
  });
  expect(independentExit).not.toBe(0);
  expect(mission?.state).toBe('paused');
  expect(mission?.validations.arithmetic?.verifiers?.[0]).toMatchObject({ command: 'bun test' });
  expect(mission?.validations.arithmetic?.verifiers?.[0]?.exitCode).not.toBe(0);
});

test('runner verifiers that pass, with observed validator evidence, complete the mission', async () => {
  const turns = new Map<string, number>();
  const { mission, independentExit } = await runMission([{ ...feature('add'), verificationCommands: ['bun test'] }], (_r, id, assigned) => {
    const n = turns.get(assigned) ?? 0; turns.set(assigned, n + 1);
    if (!n) return assigned === 'worker' ? fixAdd() : calls(['Execute', { command: 'bun test' }]);
    return n === 1 ? calls(['EndFeatureRun', assigned === 'worker' ? handoff(id) : withClaim(handoff(id), 'bun test', 0)]) : done();
  });
  expect(independentExit).toBe(0);
  expect(mission?.state).toBe('completed');
  expect(mission?.validations.arithmetic?.verifiers?.[0]?.exitCode).toBe(0);
});

test('a validator that returns to the orchestrator or reports issues does not complete the mission', async () => {
  const turns = new Map<string, number>();
  const { mission } = await runMission([feature('add')], (_r, id, assigned) => {
    const n = turns.get(assigned) ?? 0; turns.set(assigned, n + 1);
    if (!n) return assigned === 'worker' ? fixAdd() : calls(['Execute', { command: 'bun test' }]);
    if (n > 1) return done();
    if (assigned === 'scrutiny') {
      const h = handoff(id);
      return calls(['EndFeatureRun', { ...h, returnToOrchestrator: true, handoff: { ...h.handoff,
        discoveredIssues: [{ severity: 'non_blocking', description: 'Division by zero is still unhandled' }] } }]);
    }
    return n === 1 ? calls(['EndFeatureRun', handoff(id)]) : done();
  });
  expect(mission?.state).toBe('orchestrator_turn');
  expect(Object.values(mission?.features ?? {}).every(f => f.status !== 'completed')).toBe(true);
});

test('verifier commands with shell syntax are rejected rather than interpreted', async () => {
  const { verifierArgv } = await import('../src/agent/mission-evidence.ts');
  expect(verifierArgv('bun test')).toEqual(['bun', 'test']);
  for (const bad of ['bun test && rm -rf x', 'echo $(id)', 'cat a | sh', 'bun test > out', '']) expect(() => verifierArgv(bad)).toThrow();
});

// H-05: quoting groups words without a shell; operators stay refused unless quoted.
test('verifier tokenizer supports quotes and escapes but never shell features', async () => {
  const { verifierArgv } = await import('../src/agent/mission-evidence.ts');
  expect(verifierArgv('bun test -t "adds two numbers"')).toEqual(['bun', 'test', '-t', 'adds two numbers']);
  expect(verifierArgv("pytest -k 'test_feature and not test_slow'")).toEqual(['pytest', '-k', 'test_feature and not test_slow']);
  expect(verifierArgv('node -e "console.log(1 | 2)"')).toEqual(['node', '-e', 'console.log(1 | 2)']);
  expect(verifierArgv("grep -r 'a;b' src")).toEqual(['grep', '-r', 'a;b', 'src']);
  expect(verifierArgv('echo "say \\"hi\\"" a\\ b')).toEqual(['echo', 'say "hi"', 'a b']);
  expect(verifierArgv('echo "" x')).toEqual(['echo', '', 'x']);
  for (const bad of ['echo "$HOME"', 'echo "`id`"', 'echo "open', "echo 'open", 'ls *.ts', 'cd ~', 'a\nb', 'echo \\', 'bun test # c'])
    expect(() => verifierArgv(bad)).toThrow('shell syntax');
});

// H-06: the verifier runs on a disposable copy; caches work, nothing leaks, deps are read-only.
test('runVerifier lets runners write caches without touching the workspace', async () => {
  const { runVerifier } = await import('../src/agent/mission-evidence.ts');
  const { cwd } = await workspace();
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(cwd, 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(cwd, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  Bun.spawnSync(['git', 'init', '-q'], { cwd });
  await writeFile(join(cwd, '.gitignore'), 'node_modules/\n');
  const context = { cwd, signal: new AbortController().signal, autonomy: 'high', interactionMode: 'auto' } as never;
  const before = (await import('node:fs')).readdirSync(cwd).sort();
  const cache = await runVerifier(context, 'sh -c "mkdir -p .pytest_cache coverage && echo x > coverage/r && cat node_modules/dep/index.js"');
  expect(cache.exitCode).toBe(0);
  expect(cache.output).toContain('module.exports = 1');
  expect((await import('node:fs')).readdirSync(cwd).sort()).toEqual(before);
  const deps = await runVerifier(context, 'sh -c "echo y > node_modules/dep/index.js"');
  expect(deps.exitCode).not.toBe(0);
  expect(await readFile(join(cwd, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
  process.env.FAB_VERIFIER_SECRET = 'leak';
  const env = await runVerifier(context, 'sh -c env');
  delete process.env.FAB_VERIFIER_SECRET;
  expect(env.output).toContain('CI=1');
  expect(env.output).not.toContain('FAB_VERIFIER_SECRET');
}, 30_000);

// P0.3: a run reserves the model calls it needs to verify its own work before any effect.
test('insufficient model-call budget fails before feature effects', async () => {
  const paths = await workspace(); let jobs = 0;
  const fixture = scenario(paths.cwd, [feature()], () => { jobs++; return done(); });
  // The orchestrator uses 4 calls to propose, plan and start; the run needs 1 + 2*2 = 5 more.
  const result = await runAgent({ ...paths, prompt: 'mission', provider: fixture.provider, autonomy: 'high', interactionMode: 'mission', subagents: { maxModelCalls: 6 } });
  expect(jobs).toBe(0);
  expect(result.mission?.state).toBe('paused');
  expect(await readFile(join(paths.cwd, 'calc.ts'), 'utf8')).toContain('return a - b');
});

test('the shared call budget keeps reservations for the run that holds them', async () => {
  const { AgentBudget } = await import('../src/agent/tasks.ts');
  const budget = new AgentBudget(8, 10);
  budget.modelCall(); budget.modelCall();
  const run = budget.reserveCalls(5);
  expect(budget.freeCalls).toBe(3);
  for (let i = 0; i < 3; i++) budget.modelCall();
  expect(() => budget.modelCall()).toThrow('exhausted');      // other work cannot eat the reservation
  for (let i = 0; i < 5; i++) budget.modelCall(run);          // the holder spends its own calls
  expect(() => budget.modelCall(run)).toThrow('exhausted');   // and cannot exceed the global maximum
  expect(() => budget.reserveCalls(1)).toThrow('Insufficient');
  const small = new AgentBudget(8, 10), r = small.reserveCalls(4);
  small.modelCall(r); r.release(); r.release();               // release is idempotent and returns the unspent rest
  expect(small.freeCalls).toBe(9);
  expect(() => small.reserveCalls(-1)).toThrow('Invalid');
});

// P0.4: aborting a run (as the harness does on timeout) drains it before the fixture is removed.
test('an aborted mission run drains its worker before teardown and writes nothing afterwards', async () => {
  const paths = await workspace(); let started!: () => void;
  const workerStarted = new Promise<void>(r => (started = r));
  const fixture = scenario(paths.cwd, [feature()], async (_r, _id, assigned) => {
    if (assigned !== 'worker') return done();
    started();
    // A long command the abort must kill: it would write a sentinel 3 s later if it survived.
    return calls(['Execute', { command: "sh -c 'sleep 3; echo late > late.txt'" }]);
  });
  const controller = new AbortController();
  const run = runCodingAgent({ ...paths, prompt: 'mission', provider: fixture.provider, autonomy: 'high', interactionMode: 'mission', signal: controller.signal });
  await workerStarted; await Bun.sleep(300);
  controller.abort(new Error('simulated harness timeout'));
  const result = await run;
  expect(result.ok).toBe(false);
  await Bun.sleep(3500);
  const { existsSync } = await import('node:fs');
  expect(existsSync(join(paths.cwd, 'late.txt'))).toBe(false);
}, 20_000);

// P0.5: approvals and validations never carry over to work they did not examine.
test('a dismissal covers only the attempt that produced the item, not the same text reported later', async () => {
  const { MissionManager } = await import('../src/agent/mission.ts');
  const issue = 'Division by zero is still unhandled';
  const withIssue = () => { const h = handoff('add'); return parseHandoff({ ...h, handoff: { ...h.handoff,
    discoveredIssues: [{ severity: 'non_blocking', description: issue }] } }, 'add'); };
  const mission = { attempts: [{ workerSessionId: 'w1', featureId: 'add', role: 'worker', handoff: withIssue() }], dismissals: [] as Array<Record<string, unknown>> };
  const manager = Object.create(MissionManager.prototype) as { pendingItems(): unknown[]; dismiss(i: unknown): Promise<unknown>; mission: unknown; sync(): Promise<void>; log(): Promise<void> };
  Object.defineProperty(manager, 'mission', { get: () => mission });
  manager.sync = async () => {}; manager.log = async () => {};
  const dismissal = { type: 'discovered_issue', sourceFeatureId: 'add', summary: issue, justification: 'Out of scope for this arithmetic milestone, tracked separately.' };
  expect(manager.pendingItems()).toHaveLength(1);
  await manager.dismiss({ dismissals: [dismissal] });
  expect(manager.pendingItems()).toHaveLength(0);
  expect(mission.dismissals[0]).toMatchObject({ attempt: 0 });
  // A later attempt reports the identical text: it is a new open item, not covered by attempt 0's dismissal.
  mission.attempts.push({ workerSessionId: 'w2', featureId: 'add', role: 'worker', handoff: withIssue() });
  expect(manager.pendingItems()).toMatchObject([{ attempt: 1, summary: issue }]);
  // One dismissal addresses one item; dismissing twice in one call needs two open items.
  await expect(manager.dismiss({ dismissals: [dismissal, dismissal] })).rejects.toThrow('pending handoff item');
  await manager.dismiss({ dismissals: [dismissal] });
  expect(manager.pendingItems()).toHaveLength(0);
  // A legacy dismissal recorded without an attempt index covers nothing (fail closed).
  mission.dismissals = [{ ...dismissal }];
  expect(manager.pendingItems()).toHaveLength(2);
});

test('changing a feature definition or its verifiers invalidates prior validation', () => {
  const base = parseFeatures({ features: [{ ...feature(), verificationCommands: ['bun test'] }] })[0]!;
  const changed = parseFeatures({ features: [{ ...feature(), verificationCommands: ['bun test calc'] }] })[0]!;
  const { status: _a, ...d1 } = base, { status: _b, ...d2 } = changed;
  expect(JSON.stringify(d1)).not.toBe(JSON.stringify(d2));
  expect(() => parseFeatures({ features: [{ ...feature(), verificationCommands: Array(21).fill('bun test') }] })).toThrow('verificationCommands');
});

// Review findings H-01/H-02/H-03: no completion without contract
// verifiers, workers cannot weaken protected tests, and sealed verification cannot be dropped.
test('H-01: a trivial validator command cannot complete a milestone that declares no verifiers', async () => {
  const turns = new Map<string, number>();
  const { mission } = await runMission([{ ...feature('add'), verificationCommands: [], protectedPaths: [] }], (_r, id, assigned) => {
    const n = turns.get(assigned) ?? 0; turns.set(assigned, n + 1);
    if (!n) return assigned === 'worker' ? fixAdd() : calls(['Execute', { command: 'ls' }]);
    return n === 1 ? calls(['EndFeatureRun', handoff(id)]) : done();
  });
  expect(mission?.state).toBe('paused');
  expect(Object.values(mission?.features ?? {}).every(f => f.status !== 'completed')).toBe(true);
});

test('H-02: a worker that rewrites a protected test is caught before validation', async () => {
  const turns = new Map<string, number>();
  const { mission, independentExit } = await runMission([feature('add')], (_r, id, assigned) => {
    const n = turns.get(assigned) ?? 0; turns.set(assigned, n + 1);
    // Instead of fixing calc.ts, the worker replaces the failing test with one that always passes.
    if (!n && assigned === 'worker') return calls(['Create', { file_path: 'calc.test.ts', content: "import {test} from 'bun:test';test('ok',()=>{});\n" }]);
    if (!n) return calls(['Execute', { command: 'bun test' }]);
    return n === 1 ? calls(['EndFeatureRun', handoff(id)]) : done();
  });
  expect(independentExit).toBe(0); // the gutted test passes, which is exactly why it must be rejected
  expect(mission?.state).toBe('paused');
  expect(mission?.attempts.some(a => a.role !== 'worker')).toBe(false);
});

test('H-03: replanning cannot drop sealed verifiers or protected paths, only add them', async () => {
  const paths = await workspace(); let turn = 0, directory = '';
  const plan = (f: unknown) => JSON.stringify({ features: [f] });
  const provider: ModelProvider = { id: 'h03', async complete(request) {
    if (role(request)) return done();
    turn++;
    if (turn === 1) return calls(['ProposeMission', { title: 'Arithmetic', proposal: 'Repair the arithmetic and verify it independently.' }]);
    if (turn === 2) {
      directory = JSON.parse(request.messages.at(-1)!.content as string).missionDir;
      return calls(['Create', { file_path: join(directory, 'features.json'), content: plan(feature('add')) }],
        ['Create', { file_path: join(directory, 'skills/fixture/SKILL.md'), content: skill }]);
    }
    if (turn === 3) return calls(['StartMissionRun', {}]);
    if (turn === 4) return calls(['Create', { file_path: join(directory, 'features.json'), content: plan({ ...feature('add'), verificationCommands: [] }) }]);
    if (turn === 5) return calls(['StartMissionRun', {}]);
    return done();
  } };
  const result = await runAgent({ ...paths, prompt: 'mission', provider, autonomy: 'high', interactionMode: 'mission', timeoutMs: 30_000 });
  const session = await readFile(join(paths.sessionDir, `${result.sessionId}.json`), 'utf8');
  expect(session).toContain('cannot drop sealed verification: bun test');
  expect(result.mission?.state).not.toBe('completed');
}, 30_000);

test('protectedPaths reject absolute or parent-relative paths', () => {
  for (const bad of ['/etc/passwd', '../outside.ts', 'a/../../b']) {
    expect(() => parseFeatures({ features: [{ ...feature(), protectedPaths: [bad] }] })).toThrow('protectedPaths');
  }
});

test('H-04: a verification run inside Script is observed like a direct Execute', async () => {
  const turns = new Map<string, number>();
  const { mission } = await runMission([feature('add')], (_r, id, assigned) => {
    const n = turns.get(assigned) ?? 0; turns.set(assigned, n + 1);
    if (!n && assigned === 'worker') return fixAdd();
    if (!n) return calls(['Script', { code: "const r = await tools.Execute({ command: 'bun test' }); return r.exitCode;" }]);
    return n === 1 ? calls(['EndFeatureRun', assigned === 'worker' ? handoff(id) : withClaim(handoff(id), 'bun test', 0)]) : done();
  });
  const validators = (mission?.attempts ?? []).filter(a => a.role !== 'worker') as Array<{ error?: string; observed?: Array<{ command: string; exitCode: number | null; isError: boolean }> }>;
  expect(validators.length).toBe(2);
  for (const v of validators) {
    expect(v.error).toBeUndefined();
    expect(v.observed).toContainEqual({ command: 'bun test', exitCode: 0, isError: false });
  }
  expect(mission?.state).toBe('completed');
});

test('YOLO mission workers use host policy but validators remain sandboxed and offline', async () => {
  const paths = await workspace(), turns = new Map<string, number>(), observed: string[] = [];
  const fixture = scenario(paths.cwd, [feature()], (r, id, assigned) => {
    const n = turns.get(assigned) ?? 0; turns.set(assigned, n + 1);
    if (!n) {
      if (assigned === 'worker') return calls(['Execute', { command: "printf worker | tr a-z A-Z" }]);
      return calls(['Execute', { command: 'pwd', network: true }], ['Execute', { command: 'pwd' }]);
    }
    if (n === 1) {
      const results = r.messages.filter(m => m.role === 'tool');
      observed.push(assigned);
      if (assigned === 'worker') {
        expect(JSON.parse(results[0]!.content as string)).toMatchObject({ permissionMode: 'yolo', sandboxed: false, stdout: 'WORKER' });
      } else {
        expect(results[0]!.content).toContain('denied');
        expect(JSON.parse(results[1]!.content as string)).toMatchObject({ sandboxed: true, network: { enabled: false } });
      }
      return calls(['EndFeatureRun', handoff(id)]);
    }
    return done();
  });
  // A passing contract independent of the deliberately unchanged arithmetic.
  const original = fixture.provider.complete;
  fixture.provider.complete = async (...args) => {
    const response = await original(...args);
    for (const c of response.toolCalls) if (c.function.name === 'Create') {
      const input = JSON.parse(c.function.arguments);
      if (input.file_path.endsWith('features.json')) {
        const f = feature(); f.verificationCommands = ['pwd']; input.content = JSON.stringify({ features: [f] }); c.function.arguments = JSON.stringify(input);
      }
    }
    return response;
  };
  const result = await runAgent({ ...paths, prompt: 'mission', provider: fixture.provider, permissionMode: 'yolo', interactionMode: 'mission', timeoutMs: 4000 });
  expect(result.ok).toBe(true); expect(observed).toContain('worker'); expect(observed).toContain('scrutiny'); expect(observed).toContain('user-testing');
});
