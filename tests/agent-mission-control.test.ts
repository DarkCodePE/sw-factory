import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodingAgent } from '../src/agent/engine.ts';
import { missionProgressSnapshot } from '../src/agent/mission-progress.ts';
import { parseFeatures, type MissionState } from '../src/agent/mission-contract.ts';
import { SessionStore } from '../src/agent/session.ts';
import type { AgentEvent, AgentOptions, AgentResult, ModelProvider, ModelRequest, ModelTurn } from '../src/agent/types.ts';

const roots: string[] = [], live = new Set<{ controller: AbortController; done: Promise<unknown> }>();
afterEach(async () => {
  for (const x of live) x.controller.abort(new Error('teardown'));
  await Promise.all([...live].map(x => x.done));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function run(options: AgentOptions) {
  const controller = new AbortController(), signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const done = runCodingAgent({ ...options, signal }), item = { controller, done };
  live.add(item); void done.finally(() => live.delete(item)); return done;
}
const done = (): ModelTurn => ({ text: 'done', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 2 } });
const calls = (...items: Array<[string, unknown]>): ModelTurn => ({ text: '', finishReason: 'tool_calls', usage: { inputTokens: 5, outputTokens: 2 },
  toolCalls: items.map(([name, input]) => ({ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(input) } })) });
const feature = () => ({ id: 'one', description: 'Inspect the fixed contract file.', skillName: 'fixture', milestone: 'first', status: 'pending',
  preconditions: [], expectedBehavior: ['Contract file is intact'], fulfills: [], verificationCommands: ['cat contract.txt'], protectedPaths: ['contract.txt'] });
