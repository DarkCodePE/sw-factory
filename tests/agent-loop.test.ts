import { afterEach, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, node, until } from './helpers/loop-fetch.ts';
import { parseLoop } from '../src/agent/loop.ts';
import { listAgentTools, runCodingAgent } from '../src/agent/engine.ts';
import { describeTool } from '../src/agent/catalog.ts';
import { createCommandObserver } from '../src/agent/mission-evidence.ts';

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
async function setup(...args: Parameters<typeof fixture>) { const f = await fixture(...args); fixtures.push(f); return f; }

test('Loop retries until exit_zero and returns the final output, without a composite scheduler deadlock', async () => {
  const f = await setup();
  const command = node("const fs=require('fs');let n=+(fs.existsSync('count')?fs.readFileSync('count','utf8'):0)+1;fs.writeFileSync('count',String(n));console.log('attempt '+n);process.exitCode=n<3?1:0");
  expect(await f.runtime.dispatch('Loop', { command, until: 'exit_zero', maxIterations: 5, intervalMs: 0 }))
    .toMatchObject({ iterations: 3, satisfied: true, lastExitCode: 0, lastOutput: 'attempt 3\n' });
  expect(await readFile(join(f.cwd, 'count'), 'utf8')).toBe('3');
});

test('Loop output_matches can stop on a nonzero exit; exhaustion is a normal unsatisfied result', async () => {
  const f = await setup();
  expect(await f.runtime.dispatch('Loop', { command: node("console.log('READY');process.exitCode=7"), until: 'output_matches', pattern: '^READY\\n$', intervalMs: 0 }))
    .toMatchObject({ iterations: 1, satisfied: true, lastExitCode: 7 });
  expect(await f.runtime.dispatch('Loop', { command: node("console.log('not yet');process.exitCode=2"), until: 'exit_zero', maxIterations: 2, intervalMs: 0 }))
    .toMatchObject({ iterations: 2, satisfied: false, lastExitCode: 2, lastOutput: 'not yet\n' });
});

test('Loop rejects invalid fields, regexes, budgets and non-simple/background commands before execution', async () => {
  const f = await setup(), base = { command: 'pwd', until: 'exit_zero' };
  for (const p of [{ maxIterations: 0 }, { maxIterations: 51 }, { maxIterations: 1.5 }, { intervalMs: -1 }, { intervalMs: 60001 },
    { background: true }, { network: 'true' }, { command: 'pwd && pwd' }, { command: 'echo x > file' }, { command: 'x'.repeat(16385) },
    { until: 'bad' }, { pattern: 'x' }, { until: 'output_matches', pattern: '(' }, { until: 'output_matches', pattern: 'a'.repeat(257) }]) {
    await expect(f.runtime.dispatch('Loop', { ...base, ...p })).rejects.toThrow();
  }
  expect(parseLoop(base)).toMatchObject({ maxIterations: 10, intervalMs: 1000, network: false });
  expect(parseLoop({ ...base, maxIterations: 50, intervalMs: 60000 }).maxIterations).toBe(50);
});

test('Loop cannot escape spec or Execute filters/caller policy; one approval never elevates later iterations', async () => {
  const spec = await setup({ interactionMode: 'spec' });
  await expect(spec.runtime.dispatch('Loop', { command: 'pwd', until: 'exit_zero' })).rejects.toThrow('Spec mode');
  const removed = await setup({ removeTools: ['Execute'] });
  await expect(removed.runtime.dispatch('Loop', { command: 'pwd', until: 'exit_zero' })).rejects.toThrow('disabled');
  const denied = await setup({ beforeTool: async c => c.function.name !== 'Execute' });
  await expect(denied.runtime.dispatch('Loop', { command: 'pwd', until: 'exit_zero' })).rejects.toThrow('caller policy');
  const calls: string[] = [];
  const f = await setup({ autonomy: 'off', permissionHandler: async request => {
    calls.push(request.toolUses[0]!.toolUse.name); return calls.length === 3 ? 'cancel' : 'proceed_once';
  } });
  await expect(f.runtime.dispatch('Loop', { command: node('process.exitCode=1'), until: 'exit_zero', maxIterations: 3, intervalMs: 0 })).rejects.toThrow('cancelled');
  expect(calls).toEqual(['Loop', 'Execute', 'Execute']); expect(f.context.autonomy).toBe('off');
});

test('Loop requests network for EACH Execute iteration; deny prevents process creation', async () => {
  let requests = 0, permissions = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return new Response('ok'); } });
  try {
    const command = node('fetch(' + JSON.stringify(server.url.href) + ').then(async r=>{console.log(await r.text());process.exitCode=1})');
    const f = await setup({ networkPolicy: 'ask', permissionHandler: async request => {
      permissions++; expect(request.toolUses[0]!.details.network).toMatchObject({ access: 'host', scope: 'this_call' }); return 'proceed_once';
    } });
    expect(await f.runtime.dispatch('Loop', { command, network: true, until: 'exit_zero', maxIterations: 2, intervalMs: 0 })).toMatchObject({ iterations: 2, satisfied: false });
    expect(permissions).toBe(2); expect(requests).toBe(2);
    const denied = await setup({ networkPolicy: 'deny' });
    await expect(denied.runtime.dispatch('Loop', { command, network: true, until: 'exit_zero' })).rejects.toThrow('denied');
    expect(requests).toBe(2);
  } finally { server.stop(true); }
});

