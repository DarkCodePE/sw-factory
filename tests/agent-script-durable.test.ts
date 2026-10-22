import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCodingAgent, listAgentTools } from '../src/agent/engine.ts';
import { ScriptRunManager, SCRIPT_FOREGROUND_MS, SCRIPT_AWAIT_MS, SCRIPT_MAX_RUNS, SCRIPT_BUFFER_BYTES } from '../src/agent/script-runs.ts';
import { SessionStore } from '../src/agent/session.ts';
import { ToolRuntime } from '../src/agent/registry.ts';
import { AgentBudget } from '../src/agent/tasks.ts';
import { ExecRpc } from '../src/agent/rpc.ts';
import type { AgentOptions, AgentEvent, ModelRequest, ModelTurn, ToolContext } from '../src/agent/types.ts';

const roots: string[] = [], cleanups: Array<() => Promise<unknown>> = [];
let timing: ReturnType<typeof spyOn> | undefined;
afterEach(async () => { timing?.mockRestore(); timing = undefined; for (const close of cleanups.splice(0)) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const done = (): ModelTurn => ({ text: 'done', toolCalls: [], finishReason: 'stop' });
const call = (name: string, input: unknown, id: string = crypto.randomUUID()): ModelTurn => ({ text: '', finishReason: 'tool_calls', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
const toolResults = (events: AgentEvent[]) => events.filter(e => e.type === 'tool_result').map(e => e.value as any);
async function until(check: () => boolean | Promise<boolean>, timeout = 4000) { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw new Error('Wait timeout'); await Bun.sleep(4); } }
function shortForeground() {
  const original = ScriptRunManager.prototype.wait;
  timing = spyOn(ScriptRunManager.prototype, 'wait').mockImplementation(function(this: ScriptRunManager, id, ms, signal, initial) {
    return original.call(this, id, initial ? 40 : ms, signal, initial);
  });
}
async function fixture(complete: (r: ModelRequest, signal: AbortSignal) => Promise<ModelTurn> | ModelTurn) {
  const root = await mkdtemp(join(tmpdir(), 'fab-durable-')); roots.push(root); const cwd = join(root, 'workspace'); await mkdir(cwd);
  const events: AgentEvent[] = [], controller = new AbortController();
  const options: AgentOptions = { cwd, sessionDir: join(root, 'sessions'), prompt: 'script', autonomy: 'high', signal: controller.signal,
    provider: { id: 'fixture', complete: async (r, signal) => complete(r, signal) }, onEvent: e => events.push(structuredClone(e)) };
  return { root, cwd, events, controller, options };
}
function run(f: Awaited<ReturnType<typeof fixture>>) { const work = runCodingAgent(f.options); cleanups.push(async () => { f.controller.abort(); await work; }); return work; }
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const command = (code: string) => quote(process.execPath) + ' -e ' + quote(code);
async function manager(parallel = 8) {
  const state: { backgroundScripts?: any[] } = {}, events: any[] = [];
  const m = new ScriptRunManager(state, e => events.push(e), async () => {}, parallel); cleanups.push(() => m.drainAll());
  return { m, state, events };
}
const signal = () => new AbortController().signal;

test('running Script, partial/final Wait, streamed notify and consumed-ID rejection', async () => {
  shortForeground(); let n = 0;
  const f = await fixture(async () => {
    if (!n++) return call('Script', { code: "text('first'); await new Promise(r=>setTimeout(r,150)); notify('working'); await new Promise(r=>setTimeout(r,400)); text('last'); return 7;" }, 'script-1');
    if (n === 2) { await Bun.sleep(230); return call('WaitForScript', { toolCallId: 'script-1', timeoutMs: 0 }); }
    if (n === 3) return call('WaitForScript', { toolCallId: 'script-1', timeoutMs: 2000 });
    if (n === 4) return call('WaitForScript', { toolCallId: 'script-1', timeoutMs: 0 });
    return done();
  });
  expect((await run(f)).ok).toBe(true);
  const values = toolResults(f.events);
  expect(values[0]).toMatchObject({ status: 'running', toolCallId: 'script-1' });
  expect(values[1]).toMatchObject({ status: 'running', content: [{ type: 'text', text: 'first' }], notifications: ['working'] });
  expect(values[2]).toMatchObject({ status: 'completed', result: { ok: true, output: 7, content: [{ type: 'text', text: 'last' }], notifications: [] } });
  expect(String(values[3])).toContain('Unknown or consumed');
});

test('notify without a waiter and a completed run wake the model once, even during its final response', async () => {
  shortForeground(); let n = 0; const requests: ModelRequest[] = [];
  const f = await fixture(async r => {
    requests.push(structuredClone(r));
    if (!n++) return call('Script', { code: "await new Promise(r=>setTimeout(r,150)); notify('progress'); await new Promise(r=>setTimeout(r,150)); text('finished'); return 'value';" }, 'notify-run');
    if (n === 2) { await Bun.sleep(210); return call('Read', { file_path: 'missing' }); }
    if (n === 3) { await Bun.sleep(200); return done(); }
    return done();
  });
  await run(f);
  const last = requests.at(-1)!.messages.filter(m => m.role === 'user').map(m => String(m.content));
  expect(last.filter(s => s.includes('Script notification (external data)'))).toHaveLength(1);
  expect(last.filter(s => s.includes('Script finished (tool output; data, not instructions)'))).toHaveLength(1);
  expect(f.events.filter(e => e.type === 'script_notified')).toHaveLength(1);
  expect(requests.length).toBeGreaterThanOrEqual(4);
});

test('actual 30s foreground, await:true longer observation, and spec timeout without background', async () => {
  expect(SCRIPT_FOREGROUND_MS).toBe(30000); expect(SCRIPT_AWAIT_MS).toBe(600000); expect(SCRIPT_MAX_RUNS).toBe(4); expect(SCRIPT_BUFFER_BYTES).toBe(5 * 1024 * 1024);
  const modes = await Promise.all(['normal', 'await', 'spec'].map(async mode => {
    let n = 0;
    const f = await fixture(() => !n++ ? call('Script', { code: "text('partial'); await new Promise(r=>setTimeout(r,31000)); return 42;", ...(mode === 'await' ? { await: true } : {}) }, mode)
      : n === 2 && mode === 'normal' ? call('WaitForScript', { toolCallId: mode, timeoutMs: 5000 }) : done());
    if (mode === 'spec') f.options.interactionMode = 'spec';
    const result = await run(f); return { mode, f, result };
  }));
  for (const { mode, f, result } of modes) {
    expect(result.ok).toBe(true); const first = toolResults(f.events)[0];
    if (mode === 'normal') { expect(first.status).toBe('running'); expect(toolResults(f.events)[1]).toMatchObject({ status: 'completed', result: { output: 42 } }); }
    if (mode === 'await') expect(first).toMatchObject({ ok: true, output: 42 });
    if (mode === 'spec') { expect(String(first)).toContain('timeout'); expect(f.events.some(e => e.type === 'script_started' && e.background)).toBe(false); }
  }
}, 40000);

test('unknown/foreign ID, exclusive Script selection and fifth live run fail explicitly', async () => {
  const { m } = await manager();
  await expect(m.wait('foreign', 0, signal())).rejects.toThrow('Unknown');
  for (let i = 0; i < 4; i++) m.start('r' + i, { code: 'await new Promise(r=>setTimeout(r,10000));', tools: {}, timeoutMs: 20000 });
  expect(() => m.start('fifth', { code: '1', tools: {} })).toThrow('live run limit');
  const f = await fixture(() => done());
  expect(() => listAgentTools({ ...f.options, onlyTools: ['Script', 'WaitForScript'] })).toThrow('cannot be the only');
  let n = 0; f.options.provider.complete = async () => !n++ ? call('WaitForScript', { toolCallId: 'other-session' }) : done();
  await run(f); expect(String(toolResults(f.events)[0])).toContain('Unknown');
});

test('rolling buffer drops excessive output and notifications with warning while real worker continues', async () => {
  const { m, events } = await manager();
  m.start('overflow', { code: "for(let i=0;i<80;i++) text('x'.repeat(100000)); for(let i=0;i<40;i++) notify('n'+i); return 42;", tools: {}, timeoutMs: 10000 });
  const result = await m.wait('overflow', 5000, signal(), true);
  expect(result.status).toBe('completed'); expect(result.result).toMatchObject({ ok: true, output: 42 });
  expect(result.result!.content.some(c => c.type === 'text' && c.text.includes('discarded'))).toBe(true);
  expect(result.result!.notifications.length).toBeLessThanOrEqual(20);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(SCRIPT_BUFFER_BYTES + 4096);
  expect(events.at(-1)).toMatchObject({ type: 'script_completed', status: 'completed', outputEvents: 120 });
});

test('Wait clamps excessive timeout to SCRIPT_AWAIT_MS without its own approval', async () => {
  shortForeground(); const original = ScriptRunManager.prototype.wait; const observed: number[] = [];
  timing!.mockRestore();
  timing = spyOn(ScriptRunManager.prototype, 'wait').mockImplementation(function(this: ScriptRunManager, id, ms, signal, initial) { observed.push(ms); return original.call(this, id, initial ? 40 : 0, signal, initial); });
  let n = 0, approvals = 0;
  const f = await fixture(() => !n++ ? call('Script', { code: 'await new Promise(r=>setTimeout(r,500));' }, 'clamp') : n === 2 ? call('WaitForScript', { toolCallId: 'clamp', timeoutMs: 999999999 }) : done());
  f.options.autonomy = 'off'; f.options.permissionHandler = async () => { approvals++; return 'proceed_once'; };
  await run(f); expect(observed).toContain(SCRIPT_AWAIT_MS); expect(approvals).toBe(0);
});

test('kill waits for nested Execute cleanup; no write occurs after return', async () => {
  shortForeground(); let n = 0; let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(async () => {
    if (!n++) return call('Script', { code: `return await tools.Execute({command:${JSON.stringify(command("require('fs').writeFileSync('started','yes');setTimeout(()=>require('fs').writeFileSync('late','bad'),600);setTimeout(()=>{},5000)"))}});` }, 'kill-run');
    if (n === 2) { await until(() => Bun.file(join(f.cwd, 'started')).exists()); return call('WaitForScript', { toolCallId: 'kill-run', kill: true }); }
    return done();
  });
  await run(f); expect(toolResults(f.events)[1]).toMatchObject({ status: 'killed', result: { ok: false } });
  expect(f.events.find(e => e.type === 'script_completed')).toMatchObject({ status: 'killed' });
  await Bun.sleep(750); expect(await Bun.file(join(f.cwd, 'late')).exists()).toBe(false);
});

test('abort with two live Scripts drains both and leaves no late writes, repeated three times', async () => {
  shortForeground();
  for (let repetition = 0; repetition < 3; repetition++) {
    let n = 0; let f!: Awaited<ReturnType<typeof fixture>>;
    f = await fixture(async (_r, abort) => {
      if (n < 2) { const id = ++n; return call('Script', { code: id === 1 ? `await tools.Execute({command:${JSON.stringify(command("require('fs').writeFileSync('started1','yes');setTimeout(()=>require('fs').writeFileSync('late1','bad'),600);setTimeout(()=>{},5000)"))}});` : "await new Promise(r=>setTimeout(r,600)); await tools.Create({file_path:'late2',content:'bad'});" }, 'abort-' + id); }
      await until(() => Bun.file(join(f.cwd, 'started1')).exists()); f.controller.abort(new Error('abort tests')); abort.throwIfAborted(); return done();
    });
    const result = await run(f);
    expect(result.error?.type).toBe('aborted');
    expect(f.events.filter(e => e.type === 'script_completed').map(e => e.status)).toEqual(['cancelled', 'cancelled']);
    await Bun.sleep(750);
    expect(await Bun.file(join(f.cwd, 'late1')).exists()).toBe(false); expect(await Bun.file(join(f.cwd, 'late2')).exists()).toBe(false);
  }
}, 10000);

test('completed output persists on close, resume marks running snapshots cancelled and reads output once', async () => {
  shortForeground(); let n = 0;
  const f = await fixture(async () => !n++ ? call('Script', { code: "text('persisted'); await new Promise(r=>setTimeout(r,10000));" }, 'persist') : (await Bun.sleep(50), done()));
  const first = await run(f), path = join(f.options.sessionDir!, first.sessionId + '.json');
  const snapshot = JSON.parse(await readFile(path, 'utf8'));
  expect(snapshot.backgroundScripts[0]).toMatchObject({ toolCallId: 'persist', status: 'cancelled', content: [{ type: 'text', text: 'persisted' }] });
  const { m, state } = await manager(); await m.drainAll();
  const record = structuredClone(snapshot.backgroundScripts[0]); record.status = 'running';
  const restoredState = { backgroundScripts: [record] };
  const restored = new ScriptRunManager(restoredState, () => {}, async () => {}, 1); cleanups.push(() => restored.drainAll());
  expect(restoredState.backgroundScripts[0]!.status).toBe('cancelled'); expect(restored.takeCompletedForModel()).toEqual([]);
  expect(await restored.wait('persist', 0, signal())).toMatchObject({ status: 'cancelled', result: { content: [{ type: 'text', text: 'persisted' }] } });
  let resumedTurn = 0; f.options.sessionId = first.sessionId; f.options.provider.complete = async () => !resumedTurn++ ? call('WaitForScript', { toolCallId: 'persist', timeoutMs: 0 }) : done(); f.events.length = 0;
  await run(f); expect(toolResults(f.events)[0]).toMatchObject({ status: 'cancelled', result: { content: [{ type: 'text', text: 'persisted' }] } });
});

test('maxToolConcurrency one lends its Script slot to nested calls and blocks unrelated work until free', async () => {
  shortForeground(); const f = await fixture(() => done());
  const context: ToolContext = { cwd: f.cwd, signal: f.controller.signal, autonomy: 'high', interactionMode: 'auto', sandbox: 'required' };
  const runtime = new ToolRuntime(f.options, context, { depth: 0, budget: new AgentBudget(8, 256) }, { parallel: 1, maxDepth: 2, agentConcurrency: 2 }, () => { throw new Error('No child'); });
  cleanups.push(() => runtime.close());
  const start = await runtime.dispatch('Script', { code: "await new Promise(r=>setTimeout(r,150)); const r=await tools.Read({file_path:'missing'}).catch(()=>null); await new Promise(r=>setTimeout(r,150)); return 42;" }, { id: 'slot', type: 'function', function: { name: 'Script', arguments: '{}' } }) as any;
  expect(start.status).toBe('running'); let finished = false;
  const direct = runtime.dispatch('LS', {}).then(() => { finished = true; });
  await Bun.sleep(50); expect(finished).toBe(false);
  expect(await runtime.dispatch('WaitForScript', { toolCallId: 'slot', timeoutMs: 3000 })).toMatchObject({ status: 'completed', result: { output: 42 } });
  await direct; expect(finished).toBe(true);
});

test('RPC close_session drains two live Scripts and their nested commands', async () => {
  shortForeground(); let n = 0, modelWaiting = false; const f = await fixture(() => done()), frames: any[] = [];
  f.options.provider.complete = async (_r, sig) => {
    if (n < 2) { const id = ++n; return call('Script', { code: id === 1 ? `await tools.Execute({command:${JSON.stringify(command("require('fs').writeFileSync('rpc-start1','yes');setTimeout(()=>require('fs').writeFileSync('rpc-late1','bad'),600);setTimeout(()=>{},5000)"))}});` : "await new Promise(r=>setTimeout(r,600)); await tools.Create({file_path:'rpc-late2',content:'bad'});" }, 'rpc-' + id); }
    modelWaiting = true;
    return new Promise((_, reject) => { sig.addEventListener('abort', () => reject(sig.reason), { once: true }); });
  };
  const rpc = new ExecRpc({ cwd: f.cwd, sessionDir: f.options.sessionDir!, providers: { fixture: f.options.provider }, defaultModelId: 'fixture' }, frame => frames.push(frame));
  cleanups.push(() => rpc.shutdown());
  const request = (id: string, method: string, params = {}) => ({ jsonrpc: '2.0', type: 'request', id, method: 'droid.' + method, params });
  await rpc.accept(request('init', 'initialize_session', { machineId: 'local', modelId: 'fixture', autonomyLevel: 'high' }));
  await rpc.accept(request('message', 'add_user_message', { text: 'start scripts' }));
  await until(async () => modelWaiting && await Bun.file(join(f.cwd, 'rpc-start1')).exists());
  await rpc.accept(request('close', 'close_session'));
  expect(rpc.closed).toBe(true); expect(frames.find(x => x.id === 'close')).toMatchObject({ result: {} });
  const id = frames.find(x => x.id === 'init').result.sessionId, store = await SessionStore.create(f.options.sessionDir);
  const snapshot = await store.inspect(id); await store.close();
  expect(snapshot.backgroundScripts!.map(r => r.status)).toEqual(['cancelled', 'cancelled']);
  await Bun.sleep(750); expect(await Bun.file(join(f.cwd, 'rpc-late1')).exists()).toBe(false); expect(await Bun.file(join(f.cwd, 'rpc-late2')).exists()).toBe(false);
});

test('background callbacks keep launch-time autonomy, network and mission observation after host context changes', async () => {
  shortForeground(); const f = await fixture(() => done()); let observed = false, approvals = 0;
  const context: ToolContext = { cwd: f.cwd, signal: f.controller.signal, autonomy: 'low', interactionMode: 'auto', sandbox: 'required', networkPolicy: 'deny' };
  f.options.permissionHandler = async () => { approvals++; return 'cancel'; };
  f.options.missionWorker = { directory: f.root, featureId: 'one', sealed: () => false, submit: async () => ({}), observe: name => { if (name === 'Execute') observed = true; } };
  const runtime = new ToolRuntime(f.options, context, { depth: 0, budget: new AgentBudget(8, 256) }, { parallel: 2, maxDepth: 2, agentConcurrency: 2 }, () => { throw new Error('No child'); });
  cleanups.push(() => runtime.close());
  await runtime.dispatch('Script', { code: "await new Promise(r=>setTimeout(r,150)); try { await tools.Execute({command:'echo denied'}); } catch(e) { text(String(e)); } try { await tools.Execute({command:'echo no',network:true}); } catch(e) { text(String(e)); } return 42;" }, { id: 'policy', type: 'function', function: { name: 'Script', arguments: '{}' } });
  context.autonomy = 'high'; context.networkPolicy = 'auto';
  const result = await runtime.dispatch('WaitForScript', { toolCallId: 'policy', timeoutMs: 2000 }) as any;
  expect(result).toMatchObject({ status: 'completed', result: { output: 42 } });
  expect(JSON.stringify(result.result.content)).toContain('network access denied'); expect(JSON.stringify(result.result.content)).toContain('cancelled'); expect(approvals).toBe(1);
  // Observers record executed calls; a denial before dispatch never grants evidence.
  expect(observed).toBe(false);
});

test('Script calls use mission observation and per-call approval with maxToolConcurrency one', async () => {
  const f = await fixture(() => done()); let n = 0, approvals = 0; const observed: string[] = [];
  f.options.autonomy = 'off'; f.options.maxToolConcurrency = 1;
  f.options.permissionHandler = async () => { approvals++; return 'proceed_once'; };
  f.options.missionWorker = { directory: f.root, featureId: 'one', sealed: () => false, submit: async () => ({}), observe: name => observed.push(name) };
  f.options.provider.complete = async () => !n++ ? call('Script', { code: "return await tools.Execute({command:'echo evidence'});" }) : done();
  expect((await run(f)).ok).toBe(true); expect(approvals).toBe(1); expect(observed).toContain('Execute');
  expect(toolResults(f.events)[0]).toMatchObject({ ok: true, output: { exitCode: 0 } });
});

test('a failed Script persistence write cannot skip draining background Execute processes', async () => {
  const f = await fixture(() => done());
  const context: ToolContext = { cwd: f.cwd, signal: f.controller.signal, autonomy: 'high', interactionMode: 'auto', sandbox: 'required' };
  const runtime = new ToolRuntime(f.options, context, { depth: 0, budget: new AgentBudget(8, 256) }, { parallel: 2, maxDepth: 2, agentConcurrency: 2 }, () => { throw new Error('No child'); }, {}, async () => { throw new Error('snapshot write failed'); });
  cleanups.push(() => runtime.close().catch(() => {}));
  await runtime.dispatch('Execute', { background: true, command: command("require('fs').writeFileSync('saved-start','yes');setTimeout(()=>require('fs').writeFileSync('saved-late','bad'),600);setTimeout(()=>{},5000)") });
  await until(() => Bun.file(join(f.cwd, 'saved-start')).exists());
  await expect(runtime.close()).rejects.toThrow('snapshot write failed');
  await Bun.sleep(750); expect(await Bun.file(join(f.cwd, 'saved-late')).exists()).toBe(false);
});

test('registry permits discovery alongside Script and bounds combined content/result consistently', async () => {
  const f = await fixture(() => done());
  expect(listAgentTools({ ...f.options, onlyTools: ['Script', 'WaitForScript', 'ToolSearch'] }).map(t => t.schema.function.name)).toContain('ToolSearch');
  const { m, events } = await manager();
  m.start('combined', { code: "text('x'.repeat(3000000)); return 'y'.repeat(3000000);", tools: {}, timeoutMs: 10000 });
  const result = await m.wait('combined', 5000, signal(), true);
  expect(result).toMatchObject({ status: 'failed', result: { ok: false, error: { origin: 'output_limit' } } });
  expect(events.at(-1)).toMatchObject({ status: 'failed' });
});

test('runtime error cancels a callback reclaiming its slot even when another VM owns it', async () => {
  const { m } = await manager(1); let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  m.start('broken', { code: "tools.Slow({}); throw new Error('broken');", tools: { Slow: async (_v, c) => m.callback('broken', c.signal, async () => {
    entered(); await new Promise<void>(resolve => { c.signal.addEventListener('abort', () => setTimeout(resolve, 30), { once: true }); if (c.signal.aborted) resolve(); });
  }) }, timeoutMs: 5000 });
  await started;
  m.start('other', { code: 'await new Promise(r=>setTimeout(r,2000));', tools: {}, timeoutMs: 5000 });
  const start = Date.now(), failed = await m.wait('broken', 500, signal(), true);
  expect(failed).toMatchObject({ status: 'failed', result: { ok: false } }); expect(Date.now() - start).toBeLessThan(1000);
});

test('fifth Script is rejected through the engine independently of Execute process budget', async () => {
  shortForeground(); let n = 0;
  const f = await fixture(() => ++n <= 5 ? call('Script', { code: 'await new Promise(r=>setTimeout(r,10000));' }, 'live-' + n) : done());
  f.options.maxBackgroundProcesses = 1;
  expect((await run(f)).ok).toBe(true);
  const results = toolResults(f.events);
  expect(results.slice(0, 4).every(v => v.status === 'running')).toBe(true);
  expect(String(results[4])).toContain('live run limit');
  expect(f.events.filter(e => e.type === 'script_completed' && e.status === 'cancelled')).toHaveLength(4);
});

test('kill cancels a nested policy wait and a later approval never executes the command', async () => {
  shortForeground(); let release!: (v: boolean) => void, reached = false, n = 0;
  const policy = new Promise<boolean>(resolve => { release = resolve; });
  const f = await fixture(async () => {
    if (!n++) return call('Script', { code: "await tools.Execute({command:'touch forbidden'});" }, 'policy-kill');
    if (n === 2) { await until(() => reached); return call('WaitForScript', { toolCallId: 'policy-kill', kill: true }); }
    return done();
  });
  f.options.beforeTool = async call => { if (call.function.name === 'Execute') { reached = true; return policy; } return true; };
  expect((await run(f)).ok).toBe(true);
  expect(toolResults(f.events)[1]).toMatchObject({ status: 'killed' });
  release(true); await Bun.sleep(50);
  expect(await Bun.file(join(f.cwd, 'forbidden')).exists()).toBe(false);
});

test('agent transports retained Script content above the old 256 KiB result cap', async () => {
  shortForeground(); let n = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(() => !n++ ? call('Script', { code: "await tools.Gate({}); text('z'.repeat(400000)); return 42;" }, 'large')
    : n === 2 ? call('WaitForScript', { toolCallId: 'large', timeoutMs: 3000 }) : done());
  f.options.tools = [{ effect: 'read', schema: { type: 'function', function: { name: 'Gate', description: 'Test barrier', parameters: { type: 'object', properties: {} } } },
    run: (_input, c) => new Promise((resolve, reject) => { gate.then(resolve, reject); c.signal.addEventListener('abort', () => reject(c.signal.reason), { once: true }); }) }];
  f.options.onEvent = event => { f.events.push(structuredClone(event)); if (event.type === 'tool_call' && event.toolName === 'WaitForScript') release(); };
  f.options.maxContextTokens = 1000000;
  expect((await run(f)).ok).toBe(true);
  const result = toolResults(f.events).at(-1).result;
  expect(result).toMatchObject({ ok: true, output: 42 });
  expect(result.content[0].text.length).toBe(400000);
});

test('kill cancels an unstarted scheduler callback without waiting for an unrelated writer', async () => {
  shortForeground(); const f = await fixture(() => done());
  const context: ToolContext = { cwd: f.cwd, signal: f.controller.signal, autonomy: 'high', interactionMode: 'auto', sandbox: 'required' };
  const runtime = new ToolRuntime(f.options, context, { depth: 0, budget: new AgentBudget(8, 256) }, { parallel: 2, maxDepth: 2, agentConcurrency: 2 }, () => { throw new Error('No child'); });
  cleanups.push(() => runtime.close());
  const writer = runtime.dispatch('Execute', { command: command("require('fs').writeFileSync('writer-start','yes');setTimeout(()=>{},3000)") }).catch(() => {});
  cleanups.push(async () => { f.controller.abort(); await writer; });
  await until(() => Bun.file(join(f.cwd, 'writer-start')).exists());
  const started = await runtime.dispatch('Script', { code: "await tools.Create({file_path:'queued-forbidden',content:'bad'});" }, { id: 'queued', type: 'function', function: { name: 'Script', arguments: '{}' } }) as any;
  expect(started.status).toBe('running'); const time = Date.now();
  expect(await runtime.dispatch('WaitForScript', { toolCallId: 'queued', kill: true })).toMatchObject({ status: 'killed' });
  expect(Date.now() - time).toBeLessThan(1000);
  f.controller.abort(); await writer; await Bun.sleep(30);
  expect(await Bun.file(join(f.cwd, 'queued-forbidden')).exists()).toBe(false);
});

test('kill cancels TaskOutput observation while its unrelated background process remains owned', async () => {
  shortForeground(); const f = await fixture(() => done());
  const context: ToolContext = { cwd: f.cwd, signal: f.controller.signal, autonomy: 'high', interactionMode: 'auto', sandbox: 'required' };
  const runtime = new ToolRuntime(f.options, context, { depth: 0, budget: new AgentBudget(8, 256) }, { parallel: 1, maxDepth: 2, agentConcurrency: 2 }, () => { throw new Error('No child'); });
  cleanups.push(() => runtime.close());
  const process = await runtime.dispatch('Execute', { command: 'sleep 3', background: true }) as any;
  await runtime.dispatch('Script', { code: `await tools.TaskOutput({task_id:${JSON.stringify(process.taskId)}});` }, { id: 'observe', type: 'function', function: { name: 'Script', arguments: '{}' } });
  const time = Date.now();
  expect(await runtime.dispatch('WaitForScript', { toolCallId: 'observe', kill: true })).toMatchObject({ status: 'killed' });
  expect(Date.now() - time).toBeLessThan(1000);
  const tasks = await runtime.dispatch('ListAgents', {}) as any[];
  expect(tasks.find(t => t.taskId === process.taskId || t.task_id === process.taskId).status).toBe('running');
});
