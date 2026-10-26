import { afterEach, expect, test } from 'bun:test';
import { writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { configuredProviders, loadExecSettings, type ExecSettings } from '../src/agent/settings.ts';
import { configuredOmni, prepareOmniSettings, withOmniTimeout } from '../src/agent/omni/runtime.ts';
import { createRoutedProvider } from '../src/agent/providers/router.ts';
import { createAutoProvider } from '../src/agent/providers/auto.ts';
import { createOmniProvider } from '../src/agent/providers/omni.ts';
import { createOmniScheduler } from '../src/agent/omni/scheduler.ts';
import { eligibleProfiles } from '../src/agent/omni/policy.ts';
import { MissionRunControl } from '../src/agent/mission-pause.ts';
import { SessionStore } from '../src/agent/session.ts';
import { runCodingAgent } from '../src/agent/engine.ts';
import { buildProviders, parseExecArgs } from '../src/agent/exec-flags.ts';
import { ExecRpc } from '../src/agent/rpc.ts';
import type { AgentEvent, ModelRequest } from '../src/agent/types.ts';
import { cli, done, failure, fakeClock, mcp, profile, request, settings, temp, tools } from './fixtures/omni-integration/harness.ts';

const roots: string[] = [], servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => { for (const s of servers.splice(0)) s.stop(true); for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });
function serve(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch }); servers.push(server); return server;
}
const configured = (s: ExecSettings) => configuredProviders(s, { model: 'omni' }).providers.omni!;
const signal = () => new AbortController().signal;

// This is the real CLI + settings + A/B/C + generic HTTP decoder + engine + MCP dispatcher.
test('ROT-01 429 then quota then tool turn; TOS-01 avoid is never contacted; SEC-01 routing logs redact secrets', async () => {
  const cwd = await temp(roots); const calls: string[] = [], authorizations: string[] = []; let executions = 0;
  const server = serve(async req => {
    const body = await req.json() as any;
    if (new URL(req.url).pathname === '/mcp') return mcp(body, () => { executions++; });
    calls.push(body.model); authorizations.push(req.headers.get('authorization') ?? '');
    if (body.model === 'a') return failure(429, 'rate_limit_exceeded', '3600');
    if (body.model === 'b') return failure(429, 'insufficient_quota', '1');
    expect(body.tools.some((t: any) => t.function.name === 'remote___fixture')).toBe(true);
    return body.messages.some((m: any) => m.role === 'tool') ? done() : tools('remote___fixture');
  });
  const config = settings(server.url.href, [profile('avoid', 0, { providerId: 'antigravity' }), profile('incapable', 0, { supportsTools: false }),
    profile('paid', 0, { costTier: 'paid' }), profile('a', 1), profile('b', 2), profile('c', 3)]);
  for (const model of config.customModels!) model.apiKey = '${OMNI_' + model.id.toUpperCase() + '}';
  config.mcpServers = { remote: { url: server.url.href + 'mcp', readOnlyTools: ['fixture'] } };
  const result = await cli(cwd, config, { OMNI_A: 'KEY_A_SECRET_SENTINEL', OMNI_B: 'KEY_B_SECRET_SENTINEL', OMNI_C: 'KEY_C_SECRET_SENTINEL' }, ['--only-tools', 'remote___fixture']);
  expect(result.code).toBe(0); expect(result.err).toBe(''); expect(calls).toEqual(['a', 'b', 'c', 'c']); expect(executions).toBe(1);
  expect(authorizations).toEqual(['Bearer KEY_A_SECRET_SENTINEL', 'Bearer KEY_B_SECRET_SENTINEL', 'Bearer KEY_C_SECRET_SENTINEL', 'Bearer KEY_C_SECRET_SENTINEL']);
  const routed = result.events.filter(e => e.type === 'model_routed');
  expect(routed.map(e => e.to)).toEqual(['a', 'b', 'c', 'c']);
  const completed = result.events.find(e => e.type === 'result');
  expect(completed).toBeDefined(); expect(result.out).toContain('STATUS: done');
  expect(new Set(routed.map(e => e.sessionId)).size).toBe(1); expect(routed[0].sessionId).toBeTruthy();
  for (const secret of ['KEY_A_SECRET_SENTINEL', 'KEY_B_SECRET_SENTINEL', 'KEY_C_SECRET_SENTINEL', 'BODY_SECRET_SENTINEL', 'HEADER_SECRET_SENTINEL']) {
    expect(result.out + result.err).not.toContain(secret);
  }
});

