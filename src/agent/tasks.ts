import { scopedExecutionOptions, resolveExecutionPolicy, type ExecutionPolicy, type PermissionMode } from './execution-policy.ts';
import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicReplace, readWorkspaceFile, unlinkAnchored, withWorkspaceFile } from './files.ts';
import { runProcess } from './process.ts';
import { wrapCommand } from '../sandbox/index.ts';
import { inputObject, stringArg, tool } from './tools.ts';
import type { AgentOptions, AgentResult, AgentTool, ToolContext } from './types.ts';

export class AgentBudget {
  agents = 0;
  calls = 0;
  running = 0;
  constructor(readonly maxAgents: number, readonly maxCalls: number, readonly maxConcurrent = 2) {}
  /** Calls promised to a run that has not spent them yet; other work cannot consume them. */
  reservedCalls = 0;
  get freeCalls() { return this.maxCalls - this.calls - this.reservedCalls; }
  /**
   * Count one model call. A call inside a reserved run is paid from that reservation first;
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
interface TaskRecord {
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
      const source = await readWorkspaceFile(cwd, path); bytes += source.data.byteLength;
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
      await withWorkspaceFile(destination, path, true, (parent, name) => atomicReplace(parent, name, data, signal, mode));
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
  private tasks = new Map<string, TaskRecord>();
  private closed = false;
  private running = 0;
  constructor(private readonly parent: AgentOptions, private readonly context: ToolContext,
    private readonly lineage: AgentLineage, private readonly runChild: (options: AgentOptions, reservation?: CallReservation) => Promise<AgentResult>,
    private readonly maxDepth: number, private readonly concurrency: number) {}

  private get(id: string) { const task = this.tasks.get(id); if (!task) throw new Error('Unknown task ID'); return task; }
  private view(t: TaskRecord) {
    return { executionPolicy: t.executionPolicy, task_id: t.id, agentId: t.id, description: t.description, status: t.status, cwd: t.cwd,
      ...(t.result ? { result: t.result } : {}), ...(t.error ? { error: t.error } : {}),
      ...(t.diff ? { diff: t.diff } : {}), mailbox: [...t.mailbox] };
  }
  private async spawn(input: unknown, background: boolean, scopeSignal: AbortSignal) {
    const p = inputObject(input), prompt = stringArg(p, 'prompt');
    if (!prompt.trim() || Buffer.byteLength(prompt) > 64 * 1024) throw new Error('Invalid subagent prompt');
    if (this.closed || this.lineage.depth >= this.maxDepth) throw new Error('Subagent delegation depth exhausted');
    if (this.running >= this.concurrency) throw new Error('Subagent concurrency limit reached');
    this.lineage.budget.reserveAgent();
    const controller = new AbortController(), id = crypto.randomUUID();
    const task: TaskRecord = { id, description: typeof p.description === 'string' ? p.description.slice(0, 1000) : prompt.slice(0, 100),
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
          sessionId: undefined, newSessionId: undefined, fork: false,
          // A separate child lock/session and no closure-based host capabilities.
          tools: [], images: undefined, onEvent: undefined, beforeTool: this.parent.beforeTool, afterTool: this.parent.afterTool,
          mission: undefined, missionWorker: undefined,
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
        const p = inputObject(input), t = this.get(stringArg(p, 'task_id')); if (p.block !== false) await t.done; return this.view(t);
      }, 'Read a delegated task report; block until completion unless block is false.'),
      tool('TaskStop', 'read', { task_id: str }, ['task_id'], async input => {
        const t = this.get(stringArg(inputObject(input), 'task_id')); t.controller.abort(new Error('Task stopped')); await t.done; return this.view(t);
      }, 'Cancel and drain an owned task before returning.'),
      tool('InterruptAgent', 'read', { agentId: str }, ['agentId'], async input => {
        const t = this.get(stringArg(inputObject(input), 'agentId')); t.controller.abort(new Error('Agent interrupted')); await t.done; return this.view(t);
      }, 'Interrupt an owned child agent and await its cleanup.'),
      tool('ListAgents', 'read', {}, [], async () => [...this.tasks.values()].map(t => this.view(t)), 'List owned agents and their current state.'),
      tool('SendMessage', 'read', { agentId: str, message: str }, ['agentId', 'message'], async input => {
        const p = inputObject(input), t = this.get(stringArg(p, 'agentId')), message = stringArg(p, 'message');
        if (t.status !== 'running') throw new Error('Agent is not running');
        if (Buffer.byteLength(message) > 16 * 1024 || t.mailbox.length >= 64) throw new Error('Agent mailbox limit exceeded');
        t.mailbox.push(message); return { queued: true, agentId: t.id };
      }, 'Queue a bounded message for delivery at the child agent’s next model-turn boundary.'),
    ];
  }
  async close() {
    this.closed = true;
    for (const t of this.tasks.values()) if (t.status === 'running' || t.status === 'queued') t.controller.abort(new Error('Parent invocation ended'));
    await Promise.allSettled([...this.tasks.values()].map(t => t.done));
  }
}
