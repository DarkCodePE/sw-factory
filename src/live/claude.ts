// Live backend over Claude Code CLI: one `claude -p` per turn, resumable by session id.
// Design: techdocs/docs/investigacion/inspiracion/06-integracion-superagent-fab.md §5.2.
import { randomUUID } from 'node:crypto';
import { getAgent, runAgent, type AgentAdapter } from '../agents.ts';
import { createSdkMcpServer } from '../sdk/mcp-server.ts';
import { REPORT_SCHEMA, REPORT_TOOL, SessionNotFoundError, type LiveBackend, type LiveReport, type LiveTurn } from './contract.ts';

const SERVER = 'fab';
const NOT_FOUND = /No conversation found/;

/** The argv of one turn: the stock claude adapter plus session flags and the per-turn `report` MCP. */
export function liveClaudeArgv(base: string[], turn: { sessionId?: string }, sessionId: string, mcp: unknown): string[] {
  return [...base,
    turn.sessionId ? '--resume' : '--session-id', sessionId,
    '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { [SERVER]: mcp } }),
    '--allowedTools', `mcp__${SERVER}__${REPORT_TOOL}`];
}

/** Returns the error text for an invalid report, or the parsed report. Schema shape is checked by the MCP server. */
export function checkReport(input: LiveReport): string | null {
  return input.state === 'awaiting' && !input.human_action?.trim() ? 'human_action is required when state is awaiting' : null;
}

export const claudeLive: LiveBackend = {
  name: 'claude',
  confinable: true,
  async run(turn: LiveTurn) {
    const sessionId = turn.sessionId ?? randomUUID();
    const reports: LiveReport[] = [];
    const server = createSdkMcpServer({ name: SERVER, tools: [{
      name: REPORT_TOOL,
      description: 'Report the state of your work to the factory: done, blocked, or awaiting a human answer (then give human_action).',
      inputSchema: REPORT_SCHEMA as never,
      handler: (input: LiveReport) => {
        const invalid = checkReport(input);
        if (invalid) throw new Error(invalid);
        turn.onReport?.({ ...input });
        reports.push({ ...input });
        return 'report recorded';
      },
    }] });
    try {
      const mcp = await server.start();
      const base = getAgent('claude');
      const adapter: AgentAdapter = { ...base, command: (prompt, options) => liveClaudeArgv(base.command(prompt, options), turn, sessionId, mcp) };
      let run;
      try {
        run = await runAgent(adapter, turn.prompt, turn.cwd, turn.timeoutMs, {
          confine: turn.confine, capturePath: turn.capturePath, signal: turn.signal, onSpawn: turn.onSpawn,
        });
      } catch (e) {
        if (turn.sessionId && NOT_FOUND.test((e as Error).message)) throw new SessionNotFoundError(sessionId, (e as Error).message);
        throw e;
      }
      if (turn.sessionId && run.exitCode !== 0 && NOT_FOUND.test(`${run.stderr}${run.stdout}`)) throw new SessionNotFoundError(sessionId, run.stderr?.trim());
      return { ...run, sessionId, attemptId: turn.attemptId, reports };
    } finally {
      await server.close();
    }
  },
};
