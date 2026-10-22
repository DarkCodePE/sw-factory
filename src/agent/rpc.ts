import { resolveExecutionPolicy, scopedExecutionOptions, type ExecutionPolicy } from './execution-policy.ts';
import { realpath } from 'node:fs/promises';
import { listConfiguredToolCatalog, runCodingAgent } from './engine.ts';
import { abortable } from './engine.ts';
import { SessionStore } from './session.ts';
import { builtinTools } from './tools.ts';
import { describeTool, selectToolNames } from './catalog.ts';
import type { AgentEvent, AgentOptions, Autonomy, InteractionMode, ModelProvider, PermissionRequest, ToolContext, UserAnswers } from './types.ts';

const ENVELOPE = { jsonrpc: '2.0', factoryApiVersion: '1.0.0', factoryProtocolVersion: '1.269.0' };
const MAX_FRAME = 10 * 1024 * 1024;
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
class RpcError extends Error { constructor(public code: number, message: string) { super(message); } }
const required = (p: Record<string, any>, name: string) => {
  if (typeof p[name] !== 'string' || !p[name]) throw new RpcError(-32602, `params.${name}: Required string`);
  return p[name] as string;
};

export interface RpcOptions {
  cwd: string;
  sessionDir: string;
  defaultModelId: string;
  providers: Record<string, ModelProvider>;
  agent?: Pick<AgentOptions, 'allowExitSpecMode' | 'requireReadBeforeEdit' | 'settingsPolicy' | 'permissionMode' | 'sandbox' | 'networkPolicy' | 'timeoutMs' | 'maxTurns' | 'maxContextTokens' | 'tools' | 'beforeTool' | 'afterTool' | 'permissionHandler' | 'askUserHandler' | 'mcpServers'>;
  signal?: AbortSignal;
}

/** Own implementation of the observed exec RPC envelope and session lifecycle.
 * Unsupported methods return method-not-found; this is a bounded compatibility surface. */
