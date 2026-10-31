import type { Journal } from './journal.ts';
import type { Hooks } from './hooks.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { ScriptRunManager, SCRIPT_AWAIT_MS, SCRIPT_FOREGROUND_MS } from './script-runs.ts';
import { loopTool, parseLoop } from './loop.ts';
import { fetchUrlTool, parseFetch } from './fetch-url.ts';
import { sessionTools } from './session-tools.ts';
import { parsePatch } from './patch.ts';
import { abortable } from './cancellation.ts';
import { isAutoProvider } from './providers/auto.ts';
import { readWorkspaceFile } from './files.ts';
import { formatAnswers, parseQuestionnaire, permissionRequest } from './interaction.ts';
import { ToolScheduler } from './scheduler.ts';
import { networkDecision, networkPolicy, requestsNetwork } from './network-policy.ts';
import { TaskManager, type AgentLineage, type CallReservation } from './tasks.ts';
import { featureHandoffTool, MissionManager } from './mission.ts';
import type { SessionState } from './session.ts';
import { builtinTools, COMMAND_POLICY_HINT, executeAllowed, inputObject, scriptTool, stringArg, tool } from './tools.ts';
import type { AgentOptions, AgentResult, AgentTool, ToolCall, ToolContext } from './types.ts';
import { probeEgress } from '../sandbox/index.ts';