test('settings keep Omni ENV references lazy and aliases resolve to the virtual provider', async () => {
  const cwd = await temp(roots), path = join(cwd, 'settings.json');
  const s = settings('http://127.0.0.1:1/', [profile('a', 1), profile('missing', 2)]);
  s.customModels![1]!.apiKey = '${OMNI_MISSING_INTEGRATION_KEY}';
  s.modelAliases = { routed: 'omni', leaf: 'a' }; s.modelId = 'routed'; s.omniRouter!.profiles = [profile('leaf', 1), profile('missing', 2)];
  await writeFile(path, JSON.stringify(s));
  const loaded = await loadExecSettings(path);
  expect(loaded.customModels![1]!.apiKey).toBe('${OMNI_MISSING_INTEGRATION_KEY}');
  expect(loaded.omniRouter!.profiles[0]!.modelId).toBe('a');
  const built = configuredProviders(loaded, { model: 'omni' });
  expect(built.providers.routed).toBe(built.providers.omni); expect(built.defaultModelId).toBe('routed');
  expect(JSON.stringify(loaded)).not.toContain('Bearer');
});

test('COMPAT-01 legacy routers keep behavior: mixed chains and missing Omni config fail before HTTP', async () => {
  let calls = 0; const server = serve(() => { calls++; return done(); });
  for (const mixed of [{ autoRouter: { candidates: [] } }, { modelRouting: { a: { fallback: ['omni'] } } }, { modelRouting: {} }]) {
    const s = { ...settings(server.url.href), ...mixed } as ExecSettings;
    expect(() => configured(s)).toThrow('cannot be combined');
    const cwd = await temp(roots), path = join(cwd, 'settings.json'); await writeFile(path, JSON.stringify(s));
    await expect(loadExecSettings(path)).rejects.toThrow('cannot be combined');
  }
  expect(() => configuredProviders({ modelId: 'omni' }, { model: 'omni' })).toThrow('requires an omniRouter');
  expect(() => configured({ ...settings(server.url.href), modelAliases: { omni: 'a' } })).toThrow('reserved');
  const shadow = settings(server.url.href); shadow.customModels![0]!.id = 'omni'; expect(() => configured(shadow)).toThrow('reserved');
  expect(calls).toBe(0);
});

test('QUOTA-01 keys share quota group and runtime across mission/spec roles; SESSION-01 distinct facades', async () => {
  const calls: string[] = []; const server = serve(async req => { const b = await req.json() as any; calls.push(b.model); return b.model === 'a' ? failure(429, 'insufficient_quota', '1') : done(); });
  const s = settings(server.url.href, [profile('a', 1, { quotaGroup: 'shared' }), profile('a2', 2, { quotaGroup: 'shared' }), profile('b', 3)]);
  const { v } = parseExecArgs(['--mission', '--model', 'omni', '--worker-model', 'omni', '--validator-model', 'omni']);
  const built = buildProviders(v, s);
  await built.provider.complete(request, signal());
  await built.mission!.workerProvider!.complete(request, signal());
  await built.mission!.validatorProvider!.complete(request, signal());
  expect(calls).toEqual(['a', 'b', 'b', 'b']);
  expect(built.provider).not.toBe(built.mission!.workerProvider);
  const spec = buildProviders(parseExecArgs(['--use-spec', '--model', 'omni', '--spec-model', 'omni']).v, s);
  await spec.provider.complete(request, signal()); await spec.specProvider!.complete(request, signal());
  expect(calls.slice(4)).toEqual(['a', 'b', 'b']); expect(spec.provider).not.toBe(spec.specProvider);
});

