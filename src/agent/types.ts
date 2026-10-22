export type Autonomy = 'off' | 'low' | 'medium' | 'high';
export type InteractionMode = 'auto' | 'spec' | 'mission';
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Local bookkeeping, stripped before provider transmission. */
  contextKind?: 'summary';
}
export interface ToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: { inputTokens: number; outputTokens: number };
}
export interface ModelRequest {
  messages: Message[];
  tools: ToolSchema[];
  maxOutputTokens: number;
}
export interface ModelProvider {
  id: string;
  complete(request: ModelRequest, signal: AbortSignal, delta?: (text: string) => void): Promise<ModelTurn>;
}
export interface ToolContext {
  requireReadBeforeEdit?: boolean;
  fileReads?: Map<string, string>;
  readonly executionPolicy?: import('./execution-policy.ts').ExecutionPolicy;
  cwd: string;
  signal: AbortSignal;
  autonomy: Autonomy;
  interactionMode: InteractionMode;
  sandbox: 'required' | 'best-effort';
  networkPolicy?: import('./network-policy.ts').NetworkPolicy;
  /** Runtime-issued, invocation-local Execute grant. Never constructed from model input. */
  networkAccess?: boolean;
  toolUseId?: string;
  missionDir?: string;
  missionReadOnly?: boolean;
  fileJournal?: FileJournal;
  sessionDir?: string;
  tasks?: import('./tasks.ts').TaskManager;
  searchConfig?: import('./web-search.ts').SearchConfig;
}
export interface FileSnapshot { data: Uint8Array; mode: number }
export interface FileMutation { path: string; before?: FileSnapshot; after: Uint8Array; mode: number }
/** Trusted host-only observer; called at the anchored write boundary, including Script callbacks. */
export interface FileJournal {
  prepare(change: FileMutation, context: ToolContext): Promise<(applied: FileSnapshot) => Promise<void>>;
  barrier(toolName: string, context: ToolContext): Promise<void>;
}
export type ToolEffect = 'read' | 'write' | 'execute' | 'control';
export interface AgentTool {
  schema: ToolSchema;
  /** Only read-only tools may be scheduled concurrently. */
  effect: ToolEffect;
  run(input: unknown, context: ToolContext): Promise<unknown>;
}
export interface AgentEvent {
  type: 'init' | 'usage' | 'provider_retry' | 'assistant_delta' | 'assistant' | 'tool_call' | 'tool_result' | 'compaction' | 'result' | 'error' |
    'mission_state_changed' | 'mission_worker_started' | 'mission_worker_completed' | 'network_permission' | 'permission_bypass' | 'agent_spawn' | 'mode_changed' | 'settings_staged';
  sessionId: string;
  [key: string]: unknown;
}
export interface AgentOptions {
  /** Trusted scope capability: false confines explore/validation/btw to spec. */
  allowExitSpecMode?: boolean;
  requireReadBeforeEdit?: boolean;
  /** Host ceilings and configured model IDs for model-proposed session changes. */
  settingsPolicy?: import('./staged-settings.ts').SettingsPolicy;
  permissionMode?: import('./execution-policy.ts').PermissionMode;
  prompt: string;
  cwd: string;
  provider: ModelProvider;
  autonomy?: Autonomy;
  interactionMode?: InteractionMode;
  sandbox?: 'required' | 'best-effort';
  networkPolicy?: import('./network-policy.ts').NetworkPolicy;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxTurns?: number;
  maxRecoveryAttempts?: number;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  maxToolConcurrency?: number;
  sessionDir?: string;
  sessionId?: string;
  /** Reserve a new ID (fails if it exists); sessionId resumes an existing ID. */
  newSessionId?: string;
  fork?: boolean;
  tags?: string[];
  appendSystemPrompt?: string;
  images?: Array<{ mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string }>;
  tools?: AgentTool[];
  onlyTools?: string[];
  removeTools?: string[];
  onEvent?: (event: AgentEvent) => void;
  beforeTool?: (call: ToolCall) => Promise<boolean>;
  afterTool?: (call: ToolCall, result: unknown, isError: boolean) => Promise<void>;
  fileJournal?: FileJournal;
  /** A reason rejects the final answer and asks the model to repair it within the recovery budget. */
  validateFinal?: (text: string) => string | undefined | Promise<string | undefined>;
  mission?: { workerProvider?: ModelProvider; validatorProvider?: ModelProvider };
  /** Trusted, invocation-local worker capability. Never constructed from model input. */
  missionWorker?: { directory: string; featureId: string; sealed: () => boolean; submit: (input: unknown) => Promise<unknown>;
    /** Runtime record of every tool execution, direct or nested inside Script. */
    observe?: (name: string, input: unknown, value: unknown, isError: boolean) => void };
  /** Trusted host inbox; checked at model-turn boundaries. */
  receiveMessages?: () => string[];
  subagents?: { maxDepth?: number; maxAgents?: number; maxConcurrency?: number; maxModelCalls?: number; maxProcessConcurrency?: number; maxProcessOutputBytes?: number };
  maxBackgroundProcesses?: number;
  maxProcessOutputBytes?: number;
  searchConfig?: import('./web-search.ts').SearchConfig;
  mcpServers?: Record<string, import('./mcp.ts').McpConfig>;
  permissionHandler?: (request: PermissionRequest, context: ToolContext) => Promise<'proceed_once' | 'cancel'>;
  askUserHandler?: (request: { questions: UserQuestion[] }, context: ToolContext) => Promise<UserAnswers>;
}
export interface UserQuestion { index: number; question: string; topic: string; options: string[] }
export interface UserAnswers { cancelled?: boolean; answers: Array<{ index: number; question: string; answer: string }> }
export interface PermissionRequest {
  toolUses: Array<{ toolUse: { type: 'tool_use'; id: string; name: string; input: unknown }; confirmationType: string; details: Record<string, unknown> }>;
  options: Array<{ label: string; value: 'proceed_once' | 'cancel' }>;
}
export interface AgentResult {
  executionPolicy?: import('./execution-policy.ts').ExecutionPolicy;
  ok: boolean;
  sessionId: string;
  text: string;
  turns: number;
  toolCalls: number;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number };
  error?: { type: 'program' | 'provider' | 'limit' | 'timeout' | 'aborted' | 'session'; message: string };
  mission?: { missionId: string; state: import('./mission-contract.ts').MissionState['state']; directory: string; completed: number; total: number };
}
