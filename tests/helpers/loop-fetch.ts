import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRuntime } from '../../src/agent/registry.ts';
import { AgentBudget } from '../../src/agent/tasks.ts';
import { resolveExecutionPolicy } from '../../src/agent/execution-policy.ts';
import type { AgentEvent, AgentOptions, ToolContext } from '../../src/agent/types.ts';

export const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export const node = (code: string) => quote(process.execPath) + ' -e ' + quote(code);
export async function fixture(options: Partial<AgentOptions> = {}, parallel = 1) {
  const cwd = await mkdtemp(join(tmpdir(), 'fab-loop-fetch-')), controller = new AbortController();
  const events: AgentEvent[] = [], executionPolicy = resolveExecutionPolicy({ autonomy: 'high', ...options });
  const context: ToolContext = { cwd, signal: controller.signal, autonomy: executionPolicy.effectiveAutonomy, executionPolicy,
    networkPolicy: options.networkPolicy ?? 'auto', interactionMode: options.interactionMode ?? 'auto', sandbox: 'required' };
  const budget = new AgentBudget(0, 20, 1);
  const opts: AgentOptions = { cwd, prompt: '', provider: { id: 'offline', async complete() { throw new Error('No model expected'); } },
    autonomy: 'high', onEvent: e => events.push(e), ...options };
  const runtime = new ToolRuntime(opts, context, { depth: 0, budget },
    { maxDepth: 0, agentConcurrency: 1, parallel }, async () => { throw new Error('No children expected'); }, { id: 'test' });
  return { cwd, controller, context, runtime, events, budget, async close() {
    controller.abort(new Error('Fixture closed')); await runtime.close(); await rm(cwd, { recursive: true, force: true });
  } };
}
export async function until(check: () => boolean | Promise<boolean>, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Fixture wait timeout'); await Bun.sleep(3); }
}
