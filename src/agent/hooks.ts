import { runScript } from '../script-runtime/index.ts';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrapCommand } from '../sandbox/index.ts';
import type { ExecutionPolicy } from './execution-policy.ts';
import type { AgentEvent } from './types.ts';

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'SessionStart' | 'SessionEnd';
const events = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd'];
const ignored = ['Notification', 'SubagentStop', 'PreCompact'];
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
interface Group { matcher?: RegExp; commandRegex?: RegExp; hooks: Array<{ command: string; timeout: number }> }
export interface HookDecision { deny?: boolean; ask?: boolean; allow?: boolean; block?: boolean; reason?: string; updatedInput?: unknown; context: string[] }

/** Adapter keeps settings.ts under its owner's control; validates/removes only our opt-in field. */
export async function hookSettings<T>(path: string | undefined, load: (path?: string) => Promise<T>): Promise<{ settings: T; enabled: boolean }> {
  if (!path) return { settings: await load(), enabled: false };
  const data = await readFile(path); if (data.length > 1024 * 1024) throw new Error('Settings file exceeds 1 MiB');
  let raw: any; try { raw = JSON.parse(data.toString('utf8')); } catch { return { settings: await load(path), enabled: false }; }
  if (!object(raw) || !Object.hasOwn(raw, 'hooks')) return { settings: await load(path), enabled: false };
  if (!object(raw.hooks) || Object.keys(raw.hooks).some(k => k !== 'enabled') || typeof raw.hooks.enabled !== 'boolean') throw new Error('Invalid hooks settings');
  const enabled = raw.hooks.enabled; delete raw.hooks;
  const dir = await mkdtemp(join(tmpdir(), 'fab-hook-settings-'));
  try { const file = join(dir, 'settings.json'); await writeFile(file, JSON.stringify(raw), { mode: 0o600 }); return { settings: await load(file), enabled }; }
  finally { await rm(dir, { recursive: true, force: true }); }
}