test('TIME-01 server reset is not shortened across turns (HTTP metadata bridge, no real sleep)', async () => {
  const calls: string[] = []; const clock = fakeClock();
  const server = serve(async req => { const b = await req.json() as any; calls.push(b.model); return b.model === 'a' ? failure(429, undefined, '3600') : done(); });
  const s = settings(server.url.href, [profile('a', 1), profile('b', 2)]);
  const config = prepareOmniSettings(s, id => id)!;
  const built = configuredOmni(s, config, undefined, undefined, clock);
  await built.provider.complete(request, signal()); clock.advance(120001); await built.provider.complete(request, signal());
  expect(calls).toEqual(['a', 'b', 'b']); expect(clock.waits).toEqual([]);
});

test('PAY-01 paid requires opt in and empty pool never expands', async () => {
  const calls: string[] = []; const server = serve(async req => { const b = await req.json() as any; calls.push(b.model); return b.model === 'a' ? failure(402) : done(); });
  const s = settings(server.url.href, [profile('a', 1), profile('paid', 2, { costTier: 'paid' })]);
  await expect(configured(s).complete(request, signal())).rejects.toThrow('Omni routing exhausted'); expect(calls).toEqual(['a']);
  s.omniRouter!.allowPaid = true;
  await configured(s).complete(request, signal()); expect(calls).toEqual(['a', 'a', 'paid']);
});

test('TIME-02 per-attempt timeout rotates, caller abort does not, and callbacks cannot publish late deltas', async () => {
  let calls = 0, aborted = false;
  const timed = withOmniTimeout({ id: 'fixture', complete: async (_r, s, delta) => {
    calls++; await new Promise<void>(resolve => s.addEventListener('abort', () => { aborted = true; delta?.('late'); resolve(); }, { once: true }));
    throw s.reason;
  } }, 5);
  const chunks: string[] = [];
  await expect(timed.complete(request, signal(), s => chunks.push(s))).rejects.toThrow('timed out');
  expect(aborted).toBe(true); expect(chunks).toEqual([]); expect(calls).toBe(1);
  const controller = new AbortController(), reason = new Error('caller cancelled');
  const work = timed.complete(request, controller.signal); controller.abort(reason);
  await expect(work).rejects.toBe(reason);
  const order: string[] = [];
  const server = serve(async req => { const b = await req.json() as any; order.push(b.model); return b.model === 'a' ? new Promise<Response>(() => {}) : done(); });
  const s = settings(server.url.href, [profile('a', 1), profile('b', 2)]); s.omniRouter!.requestTimeoutMs = 30;
  await configured(s).complete(request, signal()); expect(order).toEqual(['a', 'b']);
});

for (const malformed of ['partial-text', 'partial-tools', 'invalid-json', 'invalid-arguments', 'invalid-finish']) {
  test(`STREAM-01 / TOOL-01 real decoder rejects ${malformed} without executing a partial tool`, async () => {
    const cwd = await temp(roots), calls: string[] = []; let executions = 0;
    const server = serve(async req => {
      const b = await req.json() as any;
      if (new URL(req.url).pathname === '/mcp') return mcp(b, () => { executions++; });
      calls.push(b.model);
      if (b.messages.some((m: any) => m.role === 'tool')) return done();
      if (malformed === 'invalid-json') return new Response('{invalid', { headers: { 'content-type': 'application/json' } });
      if (malformed === 'invalid-arguments') return tools('remote___fixture', '{invalid');
      if (malformed === 'invalid-finish') return Response.json({ choices: [{ message: { content: 'fixture' }, finish_reason: 'network timeout' }] });
      const delta = malformed === 'partial-text' ? { content: 'partial' } : { tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'remote___fixture', arguments: '{' } }] };
      return new Response('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\ndata: {invalid}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    const s = settings(server.url.href, [profile('a', 1), profile('b', 2)]);
    s.mcpServers = { remote: { url: server.url.href + 'mcp', readOnlyTools: ['fixture'] } };
    const result = await cli(cwd, s, {}, ['--only-tools', 'remote___fixture']);
    expect(executions).toBe(0); expect(calls.every(id => id === 'a')).toBe(true);
    if (malformed !== 'invalid-arguments') { expect(result.code).toBe(1); expect(calls).toEqual(['a']); }
  });
}

