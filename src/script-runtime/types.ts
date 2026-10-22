export type ScriptContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; data: string };

export type ScriptErrorOrigin = 'program' | 'runtime' | 'output_limit' | 'timeout';

export interface ScriptError {
  origin: ScriptErrorOrigin;
  message: string;
}

export interface ScriptLimits {
  maxResultBytes?: number;
  maxOutputBytes?: number;
  maxPendingCalls?: number;
  maxTimers?: number;
}

export interface RunScriptOptions {
  code: string;
  /** Host callbacks must observe signal for cancellation; arbitrary host JS cannot be killed by the worker. */
  tools: Record<string, (input: unknown, context: { signal: AbortSignal }) => Promise<unknown>>;
  onContent?: (content: ScriptContent) => void | Promise<void>;
  onNotify?: (message: string) => void | Promise<void>;
  /** Stream output to observers rather than retain a cumulative output transcript. */
  streamOutput?: boolean;
  detach?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  limits?: ScriptLimits;
  /** OS isolation for the worker process (default 'best-effort'): bwrap without network. */
  sandbox?: 'required' | 'best-effort' | 'off';
}

export type RunScriptResult = (
  | { ok: true; output: unknown }
  | { ok: false; error: ScriptError }
) & { content: ScriptContent[]; notifications: string[]; sandboxed: boolean };

export interface ToolBinding {
  path: string[];
  toolName: string;
}

export type ResolvedLimits = Required<ScriptLimits>;

export interface RunScriptHandle {
  runId: string;
  done: Promise<RunScriptResult>;
  kill(): Promise<void>;
  drained: Promise<void>;
}
