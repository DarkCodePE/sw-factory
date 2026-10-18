import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { wrapCommand } from '../sandbox/index.ts';
import { isCompiled, selfCommand } from '../self.ts';

/** Hidden fab subcommand that runs the Script worker from a compiled binary. */
export const SCRIPT_WORKER_COMMAND = '__script-worker';
import {
  DEFAULT_TIMEOUT_MS, RuntimeFailure, contentBytes, encodeFrame, errorMessage,
  isContent, readFrames, record, resolveLimits,
} from './protocol.ts';
import type { RunScriptOptions, RunScriptResult, ScriptContent, ScriptError, ToolBinding } from './types.ts';

const forbiddenPaths = new Set(['__proto__', 'prototype', 'constructor']);

function bindingsFor(tools: RunScriptOptions['tools']): ToolBinding[] {
  if (!record(tools)) throw new Error('Script tools must be a record of functions');
  const bindings = Object.entries(tools).map(([toolName, fn]) => {
    const path = toolName.split('.');
    if (typeof fn !== 'function' || path.some(p => !p || forbiddenPaths.has(p))) {
      throw new Error(`Invalid Script tool binding: ${toolName}`);
    }
    return { path, toolName };
  });
  const names = new Set(bindings.map(b => b.toolName));
  for (const { path } of bindings) {
    for (let i = 1; i < path.length; i++) {
      if (names.has(path.slice(0, i).join('.'))) throw new Error('Conflicting Script tool bindings');
    }
  }
  return bindings;
}

