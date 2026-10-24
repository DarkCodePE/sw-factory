import { scopedExecutionOptions, resolveExecutionPolicy, type ExecutionPolicy, type PermissionMode } from './execution-policy.ts';
import { isAutoProvider } from './providers/auto.ts';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomicReplace, readAnchored, readWorkspaceFile, unlinkAnchored, withWorkspaceFile } from './files.ts';
import { runProcess } from './process.ts';
import { wrapCommand } from '../sandbox/index.ts';
import { inputObject, stringArg, tool } from './tools.ts';
import type { AgentOptions, AgentResult, AgentTool, ToolContext } from './types.ts';
import type { SessionState } from './session.ts';

const SNAPSHOT_MAX_FILE_BYTES = 16 * 1024 * 1024;

export class AgentBudget {
  agents = 0;
  calls = 0;
  running = 0;
  constructor(readonly maxAgents: number, readonly maxCalls: number, readonly maxConcurrent = 2) {}
  /** Calls promised to a run that has not spent them yet; other work cannot consume them. */
  reservedCalls = 0;
  get freeCalls() { return this.maxCalls - this.calls - this.reservedCalls; }
  /**
   * Count one model call or mission Loop invocation. A call inside a reserved run is paid from that reservation first;
   * any other call may only use capacity nobody has reserved.
   */
  modelCall(reservation?: CallReservation) {
    if (reservation && reservation.remaining > 0) { reservation.remaining--; this.reservedCalls--; this.calls++; return; }
    if (this.freeCalls <= 0) throw new Error('Shared model-call budget exhausted');
    this.calls++;
  }
  /** Reserve calls up front so a run never starts effects it cannot afford to verify. */
  reserveCalls(n: number): CallReservation {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid model-call reservation');
    if (n > this.freeCalls) throw new Error(`Insufficient shared model-call budget: need ${n}, ${this.freeCalls} available`);
    this.reservedCalls += n;
    const reservation: CallReservation = { remaining: n, release: () => { this.reservedCalls -= reservation.remaining; reservation.remaining = 0; } };
    return reservation;
  }
  reserveAgent() {
    if (this.agents >= this.maxAgents || this.running >= this.maxConcurrent) throw new Error('Shared subagent budget or concurrency exhausted');
    this.agents++; this.running++;
  }
  releaseAgent() { this.running--; }
}
export interface CallReservation { remaining: number; release(): void }
export interface AgentLineage { permissionMode?: PermissionMode; depth: number; budget: AgentBudget; reservation?: CallReservation }
export interface ProcessTaskRecord {
  kind: 'process';
  id: string;
  pid: number;
  command: string;
  description: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  controller: AbortController;
  done: Promise<void>;
  stdoutFile: string;
  stderrFile: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  sandboxed?: boolean;
  sandboxReason?: string;
  network?: { requested: boolean; enabled: boolean; access?: string };
  readStdout(): Promise<string>;
  readStderr(): Promise<string>;
  stop(): Promise<void>;
}

export interface SubagentTaskRecord {
  kind?: 'subagent';
  executionPolicy?: ExecutionPolicy;
  id: string;
  description: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  controller: AbortController;
  done: Promise<void>;
  cwd?: string;
  result?: AgentResult;
  error?: string;
  mailbox: string[];
  diff?: string;
}

export interface RecordedProcessTask {
  kind: 'recorded';
  id: string;
  pid: number;
  command: string;
  description: string;
  status: 'completed' | 'failed' | 'cancelled';
  exitCode?: number | null;
}

export type AnyTaskRecord = SubagentTaskRecord | ProcessTaskRecord | RecordedProcessTask;

export interface SpawnProcessOptions {
  command: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  sandboxed: boolean;
  sandboxReason: string;
  permissionMode?: PermissionMode;
  network?: { requested: boolean; enabled: boolean; access?: string };
  description?: string;
}

function resolveSessionHome(cwd: string, sessionDir?: string, sessionId?: string): string {
  const id = sessionId ?? crypto.randomUUID();
  if (sessionDir) {
    const candidate = resolve(sessionDir);
    const r = relative(cwd, candidate);
    const inside = !r || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r));
    if (!inside) return join(candidate, id);
  }
  return join(tmpdir(), 'fab-session-' + id);
}
const env = () => ({ PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });

