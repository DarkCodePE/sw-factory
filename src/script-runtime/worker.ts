import vm from 'node:vm';
import { BOOTSTRAP } from './bootstrap.ts';
import {
  MAX_FRAME_BYTES, RuntimeFailure, contentBytes, encodeFrame, errorMessage,
  isContent, readFrames, record, resolveLimits,
} from './protocol.ts';
import type { ResolvedLimits, ScriptErrorOrigin, ToolBinding } from './types.ts';

interface VmControl {
  observe(value: unknown): void;
  deliver(encoded: string): void;
  fire(timerId: number): void;
}

const writer = Bun.stdout.writer();
let terminal = false;
let evaluated = false;
let complete = false;
let output: unknown = null;
let outputBytes = 0;
let idleScheduled = false;
let limits: ResolvedLimits;
let control: VmControl;
const pending = new Set<string>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let toolNames = new Set<string>();

function send(frame: unknown): void {
  writer.write(encodeFrame(frame));
  void Promise.resolve(writer.flush()).catch(() => process.exit(1));
}

function finish(frame: unknown): void {
  if (terminal) return;
  terminal = true;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  try {
    writer.write(encodeFrame(frame));
    void Promise.resolve(writer.flush()).then(() => process.exit(0), () => process.exit(1));
  } catch { process.exit(1); }
}

function fail(origin: ScriptErrorOrigin, message: string): void {
  // A hostile thrown value can have an enormous message; terminal diagnostics stay bounded.
  finish({ type: 'error', error: { origin, message: message.slice(0, 4096) } });
}

function idle(): void {
  if (terminal || idleScheduled) return;
  idleScheduled = true;
  setImmediate(() => {
    idleScheduled = false;
    if (complete && pending.size === 0 && timers.size === 0 && !terminal) {
      finish({ type: 'result', output });
    }
  });
}

function charge(bytes: number): void {
  outputBytes += bytes;
  if (outputBytes > limits.maxOutputBytes) {
    throw new RuntimeFailure('output_limit', 'Script output limit exceeded');
  }
}

/** Host callback returns primitives only, including on failure. It never throws into the VM. */
function bridge(encoded: unknown): string | null {
  if (terminal) return 'Script has finished';
  try {
    if (typeof encoded !== 'string') throw new Error('Invalid Script bridge request');
    if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) {
      throw new RuntimeFailure('output_limit', 'Script frame exceeds 10 MiB');
    }
    const frame: unknown = JSON.parse(encoded);
    if (!record(frame)) throw new Error('Invalid Script bridge frame');
    switch (frame.type) {
      case 'tool_call': {
        if (typeof frame.toolUseId !== 'string' || !frame.toolUseId || pending.has(frame.toolUseId) ||
            typeof frame.toolName !== 'string' || !toolNames.has(frame.toolName) || !Object.hasOwn(frame, 'input')) {
          throw new Error('Invalid Script tool call');
        }
        if (pending.size >= limits.maxPendingCalls) throw new Error('Script pending tool call limit exceeded');
        pending.add(frame.toolUseId);
        send(frame);
        break;
      }
      case 'content': {
        if (!isContent(frame.content)) throw new Error('Invalid Script content');
        charge(contentBytes(frame.content));
        send(frame);
        break;
      }
      case 'notify': {
        if (typeof frame.message !== 'string' || !frame.message.trim()) throw new Error('Invalid Script notification');
        charge(Buffer.byteLength(JSON.stringify(frame.message)));
        send(frame);
        break;
      }
      case 'schedule_timer': {
        const { timerId, delay } = frame;
        if (typeof timerId !== 'number' || !Number.isSafeInteger(timerId) || timers.has(timerId) ||
            typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || delay > 86_400_000) {
          throw new Error('Invalid Script timer');
        }
        if (timers.size >= limits.maxTimers) throw new Error('Script timer limit exceeded');
        const timer = setTimeout(() => {
          if (!terminal) {
            try { control.fire(timerId); } catch (error) { fail('program', errorMessage(error)); }
          }
        }, delay);
        timers.set(timerId, timer);
        break;
      }
      case 'timer_done':
        if (typeof frame.timerId !== 'number' || !timers.delete(frame.timerId)) throw new Error('Unknown Script timer');
        idle();
        break;
      case 'program_complete': {
        output = frame.output ?? null;
        if (Buffer.byteLength(JSON.stringify(output)) > limits.maxResultBytes) {
          throw new RuntimeFailure('output_limit', 'Script result limit exceeded');
        }
        complete = true;
        idle();
        break;
      }
      case 'program_error':
        if (typeof frame.message !== 'string') throw new Error('Invalid Script program error');
        fail('program', frame.message);
        break;
      default: throw new Error('Unknown Script bridge request');
    }
    return null;
  } catch (error) {
    const message = errorMessage(error);
    fail(error instanceof RuntimeFailure ? error.origin : 'runtime', message);
    return message;
  }
}