export class Hooks {
  private groups = new Map<string, Group[]>();
  private controller = new AbortController();
  private active = new Set<Promise<unknown>>();
  private messages: string[] = [];
  context(messages: string[]) { this.messages.push(...messages); }
  takeContext() { return this.messages.splice(0); }
  private started = false;
  private ended = false;
  private readOnly = false;
  restrictWorkspace(readOnly: boolean) { this.readOnly = readOnly; }
  constructor(readonly cwd: string, readonly sessionId: string, private policy: ExecutionPolicy,
    private emit: (event: AgentEvent) => void, private warn: (message: string) => void = message => console.error(message)) {}
  async load() {
    const home = process.env.FABRICA_HOME ?? join(process.env.HOME ?? '.', '.fabrica');
    for (const path of [join(home, 'hooks.json'), join(this.cwd, '.fab/hooks.json')]) {
      let bytes: Buffer; try { bytes = await readFile(path); } catch (e: any) { if (e.code === 'ENOENT') continue; throw e; }
      if (bytes.length > 1024 * 1024) throw new Error('Hooks file exceeds 1 MiB');
      let raw: unknown; try { raw = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid hooks JSON'); }
      if (!object(raw)) throw new Error('Invalid hooks configuration');
      for (const [event, values] of Object.entries(raw)) {
        if (![...events, ...ignored].includes(event) || !Array.isArray(values)) throw new Error('Invalid hooks event or groups');
        let count = (this.groups.get(event) ?? []).reduce((n, g) => n + g.hooks.length, 0);
        for (const value of values) {
          if (!object(value) || Object.keys(value).some(k => !['matcher', 'commandRegex', 'hooks'].includes(k)) ||
              !Array.isArray(value.hooks) || ['matcher', 'commandRegex'].some(k => value[k] !== undefined && (typeof value[k] !== 'string' || value[k].length > 256))) throw new Error('Invalid hooks group');
          const hooks = value.hooks.map(h => {
            if (!object(h) || Object.keys(h).some(k => !['type', 'command', 'timeout'].includes(k)) || h.type !== 'command' ||
                typeof h.command !== 'string' || !h.command.trim() || h.command.length > 16384 ||
                h.timeout !== undefined && (typeof h.timeout !== 'number' || !Number.isFinite(h.timeout) || h.timeout <= 0 || h.timeout > 60)) throw new Error('Invalid command hook');
            if (++count > 8) throw new Error('At most 8 hooks per event');
            return { command: h.command, timeout: h.timeout ?? 60 };
          });
          try {
            const group: Group = { hooks, matcher: value.matcher && value.matcher !== '*' ? new RegExp('^(?:' + value.matcher + ')$') : undefined,
              commandRegex: value.commandRegex ? new RegExp(value.commandRegex) : undefined };
            this.groups.set(event, [...this.groups.get(event) ?? [], group]);
          } catch { this.warn('Ignoring hook group with invalid regex: ' + event); }
        }
        if (ignored.includes(event)) this.warn('Hook event accepted but not executed: ' + event);
      }
    }
    return this;
  }
  private async command(command: string, timeout: number, input: unknown, signal: AbortSignal) {
    let argv = ['/bin/sh', '-c', command];
    let env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', FAB_PROJECT_DIR: this.cwd, FAB_SESSION_ID: this.sessionId };
    if (this.policy.execution === 'sandbox') {
      const wrapped = await wrapCommand(argv, { workdir: this.cwd, env, mode: 'required', allowNetwork: false, readOnlyPaths: this.readOnly ? [this.cwd] : [] }); argv = wrapped.argv; env = wrapped.env;
    }
    signal.throwIfAborted();
    return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd: this.cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '', remaining = 65536, spawnError: unknown;
      const stop = () => { try { if (process.platform === 'win32') child.kill('SIGKILL'); else if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
      let pipes: ReturnType<typeof setTimeout> | undefined;
      const settlePipes = () => { pipes ??= setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 100); };
      const timer = setTimeout(() => { stop(); settlePipes(); }, timeout * 1000);
      signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
      const retain = (chunk: Buffer, stderr: boolean) => { const data = chunk.subarray(0, remaining).toString('utf8'); remaining -= Math.min(chunk.length, remaining); if (stderr) err += data; else out += data; };
      child.stdout.on('data', part => retain(part, false)); child.stderr.on('data', part => retain(part, true));
      child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input));
      child.on('error', error => { spawnError = error; });
      child.once('exit', () => { stop(); settlePipes(); });
      child.once('close', code => {
        clearTimeout(timer); clearTimeout(pipes); signal.removeEventListener('abort', stop);
        if (spawnError) reject(spawnError); else resolve({ exitCode: code ?? -1, stdout: out, stderr: err });
      });
    });
  }
  async fire(event: HookEvent, fields: Record<string, unknown>, signal: AbortSignal, ending = false): Promise<HookDecision> {
    const combined = ending ? signal : AbortSignal.any([signal, this.controller.signal]);
    const result: HookDecision = { context: [] };
    for (const group of this.groups.get(event) ?? []) {
      const checks = [[group.matcher?.source, String(fields.tool_name ?? '')], [group.commandRegex?.source, String((fields.tool_input as any)?.command ?? '')]].filter(p => p[0] !== undefined);
      if (checks.length) {
        const matched = await runScript({ code: `return ${JSON.stringify(checks)}.every(([pattern,subject]) => new RegExp(pattern).test(subject));`, tools: {}, timeoutMs: 500, signal: combined, sandbox: 'required' });
        combined.throwIfAborted();
        if (!matched.ok) throw new Error('Hook matcher failed or exceeded its execution budget');
        if (!matched.output) continue;
      }
      for (const hook of group.hooks) {
        combined.throwIfAborted(); const start = performance.now();
        const work = this.command(hook.command, ending ? Math.min(1, hook.timeout) : hook.timeout,
          { ...fields, session_id: this.sessionId, cwd: this.cwd, permission_mode: this.policy.permissionMode, hook_event_name: event }, combined);
        this.active.add(work);
        let output: Awaited<typeof work>;
        try { output = await work; } catch (e) { if (combined.aborted) throw e; this.warn('Hook failed to start: ' + event); continue; }
        finally { this.active.delete(work); }
        combined.throwIfAborted();
        let raw: any; try { raw = JSON.parse(output.stdout); } catch { /* stdout may be plain additional context */ }
        if (raw !== undefined && (!object(raw) || Object.keys(raw).some(k => !['continue', 'suppressOutput', 'decision', 'reason', 'hookSpecificOutput'].includes(k)) ||
            raw.continue !== undefined && typeof raw.continue !== 'boolean' || raw.suppressOutput !== undefined && typeof raw.suppressOutput !== 'boolean' ||
            raw.decision !== undefined && raw.decision !== 'block' || raw.reason !== undefined && typeof raw.reason !== 'string' ||
            raw.hookSpecificOutput !== undefined && (!object(raw.hookSpecificOutput) || Object.keys(raw.hookSpecificOutput).some(k => !['permissionDecision', 'updatedInput', 'additionalContext'].includes(k)) ||
              raw.hookSpecificOutput.permissionDecision !== undefined && !['allow', 'deny', 'ask'].includes(raw.hookSpecificOutput.permissionDecision) ||
              raw.hookSpecificOutput.additionalContext !== undefined && typeof raw.hookSpecificOutput.additionalContext !== 'string'))) { this.warn('Ignoring invalid hook JSON output: ' + event); raw = undefined; }
        const specific = raw?.hookSpecificOutput;
        const blocking = output.exitCode === 2 || raw?.decision === 'block' || raw?.continue === false;
        if (output.exitCode === 0 || output.exitCode === 2) {
          result.block ||= blocking;
          result.deny ||= specific?.permissionDecision === 'deny'; result.ask ||= specific?.permissionDecision === 'ask'; result.allow ||= specific?.permissionDecision === 'allow';
          result.reason = raw?.reason ?? (blocking ? output.stderr.trim() || 'Blocked by hook' : result.reason);
          if (event === 'PreToolUse' && specific && Object.hasOwn(specific, 'updatedInput')) result.updatedInput = specific.updatedInput;
          const context = raw?.suppressOutput ? undefined : specific?.additionalContext ?? (output.exitCode === 0 && ['UserPromptSubmit', 'SessionStart'].includes(event) && !raw ? output.stdout.trim() : undefined);
          if (context) result.context.push(context);
        }
        this.emit({ type: 'hook', sessionId: this.sessionId, event, command: hook.command, exitCode: output.exitCode,
          decision: result.deny ? 'deny' : result.block ? 'block' : result.ask ? 'ask' : result.allow ? 'allow' : undefined, durationMs: performance.now() - start });
      }
    }
    return result;
  }
  async start(signal: AbortSignal) { if (this.started) return { context: [] }; this.started = true; return this.fire('SessionStart', {}, signal); }
  async close() {
    if (this.ended) return; this.ended = true; this.controller.abort(new Error('Hook session closed'));
    await Promise.allSettled([...this.active]);
    await this.fire('SessionEnd', {}, AbortSignal.timeout(1000), true).catch(() => {});
  }
}