/** Disposable child checkout outside the parent's writable workspace. Copy the
 * current tracked/untracked state, including deletions, rather than silently
 * executing against HEAD when the parent is dirty. Never copy ignored secrets,
 * hooks or Git configuration. Child changes are returned for explicit integration. */
async function snapshotWorkspace(cwd: string, signal: AbortSignal): Promise<{ cwd: string; baseline: string }> {
  const container = await mkdtemp(join(tmpdir(), 'fab-subagent-')), destination = join(container, 'workspace');
  const git = async (args: string[], dir = cwd, bytes = 2 * 1024 * 1024) => {
    const wrapped = await wrapCommand(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', ...args], {
      workdir: dir, mode: 'required', env: env(), allowNetwork: false,
      readOnlyPaths: dir === cwd ? [cwd] : [], writablePaths: dir === cwd ? [container] : [],
    });
    const r = await runProcess(wrapped.argv, dir, wrapped.env, signal, bytes);
    if (r.exitCode) throw new Error('Subagent workspace preparation failed: ' + r.stderr.slice(0, 1000));
    return r.stdout;
  };
  const files = [...new Set((await git(['ls-tree', '-r', '--name-only', '-z', 'HEAD']) + await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean))];
  if (files.length > 10_000) throw new Error('Subagent snapshot exceeds file-count budget');
  const contents: Array<{ path: string; data?: Buffer; mode?: number }> = [];
  let bytes = 0;
  for (const path of files) {
    signal.throwIfAborted();
    try {
      const source = await withWorkspaceFile(cwd, path, false, (parent, name) => readAnchored(parent, name, SNAPSHOT_MAX_FILE_BYTES));
      bytes += source.data.byteLength;
      if (bytes > 32 * 1024 * 1024) throw new Error('Subagent snapshot exceeds 32 MiB');
      contents.push({ path, data: source.data, mode: source.mode });
    } catch (e: any) { if (e.code !== 'ENOENT') throw e; contents.push({ path }); }
  }
  await git(['-c', 'protocol.file.allow=always', 'clone', '--quiet', '--depth', '1', '--no-tags', '--no-hardlinks', '--no-local', '--no-checkout', '--', cwd, destination]);
  // Remove inherited URL before a model can run commands. Each clone owns its Git metadata.
  await git(['remote', 'remove', 'origin'], destination);
  await git(['checkout', '--quiet', '--detach', 'HEAD'], destination);
  for (const { path, data, mode } of contents) {
    signal.throwIfAborted();
    try {
      if (!data) { const error = new Error('Deleted source path'); Object.assign(error, { code: 'ENOENT' }); throw error; }
      await withWorkspaceFile(destination, path, true, (parent, name) =>
        atomicReplace(parent, name, data, signal, mode, false, SNAPSHOT_MAX_FILE_BYTES));
    } catch (e: any) {
      // Deleted tracked paths must be deleted in the child too. Other failures,
      // including symlinks and oversized files, fail closed without a stale copy.
      if (e.code !== 'ENOENT') throw e;
      await withWorkspaceFile(destination, path, false, (parent, name) => unlinkAnchored(parent, name)).catch((e: any) => { if (e.code !== 'ENOENT') throw e; });
    }
  }
  // Dependency trees stay read-only to child commands through the OS sandbox.
  // They are not followed by the file tools (which reject symlink traversal).
  const { lstat } = await import('node:fs/promises');
  if (await lstat(join(cwd, 'node_modules')).then(s => s.isDirectory(), () => false)) {
    await symlink(join(cwd, 'node_modules'), join(destination, 'node_modules')).catch((e: any) => { if (e.code !== 'EEXIST') throw e; });
  }
  await git(['add', '--all', '--'], destination);
  const baseline = (await git(['write-tree'], destination)).trim();
  return { cwd: destination, baseline };
}

/** Invocation-owned tasks. Foreground and background tasks share the parent's
 * hard call/agent/depth limits. Shutdown aborts and drains all children. */
export class TaskManager {
  private tasks = new Map<string, SubagentTaskRecord>();
  private processTasks = new Map<string, ProcessTaskRecord>();
  private recordedTasks = new Map<string, RecordedProcessTask>();
  private closed = false;
  private running = 0;
  private runningProcesses = 0;
  private readonly maxProcessConcurrency: number;
  private readonly maxProcessOutputBytes: number;
  private readonly sessionHome: string;

