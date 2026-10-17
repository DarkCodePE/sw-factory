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
  tools: Record<string, (input: unknown) => Promise<unknown>>;
  timeoutMs?: number;
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