/** A fresh, disposable Bun subprocess owns every VM evaluation. */
export async function runScript(opts: RunScriptOptions): Promise<RunScriptResult> {
  const startedAt = performance.now();
  const content: ScriptContent[] = [];
  const notifications: string[] = [];
  let sandboxed = false;
  let scratch: string | undefined;
  const failure = (error: ScriptError): RunScriptResult => ({ ok: false, error, content, notifications, sandboxed });
  try {
    if (opts.signal?.aborted) return failure({ origin: 'runtime', message: 'Script aborted' });
    if (!opts || typeof opts.code !== 'string') throw new Error('Script code must be a string');
    const limits = resolveLimits(opts.limits);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
      throw new Error('Invalid Script timeoutMs');
    }
    const bindings = bindingsFor(opts.tools);
    const tools = new Map(bindings.map(b => [b.toolName, opts.tools[b.toolName]!]));
    const evaluation = encodeFrame({ type: 'evaluate', code: opts.code, bindings });
    if (performance.now() - startedAt >= timeoutMs) {
      return failure({ origin: 'timeout', message: 'Script total timeout exceeded' });
    }
    const workerArgv = [...selfCommand(SCRIPT_WORKER_COMMAND, new URL('./worker.ts', import.meta.url)), JSON.stringify(limits)];
    let argv = workerArgv;
    const env = { PATH: process.env.PATH ?? '' };
    // Inside a compiled binary the module directory is virtual; use a real directory instead.
    let cwd = isCompiled() ? tmpdir() : fileURLToPath(new URL('.', import.meta.url));
    if ((opts.sandbox ?? 'best-effort') !== 'off') {
      // The VM context is not a security boundary on its own; the worker process itself runs
      // inside the OS sandbox: read-only system, private /tmp, no network, empty environment.
      scratch = mkdtempSync(join(tmpdir(), 'fab-script-'));
      const wrapped = await wrapCommand(workerArgv, {
        workdir: scratch,
        env,
        mode: opts.sandbox === 'required' ? 'required' : 'best-effort',
      });
      argv = wrapped.argv;
      sandboxed = !wrapped.degraded;
      cwd = scratch;
    }
    if (opts.signal?.aborted) return failure({ origin: 'runtime', message: 'Script aborted' });
    const child = Bun.spawn(argv, {
      env,
      cwd,
      stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
    });

    return await new Promise<RunScriptResult>((resolve) => {
      let finished = false;
      let phase: 'booting' | 'ready' | 'running' = 'booting';
      let outputBytes = 0;
      const pending = new Set<string>();
      const usedIds = new Set<string>();
      let writes = Promise.resolve();
      const calls = new AbortController();
      const finish = (answer: RunScriptResult) => {
        if (finished) return;
        finished = true;
        calls.abort(new Error('Script evaluation ended'));
        clearTimeout(deadline);
        opts.signal?.removeEventListener('abort', abort);
        // SIGKILL also stops synchronous loops and VM microtask starvation.
        try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
        void child.exited.then(() => resolve(answer), () => resolve(answer));
      };
      const fail = (error: unknown) => finish(failure({
        origin: error instanceof RuntimeFailure ? error.origin : 'runtime',
        message: errorMessage(error),
      }));
      const deadline = setTimeout(() => finish(failure({
        origin: 'timeout', message: 'Script total timeout exceeded',
      })), Math.max(0, timeoutMs - (performance.now() - startedAt)));
      const abort = () => finish(failure({ origin: 'runtime', message: 'Script aborted' }));
      opts.signal?.addEventListener('abort', abort, { once: true });
      if (opts.signal?.aborted) abort();

      const write = (frame: unknown) => {
        // Serialize before enqueueing; callbacks cannot change the queued payload.
        let data: string;
        try { data = encodeFrame(frame); } catch (error) { fail(error); return; }
        writes = writes.then(async () => {
          if (finished) return;
          child.stdin.write(data);
          await child.stdin.flush();
        }).catch(fail);
      };
      const charge = (bytes: number) => {
        outputBytes += bytes;
        if (outputBytes > limits.maxOutputBytes) {
          throw new RuntimeFailure('output_limit', 'Script output limit exceeded');
        }
      };
      const dispatch = (frame: Record<string, unknown>) => {
        const { toolName, toolUseId } = frame;
        if (typeof toolName !== 'string' || typeof toolUseId !== 'string' || !toolUseId ||
            usedIds.has(toolUseId) || !tools.has(toolName) || !Object.hasOwn(frame, 'input')) {
          throw new Error('Invalid Script tool call');
        }
        if (pending.size >= limits.maxPendingCalls) throw new Error('Script pending tool call limit exceeded');
        usedIds.add(toolUseId);
        pending.add(toolUseId);
        void Promise.resolve().then(() => {
          if (finished) return;
          return tools.get(toolName)!(frame.input, { signal: calls.signal });
        }).then(value => {
          if (!finished) write({ type: 'tool_result', toolUseId, isError: false, content: value ?? null });
        }, error => {
          if (!finished) write({ type: 'tool_result', toolUseId, isError: true, content: errorMessage(error) });
        }).finally(() => pending.delete(toolUseId)).catch(fail);
      };

      void (async () => {
        try {
          for await (const frame of readFrames(child.stdout)) {
            if (finished) break;
            if (frame.type === 'ready') {
              if (phase !== 'booting' || frame.protocolVersion !== 1) throw new Error('Invalid Script handshake');
              phase = 'ready';
              // The only evaluation ever sent to this process.
              writes = writes.then(async () => {
                if (finished) return;
                child.stdin.write(evaluation);
                await child.stdin.flush();
              }).catch(fail);
              continue;
            }
            if (frame.type === 'error') {
              if (!record(frame.error) || !['program', 'runtime', 'output_limit'].includes(String(frame.error.origin)) ||
                  typeof frame.error.message !== 'string') throw new Error('Invalid Script error frame');
              finish(failure(frame.error as unknown as ScriptError));
              break;
            }
            if (frame.type === 'evaluation_started') {
              if (phase !== 'ready') throw new Error('Unexpected Script evaluation');
              phase = 'running';
              continue;
            }
            if (phase !== 'running') throw new Error('Script frame received before evaluation');
            switch (frame.type) {
              case 'tool_call': dispatch(frame); break;
              case 'content': {
                if (!isContent(frame.content)) throw new Error('Invalid Script content frame');
                charge(contentBytes(frame.content));
                content.push(frame.content);
                break;
              }
              case 'notify': {
                if (typeof frame.message !== 'string' || !frame.message.trim()) throw new Error('Invalid Script notification');
                charge(Buffer.byteLength(JSON.stringify(frame.message)));
                notifications.push(frame.message);
                break;
              }
              case 'result': {
                if (!Object.hasOwn(frame, 'output')) throw new Error('Missing Script result');
                if (Buffer.byteLength(JSON.stringify(frame.output)) > limits.maxResultBytes) {
                  throw new RuntimeFailure('output_limit', 'Script result limit exceeded');
                }
                finish({ ok: true, output: frame.output, content, notifications, sandboxed });
                break;
              }
              default: throw new Error('Unknown Script worker frame');
            }
          }
          if (!finished) fail(new Error('Script worker exited without a terminal frame'));
        } catch (error) { fail(error); }
      })();
    });
  } catch (error) {
    return failure({ origin: error instanceof RuntimeFailure ? error.origin : 'runtime', message: errorMessage(error) });
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
