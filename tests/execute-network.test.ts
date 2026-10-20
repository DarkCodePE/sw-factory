import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ToolRuntime } from '../src/agent/registry.ts';
import { AgentBudget } from '../src/agent/tasks.ts';
import { loadExecSettings } from '../src/agent/settings.ts';
import { NETWORK_POLICIES, networkDecision, networkPolicy } from '../src/agent/network-policy.ts';
import { builtinTools } from '../src/agent/tools.ts';
import { runCodingAgent } from '../src/agent/engine.ts';
import { _setSandboxDetectionForTesting, clearSandboxCache } from '../src/sandbox/detect.ts';
import type { AgentEvent, AgentOptions, Autonomy, PermissionRequest, ToolContext } from '../src/agent/types.ts';

const roots: string[] = [], runtimes: ToolRuntime[] = [];
afterEach(async () => { for (const r of runtimes.splice(0)) await r.close(); for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
async function fixture(autonomy: Autonomy = 'high', policy: 'auto' | 'ask' | 'deny' = 'auto', handler?: AgentOptions['permissionHandler']) {
  const cwd = await mkdtemp(join(tmpdir(), 'fab-network-')); roots.push(cwd);
  const events: AgentEvent[] = [];
  const context: ToolContext = { cwd, autonomy, networkPolicy: policy, signal: new AbortController().signal, interactionMode: 'auto', sandbox: 'required' };
  const runtime = new ToolRuntime({ cwd, prompt: '', provider: { id: 'offline', async complete() { throw new Error('No model calls expected'); } },
    autonomy, networkPolicy: policy, permissionHandler: handler, onEvent: e => events.push(e) }, context,
    { depth: 0, budget: new AgentBudget(0, 10, 1) }, { maxDepth: 0, agentConcurrency: 1, parallel: 1 }, async () => { throw new Error('No children expected'); }, { id: 'network-test' });
  runtimes.push(runtime); return { cwd, runtime, context, events };
}
function endpoint() {
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return new Response('network-proof'); } });
  const script = `fetch(${JSON.stringify(server.url.href)}, {signal:AbortSignal.timeout(1000)}).then(async r=>console.log(await r.text())).catch(()=>{console.error('network-blocked');process.exitCode=2})`;
  return { server, requests: () => requests, command: `${quote(process.execPath)} -e ${quote(script)}` };
}

test('network policy matrix: auto permits only high; ask never auto-permits; deny and spec never permit', () => {
  for (const level of ['off', 'low', 'medium', 'high'] as const) for (const policy of NETWORK_POLICIES) {
    expect(networkDecision(false, policy, level, 'auto')).toBe('none');
    expect(networkDecision(true, policy, level, 'auto')).toBe(policy === 'deny' ? 'deny' : policy === 'auto' && level === 'high' ? 'allow' : 'ask');
    expect(networkDecision(true, policy, level, 'spec')).toBe('deny');
  }
  expect(() => networkPolicy('allow')).toThrow(); expect(() => networkPolicy(null)).toThrow();
});

test('Execute stays offline by default, even at high; an explicit high request uses the network and remains sandboxed', async () => {
  const f = await fixture(), e = endpoint();
  try {
    const offline: any = await f.runtime.dispatch('Execute', { command: e.command });
    expect(offline.exitCode).toBe(2); expect(offline.network.enabled).toBe(false); expect(e.requests()).toBe(0);
    const online: any = await f.runtime.dispatch('Execute', { command: e.command, network: true });
    expect(online.exitCode).toBe(0); expect(online.stdout).toContain('network-proof'); expect(online.sandboxed).toBe(true);
    expect(online.network).toEqual({ requested: true, enabled: true }); expect(e.requests()).toBe(1);
    expect(f.events.at(-1)).toMatchObject({ type: 'network_permission', decision: 'allowed_automatically', scope: 'this_call' });
  } finally { e.server.stop(true); }
});

test('off/low/medium ask before starting anything; one approval combines command and network authority', async () => {
  for (const level of ['off', 'low', 'medium'] as const) {
    const e = endpoint(); let prompts = 0;
    try {
      const f = await fixture(level, 'auto', async request => {
        prompts++; expect(e.requests()).toBe(0);
        expect(request.toolUses[0]!.details.network).toMatchObject({ requested: true, access: 'host', scope: 'this_call' });
        expect(request.toolUses[0]!.toolUse.input).toMatchObject({ command: e.command, network: true });
        return 'proceed_once';
      });
      const result: any = await f.runtime.dispatch('Execute', { command: e.command, network: true });
      expect(result.exitCode).toBe(0); expect(prompts).toBe(1); expect(e.requests()).toBe(1); expect(f.context.autonomy).toBe(level);
      expect(f.events.at(-1)?.decision).toBe('allowed_once');
    } finally { e.server.stop(true); }
  }
});

