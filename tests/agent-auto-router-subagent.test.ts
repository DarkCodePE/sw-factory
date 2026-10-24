import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCodingAgent } from '../src/agent/engine.ts';
import { createAutoProvider } from '../src/agent/providers/auto.ts';
import type { AutoRouterConfig, RoutingContext, RoutingDecision } from '../src/agent/router/types.ts';
import type { AgentEvent, ModelProvider, ModelTurn } from '../src/agent/types.ts';

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
const done = (text = 'done'): ModelTurn => ({ text, toolCalls: [], finishReason: 'stop' });
const calls = (...tools: Array<[string, unknown]>): ModelTurn => ({ text: '', finishReason: 'tool_calls', toolCalls: tools.map(([name, input]) => ({ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(input) } })) });

async function repo(withLargeFile = false) {
  const cwd = await mkdtemp(join(tmpdir(), 'fab-auto-subagent-test-')); roots.push(cwd);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', cwd, '-c', 'user.name=fixture', '-c', 'user.email=fixture@local', ...args]);
    if (result.exitCode) throw new Error(result.stderr.toString());
  };
  git('init', '-q');
  if (withLargeFile) await writeFile(join(cwd, 'large.json'), Buffer.alloc(1_100_000, 0x61));
  else await writeFile(join(cwd, 'file'), 'baseline');
  git('add', '.'); git('commit', '-qm', 'fixture'); return cwd;
}

test('Task snapshots a tracked file larger than the normal workspace read limit without auto routing', async () => {
  const cwd = await repo(true); let parentTurns = 0, childCwd = '', task: any;
  const provider: ModelProvider = { id: 'fixture', async complete(request) {
    const workspace = /^Workspace: (.+)$/m.exec(request.messages[1]!.content as string)![1]!;
    if (workspace === cwd) {
      if (!parentTurns++) return calls(['Task', { prompt: 'inspect the snapshot' }]);
      task = JSON.parse(request.messages.at(-1)!.content as string); return done();
    }
    childCwd = workspace; return done('child complete');
  } };
  const result = await runCodingAgent({ prompt: 'delegate', cwd, provider, autonomy: 'medium' });
  if (childCwd) roots.push(dirname(childCwd));
  expect(result.ok).toBe(true);
  expect(task.status).toBe('completed');
  expect((await readFile(join(childCwd, 'large.json'))).byteLength).toBe(1_100_000);
});

test('auto subagent classifies independently and emits only tagged routing events to the parent', async () => {
  const cwd = await repo(); let parentTurns = 0, childSessionId = '', childAgentId = '';
  const events: AgentEvent[] = [], contexts: RoutingContext[] = [];
  const config: AutoRouterConfig = { classifierModel: 'classifier', candidates: [
    { modelId: 'parent-model', description: 'parent', relativeCost: 2, supportsImages: true },
    { modelId: 'child-model', description: 'child', relativeCost: 1, supportsImages: true },
  ] };
  const parentModel: ModelProvider = { id: 'parent-model', async complete(request) {
    if (parentTurns++) {
      const toolResult = request.messages.at(-1)?.content;
      if (typeof toolResult === 'string') {
        const task = JSON.parse(toolResult);
        childSessionId = task.result.sessionId;
        childAgentId = task.agentId;
      }
      return done('parent complete');
    }
    return calls(['Task', { prompt: 'Return the child response' }]);
  } };
  const childModel: ModelProvider = { id: 'child-model', async complete() { return done('HIJO'); } };
  const providers = { classifier: { id: 'classifier', async complete() { return done(); } }, 'parent-model': parentModel, 'child-model': childModel };
  const route = async (_config: AutoRouterConfig, _classifier: ModelProvider | undefined, ctx: RoutingContext): Promise<RoutingDecision> => {
    contexts.push(ctx);
    return { modelId: ctx.isSubagent ? 'child-model' : 'parent-model', reason: 'routine', fallbacks: [], scores: {}, classifierMs: 1 };
  };
  const auto = createAutoProvider({ config, providers, route, upgradeTarget: () => undefined, surface: 'exec', onEvent: e => events.push(e), sleep: async () => {}, random: () => 1 });
  const result = await runCodingAgent({ prompt: 'Use Task once to delegate to a child', cwd, provider: auto, autonomy: 'medium', onEvent: e => events.push(e) });
  const parentSessionId = result.sessionId;
  const routed = events.filter(e => e.type === 'model_routed');
  expect(result.ok).toBe(true);
  expect(contexts.map(ctx => ({ surface: ctx.surface, isSubagent: ctx.isSubagent }))).toEqual([
    { surface: 'exec', isSubagent: false }, { surface: 'subagent', isSubagent: true },
  ]);
  expect(routed).toHaveLength(2);
  expect(routed.find(e => e.sessionId === parentSessionId)).toBeDefined();
  const childRoute = routed.find(e => e.sessionId !== parentSessionId);
  expect(childRoute).toBeDefined();
  expect(childRoute!.sessionId).toBe(childSessionId);
  expect(childRoute!.agentId).toBe(childAgentId);
  const childEvents = events.filter(e => e.sessionId === childSessionId);
  expect(childEvents.some(e => e.type === 'assistant_delta')).toBe(false);
  expect(childEvents.some(e => e.type === 'result')).toBe(false);
  expect(childEvents.every(e => e.type === 'model_routed' || e.type === 'model_transition')).toBe(true);
  expect(events.filter(e => e.type === 'result' && e.sessionId === parentSessionId)).toHaveLength(1);
});