function bindingsFrom(value: unknown): ToolBinding[] {
  if (!Array.isArray(value)) throw new Error('Invalid Script bindings');
  const paths = new Set<string>();
  for (const binding of value) {
    if (!record(binding) || typeof binding.toolName !== 'string' || !Array.isArray(binding.path) ||
        !binding.path.length || binding.path.some((p: unknown) => typeof p !== 'string' ||
          !p || ['__proto__', 'prototype', 'constructor'].includes(p))) throw new Error('Invalid Script binding');
    const path = JSON.stringify(binding.path);
    if (paths.has(path)) throw new Error('Duplicate Script binding');
    paths.add(path);
  }
  for (const binding of value) {
    for (let i = 1; i < binding.path.length; i++) {
      if (paths.has(JSON.stringify(binding.path.slice(0, i)))) throw new Error('Conflicting Script bindings');
    }
  }
  return value as ToolBinding[];
}

function script(code: string): vm.Script {
  const options: vm.ScriptOptions = {
    filename: 'script.js',
    // A host Error rejection would expose its host Function constructor to user code.
    importModuleDynamically() { throw 'Script imports are disabled'; },
  };
  // Bun compiles vm.Script lazily. Choose the wrapper before executing anything,
  // rather than retrying a script that might itself have thrown a SyntaxError.
  const source = /\b(?:await|return)\b/.test(code) ? `(async () => {\n${code}\n})()` : code;
  return new vm.Script(source, options);
}

function evaluate(frame: Record<string, unknown>): void {
  if (evaluated) throw new Error('Script accepts one evaluation');
  evaluated = true;
  if (typeof frame.code !== 'string') throw new Error('Invalid Script code');
  const bindings = bindingsFrom(frame.bindings);
  toolNames = new Set(bindings.map(b => b.toolName));
  const globals = Object.create(null);
  globals.__scriptBootstrap = bridge;
  globals.__scriptBindings = JSON.stringify(bindings);
  const context = vm.createContext(globals, { codeGeneration: { strings: false, wasm: false } });
  control = new vm.Script(BOOTSTRAP, { filename: 'script-bootstrap.js' }).runInContext(context) as VmControl;
  send({ type: 'evaluation_started' });
  try {
    // Never await a VM thenable in the host: it could receive host resolve/reject functions.
    control.observe(script(frame.code).runInContext(context));
  } catch (error) { fail('program', errorMessage(error)); }
}

/** Worker entry point; the compiled fab binary calls it for its hidden `__script-worker` subcommand. */
export async function runScriptWorker(encodedLimits = process.argv[2]): Promise<void> {
  try {
    limits = resolveLimits(JSON.parse(encodedLimits ?? '{}'));
    process.on('unhandledRejection', error => fail('program', errorMessage(error)));
    process.on('uncaughtException', error => fail('program', errorMessage(error)));
    send({ type: 'ready', protocolVersion: 1 });
    for await (const frame of readFrames(Bun.stdin.stream())) {
      if (terminal) break;
      if (frame.type === 'evaluate') evaluate(frame);
      else if (frame.type === 'tool_result') {
        if (!evaluated || typeof frame.toolUseId !== 'string' || !pending.delete(frame.toolUseId) ||
            typeof frame.isError !== 'boolean' || !Object.hasOwn(frame, 'content')) {
          throw new Error('Invalid Script tool result');
        }
        // Parse in the VM so host data/prototypes never cross the context boundary.
        control.deliver(JSON.stringify(frame));
        idle();
      } else throw new Error('Unknown Script parent frame');
    }
    if (!terminal) fail('runtime', 'Script input closed before evaluation completed');
  } catch (error) {
    fail(error instanceof RuntimeFailure ? error.origin : 'runtime', errorMessage(error));
  }
}

if (import.meta.main) void runScriptWorker();