test('ask overrides high, grants do not survive a call, and denial never launches the command', async () => {
  const e = endpoint(); let prompts = 0;
  const f = await fixture('high', 'ask', async () => ++prompts === 1 ? 'proceed_once' : 'cancel');
  try {
    expect((await f.runtime.dispatch('Execute', { command: e.command, network: true }) as any).exitCode).toBe(0);
    const offline: any = await f.runtime.dispatch('Execute', { command: e.command }); expect(offline.exitCode).toBe(2);
    await expect(f.runtime.dispatch('Execute', { command: e.command, network: true })).rejects.toThrow('cancelled');
    expect(prompts).toBe(2); expect(e.requests()).toBe(1); expect(f.context.networkAccess).toBeUndefined();
  } finally { e.server.stop(true); }
});

test('deny, absent approval handler, invalid input and cancellation cannot start a network command', async () => {
  const e = endpoint();
  try {
    let called = false;
    const denied = await fixture('high', 'deny', async () => { called = true; return 'proceed_once'; });
    await expect(denied.runtime.dispatch('Execute', { command: e.command, network: true, networkPolicy: 'auto', networkAccess: true })).rejects.toThrow('denied'); expect(called).toBe(false);
    const noHandler = await fixture('medium');
    await expect(noHandler.runtime.dispatch('Execute', { command: e.command, network: true })).rejects.toThrow('network approval required');
    await expect(noHandler.runtime.dispatch('Execute', { command: e.command, network: 'true' })).rejects.toThrow('boolean');
    const invalid = await fixture('low', 'auto', async () => { called = true; return 'proceed_once'; });
    await expect(invalid.runtime.dispatch('Execute', { command: 3, network: true })).rejects.toThrow('command must be a string'); expect(called).toBe(false);
    const controller = new AbortController();
    const cancelled = await fixture('low', 'auto', async () => { controller.abort(); return 'proceed_once'; });
    await expect(cancelled.runtime.dispatch('Execute', { command: e.command, network: true }, undefined, controller.signal)).rejects.toThrow();
    expect(e.requests()).toBe(0);
  } finally { e.server.stop(true); }
});

test('approval is bound to an immutable command snapshot; host network does not grant outside writes or inherited secrets', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'fab-network-outside-')); roots.push(outside);
  const path = join(outside, 'untouched'); await writeFile(path, 'original');
  let shown: PermissionRequest | undefined;
  const f = await fixture('off', 'auto', async request => { shown = request;
    expect(Object.isFrozen(request.toolUses[0]!.toolUse.input)).toBe(true); return 'proceed_once'; });
  const script = `const fs=require('node:fs'); try{fs.writeFileSync(${JSON.stringify(path)},'bad'); process.exitCode=3}catch{}; console.log(process.env.FAB_NETWORK_SECRET??'scrubbed')`;
  process.env.FAB_NETWORK_SECRET = 'synthetic-not-for-child';
  try {
    const result: any = await f.runtime.dispatch('Execute', { command: `${quote(process.execPath)} -e ${quote(script)}`, network: true });
    expect(result.exitCode).toBe(0); expect(result.sandboxed).toBe(true); expect(result.stdout.trim()).toBe('scrubbed');
    expect(await readFile(path, 'utf8')).toBe('original'); expect(shown?.toolUses[0]!.details.cwd).toBe(f.cwd);
  } finally { delete process.env.FAB_NETWORK_SECRET; }
});

test('Script nested Execute shares the network gate and a sequence retains its one-call network request', async () => {
  const e = endpoint(); let approvals = 0;
  const f = await fixture('medium', 'auto', async () => { approvals++; return 'proceed_once'; });
  try {
    const curl = `${quote(Bun.which('curl')!)} --fail --silent ${quote(e.server.url.href)}`;
    const result: any = await f.runtime.dispatch('Script', { code: `return await tools.Execute(${JSON.stringify({ command: `${curl} && ${curl}`, network: true })});` });
    expect(result.output.exitCode).toBe(0); expect(result.output.network.enabled).toBe(true); expect(e.requests()).toBe(2); expect(approvals).toBe(1);
    const execute = builtinTools().find(t => t.schema.function.name === 'Execute')!;
    await expect(execute.run({ command: e.command, network: true }, f.context)).rejects.toThrow('runtime grant');
  } finally { e.server.stop(true); }
});