const handoff = () => ({ featureId: 'one', successState: 'success', returnToOrchestrator: false, handoff: {
  salientSummary: 'Completed the synthetic mission work with truthful evidence.',
  whatWasImplemented: 'Inspected the assigned behavior and kept the protected contract unchanged throughout this synthetic mission.',
  whatWasLeftUndone: '', verification: { commandsRun: [] }, tests: { added: [], coverage: 'Independent runner verification.' }, discoveredIssues: [],
} });
function assigned(r: ModelRequest): string | undefined {
  const text = r.messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('Assigned mission feature '))?.content;
  return typeof text === 'string' ? /; role ([\w-]+)\./.exec(text)?.[1] : undefined;
}
async function fixture(options: { child?: (r: ModelRequest, role: string, signal: AbortSignal) => Promise<ModelTurn> | ModelTurn; plan?: boolean; features?: unknown[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fab-mission-control-')); roots.push(root);
  const cwd = join(root, 'repo'), sessionDir = join(root, 'sessions'); await mkdir(cwd); await writeFile(join(cwd, 'contract.txt'), 'intact\n');
  const events: AgentEvent[] = [], requests: ModelRequest[] = []; let parent = 0, directory = '', started: any;
  const child = options.child ?? ((r, role) => {
    const tools = r.messages.filter(m => m.role === 'tool').length;
    if (role === 'worker') return tools ? done() : calls(['EndFeatureRun', handoff()]);
    return !tools ? calls(['Execute', { command: 'cat contract.txt' }]) : tools === 1 ? calls(['EndFeatureRun', handoff()]) : done();
  });
  const provider: ModelProvider = { id: 'fixture', async complete(r, signal) {
    const role = assigned(r); if (role) return child(r, role, signal);
    requests.push(structuredClone(r));
    if (!parent++) return calls(['ProposeMission', { title: 'Control', proposal: 'Verify one feature and all milestone gates.' }]);
    if (parent === 2 && options.plan !== false) {
      directory = JSON.parse(String(r.messages.at(-1)!.content)).missionDir;
      return calls(['Create', { file_path: join(directory, 'features.json'), content: JSON.stringify({ features: options.features ?? [feature()] }) }],
        ['Create', { file_path: join(directory, 'skills/fixture/SKILL.md'), content: '---\nname: fixture\ndescription: Inspect fixed contract.\n---\nUse runtime evidence.' }]);
    }
    if (parent === (options.plan === false ? 2 : 3)) return calls(['StartMissionRun', {}]);
    const tail = String([...r.messages].reverse().find(m => m.role === 'tool')!.content); try { started = JSON.parse(tail); } catch { started = tail; }
    return done();
  } };
  const agent: AgentOptions = { cwd, sessionDir, prompt: 'mission', provider, autonomy: 'high', interactionMode: 'mission',
    onEvent: e => events.push(structuredClone(e)) };
  return { root, cwd, sessionDir, events, requests, agent, provider, directory: () => directory, started: () => started };
}
async function until(check: () => boolean | Promise<boolean>, timeout = 3500) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Wait timeout'); await Bun.sleep(3); }
}
async function saved(f: Awaited<ReturnType<typeof fixture>>, result: AgentResult) {
  return JSON.parse(await readFile(join(f.sessionDir, result.sessionId + '.json'), 'utf8'));
}

test('Mission Control emits the shared event contract, coherent snapshots and persisted attempt usage/duration', async () => {
  const f = await fixture(), result = await run(f.agent), state = await saved(f, result), snapshot = result.mission!.snapshot;
  expect(result.mission?.state).toBe('completed');
  expect(snapshot).toEqual(f.started().progressSnapshot);
  expect(snapshot).toMatchObject({ title: 'Control', state: 'completed', features: [{ id: 'one', milestone: 'first', status: 'completed', attempts: 1 }],
    milestones: [{ id: 'first', scrutiny: true, userTesting: true, verifiersPassed: true }], totals: { completed: 1, total: 1, usage: { inputTokens: 40, outputTokens: 16 } } });
  expect(snapshot.workers.map(w => w.status)).toEqual(['completed', 'completed', 'completed']);
  expect(snapshot.totals.durationMs).toBe(snapshot.workers.reduce((n, w) => n + w.durationMs, 0));
  expect(f.events.filter(e => e.type === 'mission_feature_updated').map(e => [e.status, e.attempts]))
    .toEqual([['pending', 0], ['pending', 1], ['awaiting_validation', 1], ['completed', 1]]);
  expect(f.events.filter(e => e.type === 'mission_worker_started').map(e => [e.role, e.milestone]))
    .toEqual([['worker', 'first'], ['scrutiny', 'first'], ['user-testing', 'first']]);
  const completed = f.events.filter(e => e.type === 'mission_worker_completed');
  expect(completed).toHaveLength(3); expect(completed[0]).toMatchObject({ milestone: 'first', successState: 'success', usage: { inputTokens: 10, outputTokens: 4 }, exitCode: 0, hasHandoff: true });
  expect(completed.every(e => typeof e.durationMs === 'number' && Number(e.durationMs) >= 0)).toBe(true);
  expect(f.events.find(e => e.type === 'mission_milestone_validated')).toMatchObject({ milestone: 'first', passed: true, verifiers: [{ command: 'cat contract.txt', exitCode: 0 }] });
  expect(f.events.filter(e => e.type.startsWith('mission_')).every(e => e.sessionId === result.sessionId && e.missionId === snapshot.missionId)).toBe(true);
  expect(f.events.filter(e => e.type === 'mission_progress').at(-1)!.snapshot).toEqual(snapshot);
  for (const [i, attempt] of state.mission.attempts.entries()) {
    const disk = JSON.parse(await readFile(join(state.mission.directory, 'handoffs', attempt.workerSessionId + '-' + (i + 1) + '.json'), 'utf8'));
    expect(disk).toMatchObject({ usage: attempt.usage, durationMs: attempt.durationMs, milestone: 'first' });
  }
});

test('snapshot bounds 100 features/recent workers, includes lifetime totals and no handoff prose or mutable state', () => {
  expect(parseFeatures({ features: Array.from({ length: 100 }, (_, i) => ({ ...feature(), id: 'f' + i })) })).toHaveLength(100);
  expect(() => parseFeatures({ features: Array.from({ length: 101 }, (_, i) => ({ ...feature(), id: 'f' + i })) })).toThrow('1..100');
  const mission: MissionState = { version: 1, missionId: 'm', directory: '/owned', workingDirectory: '/repo', title: 'x'.repeat(50000), proposal: 'long'.repeat(50000),
    state: 'paused', createdAt: '', updatedAt: new Date().toISOString(), features: {}, validations: {}, dismissals: [], attempts: [] };
  for (let i = 0; i < 100; i++) mission.features['f' + i] = { status: 'pending', milestone: 'first', attempts: 0, workerSessionIds: [], definitionHash: 'hash' };
  for (let i = 0; i < 150; i++) mission.attempts.push({ workerSessionId: 'w' + i, featureId: 'f0', role: 'worker', error: 'secret'.repeat(50000), usage: { inputTokens: 1, outputTokens: 2 }, durationMs: 3 });
  const snapshot = missionProgressSnapshot(mission);
  expect(snapshot.features).toHaveLength(100); expect(snapshot.workers).toHaveLength(100); expect(snapshot.workers[0]!.workerSessionId).toBe('w50');
  expect(snapshot.workers.at(-1)!.workerSessionId).toBe('w149'); expect(snapshot.title.length).toBe(200);
  expect(snapshot.totals).toMatchObject({ total: 100, usage: { inputTokens: 150, outputTokens: 300 }, durationMs: 450 });
  expect(JSON.stringify(snapshot)).not.toContain('secret'); expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(64 * 1024);
  snapshot.features[0]!.status = 'completed'; expect(mission.features.f0!.status).toBe('pending');
  mission.attempts[149]!.usage = { inputTokens: Infinity, outputTokens: -10 }; mission.attempts[149]!.durationMs = NaN;
  expect(missionProgressSnapshot(mission).workers.at(-1)).toMatchObject({ usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 0 });
});

test('aborting a host pause signal outside a run does nothing; pre-aborted Start pauses before planning/worker/budget', async () => {
  const pause = new AbortController(), f = await fixture({ plan: false });
  f.agent.mission = { pauseSignal: pause.signal };
  f.agent.provider = { id: 'outside', async complete(r) {
    if (!r.messages.some(m => m.role === 'tool')) return calls(['ProposeMission', { title: 'Idle', proposal: 'No active StartMissionRun.' }]);
    pause.abort(); return done();
  } };
  const result = await run(f.agent);
  expect(result.mission!.state).toBe('planning'); expect(f.events.some(e => e.type === 'mission_paused')).toBe(false);
  const g = await fixture({ plan: false, child: () => { throw new Error('Must not launch'); } });
  g.agent.mission = { pauseSignal: pause.signal };
  const stopped = await run(g.agent);
  expect(g.started()).toMatchObject({ started: true, paused: true });
  expect(stopped.mission?.state).toBe('paused'); expect(stopped.mission!.snapshot.workers).toEqual([]);
  expect(g.events.some(e => e.type === 'mission_worker_started')).toBe(false);
  expect(g.events.find(e => e.type === 'mission_paused')).toMatchObject({ reason: 'host_request' });
});

test('all normal failure routes emit the matching mission_paused reason and verifier failures cannot complete', async () => {
  for (const reason of ['worker_failed', 'validation_failed', 'protected_paths_changed', 'verification_missing', 'error'] as const) {
    const config = feature(); if (reason === 'verification_missing') config.verificationCommands = [];
    const f = await fixture({ features: [config], child: (r, role) => {
      const count = r.messages.filter(m => m.role === 'tool').length;
      if (role === 'worker') {
        if (reason === 'worker_failed') return done();
        if (reason === 'protected_paths_changed') return count === 0 ? calls(['Edit', { file_path: 'contract.txt', old_str: 'intact', new_str: 'tampered' }]) : count === 1 ? calls(['EndFeatureRun', handoff()]) : done();
        return count ? done() : calls(['EndFeatureRun', handoff()]);
      }
      if (reason === 'validation_failed') return done();
      return !count ? calls(['Execute', { command: 'cat contract.txt' }]) : count === 1 ? calls(['EndFeatureRun', handoff()]) : done();
    } });
    if (reason === 'error') f.agent.subagents = { maxAgents: 2 };
    const result = await run(f.agent);
    expect(result.mission?.state).toBe('paused');
    expect(f.events.find(e => e.type === 'mission_paused')).toMatchObject({ reason });
    expect(result.mission!.snapshot.totals.completed).toBe(0);
  }
  const f = await fixture({ features: [{ ...feature(), verificationCommands: ['false'] }] });
  const result = await run(f.agent);
  expect(f.events.find(e => e.type === 'mission_milestone_validated')).toMatchObject({ passed: false, verifiers: [{ command: 'false', exitCode: 1 }] });
  expect(f.events.find(e => e.type === 'mission_paused')).toMatchObject({ reason: 'validation_failed' });
  expect(result.mission?.state).toBe('paused');
});

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const command = (s: string) => quote(process.execPath) + ' -e ' + quote(s);
test('host pause drains foreground and background workers with no late writes, repeated three times; owned worker resumes without replay', async () => {
  for (let repetition = 0; repetition < 3; repetition++) {
    const pause = new AbortController(); let f!: Awaited<ReturnType<typeof fixture>>;
    f = await fixture({ child: (r, role) => {
      if (role !== 'worker') {
        const count = r.messages.filter(m => m.role === 'tool').length;
        return !count ? calls(['Execute', { command: 'cat contract.txt' }]) : count === 1 ? calls(['EndFeatureRun', handoff()]) : done();
      }
      const count = r.messages.filter(m => m.role === 'tool').length;
      return count === 0 ? calls(['Execute', { background: true, command: command("require('fs').writeFileSync('background-start','yes');setTimeout(()=>require('fs').writeFileSync('late-background','bad'),800);setTimeout(()=>{},5000)") }])
        : calls(['Execute', { command: command("require('fs').appendFileSync('foreground-count','x');setTimeout(()=>require('fs').writeFileSync('late-foreground','bad'),800);setTimeout(()=>{},5000)") }]);
    } });
    f.agent.mission = { pauseSignal: pause.signal };
    const inbox: string[] = []; f.agent.receiveMessages = () => inbox.splice(0);
    const work = run(f.agent);
    await until(() => Bun.file(join(f.cwd, 'background-start')).exists());
    await until(() => Bun.file(join(f.cwd, 'foreground-count')).exists());
    inbox.push('Host redirection: inspect partial effects and change the plan.');
    pause.abort(); const result = await work, state = await saved(f, result), attempt = state.mission.attempts[0];
    expect(result.ok).toBe(true); expect(f.started()).toMatchObject({ started: true, paused: true });
    expect(attempt).toMatchObject({ error: 'Paused by host', status: 'failed', usage: { inputTokens: 10, outputTokens: 4 } });
    expect(state.mission.features.one.attempts).toBe(0);
    expect(f.events.find(e => e.type === 'mission_paused')).toMatchObject({ reason: 'host_request' });
    const store = await SessionStore.create(f.sessionDir), child = await store.load(attempt.workerSessionId); await store.close();
    expect(f.requests.at(-1)!.messages.some(m => typeof m.content === 'string' && m.content.includes('Host redirection: inspect partial effects'))).toBe(true);
    expect(child.pending).toEqual([]); expect(child.messages.at(-1)!.content).toContain('may have partially completed');
    expect(child.backgroundTasks!.every(t => t.status !== 'running')).toBe(true);
    await Bun.sleep(900);
    expect(await Bun.file(join(f.cwd, 'late-background')).exists()).toBe(false);
    expect(await Bun.file(join(f.cwd, 'late-foreground')).exists()).toBe(false);
    const disk = JSON.parse(await readFile(join(state.mission.directory, 'handoffs', attempt.workerSessionId + '-1.json'), 'utf8'));
    expect(disk).toMatchObject({ error: 'Paused by host', usage: attempt.usage, durationMs: attempt.durationMs });
    if (repetition !== 0) continue;
    const events: AgentEvent[] = []; let parent = 0, sawMessage = false;
    const provider: ModelProvider = { id: 'fixture', async complete(r) {
      const role = assigned(r);
      if (!role) return parent++ ? done() : calls(['StartMissionRun', { resumeWorkerSessionId: attempt.workerSessionId, messageToWorker: 'Inspect partial effects before continuing.' }]);
      if (role === 'worker') {
        sawMessage = r.messages.some(m => typeof m.content === 'string' && m.content.includes('Inspect partial effects before continuing.'));
        return r.messages.some(m => m.role === 'assistant' && m.tool_calls?.some(c => c.function.name === 'EndFeatureRun')) ? done() : calls(['EndFeatureRun', handoff()]);
      }
      const count = r.messages.filter(m => m.role === 'tool').length;
      return !count ? calls(['Execute', { command: 'cat contract.txt' }]) : count === 1 ? calls(['EndFeatureRun', handoff()]) : done();
    } };
    const resumed = await run({ ...f.agent, provider, mission: { pauseSignal: new AbortController().signal }, sessionId: result.sessionId, prompt: 'resume', onEvent: e => events.push(e) });
    expect(resumed.mission?.state).toBe('completed'); expect(sawMessage).toBe(true);
    expect(await readFile(join(f.cwd, 'foreground-count'), 'utf8')).toBe('x');
    expect(events.find(e => e.type === 'mission_worker_started')).toMatchObject({ workerSessionId: attempt.workerSessionId });
    expect((await saved(f, resumed)).mission.features.one.attempts).toBe(1);
  }
}, 15000);

test('ordinary abort during host pause takes precedence, drains work and cannot return a successful pause', async () => {
  const pause = new AbortController(), abort = new AbortController(); let providerStarted = false;
  const f = await fixture({ child: async (_r, _role, signal) => {
    providerStarted = true;
    await new Promise<void>(resolve => { signal.addEventListener('abort', () => setTimeout(resolve, 40), { once: true }); });
    return done();
  } });
  f.agent.mission = { pauseSignal: pause.signal }; f.agent.signal = abort.signal;
  const work = run(f.agent); await until(() => providerStarted);
  pause.abort(); abort.abort(new Error('turn aborted'));
  const result = await work;
  expect(result).toMatchObject({ ok: false, error: { type: 'aborted' } });
  expect(f.events.some(e => e.type === 'mission_paused' && e.reason === 'host_request')).toBe(false);
  expect(result.mission?.state).toBe('paused');
});

test('missing verifier contract stays paused on repeated Start even when both validator roles previously succeeded', async () => {
  const f = await fixture({ features: [{ ...feature(), verificationCommands: [] }] });
  const first = await run(f.agent); let parent = 0;
  const provider: ModelProvider = { id: 'fixture', async complete() { return parent++ ? done() : calls(['StartMissionRun', {}]); } };
  const resumed = await run({ ...f.agent, provider, sessionId: first.sessionId, prompt: 'try again' });
  expect(first.mission?.state).toBe('paused'); expect(resumed.mission?.state).toBe('paused');
  expect(resumed.mission!.snapshot.milestones[0]!.verifiersPassed).toBe(null);
  expect(resumed.mission!.snapshot.totals.completed).toBe(0);
});


test('host pause resumes an owned validator and also a worker that submitted handoff before pause', async () => {
  for (const pausedRole of ['worker', 'scrutiny'] as const) {
    const pause = new AbortController(); let hanging = false;
    const f = await fixture({ child: async (r, role, signal) => {
      const count = r.messages.filter(m => m.role === 'tool').length;
      if (role === pausedRole && count === 1) {
        hanging = true;
        return new Promise((_, reject) => { const stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop(); });
      }
      if (role === 'worker') return count ? done() : calls(['EndFeatureRun', handoff()]);
      return !count ? calls(['Execute', { command: 'cat contract.txt' }]) : count === 1 ? calls(['EndFeatureRun', handoff()]) : done();
    } });
    f.agent.mission = { pauseSignal: pause.signal };
    const running = run(f.agent); await until(() => hanging); pause.abort();
    const first = await running, before = await saved(f, first), paused = before.mission.attempts.at(-1);
    expect(paused).toMatchObject({ role: pausedRole, error: 'Paused by host', status: 'failed' });
    if (pausedRole === 'worker') {
      expect(paused.handoff.successState).toBe('success');
      expect(before.mission.features.one.attempts).toBe(0);
      expect(first.mission!.snapshot.workers.at(-1)!.status).toBe('failed');
    }
    // Pause a second time before opening the already persisted child session.
    const again = new AbortController(); let middleTurn = 0;
    const middle = await run({ ...f.agent, sessionId: first.sessionId, prompt: 'resume briefly', mission: { pauseSignal: again.signal },
      provider: { id: 'fixture', async complete(r) {
        if (assigned(r)) throw new Error('Must pause before reopening child');
        return middleTurn++ ? done() : calls(['StartMissionRun', { resumeWorkerSessionId: paused.workerSessionId }]);
      } }, onEvent: e => { if (e.type === 'mission_worker_started') again.abort(); } });
    expect((await saved(f, middle)).mission.attempts.at(-1)).toMatchObject({ sessionCreated: true, pausedByHost: true });
    let parent = 0, redirected = false;
    const provider: ModelProvider = { id: 'fixture', async complete(r) {
      const role = assigned(r);
      if (!role) return parent++ ? done() : calls(['StartMissionRun', { resumeWorkerSessionId: paused.workerSessionId, messageToWorker: 'Review current source before continuing.' }]);
      const fresh = r.messages.slice(r.messages.map(m => m.role).lastIndexOf('user'));
      const count = fresh.filter(m => m.role === 'tool').length;
      if (role === pausedRole) redirected = r.messages.some(m => typeof m.content === 'string' && m.content.includes('Review current source before continuing.'));
      if (role === 'worker') return count ? done() : calls(['EndFeatureRun', handoff()]);
      return !count ? calls(['Execute', { command: 'cat contract.txt' }]) : count === 1 ? calls(['EndFeatureRun', handoff()]) : done();
    } };
    const resumed = await run({ ...f.agent, provider, sessionId: first.sessionId, prompt: 'resume', mission: { pauseSignal: new AbortController().signal } });
    expect(resumed.mission?.state).toBe('completed'); expect(redirected).toBe(true);
    const attempts = (await saved(f, resumed)).mission.attempts;
    expect(attempts.filter((a: any) => a.workerSessionId === paused.workerSessionId)).toHaveLength(3);
    expect(resumed.mission!.snapshot.totals.completed).toBe(1);
  }
});

test('pause during final state persistence is observed before StartMissionRun returns', async () => {
  const f = await fixture(), pause = new AbortController();
  f.agent.mission = { pauseSignal: pause.signal };
  f.agent.onEvent = e => { f.events.push(structuredClone(e)); if (e.type === 'mission_state_changed' && e.state === 'completed') pause.abort(); };
  const result = await run(f.agent);
  expect(f.started()).toMatchObject({ started: true, paused: true });
  expect(result.mission?.state).toBe('paused');
  expect(f.events.filter(e => e.type === 'mission_paused').at(-1)).toMatchObject({ reason: 'host_request' });
});

test('pause before child session creation resumes the owned ID with no missing-session fallback', async () => {
  for (const boundary of ['mission_worker_started', 'mission_progress'] as const) {
    const f = await fixture(), pause = new AbortController(); let childCalls = 0;
    f.agent.mission = { pauseSignal: pause.signal };
    f.agent.onEvent = e => { f.events.push(structuredClone(e));
      if (e.type === boundary && (e.type === 'mission_worker_started' || (e.snapshot as any)?.workers?.some((w: any) => w.status === 'running'))) pause.abort();
    };
    const normal = f.provider; f.agent.provider = { id: normal.id, complete(r, signal) { if (assigned(r)) childCalls++; return normal.complete(r, signal); } };
    const first = await run(f.agent), state = await saved(f, first), paused = state.mission.attempts[0];
    expect(childCalls).toBe(0); expect(paused).toMatchObject({ sessionCreated: false, pausedByHost: true, error: 'Paused by host' });
    let parent = 0;
    const provider: ModelProvider = { id: 'fixture', async complete(r) {
      if (assigned(r)) return normal.complete(r, new AbortController().signal);
      return parent++ ? done() : calls(['StartMissionRun', { resumeWorkerSessionId: paused.workerSessionId }]);
    } };
    const result = await run({ ...f.agent, sessionId: first.sessionId, provider, prompt: 'resume', mission: {}, onEvent: undefined });
    expect(result.mission?.state).toBe('completed');
    const attempts = (await saved(f, result)).mission.attempts;
    expect(attempts[1]).toMatchObject({ workerSessionId: paused.workerSessionId, sessionCreated: true, status: 'completed' });
  }
});

test('provider error text cannot mint a host pause or refund feature attempts', async () => {
  const f = await fixture({ child: (r, role) => {
    if (role === 'worker' && r.messages.some(m => m.role === 'tool')) throw new Error('Paused by host');
    return calls(['EndFeatureRun', handoff()]);
  } });
  f.agent.maxRecoveryAttempts = 0;
  const result = await run(f.agent), state = await saved(f, result);
  expect(state.mission.features.one.attempts).toBe(1);
  expect(state.mission.attempts[0].pausedByHost).not.toBe(true);
  expect(f.events.filter(e => e.type === 'mission_paused').at(-1)).toMatchObject({ reason: 'worker_failed' });
});

test('paused partial handoff can resume its worker; old unfinished items still require explicit dismissal', async () => {
  const pause = new AbortController(); let hanging = false;
  const partial = handoff(); partial.successState = 'partial'; partial.handoff.whatWasLeftUndone = 'Review remaining evidence.';
  const f = await fixture({ child: async (r, _role, signal) => {
    if (!r.messages.some(m => m.role === 'tool')) return calls(['EndFeatureRun', partial]);
    hanging = true;
    return new Promise((_, reject) => { const stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop(); });
  } });
  f.agent.mission = { pauseSignal: pause.signal };
  const work = run(f.agent); await until(() => hanging); pause.abort();
  const first = await work, paused = (await saved(f, first)).mission.attempts[0]; let parent = 0;
  const provider: ModelProvider = { id: 'fixture', async complete(r) {
    if (assigned(r)) return r.messages.slice(r.messages.map(m => m.role).lastIndexOf('user')).some(m => m.role === 'tool') ? done() : calls(['EndFeatureRun', handoff()]);
    return parent++ ? done() : calls(['StartMissionRun', { resumeWorkerSessionId: paused.workerSessionId, messageToWorker: 'Inspect and resolve remaining work.' }]);
  } };
  const resumed = await run({ ...f.agent, provider, sessionId: first.sessionId, prompt: 'resume', mission: {} });
  expect(resumed.mission?.state).toBe('orchestrator_turn');
  const attempts = (await saved(f, resumed)).mission.attempts;
  expect(attempts).toHaveLength(2); expect(attempts[1]).toMatchObject({ workerSessionId: paused.workerSessionId, status: 'completed' });
  expect(resumed.mission!.snapshot.totals.completed).toBe(0);
});

test('pause while persisting a drained attempt settles disk metrics and refunds its retry before terminal event', async () => {
  const f = await fixture(), pause = new AbortController();
  f.agent.mission = { pauseSignal: pause.signal };
  f.agent.onEvent = e => { f.events.push(structuredClone(e));
    if (e.type === 'mission_feature_updated' && e.attempts === 1) pause.abort();
  };
  const result = await run(f.agent), state = await saved(f, result), attempt = state.mission.attempts[0];
  expect(f.started()).toMatchObject({ paused: true }); expect(state.mission.features.one.attempts).toBe(0);
  expect(attempt).toMatchObject({ status: 'failed', pausedByHost: true, error: 'Paused by host' });
  expect(f.events.filter(e => e.type === 'mission_worker_completed')).toHaveLength(1);
  expect(f.events.find(e => e.type === 'mission_worker_completed')).toMatchObject({ error: 'Paused by host', exitCode: 1 });
  const disk = JSON.parse(await readFile(join(state.mission.directory, 'handoffs', attempt.workerSessionId + '-1.json'), 'utf8'));
  expect(disk).toMatchObject({ pausedByHost: true, error: 'Paused by host', usage: attempt.usage, durationMs: attempt.durationMs });
});