test('ERR-01 refusal does not rotate; 401 disables account and a different account can serve', async () => {
  let status = 403; const calls: string[] = [];
  const server = serve(async req => { const b = await req.json() as any; calls.push(b.model); return b.model === 'a' ? failure(status) : done(); });
  const s = settings(server.url.href, [profile('a', 1), profile('a2', 2, { accountId: 'a' }), profile('b', 3)]);
  await expect(configured(s).complete(request, signal())).rejects.toThrow('terminally'); expect(calls).toEqual(['a']);
  status = 401; await configured(s).complete(request, signal()); expect(calls).toEqual(['a', 'a', 'b']);
});

test('SEC-01 invalid URL and key errors redact secrets; duplicate credentials cannot create new quota', async () => {
  const s = settings('https://user:URL_SECRET_SENTINEL@/');
  expect(() => configured(s)).toThrow('invalid baseUrl');
  try { configured(s); } catch (error) { expect(String(error)).not.toContain('URL_SECRET_SENTINEL'); }
  const server = serve(() => done()); const valid = settings(server.url.href);
  valid.customModels![0]!.apiKey = 'LITERAL_SECRET_SENTINEL';
  try { configured(valid); throw new Error('must reject'); } catch (error) { expect(String(error)).toContain('literal keys are prohibited'); expect(String(error)).not.toContain('LITERAL_SECRET_SENTINEL'); }
  for (const model of valid.customModels!) model.apiKey = '${OMNI_SAME_KEY}';
  expect(() => configured(valid)).toThrow('must share accountId and quotaGroup');
});

test('event failure and elapsed deadline release leases without dispatch; attempted identity remains stable', async () => {
  const clock = fakeClock(); const s = settings('http://127.0.0.1:1/', [profile('a', 1)]); const config = s.omniRouter!;
  const scheduler = createOmniScheduler(config, { clock, eligible: eligibleProfiles }); let calls = 0;
  const base = { scheduler, clock, estimateRequest: () => ({ tools: false, images: false, estimatedInputTokens: 1, maxOutputTokens: 1 }),
    resolveLeaf: async () => ({ id: 'a', async complete() { calls++; return { text: 'done', toolCalls: [], finishReason: 'stop' }; } }) };
  const failure = new Error('event callback failed');
  const provider = createOmniProvider(config, { ...base, emit: () => { throw failure; } });
  await expect(provider.complete(request, signal())).rejects.toBe(failure); expect(scheduler.diagnose()[0]!.inFlight).toBe(0);
  const late = createOmniProvider(config, { ...base, async resolveLeaf(...args) { clock.advance(4001); return base.resolveLeaf(); } });
  await expect(late.complete(request, signal())).rejects.toThrow('exhausted');
  expect(calls).toBe(0); expect(scheduler.diagnose()[0]!.inFlight).toBe(0);
});

test('SESSION-01 subagent routing stays scoped through real engine and shared quota health', async () => {
  const cwd = await temp(roots, true); let parentTurns = 0; const events: AgentEvent[] = [], calls: string[] = [];
  const server = serve(async req => {
    const b = await req.json() as any; calls.push(b.model);
    if (b.model === 'a') return failure(402);
    const workspace = /^Workspace: (.+)$/m.exec(b.messages[1].content)?.[1];
    if (workspace === cwd && !parentTurns++) return tools('Task', JSON.stringify({ prompt: 'read-only child response' }));
    if (workspace !== cwd && workspace) roots.push(dirname(workspace));
    return done('STATUS: complete');
  });
  const s = settings(server.url.href, [profile('a', 1), profile('b', 2)]);
  const result = await runCodingAgent({ cwd, prompt: 'delegate once', provider: configured(s), autonomy: 'medium', onEvent: e => events.push(e) });
  expect(result.ok).toBe(true); expect(calls).toEqual(['a', 'b', 'b', 'b']);
  const routed = events.filter(e => e.type === 'model_routed');
  const child = routed.find(e => e.sessionId !== result.sessionId)!;
  expect(child).toBeDefined(); expect(child.sessionId).toBeTruthy(); expect(child.agentId).toBeTruthy();
  expect(routed.filter(e => e.sessionId === result.sessionId).map(e => e.to)).toEqual(['a', 'b', 'b']);
  expect(events.filter(e => e.sessionId === child.sessionId).every(e => e.type === 'model_routed')).toBe(true);
});