test('settings validate the network policy instead of accepting an unrestricted allow mode', async () => {
  const f = await fixture(), file = join(f.cwd, 'settings.json');
  for (const policy of NETWORK_POLICIES) { await writeFile(file, JSON.stringify({ sandboxNetwork: policy })); expect((await loadExecSettings(file)).sandboxNetwork).toBe(policy); }
  await writeFile(file, JSON.stringify({ sandboxNetwork: 'allow' })); await expect(loadExecSettings(file)).rejects.toThrow('Network policy');
});

test('Execute never falls back to an unisolated process when best-effort cannot enforce network policy', async () => {
  const f = await fixture(); f.context.sandbox = 'best-effort';
  _setSandboxDetectionForTesting({ backend: 'none', available: false, network: false, reason: 'unavailable fixture' });
  try {
    for (const network of [false, true]) await expect(f.runtime.dispatch('Execute', { command: 'touch should-not-exist', network })).rejects.toThrow('Sandbox execution is required');
    expect(await Bun.file(join(f.cwd, 'should-not-exist')).exists()).toBe(false);
  } finally { clearSandboxCache(); }
});

test('a network grant cannot leave delayed descendants connected after the call returns or is aborted', async () => {
  for (const abort of [false, true]) {
    const f = await fixture(), e = endpoint(), controller = new AbortController();
    const later = `setTimeout(()=>fetch(${JSON.stringify(e.server.url.href)}).catch(()=>{}),200)`;
    const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(later)}],{detached:true,stdio:'ignore'}).unref();require('fs').writeFileSync('started','1');${abort ? 'setTimeout(()=>{},2000)' : ''}`;
    try {
      const pending = f.runtime.dispatch('Execute', { command: `${quote(process.execPath)} -e ${quote(script)}`, network: true }, undefined, controller.signal);
      if (abort) {
        const deadline = Date.now() + 2000;
        while (!await Bun.file(join(f.cwd, 'started')).exists()) { if (Date.now() > deadline) { controller.abort(); throw new Error('Sandboxed process never started'); } await Bun.sleep(2); }
        controller.abort(); await expect(pending).rejects.toThrow();
      } else await pending;
      const atReturn = e.requests(); await Bun.sleep(300); expect(e.requests()).toBe(atReturn);
      if (abort) expect(e.requests()).toBe(0);
    } finally { controller.abort(); e.server.stop(true); }
  }
});

test('delegation inherits deny and a one-call Task approval never turns the child into auto high', async () => {
  for (const scenario of [{ autonomy: 'high', policy: 'deny', prompts: 0 }, { autonomy: 'off', policy: 'auto', prompts: 2 }] as const) {
    const f = await fixture();
    const git = (...args: string[]) => { const r = Bun.spawnSync(['git', ...args], { cwd: f.cwd }); expect(r.exitCode).toBe(0); };
    git('init', '-q'); await writeFile(join(f.cwd, 'README.md'), 'fixture'); git('add', 'README.md');
    git('-c', 'user.name=Network Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'fixture');
    let childError = '', childCwd = '', prompts = 0;
    const result = await runCodingAgent({ prompt: 'parent task', cwd: f.cwd, sessionDir: join(f.cwd, '.sessions'), autonomy: scenario.autonomy, networkPolicy: scenario.policy,
      permissionHandler: async request => { prompts++; return request.toolUses[0]!.toolUse.name === 'Task' ? 'proceed_once' : 'cancel'; },
      provider: { id: 'delegation-fixture', async complete(request) {
        const isChild = request.messages.some(m => m.role === 'user' && m.content === 'child network task');
        const previous = [...request.messages].reverse().find(m => m.role === 'tool');
        if (previous) {
          if (isChild) childError = String(previous.content);
          else {
            const task = JSON.parse(String(previous.content)); childCwd = task.cwd;
            expect(childCwd.startsWith(join(tmpdir(), 'fab-subagent-')) && childCwd.endsWith('/workspace')).toBe(true);
            roots.push(dirname(childCwd));
          }
          return { text: 'done', toolCalls: [], finishReason: 'stop' };
        }
        return { text: '', finishReason: 'tool_calls', toolCalls: [{ id: isChild ? 'child-net' : 'parent-task', type: 'function', function: {
          name: isChild ? 'Execute' : 'Task', arguments: JSON.stringify(isChild ? { command: 'touch unapproved-network-command', network: true } : { prompt: 'child network task' }),
        } }] };
      } },
    });
    expect(result.ok).toBe(true); expect(childError).toContain(scenario.policy === 'deny' ? 'denied by policy' : 'cancelled');
    expect(prompts).toBe(scenario.prompts); expect(await Bun.file(join(childCwd, 'unapproved-network-command')).exists()).toBe(false);
  }
});
