import { runScript } from '../script-runtime/index.ts';
import { abortable } from './cancellation.ts';
import { hostCommand } from './execute-host.ts';
import { verifierArgv } from './mission-evidence.ts';
import { inputObject, tool } from './tools.ts';
import type { ToolContext } from './types.ts';

export interface LoopInput { command: string; network: boolean; until: 'exit_zero' | 'output_matches'; pattern?: string; maxIterations: number; intervalMs: number }
export function parseLoop(input: unknown): LoopInput {
  const p = inputObject(input);
  if (Object.keys(p).some(k => !['command', 'network', 'until', 'pattern', 'maxIterations', 'intervalMs'].includes(k))) throw new Error('Unknown Loop input field');
  const command = hostCommand(p);
  verifierArgv(command, 16_384);
  if (p.until !== 'exit_zero' && p.until !== 'output_matches') throw new Error('Loop until must be exit_zero or output_matches');
  const maxIterations = p.maxIterations === undefined ? 10 : p.maxIterations, intervalMs = p.intervalMs === undefined ? 1000 : p.intervalMs;
  if (!Number.isSafeInteger(maxIterations) || Number(maxIterations) < 1 || Number(maxIterations) > 50) throw new Error('Loop maxIterations must be 1..50');
  if (!Number.isSafeInteger(intervalMs) || Number(intervalMs) < 0 || Number(intervalMs) > 60_000) throw new Error('Loop intervalMs must be 0..60000');
  if (p.until === 'output_matches') {
    if (typeof p.pattern !== 'string' || !p.pattern.length || p.pattern.length > 256) throw new Error('Loop pattern must contain 1..256 characters');
    // Compilation is bounded by pattern length. Matching happens only in a killable worker.
    try { new RegExp(p.pattern); } catch { throw new Error('Invalid Loop pattern'); }
  } else if (p.pattern !== undefined) throw new Error('Loop pattern requires output_matches');
  return { command, network: p.network === true, until: p.until, pattern: p.pattern as string | undefined, maxIterations: Number(maxIterations), intervalMs: Number(intervalMs) };
}
async function matches(pattern: string, output: string, c: ToolContext): Promise<boolean> {
  const result = await runScript({
    code: 'return new RegExp(' + JSON.stringify(pattern) + ').test(' + JSON.stringify(output) + ')',
    tools: {}, signal: c.signal, timeoutMs: 1000, sandbox: 'required',
    limits: { maxResultBytes: 1024, maxOutputBytes: 1024, maxPendingCalls: 0, maxTimers: 0 },
  });
  c.signal.throwIfAborted();
  if (!result.ok) throw new Error('Loop pattern evaluation failed: ' + result.error.origin + ': ' + result.error.message);
  return result.output === true;
}
export function loopTool(dispatch: (name: string, input: unknown, signal: AbortSignal) => Promise<unknown>, charge: () => void) {
  return tool('Loop', 'execute', {
    command: { type: 'string' }, network: { type: 'boolean' },
    until: { type: 'string', enum: ['exit_zero', 'output_matches'] }, pattern: { type: 'string', maxLength: 256 },
    maxIterations: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    intervalMs: { type: 'integer', minimum: 0, maximum: 60_000, default: 1000 },
  }, ['command', 'until'], async (input, c) => {
    const p = parseLoop(input);
    if (c.interactionMode === 'spec') throw new Error('Spec mode denies Loop');
    c.signal.throwIfAborted(); charge();
    let iterations = 0, satisfied = false, lastExitCode = -1, lastOutput = '';
    while (iterations < p.maxIterations) {
      c.signal.throwIfAborted();
      const value = await dispatch('Execute', Object.freeze({ command: p.command, network: p.network }), c.signal);
      c.signal.throwIfAborted();
      const result = value as { exitCode?: unknown; stdout?: unknown; stderr?: unknown };
      if (!Number.isInteger(result?.exitCode) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') throw new Error('Loop expected a foreground Execute result');
      iterations++; lastExitCode = result.exitCode as number; lastOutput = result.stdout + result.stderr;
      satisfied = p.until === 'exit_zero' ? lastExitCode === 0 : await matches(p.pattern!, lastOutput, c);
      c.signal.throwIfAborted();
      if (satisfied || iterations === p.maxIterations) break;
      if (p.intervalMs) await abortable(new Promise<void>(resolve => {
        const timer = setTimeout(done, p.intervalMs);
        function done() { clearTimeout(timer); c.signal.removeEventListener('abort', done); resolve(); }
        c.signal.addEventListener('abort', done, { once: true }); if (c.signal.aborted) done();
      }), c.signal);
    }
    c.signal.throwIfAborted();
    return { iterations, satisfied, lastExitCode, lastOutput };
  }, 'Repeat one foreground command with a fixed iteration budget. Every execution requests its own Execute permissions; planning mode is excluded.');
}