export class ExecRpc {
  private readonly startupPolicy: ExecutionPolicy;
  private sessionId?: string;
  private persisted = false;
  private cwd: string;
  private modelId: string;
  private autonomy: Autonomy = 'off';
  private mode: InteractionMode = 'auto';
  private agentExitedSpec = false;
  private only?: string[];
  private removed?: string[];
  private active?: { controller: AbortController; done: Promise<void> };
  private messages: Record<string, unknown>[] = [];
  private assistantId?: string;
  private turnId?: string;
  private seenIds = new Set<string>();
  private catalog?: Awaited<ReturnType<typeof listConfiguredToolCatalog>>;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  closed = false;
  constructor(private readonly options: RpcOptions, private readonly write: (frame: unknown) => void) {
    this.startupPolicy = resolveExecutionPolicy(options.agent ?? {});
    this.autonomy = this.startupPolicy.effectiveAutonomy;
    this.cwd = options.cwd; this.modelId = options.defaultModelId;
  }
  private response(id: string | null, result: unknown, error?: { code: number; message: string }) {
    this.write({ ...ENVELOPE, type: 'response', id, ...(error ? { error } : { result }) });
  }
  private notify(notification: Record<string, unknown>) {
    this.write({ ...ENVELOPE, type: 'notification', method: 'droid.session_notification',
      params: { ...(this.sessionId ? { sessionId: this.sessionId } : {}), notification } });
  }
  private executionOptions() {
    return scopedExecutionOptions({ executionPolicy: this.agentExitedSpec ? resolveExecutionPolicy({ autonomy: this.autonomy }) : this.startupPolicy, autonomy: this.autonomy,
      sandbox: this.options.agent?.sandbox ?? 'required', networkPolicy: this.agentExitedSpec ? 'deny' : this.options.agent?.networkPolicy }, this.mode === 'spec');
  }
  private rejectAuthority(p: Record<string, any>) {
    for (const key of ['permissionMode', 'yolo', 'sandbox', 'networkPolicy', 'executionPolicy', 'fab_execution_policy'])
      if (Object.hasOwn(p, key)) throw new RpcError(-32602, `${key} is configured by the host, not session requests`);
  }
  private settingsPolicy() {
    return this.options.agent?.settingsPolicy ?? { modelIds: Object.keys(this.options.providers), maxAutonomy: this.autonomy, networkPolicy: this.executionOptions().networkPolicy ?? 'auto' };
  }
  private settings() {
    return { modelId: this.modelId, reasoningEffort: 'none', autonomyMode: this.mode === 'spec' ? 'spec' : this.autonomy === 'off' ? 'normal' : `auto-${this.autonomy}`,
      autonomyLevel: this.autonomy, interactionMode: this.mode, availableAutonomyLevels: ['off', 'low', 'medium', 'high'],
      additionalToolIds: [], enabledToolIds: [], disabledToolIds: this.removed ?? [], restrictToolIds: this.only ?? [],
      toolExecutionMode: 'direct_only', allowSubagentsInScripts: false, compactionThresholdCheckEnabled: true, migrationActive: false,
      networkPolicy: this.executionOptions().networkPolicy ?? 'auto', fab_execution_policy: resolveExecutionPolicy(this.executionOptions()) };
  }
  private models() {
    return Object.keys(this.options.providers).map(id => ({ id, displayName: id, shortDisplayName: id,
      modelProvider: 'generic-chat-completion-api', supportedReasoningEfforts: ['none'], defaultReasoningEffort: 'none', isCustom: true }));
  }
  private update(p: Record<string, any>) {
    this.rejectAuthority(p);
    if (this.startupPolicy.permissionMode === 'yolo' && Object.hasOwn(p, 'autonomyLevel') && p.autonomyLevel !== 'high') throw new RpcError(-32602, 'YOLO requires high autonomy');
    const modelId = p.modelId ?? this.modelId, autonomy = p.autonomyLevel ?? this.autonomy, mode = p.interactionMode ?? this.mode;
    if (!Object.hasOwn(this.options.providers, modelId)) throw new RpcError(-32602, 'Unknown configured model');
    if (!['off', 'low', 'medium', 'high'].includes(autonomy) || !['auto', 'spec'].includes(mode)) throw new RpcError(-32602, 'Unsupported autonomy/interaction mode');
    for (const key of ['restrictToolIds', 'disabledToolIds']) if (p[key] !== undefined && (!Array.isArray(p[key]) || p[key].some((x: unknown) => typeof x !== 'string'))) throw new RpcError(-32602, `Invalid ${key}`);
    if (p.reasoningEffort !== undefined && p.reasoningEffort !== 'none') throw new RpcError(-32602, 'Reasoning overrides require a configured provider');
    this.catalog = undefined;
    this.modelId = modelId; this.autonomy = autonomy; this.mode = mode;
    if (Object.hasOwn(p, 'interactionMode')) this.agentExitedSpec = false;
    if (p.restrictToolIds) this.only = p.restrictToolIds.length ? p.restrictToolIds : undefined;
    if (p.disabledToolIds) this.removed = p.disabledToolIds;
  }
  private idle() { if (this.active) throw new RpcError(-32000, 'Session is busy'); }
  private initialized() { if (!this.sessionId) throw new RpcError(-32000, 'Session is not initialized'); }
  private async toolCatalog() {
    if (!this.catalog) this.catalog = await listConfiguredToolCatalog({ ...this.options.agent, prompt: '', cwd: this.cwd,
      provider: this.options.providers[this.modelId]!, ...this.executionOptions(), settingsPolicy: this.settingsPolicy() }, this.options.signal);
    return this.catalog;
  }
  private async call(method: string, params: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.pending.size >= 64) throw new Error('RPC pending-request limit exceeded');
    const id = crypto.randomUUID();
    let abort!: () => void;
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        abort = () => reject(new Error('RPC request cancelled'));
        this.pending.set(id, { resolve, reject }); signal.addEventListener('abort', abort, { once: true });
        this.write({ ...ENVELOPE, type: 'request', id, method, params });
        if (signal.aborted) abort();
      });
      return { id, result };
    } finally { this.pending.delete(id); signal.removeEventListener('abort', abort); }
  }
  private permission = async (request: PermissionRequest, context: ToolContext): Promise<'proceed_once' | 'cancel'> => {
    this.notify({ type: 'droid_working_state_changed', newState: 'waiting_for_tool_confirmation' });
    const { id, result } = await this.call('droid.request_permission', request, context.signal);
    if (!object(result) || !['proceed_once', 'cancel'].includes(result.selectedOption)) throw new Error('Invalid permission response: expected selectedOption');
    this.notify({ type: 'permission_resolved', requestId: id, toolUseIds: request.toolUses.map(t => t.toolUse.id), selectedOption: result.selectedOption });
    return result.selectedOption;
  };
  private askUser = async (request: { questions: import('./types.ts').UserQuestion[] }, context: ToolContext): Promise<UserAnswers> => {
    this.notify({ type: 'droid_working_state_changed', newState: 'waiting_for_tool_confirmation' });
    const { result } = await this.call('droid.ask_user', { toolCallId: context.toolUseId, ...request }, context.signal);
    return result as UserAnswers;
  };
  private message(role: 'user' | 'assistant', content: unknown[], requestId?: string) {
    const now = Date.now(), id = role === 'assistant' ? this.assistantId ?? crypto.randomUUID() : this.turnId!;
    const message = { id, role, content, createdAt: now, updatedAt: now, seq: this.messages.length,
      parentId: this.messages.at(-1)?.id ?? 'root' };
    this.messages.push(message); this.notify({ type: 'create_message', message, ...(requestId ? { requestId } : {}) });
  }
  private event = (event: AgentEvent) => {
    if (event.type === 'init') this.notify({ type: 'fab_execution_policy', policy: event.executionPolicy });
    else if (event.type === 'mode_changed') {
      this.agentExitedSpec = true; this.mode = 'auto'; this.catalog = undefined;
      this.notify({ type: 'fab_mode_changed', interactionMode: 'auto', autonomyLevel: event.autonomy });
    }
    else if (event.type === 'settings_staged') this.notify({ type: 'fab_settings_staged', proposal: event.proposal });
    else if (event.type === 'permission_bypass') this.notify({ type: 'fab_permission_bypass', toolUseId: event.toolUseId, toolName: event.toolName, permissionMode: event.permissionMode });
    else if (event.type === 'assistant_delta') {
      this.assistantId ??= crypto.randomUUID();
      this.notify({ type: 'assistant_text_delta', messageId: this.assistantId, blockIndex: 0, textDelta: event.text });
    } else if (event.type === 'assistant') {
      this.assistantId ??= crypto.randomUUID();
      this.notify({ type: 'assistant_text_complete', messageId: this.assistantId, blockIndex: 0 });
      this.message('assistant', [{ type: 'text', text: event.text }]); this.assistantId = undefined;
    } else if (event.type === 'tool_call') {
      let input: unknown = null;
      try { input = JSON.parse(String(event.arguments)); } catch { /* Dispatcher produces a recoverable tool error. */ }
      const toolUse = { type: 'tool_use', id: event.id, name: event.toolName, input };
      this.notify({ type: 'tool_call', toolUse });
      this.message('assistant', [toolUse]);
      this.notify({ type: 'droid_working_state_changed', newState: 'executing_tool' });
      this.notify({ type: 'tool_execution_phase_changed', toolUseId: event.id, toolName: event.toolName, phase: 'executing' });
    } else if (event.type === 'tool_result') {
      this.notify({ type: 'tool_result', toolUseId: event.id, messageId: crypto.randomUUID(), isError: event.isError, content: typeof event.value === 'string' ? event.value : JSON.stringify(event.value) });
    } else if (event.type === 'compaction') this.notify({ type: 'context_compacted', estimatedTokens: event.estimatedTokens });
    else if (event.type === 'network_permission') this.notify({ type: 'fab_network_permission', toolUseId: event.toolUseId, policy: event.policy, decision: event.decision, access: event.access, scope: event.scope });
    else if (event.type.startsWith('mission_')) { const { sessionId, ...notification } = event; this.notify(notification); }
  };
  async accept(value: unknown): Promise<void> {
    let id: string | null = null;
    try {
      if (object(value) && value.jsonrpc === '2.0' && value.type === 'response' && typeof value.id === 'string') {
        const pending = this.pending.get(value.id);
        if (pending) {
          if (value.error) pending.reject(new Error('Client rejected RPC request'));
          else if (!Object.hasOwn(value, 'result')) pending.reject(new Error('Malformed RPC response'));
          else pending.resolve(value.result);
        }
        return;
      }
      if (!object(value) || value.jsonrpc !== '2.0' || value.type !== 'request' || typeof value.id !== 'string' || !value.id ||
          typeof value.method !== 'string' || !object(value.params ?? {})) throw new RpcError(-32700, 'Parse error');
      id = value.id;
      if (this.closed) throw new RpcError(-32000, 'Connection is closed');
      if (this.seenIds.has(id)) throw new RpcError(-32600, 'Duplicate request ID');
      if (this.seenIds.size >= 100_000) throw new RpcError(-32000, 'Connection request limit exceeded');
      this.seenIds.add(id);
      const p = value.params ?? {};
      switch (value.method) {
        case 'droid.initialize_session': {
          this.idle(); if (this.sessionId) throw new RpcError(-32000, 'Session already initialized');
          required(p, 'machineId');
          const cwd = await realpath(p.cwd ?? this.options.cwd); this.update(p); this.cwd = cwd;
          this.sessionId = crypto.randomUUID();
          this.notify({ type: 'settings_updated', settings: this.settings() });
          this.response(id, { sessionId: this.sessionId, hostId: p.machineId, session: { messages: [] }, settings: this.settings(), availableModels: this.models() });
          return;
        }
        case 'droid.list_models': this.response(id, { models: this.models() }); return;
        case 'droid.list_tools': this.response(id, { tools: (await this.toolCatalog()).map(t => describeTool(t, this.autonomy, this.mode, selectToolNames(this.only), selectToolNames(this.removed), resolveExecutionPolicy(this.executionOptions()))) }); return;
        case 'droid.update_session_settings':
          this.initialized(); this.idle(); this.update(p); this.notify({ type: 'settings_updated', requestId: id, settings: this.settings() }); this.response(id, {}); return;
        case 'droid.add_user_message': {
          this.initialized(); this.idle(); const text = required(p, 'text');
          this.turnId = crypto.randomUUID(); this.assistantId = undefined;
          this.response(id, {}); this.message('user', [{ type: 'text', text }], id);
          this.notify({ type: 'droid_working_state_changed', newState: 'streaming_assistant_message' });
          const controller = new AbortController();
          const signal = this.options.signal ? AbortSignal.any([controller.signal, this.options.signal]) : controller.signal;
          // Install busy state before starting user/provider code.
          const active = { controller, done: Promise.resolve() }; this.active = active;
          active.done = (async () => {
            try {
              const result = await runCodingAgent({ ...this.options.agent, cwd: this.cwd, prompt: text,
                permissionHandler: this.options.agent?.permissionHandler ?? this.permission,
                askUserHandler: this.options.agent?.askUserHandler ?? this.askUser,
                sessionDir: this.options.sessionDir, ...(this.persisted ? { sessionId: this.sessionId } : { newSessionId: this.sessionId }),
                provider: this.options.providers[this.modelId]!, ...this.executionOptions(),
                settingsPolicy: this.settingsPolicy(),
                onlyTools: selectToolNames(this.only), removeTools: selectToolNames(this.removed), signal, onEvent: this.event });
              this.persisted = true;
              this.notify({ type: 'agent_turn_completed', reason: result.ok ? 'completed' : result.error?.type === 'aborted' ? 'interrupted' : 'error',
                turnId: this.turnId, tokenUsage: result.usage, durationMs: result.durationMs, ...(result.error ? { error: result.error } : {}) });
            } catch (error) {
              this.notify({ type: 'agent_turn_completed', reason: 'error', turnId: this.turnId,
                error: { message: error instanceof Error ? error.message : String(error) } });
            } finally {
              this.active = undefined;
              this.notify({ type: 'droid_working_state_changed', newState: 'idle' });
            }
          })();
          return;
        }
        case 'droid.interrupt_session':
          this.initialized(); this.active?.controller.abort(new Error('Session interrupted')); await this.active?.done;
          this.response(id, {}); return;
        case 'droid.load_session': {
          this.rejectAuthority(p); this.idle(); const sessionId = required(p, 'sessionId'), store = await SessionStore.create(this.options.sessionDir);
          const state = await store.load(sessionId);
          const model = Object.entries(this.options.providers).find(([, provider]) => provider.id === state.provider)?.[0];
          if (!model) throw new RpcError(-32602, 'Saved provider is not configured');
          this.cwd = state.cwd; this.modelId = model; this.sessionId = sessionId; this.persisted = true;
          this.messages = state.messages.filter(m => m.role !== 'system').map((m, index) => ({ id: `saved-${index}`, role: m.role,
            content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content ?? [] }));
          this.response(id, { sessionId, session: { messages: this.messages }, settings: this.settings(), availableModels: this.models() }); return;
        }
        case 'droid.close_session':
          this.active?.controller.abort(new Error('Session closed')); await this.active?.done;
          this.closed = true; this.response(id, {}); return;
        default: throw new RpcError(-32601, 'Method not found');
      }
    } catch (error) {
      this.response(id, undefined, { code: error instanceof RpcError ? error.code : -32603,
        message: error instanceof Error ? error.message : 'Internal error' });
    }
  }
  parseError() { this.response(null, undefined, { code: -32700, message: 'Parse error' }); }
  async shutdown() { this.active?.controller.abort(new Error('RPC transport closed')); await this.active?.done; this.closed = true; }
}

export async function serveExecRpc(input: AsyncIterable<Uint8Array>, write: (line: string) => void, opts: RpcOptions) {
  const rpc = new ExecRpc(opts, frame => {
    const line = JSON.stringify(frame);
    if (Buffer.byteLength(line) > MAX_FRAME) throw new Error('RPC output frame exceeds 10 MiB');
    write(line + '\n');
  });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const iterator = input[Symbol.asyncIterator]();
  let buffer = '';
  try {
    for (;;) {
      const next = await (opts.signal ? abortable(iterator.next(), opts.signal) : iterator.next());
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_FRAME) throw new Error('RPC input frame exceeds 10 MiB');
        if (!line.trim()) continue;
        let value: unknown; try { value = JSON.parse(line); } catch { rpc.parseError(); continue; }
        await rpc.accept(value); if (rpc.closed) return;
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME) throw new Error('RPC input frame exceeds 10 MiB');
    }
    buffer += decoder.decode();
    if (buffer.trim()) rpc.parseError();
  } finally {
    await rpc.shutdown();
    // Do not wait indefinitely on a source whose pending read ignores cancellation.
    void iterator.return?.().catch(() => {});
  }
}