test('mission Loop spends one shared call per invocation while observing every Execute internally', async () => {
  const observer = createCommandObserver(), f = await setup({ interactionMode: 'mission', missionWorker: {
    directory: '.', featureId: 'fixture', sealed: () => false, submit: async () => null, observe: observer.observe,
  } });
  expect(await f.runtime.dispatch('Loop', { command: node('process.exitCode=1'), until: 'exit_zero', maxIterations: 3, intervalMs: 0 })).toMatchObject({ iterations: 3 });
  expect(f.budget.calls).toBe(1);
  expect(observer.observed()).toHaveLength(3); expect(observer.observed().every(o => o.exitCode === 1)).toBe(true);
  f.budget.calls = f.budget.maxCalls;
  await expect(f.runtime.dispatch('Loop', { command: node("require('fs').writeFileSync('unbudgeted','x')"), until: 'exit_zero' })).rejects.toThrow('budget');
  expect(await Bun.file(join(f.cwd, 'unbudgeted')).exists()).toBe(false);
});

test('Loop cancellation kills current command and prevents late writes, repeated three times', async () => {
  for (let repetition = 0; repetition < 3; repetition++) {
    const f = await setup();
    const command = node("require('fs').writeFileSync('started','yes');setTimeout(()=>require('fs').writeFileSync('late','bad'),250);setTimeout(()=>{},3000)");
    const work = f.runtime.dispatch('Loop', { command, until: 'exit_zero', maxIterations: 50, intervalMs: 0 });
    await until(() => Bun.file(join(f.cwd, 'started')).exists()); f.controller.abort(new Error('cancel'));
    await expect(work).rejects.toThrow(); await Bun.sleep(320);
    expect(await Bun.file(join(f.cwd, 'late')).exists()).toBe(false);
  }
}, 10000);

test('Loop cancels interval waits promptly and does not launch a second command', async () => {
  const f = await setup();
  const command = node("require('fs').appendFileSync('count','x');process.exitCode=1");
  const work = f.runtime.dispatch('Loop', { command, until: 'exit_zero', intervalMs: 60000 });
  await until(() => Bun.file(join(f.cwd, 'count')).exists()); await Bun.sleep(50);
  const start = Date.now(); f.controller.abort(); await expect(work).rejects.toThrow();
  expect(Date.now() - start).toBeLessThan(500); expect(await readFile(join(f.cwd, 'count'), 'utf8')).toBe('x');
});

test('adversarial regex cannot block the agent event loop beyond the worker deadline', async () => {
  const f = await setup(); let heartbeat = false;
  const timer = setTimeout(() => { heartbeat = true; }, 0);
  const start = Date.now();
  try {
    try {
      const result: any = await f.runtime.dispatch('Loop', { command: node("console.log(String.fromCharCode(97).repeat(30000)+String.fromCharCode(33))"), until: 'output_matches', pattern: '(a+)+$', maxIterations: 1, intervalMs: 0 });
      expect(result.satisfied).toBe(false); // JavaScriptCore may bound backtracking itself.
    } catch (error) { expect(String(error)).toContain('pattern evaluation failed: timeout'); }
    expect(heartbeat).toBe(true); expect(Date.now() - start).toBeLessThan(2000);
  } finally { clearTimeout(timer); }
}, 4000);

test('Loop uses existing output limits and Script callbacks; catalog/filter identities remain correct', async () => {
  const f = await setup();
  await expect(f.runtime.dispatch('Loop', { command: node("console.log(String.fromCharCode(120).repeat(300000))"), until: 'exit_zero' })).rejects.toThrow('output limit');
  const scripted = await f.runtime.dispatch('Script', { code: "return await tools.Loop({command:'pwd',until:'exit_zero'})" }) as any;
  expect(scripted.output).toMatchObject({ iterations: 1, satisfied: true });
  const tools = listAgentTools({ cwd: f.cwd, prompt: '', provider: { id: 'catalog', complete: async () => { throw Error(); } } });
  expect(describeTool(tools.find(t => t.schema.function.name === 'Loop')!)).toMatchObject({ id: 'loop-cli', category: 'execute', defaultAllowed: false });
  expect(describeTool(tools.find(t => t.schema.function.name === 'FetchUrl')!)).toMatchObject({ id: 'fetch_url', category: 'read', defaultAllowed: true });
});

test('Loop can return the entire Execute byte budget even when JSON escaping exceeds the generic result cap', async () => {
  const f = await setup(); let turn = 0;
  const result = await runCodingAgent({ cwd: f.cwd, prompt: 'loop', autonomy: 'high', maxContextTokens: 2_000_000, sessionDir: join(f.cwd, 'sessions'),
    provider: { id: 'loop-large', async complete(request) {
      if (!turn++) return { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'loop-large', type: 'function', function: {
        name: 'Loop', arguments: JSON.stringify({ command: node('process.stdout.write(String.fromCharCode(1).repeat(256*1024))'), until: 'exit_zero' }),
      } }] };
      const value = JSON.parse(String(request.messages.at(-1)!.content));
      expect(value).toMatchObject({ iterations: 1, satisfied: true, lastExitCode: 0 }); expect(value.lastOutput.length).toBe(256 * 1024);
      return { text: 'done', toolCalls: [], finishReason: 'stop' };
    } },
  });
  expect(result.ok).toBe(true);
});