  constructor(private readonly parent: AgentOptions, private readonly context: ToolContext,
    private readonly lineage: AgentLineage, private readonly runChild: (options: AgentOptions, reservation?: CallReservation) => Promise<AgentResult>,
    private readonly maxDepth: number, private readonly concurrency: number,
    maxProcessConcurrency = 4, maxProcessOutputBytes = 1024 * 1024, sessionHome?: string,
    private readonly sessionState?: Partial<SessionState>) {
    this.maxProcessConcurrency = maxProcessConcurrency;
    this.maxProcessOutputBytes = maxProcessOutputBytes;
    this.sessionHome = resolveSessionHome(context.cwd, sessionHome ?? parent.sessionDir, parent.sessionId);
    if (sessionState?.backgroundTasks) {
      for (const p of sessionState.backgroundTasks) {
        this.recordedTasks.set(p.taskId, {
          kind: 'recorded',
          id: p.taskId,
          pid: p.pid ?? 0,
          command: p.command,
          description: p.command.slice(0, 100),
          status: p.status === 'running' ? 'cancelled' : p.status,
          exitCode: p.exitCode,
        });
      }
    }
  }

  private get(id: string): AnyTaskRecord {
    const task = this.tasks.get(id) ?? this.processTasks.get(id) ?? this.recordedTasks.get(id);
    if (!task) throw new Error('Unknown task ID');
    return task;
  }

  private async view(t: AnyTaskRecord, block = false) {
    if ('kind' in t && t.kind === 'recorded') {
      return {
        task_id: t.id,
        taskId: t.id,
        pid: t.pid,
        command: t.command,
        description: t.description,
        status: t.status,
        exitCode: t.exitCode ?? 0,
        output: '',
      };
    }
    if ('kind' in t && t.kind === 'process') {
      if (block) await t.done;
      const stdout = await t.readStdout();
      const stderr = await t.readStderr();
      return {
        task_id: t.id,
        taskId: t.id,
        pid: t.pid,
        command: t.command,
        description: t.description,
        status: t.status,
        exitCode: t.exitCode !== undefined ? t.exitCode : (t.status === 'running' ? null : 0),
        stdout,
        stderr,
        output: stdout + (stderr ? (stdout ? '\n' : '') + stderr : ''),
        sandboxed: t.sandboxed,
        sandboxReason: t.sandboxReason,
        network: t.network,
        ...(t.error ? { error: t.error } : {}),
      };
    }
    const sub = t as SubagentTaskRecord;
    if (block) await sub.done;
    return {
      executionPolicy: sub.executionPolicy,
      task_id: sub.id,
      taskId: sub.id,
      agentId: sub.id,
      description: sub.description,
      status: sub.status,
      cwd: sub.cwd,
      ...(sub.result ? { result: sub.result } : {}),
      ...(sub.error ? { error: sub.error } : {}),
      ...(sub.diff ? { diff: sub.diff } : {}),
      mailbox: [...sub.mailbox],
    };
  }

  private syncSessionState() {
    if (!this.sessionState) return;
    const tasks: Array<{ taskId: string; pid?: number; command: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; exitCode?: number | null }> = [];
    for (const rec of this.recordedTasks.values()) {
      tasks.push({ taskId: rec.id, pid: rec.pid, command: rec.command, status: rec.status, exitCode: rec.exitCode });
    }
    for (const p of this.processTasks.values()) {
      tasks.push({ taskId: p.id, pid: p.pid, command: p.command, status: p.status, exitCode: p.exitCode });
    }
    this.sessionState.backgroundTasks = tasks;
  }