test('RPC lists virtual Omni and transports safe routing fields', async () => {
  const cwd = await temp(roots), frames: any[] = []; const server = serve(() => done());
  const built = configuredProviders(settings(server.url.href), { model: 'omni' });
  const rpc = new ExecRpc({ cwd, sessionDir: join(cwd, 'sessions'), ...built }, frame => frames.push(frame));
  try {
    await rpc.accept({ jsonrpc: '2.0', type: 'request', id: 'initialize', method: 'droid.initialize_session', params: { machineId: 'fixture' } });
    const models = frames.find(frame => frame.id === 'initialize').result.availableModels;
    expect(models.find((m: any) => m.id === 'omni').modelProvider).toBe('omni');
    await rpc.accept({ jsonrpc: '2.0', type: 'request', id: 'message', method: 'droid.add_user_message', params: { text: 'fixture' } });
    const deadline = Date.now() + 2000;
    while (!frames.some(frame => frame.params?.notification?.type === 'agent_turn_completed')) {
      if (Date.now() > deadline) throw new Error('RPC fixture timed out');
      await Bun.sleep(2);
    }
    const routed = frames.find(frame => frame.params?.notification?.type === 'fab_model_routed');
    expect(routed.params.notification).toMatchObject({ from: 'omni', to: 'a', reason: 'selection' });
    expect(routed.params.sessionId).toBeTruthy();
  } finally { await rpc.shutdown(); }
});

test('role reasoning overrides preserve shared quota state without sharing adapter options', async () => {
  const calls: Array<[string, string]> = [];
  const server = serve(async req => { const b = await req.json() as any; calls.push([b.model, b.reasoning_effort]); return b.model === 'a' ? failure(402) : done(); });
  const s = settings(server.url.href, [profile('a', 1), profile('b', 2)]);
  const built = buildProviders(parseExecArgs(['--mission', '--model', 'omni', '-r', 'low', '--worker-model', 'omni', '--worker-reasoning-effort', 'high']).v, s);
  await built.provider.complete(request, signal()); await built.mission!.workerProvider!.complete(request, signal());
  expect(calls).toEqual([['a', 'low'], ['b', 'low'], ['b', 'high']]);
});

test('private profile leaves cannot bypass ToS, payment, leases or cooldown via aliases or explicit selection', () => {
  const s = settings('http://127.0.0.1:1/', [profile('paid', 1, { costTier: 'paid' }), profile('avoid', 2, { tos: 'avoid' })]);
  s.modelAliases = { bypass: 'avoid' };
  const built = configuredProviders(s, { model: 'omni' });
  expect(Object.keys(built.providers)).toEqual(['omni']);
  for (const modelId of ['paid', 'avoid', 'bypass']) expect(() => configuredProviders({ ...s, modelId }, { model: 'omni' })).toThrow('profile leaves are private');
});