export class ToolRuntime {
  readonly registry: Map<string, AgentTool>;
  private exitQueued = false;
  readonly scripts: ScriptRunManager;
  private closing?: Promise<void>;
  private mission?: MissionManager;
  async reconcileMissionCrash() { await this.mission?.reconcileCrash(); }
  private readonly available: (name: string) => boolean;
  get visible(): AgentTool[] { return [...this.registry.values()].filter(t => this.available(t.schema.function.name)); }
  commitModeChange(context: ToolContext) {
    context.signal.throwIfAborted();
    if (!this.exitQueued) return false;
    this.exitQueued = false;
    context.interactionMode = 'auto';
    return true;
  }
  readonly dispatch: (name: string, input: unknown, call?: ToolCall, scopedSignal?: AbortSignal) => Promise<unknown>;
  private readonly owned = new Set<Promise<unknown>>();
  private readonly tasks: TaskManager;
  private processRoots = new Map<number, string>();
  private processIdentity(pid: number) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      return { parent: Number(fields[1]), started: fields[19]! };
    } catch { return undefined; }
  }
  /** bwrap's namespace init can have another session/group: kill descendants before its monitor. */
  interruptProcesses() {
    if (process.platform !== 'linux') return;
    const owned = new Map<number, string>();
    const visit = (pid: number, started: string, depth = 0) => {
      if (depth > 32 || owned.size >= 1024 || this.processIdentity(pid)?.started !== started) return;
      owned.set(pid, started);
      let children: string[]; try { children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/); } catch { return; }
      for (const value of children) {
        const child = Number(value), identity = child > 0 ? this.processIdentity(child) : undefined;
        if (identity?.parent === pid) visit(child, identity.started, depth + 1);
      }
    };
    for (const [pid, started] of this.processRoots) if (this.processIdentity(pid)?.parent === process.pid) visit(pid, started);
    for (const [pid, started] of [...owned].reverse()) {
      if (this.processIdentity(pid)?.started === started) try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
    this.processRoots.clear();
  }
  constructor(opts: AgentOptions, context: ToolContext, lineage: AgentLineage,
    limits: { maxDepth: number; agentConcurrency: number; parallel: number; maxBackgroundProcesses?: number; maxProcessOutputBytes?: number },
    runChild: (options: AgentOptions, reservation?: CallReservation) => Promise<AgentResult>, state: Partial<SessionState> = {}, saveState: () => Promise<void> = async () => {}, journal?: Journal, hooks?: Hooks) {
    const yolo = context.executionPolicy?.permissionMode === 'yolo';
    const owned = this.owned;
    const available = (name: string) => (!opts.onlyTools || opts.onlyTools.includes(name)) && !opts.removeTools?.includes(name) &&
      (name !== 'UpgradeSessionModel' || isAutoProvider(opts.provider) && (opts.provider.currentModelId === undefined || opts.provider.canUpgrade())) &&
      (name !== 'ExitSpecMode' || context.interactionMode === 'spec' && opts.allowExitSpecMode !== false && !opts.missionWorker);
    this.available = available;
    const settingsPolicy = Object.freeze({
      modelIds: [...opts.settingsPolicy?.modelIds ?? [opts.provider.id]],
      maxAutonomy: opts.settingsPolicy?.maxAutonomy ?? context.autonomy,
      networkPolicy: opts.settingsPolicy?.networkPolicy ?? networkPolicy(context.networkPolicy),
    });
    const registry = new Map<string, AgentTool>();
    const add = (t: AgentTool) => {
      const name = t.schema.function.name;
      if (!/^[\w.-]+$/.test(name) || registry.has(name)) throw new Error(`Invalid or duplicate tool ${name}`);
      registry.set(name, t);
    };
    for (const t of builtinTools(yolo ? 'yolo' : 'standard')) add(t);
    add(fetchUrlTool());
    for (const t of sessionTools(opts, context, settingsPolicy, () => { this.exitQueued = true; }, state.id ?? '')) add(t);
    for (const t of opts.tools ?? []) add(t);
    const auto = opts.provider;
    if (isAutoProvider(auto)) {
      add(tool('UpgradeSessionModel', 'read', {}, [], async () => {
        const moved = auto.upgrade();
        if (!moved) throw new Error('No higher model tier is available');
        return { from: moved.from, to: moved.to, note: 'The next model turn runs on the higher tier.' };
      }, 'Move this session to the next more capable (and more expensive) model for the rest of the session. ' +
        'Call it only when the current model has clearly stalled: the same step failed repeatedly, it keeps misreading the code, or the task needs deeper reasoning than it shows. ' +
        'Do not call it for routine work or after a single failure.'));
    }
    const maxProcesses = limits.maxBackgroundProcesses ?? opts.maxBackgroundProcesses ?? opts.subagents?.maxProcessConcurrency ?? 4;
    const maxOutputBytes = limits.maxProcessOutputBytes ?? opts.maxProcessOutputBytes ?? opts.subagents?.maxProcessOutputBytes ?? 1024 * 1024;
    const tasks = new TaskManager(opts, context, lineage, runChild, limits.maxDepth, limits.agentConcurrency, maxProcesses, maxOutputBytes, opts.sessionDir, state);
    context.tasks = tasks;
    for (const t of tasks.tools()) add(t);
    if (context.interactionMode === 'mission') {
      const session = state.id ? state as SessionState : { id: 'catalog', ...state } as SessionState;
      this.mission = new MissionManager(opts, context, session, lineage, limits.maxDepth, saveState, runChild);
      for (const t of this.mission.tools()) add(t);
    }
    if (opts.missionWorker) add(featureHandoffTool(opts.missionWorker));
    add(tool('TodoWrite', 'read', { todos: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }] } }, ['todos'], async input => {
      const p = inputObject(input);
      if (!(typeof p.todos === 'string' && Buffer.byteLength(p.todos) <= 32 * 1024) && !(Array.isArray(p.todos) && p.todos.length <= 100)) throw new Error('Invalid todos');
      state.todos = p.todos as string | unknown[]; return { todos: state.todos };
    }, 'Replace the current task checklist.'));
    add(tool('AskUser', 'read', { questionnaire: { type: 'string' } }, ['questionnaire'], async (input, c) => {
      const questions = parseQuestionnaire(stringArg(inputObject(input), 'questionnaire'));
      if (!opts.askUserHandler) return 'User cancelled the questionnaire.';
      return formatAnswers(questions, await abortable(opts.askUserHandler({ questions }, c), c.signal));
    }, 'Ask numbered questions with [question], [topic] and [option] fields. Unattended runs decline.'));
    add(tool('Skill', 'read', { skill: { type: 'string' } }, ['skill'], async (input, c) => {
      const name = stringArg(inputObject(input), 'skill');
      if (!/^[\w-]+$/.test(name)) throw new Error('Invalid skill name');
      const { text } = opts.missionWorker ? await readWorkspaceFile(opts.missionWorker.directory, `skills/${name}/SKILL.md`)
        : await readWorkspaceFile(c.cwd, `.agents/skills/${name}/SKILL.md`);
      if (Buffer.byteLength(text) > 64 * 1024) throw new Error('Skill exceeds size limit');
      return text;
    }, 'Read instructions for a project skill under .agents/skills.'));
    const scripts = this.scripts = new ScriptRunManager(state, event => opts.onEvent?.({ ...event, sessionId: state.id ?? '' } as import('./types.ts').AgentEvent), saveState, limits.parallel);
    const scheduler = new ToolScheduler(limits.parallel);
    const dispatch = async (name: string, input: unknown, call?: ToolCall, scopedSignal?: AbortSignal, authority?: ToolContext, skipHooks = false): Promise<unknown> => {
      if (this.closing) throw new Error('Tool runtime is closed');
      const scope = authority ?? context;
      const signal = scopedSignal ? AbortSignal.any([scope.signal, scopedSignal]) : scope.signal;
      signal.throwIfAborted();
      const t = registry.get(name); if (!t) throw new Error(`Unknown tool: ${name}`);
      const pre = !skipHooks && hooks ? await hooks.fire('PreToolUse', { tool_name: name, tool_input: input }, signal) : undefined;
      if (pre?.deny || pre?.block) throw new Error(pre.reason ?? 'Tool denied by hook');
      if (pre && Object.hasOwn(pre, 'updatedInput')) input = pre.updatedInput;
      hooks?.context(pre?.context ?? []);
      if (call) call.function.arguments = JSON.stringify(input);
      // Bind approval to the command and network request shown to the caller.
      if (name === 'Execute' || name === 'ApplyPatch' || name === 'ExitSpecMode' || name === 'StageSettingsChanges' || name === 'Loop' || name === 'FetchUrl') input = Object.freeze({ ...inputObject(input) });
      if (name === 'Loop') parseLoop(input);
      if (name === 'FetchUrl') parseFetch(input);
      if (name === 'ApplyPatch') parsePatch(inputObject(input).patch);
      const actual = call ?? { id: crypto.randomUUID(), type: 'function' as const, function: { name, arguments: JSON.stringify(input) } };
      if (!available(name)) throw new Error(`Tool disabled in this scope: ${name}`);
      if (scope.interactionMode === 'spec' && t.effect === 'write') throw new Error('Spec mode denies workspace mutations');
      if (scope.interactionMode === 'spec' && t.effect === 'execute' && !['Script', 'WaitForScript', 'Execute', 'Task', 'SpawnAgent'].includes(name)) throw new Error('Spec mode denies unrestricted execution tools');
      if (opts.beforeTool && !await abortable(opts.beforeTool(actual), signal)) throw new Error('Tool denied by caller policy');
      const netTool = name === 'FetchUrl' || name === 'WebSearch';
      const requested = netTool || name === 'Execute' && requestsNetwork(input);
      const policy = networkPolicy(scope.networkPolicy);
      const network = networkDecision(requested, policy, scope.autonomy, scope.interactionMode, netTool);
      const networkEvent = (decision: string) => { if (requested) opts.onEvent?.({ type: 'network_permission', sessionId: state.id ?? '', toolUseId: actual.id, policy, decision, access: netTool ? 'http_url' : 'host', scope: 'this_call', toolName: name }); };
      if (network === 'deny') { networkEvent('denied'); throw new Error(name + ' network access denied by policy or spec mode'); }
      if (requested && !scope.egressProbe) {
        try {
          const probe = await probeEgress({
            workdir: scope.cwd,
            allowNetwork: network === 'allow',
            mode: scope.sandbox,
          });
          scope.egressProbe = probe;
          // El pool (proceso padre) recoge la sonda de este hijo por archivo para el run.json.
          if (process.env.FABRICA_EGRESS_PROBE_FILE) writeFileSync(process.env.FABRICA_EGRESS_PROBE_FILE, JSON.stringify(probe));
          opts.onEvent?.({
            type: 'egress_probe',
            sessionId: state.id ?? '',
            reachable: probe.reachable,
            decided: probe.decided,
            positiveControl: probe.positiveControl,
          });
        } catch {}
      }
      const allowedCommand = name !== 'Execute' || executeAllowed(input, scope);
      const needsApproval = pre?.ask || !pre?.allow && !yolo && (network === 'ask' || t.effect === 'write' && scope.autonomy === 'off' ||
        t.effect === 'execute' && !['Execute', 'Script', 'WaitForScript'].includes(name) && !['medium', 'high'].includes(scope.autonomy) ||
        !allowedCommand);
      let granted = pre?.allow === true;
      if (needsApproval) {
        if (scope.interactionMode === 'spec' && name === 'Execute') throw new Error('Spec mode denies this command');
        if (!opts.permissionHandler) {
          networkEvent('denied');
          throw new Error(network === 'ask' ? name + ' network approval required; use the interactive TUI/RPC or auto high with network policy auto' : name === 'Execute' ? COMMAND_POLICY_HINT : 'Tool requires higher autonomy or explicit permission');
        }
        const outcome = await abortable(opts.permissionHandler(permissionRequest(actual, input, scope), { ...scope, signal }), signal);
        signal.throwIfAborted();
        if (outcome !== 'proceed_once') { networkEvent('denied'); throw new Error('Tool execution cancelled by caller'); }
        granted = true;
      }
      signal.throwIfAborted();
      networkEvent(network === 'allow' && !needsApproval ? 'allowed_automatically' : 'allowed_once');
      if (yolo && t.effect !== 'read') opts.onEvent?.({ type: 'permission_bypass', sessionId: state.id ?? '', toolUseId: actual.id, toolName: name, permissionMode: 'yolo' });
      const run = async () => {
        if (opts.missionWorker?.sealed() && ['write', 'execute'].includes(t.effect)) throw new Error('Worker workspace mutation is closed after EndFeatureRun');
        if (t.effect !== 'read' && !['Edit', 'Create', 'ApplyPatch', 'Script', 'WaitForScript'].includes(name)) await scope.fileJournal?.barrier(name, scope);
        const selected = name === 'Loop' ? loopTool((nested, value, nestedSignal) => dispatch(nested, value, undefined, nestedSignal, scope, skipHooks), () => {
          if (opts.missionWorker || scope.interactionMode === 'mission') lineage.budget.modelCall(lineage.reservation);
        }) : t;
        const work = selected.run(input, { ...scope, tasks, signal, toolUseId: actual.id, networkAccess: requested, ...(granted && name !== 'Script' ? { autonomy: 'high' as const } : {}) });
        const value = await (name === 'TaskOutput' ? abortable(work, signal) : work);
        if (name === 'Execute' && (input as any)?.background === true && process.platform === 'linux') {
          const pid = (value as any)?.pid, identity = Number.isSafeInteger(pid) ? this.processIdentity(pid) : undefined;
          if (identity?.parent === process.pid) this.processRoots.set(pid, identity.started);
        }
        return value;
      };
      await journal?.append('tool_start', { toolCallId: actual.id, name, effect: t.effect });
      signal.throwIfAborted(); if (this.closing) throw new Error('Tool runtime is closed');
      const work = ['Loop', 'Script', 'WaitForScript', 'TaskOutput', 'TaskStop', 'InterruptAgent'].includes(name) ? run() : scripts.runTool(signal, () => scripts.schedule(signal, start => scheduler.run(t.effect === 'read', signal, start), run));
      owned.add(work);
      try {
        const value = await work;
        opts.missionWorker?.observe?.(name, input, value, false);
        await journal?.append('tool_end', { toolCallId: actual.id, name, effect: t.effect, ok: true });
        const post = !skipHooks && hooks ? await hooks.fire('PostToolUse', { tool_name: name, tool_input: input, tool_response: value }, signal) : undefined;
        hooks?.context(post?.context ?? []);
        if (post?.block) hooks?.context(['PostToolUse feedback: ' + (post.reason ?? 'Review the observed result')]);
        return value;
      } catch (error) {
        opts.missionWorker?.observe?.(name, input, null, true);
        if (!signal.aborted) await journal?.append('tool_end', { toolCallId: actual.id, name, effect: t.effect, ok: false });
        throw error;
      } finally { owned.delete(work); }
    };
    add(loopTool((name, input, signal) => dispatch(name, input, undefined, signal), () => {
      if (opts.missionWorker || context.interactionMode === 'mission') lineage.budget.modelCall(lineage.reservation);
    }));
    add(scriptTool((name, input, signal, authority) => dispatch(name, input, undefined, signal, authority, true), () => [...registry.keys()].filter(available), scripts));
    add(tool('WaitForScript', 'execute', { toolCallId: { type: 'string' }, timeoutMs: { type: 'number' }, kill: { type: 'boolean' } }, ['toolCallId'], async (input, c) => {
      const p = inputObject(input), id = stringArg(p, 'toolCallId');
      if (Object.keys(p).some(k => !['toolCallId', 'timeoutMs', 'kill'].includes(k)) || !id || id.length > 256 ||
          p.kill !== undefined && typeof p.kill !== 'boolean' || p.timeoutMs !== undefined && (typeof p.timeoutMs !== 'number' || !Number.isFinite(p.timeoutMs) || p.timeoutMs < 0)) throw new Error('Invalid WaitForScript input');
      if (p.kill) await scripts.kill(id);
      return scripts.wait(id, Math.min(SCRIPT_AWAIT_MS, p.timeoutMs as number ?? SCRIPT_FOREGROUND_MS), c.signal);
    }, 'Read and consume buffered Script output by its original toolCallId. Optionally wait or kill and drain pending calls.'));
    add(tool('ToolSearch', 'read', { query: { type: 'string' } }, ['query'], async input => {
      const query = stringArg(inputObject(input), 'query').toLowerCase();
      return [...registry.values()].filter(t => available(t.schema.function.name) && t.schema.function.name.toLowerCase().includes(query)).map(t => t.schema);
    }, 'Discover registered tool schemas by name.'));
    for (const name of [...opts.onlyTools ?? [], ...opts.removeTools ?? []]) if (!registry.has(name) && !((opts.missionWorker || context.interactionMode === 'mission') && ['ProposeMission', 'StartMissionRun', 'EndFeatureRun', 'DismissHandoffItems'].includes(name))) throw new Error(`Unknown selected tool: ${name}`);
    if (opts.onlyTools?.length && [...registry.keys()].filter(available).every(n => ['Script', 'WaitForScript'].includes(n))) throw new Error('Script and WaitForScript cannot be the only allowed tools');
    this.registry = registry; this.dispatch = dispatch; this.tasks = tasks;
  }
  async close() {
    this.closing ??= (async () => {
      this.interruptProcesses();
      const drains = await Promise.allSettled([this.scripts.drainAll(), this.tasks.close()]);
      await Promise.allSettled([...this.owned]);
      this.interruptProcesses(); await this.tasks.close();
      const failure = drains.find(r => r.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    })();
    await this.closing;
  }
}