  async spawnProcess(opts: SpawnProcessOptions): Promise<{ taskId: string; pid: number; status: 'running' }> {
    if (this.closed) throw new Error('Task manager is closed');
    if (this.runningProcesses >= this.maxProcessConcurrency) {
      throw new Error(`Background process limit reached (maximum ${this.maxProcessConcurrency} concurrent processes)`);
    }
    const id = crypto.randomUUID();
    const tasksDir = join(this.sessionHome, 'tasks');
    await mkdir(tasksDir, { recursive: true, mode: 0o700 });
    const stdoutFile = join(tasksDir, `${id}.stdout`);
    const stderrFile = join(tasksDir, `${id}.stderr`);

    const stdoutStream = createWriteStream(stdoutFile, { flags: 'a', mode: 0o600 });
    const stderrStream = createWriteStream(stderrFile, { flags: 'a', mode: 0o600 });

    const controller = new AbortController();
    const signal = AbortSignal.any([this.context.signal, controller.signal]);

    let totalBytes = 0;
    let truncated = false;
    const maxBytes = this.maxProcessOutputBytes;

    const child = spawn(opts.argv[0]!, opts.argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (err) => reject(err));
    });

    const pid = child.pid!;
    this.runningProcesses++;

    const kill = (sig: 'SIGTERM' | 'SIGKILL') => {
      try {
        if (process.platform !== 'win32' && pid) process.kill(-pid, sig);
      } catch {}
      try {
        child.kill(sig);
      } catch {}
      try {
        if (pid) process.kill(pid, sig);
      } catch {}
    };

    let exited = false;
    const closeStreams = () => new Promise<void>((res) => {
      let pending = 2;
      const doneOne = () => {
        if (--pending <= 0) res();
      };
      try { stdoutStream.end(doneOne); } catch { doneOne(); }
      try { stderrStream.end(doneOne); } catch { doneOne(); }
    });

    const destroyPipes = () => {
      try { child.stdout?.destroy(); } catch {}
      try { child.stderr?.destroy(); } catch {}
    };

    const done = new Promise<void>((resolve) => {
      let exitTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = async (code: number | null, signalName: string | null) => {
        if (exited) return;
        exited = true;
        if (exitTimer) clearTimeout(exitTimer);
        this.runningProcesses--;
        signal.removeEventListener('abort', onAbort);
        record.exitCode ??= code;
        record.signal ??= signalName;
        if (record.status === 'running') {
          record.status = signal.aborted ? 'cancelled' : record.exitCode === 0 ? 'completed' : 'failed';
        }
        await closeStreams();
        this.syncSessionState();
        resolve();
      };

      const onAbort = () => {
        if (exited) return;
        kill('SIGTERM');
        setTimeout(() => {
          if (!exited) {
            kill('SIGKILL');
            destroyPipes();
            finish(null, 'SIGKILL');
          }
        }, 200);
      };

      signal.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (part: Buffer) => {
        if (totalBytes < maxBytes) {
          const toWrite = part.subarray(0, maxBytes - totalBytes);
          stdoutStream.write(toWrite);
          totalBytes += toWrite.length;
          if (totalBytes >= maxBytes && !truncated) {
            truncated = true;
            stdoutStream.write(Buffer.from('\n[output truncated at limit]\n'));
          }
        }
      });

      child.stderr?.on('data', (part: Buffer) => {
        if (totalBytes < maxBytes) {
          const toWrite = part.subarray(0, maxBytes - totalBytes);
          stderrStream.write(toWrite);
          totalBytes += toWrite.length;
          if (totalBytes >= maxBytes && !truncated) {
            truncated = true;
            stderrStream.write(Buffer.from('\n[output truncated at limit]\n'));
          }
        }
      });

      child.once('exit', (code, signalName) => {
        record.exitCode = code;
        record.signal = signalName;
        exitTimer = setTimeout(() => {
          destroyPipes();
          finish(code, signalName);
        }, 1000);
      });

      child.once('close', (code, signalName) => {
        finish(code, signalName);
      });
    });

    const record: ProcessTaskRecord = {
      kind: 'process',
      id,
      pid,
      command: opts.command,
      description: opts.description ?? opts.command.slice(0, 100),
      status: 'running',
      controller,
      done,
      stdoutFile,
      stderrFile,
      sandboxed: opts.sandboxed,
      sandboxReason: opts.sandboxReason,
      network: opts.network,
      readStdout: async () => {
        try { return await readFile(stdoutFile, 'utf8'); } catch { return ''; }
      },
      readStderr: async () => {
        try { return await readFile(stderrFile, 'utf8'); } catch { return ''; }
      },
      stop: async () => {
        if (record.status !== 'running') return;
        record.status = 'cancelled';
        controller.abort(new Error('Task stopped'));
        kill('SIGTERM');
        const finished = await Promise.race([
          done.then(() => true),
          Bun.sleep(200).then(() => false),
        ]);
        if (!finished) {
          kill('SIGKILL');
          destroyPipes();
        }
        await done;
      },
    };

    this.processTasks.set(id, record);
    this.syncSessionState();
    return { taskId: id, pid, status: 'running' };
  }

  private async spawn(input: unknown, background: boolean, scopeSignal: AbortSignal) {
    const p = inputObject(input), prompt = stringArg(p, 'prompt');
    if (!prompt.trim() || Buffer.byteLength(prompt) > 64 * 1024) throw new Error('Invalid subagent prompt');
    if (this.closed || this.lineage.depth >= this.maxDepth) throw new Error('Subagent delegation depth exhausted');
    if (this.running >= this.concurrency) throw new Error('Subagent concurrency limit reached');
    this.lineage.budget.reserveAgent();
    const controller = new AbortController(), id = crypto.randomUUID();
    const task: SubagentTaskRecord = { id, description: typeof p.description === 'string' ? p.description.slice(0, 1000) : prompt.slice(0, 100),
      status: 'queued', controller, done: Promise.resolve(), mailbox: [] };
    this.tasks.set(id, task); this.running++;
    const signal = AbortSignal.any([this.context.signal, scopeSignal, controller.signal]);
    let ready!: () => void;
    const prepared = new Promise<void>(resolve => { ready = resolve; });
    task.done = (async () => {
      try {
        const snapshot = await snapshotWorkspace(this.context.cwd, signal);
        task.cwd = snapshot.cwd; signal.throwIfAborted(); task.status = 'running'; ready();
        const readonly = p.subagent_type === 'explore' || this.context.interactionMode === 'spec';
        const execution = scopedExecutionOptions(this.context, readonly);
        task.executionPolicy = resolveExecutionPolicy(execution);
        this.parent.onEvent?.({ type: 'agent_spawn', sessionId: this.parent.sessionId ?? '', agentId: id, executionPolicy: task.executionPolicy });
        task.result = await this.runChild({ ...this.parent, cwd: task.cwd, prompt, signal,
          // A child of an auto session classifies on its own instead of inheriting the parent's model.
          provider: isAutoProvider(this.parent.provider) ? this.parent.provider.forSubagent() : this.parent.provider,
          sessionId: undefined, newSessionId: undefined, fork: false,
          // A separate child lock/session and no closure-based host capabilities.
          tools: [], images: undefined, onEvent: this.parent.onEvent, beforeTool: this.parent.beforeTool, afterTool: this.parent.afterTool,
          mission: undefined, missionWorker: undefined, allowExitSpecMode: false,
          onlyTools: this.parent.onlyTools?.filter(n => !['ProposeMission', 'StartMissionRun', 'EndFeatureRun', 'DismissHandoffItems'].includes(n)),
          removeTools: this.parent.removeTools?.filter(n => !['ProposeMission', 'StartMissionRun', 'EndFeatureRun', 'DismissHandoffItems'].includes(n)),
          receiveMessages: () => task.mailbox.splice(0),
          ...execution, sessionDir: join(task.cwd, '.git', 'fab-sessions') });
        task.status = signal.aborted ? 'cancelled' : task.result.ok ? 'completed' : 'failed';
        if (task.status === 'completed') {
          const { lstat, realpath } = await import('node:fs/promises');
          const metadata = join(task.cwd, '.git');
          if (!(await lstat(metadata)).isDirectory() || await realpath(metadata) !== metadata) throw new Error('Child Git metadata is no longer owned');
          const collect = async (args: string[]) => {
            // Child config/attributes/metadata are untrusted after execution. Git may
            // run filters even during add; collection stays in the required sandbox.
            const wrapped = await wrapCommand(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', ...args], {
              workdir: task.cwd!, mode: 'required', env: env(), allowNetwork: false,
            });
            return runProcess(wrapped.argv, task.cwd!, wrapped.env, signal);
          };
          const staged = await collect(['add', '--intent-to-add', '--all', '--']);
          if (staged.exitCode) throw new Error('Cannot collect child changes');
          const r = await collect(['diff', '--no-textconv', '--no-ext-diff', '--binary', snapshot.baseline, '--']);
          if (r.exitCode) throw new Error('Cannot collect child diff');
          task.diff = r.stdout;
        }
      } catch (e) { task.status = signal.aborted ? 'cancelled' : 'failed'; task.error = e instanceof Error ? e.message : String(e); }
      finally { this.running--; this.lineage.budget.releaseAgent(); ready(); }
    })();
    await prepared;
    if (!background) await task.done;
    return this.view(task);
  }

  tools(): AgentTool[] {
    const str = { type: 'string' };
    const properties = { prompt: str, description: str, subagent_type: str, run_in_background: { type: 'boolean' } };
    return [
      tool('Task', 'execute', properties, ['prompt'], async (input, c) => this.spawn(input, inputObject(input).run_in_background === true, c.signal),
        'Delegate bounded work to an independent checkout of the current workspace. Return the report and diff for explicit integration.'),
      tool('SpawnAgent', 'execute', properties, ['prompt'], (input, c) => this.spawn(input, true, c.signal),
        'Start an isolated child agent and return its ID; retrieve output and interrupt it using task tools.'),
      tool('TaskOutput', 'read', { task_id: str, block: { type: 'boolean' } }, ['task_id'], async input => {
        const p = inputObject(input), t = this.get(stringArg(p, 'task_id'));
        const block = p.block !== false;
        return this.view(t, block);
      }, 'Read a delegated task report or background process output; block until completion unless block is false.'),
      tool('TaskStop', 'read', { task_id: str }, ['task_id'], async input => {
        const t = this.get(stringArg(inputObject(input), 'task_id'));
        if ('kind' in t && t.kind === 'process') {
          await t.stop();
          return this.view(t, false);
        }
        if ('kind' in t && t.kind === 'recorded') {
          return this.view(t, false);
        }
        (t as SubagentTaskRecord).controller.abort(new Error('Task stopped'));
        await (t as SubagentTaskRecord).done;
        return this.view(t, true);
      }, 'Cancel and drain an owned task or background process before returning.'),
      tool('InterruptAgent', 'read', { agentId: str }, ['agentId'], async input => {
        const t = this.get(stringArg(inputObject(input), 'agentId'));
        if ('kind' in t && t.kind === 'process') {
          await t.stop();
          return this.view(t, false);
        }
        if ('kind' in t && t.kind === 'recorded') {
          return this.view(t, false);
        }
        (t as SubagentTaskRecord).controller.abort(new Error('Agent interrupted'));
        await (t as SubagentTaskRecord).done;
        return this.view(t, true);
      }, 'Interrupt an owned child agent or background process and await its cleanup.'),
      tool('ListAgents', 'read', {}, [], async () => {
        const all: unknown[] = [];
        for (const t of this.tasks.values()) all.push(await this.view(t, false));
        for (const p of this.processTasks.values()) all.push(await this.view(p, false));
        for (const r of this.recordedTasks.values()) all.push(await this.view(r, false));
        return all;
      }, 'List owned agents and background processes and their current state.'),
      tool('SendMessage', 'read', { agentId: str, message: str }, ['agentId', 'message'], async input => {
        const p = inputObject(input), t = this.get(stringArg(p, 'agentId')), message = stringArg(p, 'message');
        if ('status' in t && t.status !== 'running') throw new Error('Agent is not running');
        if (!('mailbox' in t)) throw new Error('Cannot send message to a background process');
        if (Buffer.byteLength(message) > 16 * 1024 || t.mailbox.length >= 64) throw new Error('Agent mailbox limit exceeded');
        t.mailbox.push(message); return { queued: true, agentId: t.id };
      }, 'Queue a bounded message for delivery at the child agent’s next model-turn boundary.'),
    ];
  }

  async close() {
    this.closed = true;
    for (const t of this.tasks.values()) if (t.status === 'running' || t.status === 'queued') t.controller.abort(new Error('Parent invocation ended'));
    for (const p of this.processTasks.values()) {
      if (p.status === 'running') {
        p.controller.abort(new Error('Parent invocation ended'));
        void p.stop();
      }
    }
    await Promise.allSettled([
      ...[...this.tasks.values()].map(t => t.done),
      ...[...this.processTasks.values()].map(p => p.stop()),
    ]);
    this.syncSessionState();
  }
}
