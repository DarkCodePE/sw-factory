// Live (resumable) agent contract. Shared by every live backend; do not change it in a backend branch.
// "Live" means resumable by session id, one turn per call: the pool's one-shot model is kept.
// Design: techdocs/docs/investigacion/inspiracion/06-integracion-superagent-fab.md §5.2 (D2, D3, D4).
import type { AgentRun } from '../agents.ts';
import type { EnvDecl } from '../sandbox/confine.ts';

/** What the agent reports through the fab's `report` MCP tool (D3). */
export interface LiveReport {
  state: 'done' | 'blocked' | 'awaiting';
  summary: string;
  /** Required when state is `awaiting`: the question or action asked of a human. */
  human_action?: string;
}

export interface LiveTurn {
  /** Absent: start a new session. Present: resume exactly that session; never silently start another. */
  sessionId?: string;
  /** Id to give a NEW session (T17): the fab writes it durably before launching. Ignored when `sessionId` is set. */
  newSessionId?: string;
  /** Modelo resuelto para el adaptador de este turno. Ausente si usa su valor por defecto. */
  model?: string;
  prompt: string;
  cwd: string;
  /** Identifies this attempt; every report of the turn is bound to it (D4). */
  attemptId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Run under the fab sandbox. A backend that cannot must throw, not run unconfined. */
  confine?: boolean;
  capturePath?: string;
  /** Host dir for claude's `~/.claude/projects` (T40). Must lie outside everything the sandbox mounts; only claude uses it. */
  claudeProjects?: string;
  /** Host dir for the per-turn MCP config, which carries the turn token (T41). Required (every turn): outside everything the sandbox mounts writable and with no symlink in its path, else the turn fails closed. */
  mcpConfigDir?: string;
  /** Servidores MCP del rol (T72f), ya en el formato de `--mcp-config`, con las referencias `${NOMBRE}` sin resolver. Se suman al `fab` de este turno, que nunca se sustituye. */
  mcpServers?: Record<string, unknown>;
  /** Modo declarado (T72): qué variables recibe el proceso del turno. Ausente: modo anterior. */
  envDecl?: EnvDecl;
  /** Valores entregados, por nombre: se limpian de la salida del turno (S6). */
  scrub?: Record<string, string>;
  onSpawn?: (pgid: number) => void;
  /**
   * Called synchronously for each valid report before the tool answers the agent (T16). It persists the report
   * (e.g. `ReportStore.recorder`); if it throws, the agent receives the error and the report is NOT accepted.
   */
  onReport?: (report: LiveReport) => void;
}

export interface LiveTurnResult extends AgentRun {
  /** The session to resume next turn. Equal to `turn.sessionId` when one was given. */
  sessionId: string;
  attemptId: string;
  /** Reports received through the `report` tool during this turn, in order. */
  reports: LiveReport[];
}

/** Capabilities are the optional members (D2): an absent method is an absent capability. */
export interface LiveBackend {
  name: string;
  /** Whether `confine: true` is supported. */
  confinable: boolean;
  /** El backend recibe el prompt sin pasarlo por argv ni por un runner. */
  promptStdin?: boolean;
  run(turn: LiveTurn): Promise<LiveTurnResult>;
  /** Mid-turn correction. Not part of phase 2; declared so a later backend can add it. */
  steer?(sessionId: string, message: string, requestId: string): Promise<void>;
}

/** Thrown when a given sessionId cannot be resumed. */
export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string, detail = '') {
    super(`live session ${sessionId} not found${detail ? `: ${detail}` : ''}`);
    this.name = 'SessionNotFoundError';
  }
}

export const REPORT_TOOL = 'report';
export const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: ['done', 'blocked', 'awaiting'] },
    summary: { type: 'string' },
    human_action: { type: 'string' },
  },
  required: ['state', 'summary'],
  additionalProperties: false,
} as const;