test('unknown SSE error is terminal even before output; overflowing Retry-After never permits an early retry', async () => {
  const calls: string[] = [];
  const server = serve(async req => {
    const b = await req.json() as any; calls.push(b.model);
    return new Response('data: {"error":{"code":"content_policy_violation","message":"refused"}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  await expect(configured(settings(server.url.href)).complete(request, signal())).rejects.toThrow('terminally'); expect(calls).toEqual(['a']);
  const { retryAtFromHeader } = await import('../src/agent/providers/http-failure.ts');
  for (const value of ['1e999', '9'.repeat(400)]) expect(retryAtFromHeader(value, 1000)).toBe(Number.MAX_SAFE_INTEGER);
});

test('unavailable keys skip accounts without spending the HTTP attempt budget', async () => {
  const cwd = await temp(roots), calls: string[] = [];
  const server = serve(async req => { const b = await req.json() as any; calls.push(b.model); return done(); });
  const s = settings(server.url.href, [profile('missing', 1), profile('available', 2)]);
  s.customModels![0]!.apiKey = '${OMNI_MISSING_INTEGRATION_KEY}'; s.omniRouter!.maxAttempts = 1;
  const result = await cli(cwd, s);
  expect(result.code).toBe(0); expect(calls).toEqual(['available']);
});

test('equal keys from different ENV references cannot multiply quota', async () => {
  const cwd = await temp(roots), calls: string[] = [];
  const server = serve(async req => { const b = await req.json() as any; calls.push(b.model); return b.model === 'a' ? failure(402) : done(); });
  const s = settings(server.url.href);
  s.customModels![0]!.apiKey = '${OMNI_KEY_ONE}'; s.customModels![1]!.apiKey = '${OMNI_KEY_TWO}';
  const result = await cli(cwd, s, { OMNI_KEY_ONE: 'SAME_KEY_SECRET_SENTINEL', OMNI_KEY_TWO: 'SAME_KEY_SECRET_SENTINEL' });
  expect(result.code).toBe(0); expect(calls).toEqual(['a', 'c']); expect(result.out + result.err).not.toContain('SAME_KEY_SECRET_SENTINEL');
});

test('CAP-01 unknown image token cost and incapable models fail before HTTP', async () => {
  let calls = 0; const server = serve(() => { calls++; return done(); });
  const s = settings(server.url.href, [profile('a', 1, { supportsImages: true, supportsTools: false })]);
  const provider = configured(s);
  const withTools: ModelRequest = { ...request, tools: [{ type: 'function', function: { name: 'fixture', description: '', parameters: {} } }] };
  await expect(provider.complete(withTools, signal())).rejects.toThrow('exhausted');
  const withImage: ModelRequest = { ...request, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }] }] };
  await expect(provider.complete(withImage, signal())).rejects.toThrow('exhausted'); expect(calls).toBe(0);
});


test('COMPAT-01 SDK static/auto composition is rejected before any upstream call', () => {
  let calls = 0;
  const ordinary = { id: 'ordinary', async complete() { calls++; return { text: 'done', toolCalls: [], finishReason: 'stop' }; } };
  const omni = configured(settings('http://127.0.0.1:1/'));
  expect(() => createRoutedProvider(ordinary, [omni])).toThrow('cannot be composed');
  expect(() => createRoutedProvider(omni, [ordinary])).toThrow('cannot be composed');
  expect(() => createRoutedProvider(ordinary, [{ id: 'alias', provider: omni }])).toThrow('cannot be composed');
  expect(() => createAutoProvider({ config: { candidates: [{ modelId: 'alias', description: '', relativeCost: 1, supportsImages: false }] },
    providers: { alias: omni }, surface: 'exec', route: async () => { throw new Error('must not route'); }, upgradeTarget: () => undefined,
  })).toThrow('cannot be composed');
  expect(calls).toBe(0);
});

test('TOS-01 equivalent DNS host spelling cannot bypass avoid; ERR-01 denial status wins over transient code', async () => {
  const calls: string[] = [];
  const server = serve(async req => { const b = await req.json() as any; calls.push(b.model); return failure(403, 'server_error'); });
  const s = settings(server.url.href, [profile('avoid', 0), profile('allowed', 1)]);
  s.customModels![0]!.baseUrl = 'https://api.fireworks.ai./v1'; s.customModels![0]!.apiKey = '${UNUSED_AVOID_KEY}';
  await expect(configured(s).complete(request, signal())).rejects.toThrow('terminally'); expect(calls).toEqual(['allowed']);
});


test('COMPAT-01 Omni session facades preserve invocation-bound mission pause capabilities', async () => {
  const cwd = await temp(roots), sessionDir = join(cwd, 'sessions');
  const host = new AbortController(), control = new MissionRunControl(signal(), host.signal); let saved = 0;
  const server = serve(() => tools('Read', JSON.stringify({ file_path: 'baseline' })));
  const options = control.authorize({ cwd, sessionDir, prompt: 'read', provider: configured(settings(server.url.href)),
    signal: control.signal, onEvent: event => { if (event.type === 'tool_call') host.abort(); },
  }, () => { saved++; });
  try {
    const result = await runCodingAgent(options);
    expect(result.ok).toBe(false); expect(result.error?.type).toBe('aborted'); expect(saved).toBe(1);
    const store = await SessionStore.create(sessionDir);
    const state = await store.load(result.sessionId);
    expect(state.pending).toEqual([]);
    expect(state.messages.at(-1)?.content).toContain('Interrupted by host mission pause');
  } finally { control.dispose(); }
});
