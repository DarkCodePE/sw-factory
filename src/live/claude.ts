// Live backend over Claude Code CLI: one `claude -p` per turn, resumable by session id.
// Design: techdocs/docs/investigacion/inspiracion/06-integracion-superagent-fab.md §5.2.
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgent, runAgent, type AgentAdapter } from '../agents.ts';
import { parseClaudeStream } from '../agent-output.ts';
import { hostDir } from '../sandbox/confine.ts';
import { createSdkMcpServer } from '../sdk/mcp-server.ts';
import { REPORT_SCHEMA, REPORT_TOOL, SessionNotFoundError, type LiveBackend, type LiveReport, type LiveTurn } from './contract.ts';

const SERVER = 'fab';
const NOT_FOUND = /No conversation found/;

/**
 * The argv of one turn: the stock claude adapter plus session flags and the per-turn `report` MCP (T34, H-19).
 * The MCP config (it carries the per-turn token) goes by FILE, never inline: argv is visible in the process list.
 * `--allowedTools` is merged into the adapter's single flag and `--mcp-config` appears once, so the result does not depend
 * on how a given `claude` version treats repeated flags (pinned by tests/live-claude.test.ts).
 */
export function liveClaudeArgv(base: string[], turn: { sessionId?: string }, sessionId: string, mcpConfigPath: string): string[] {
  const argv = [...base], tool = `mcp__${SERVER}__${REPORT_TOOL}`, at = argv.indexOf('--allowedTools');
  if (at >= 0) argv[at + 1] = `${argv[at + 1]},${tool}`; else argv.push('--allowedTools', tool);
  const format = argv.indexOf('--output-format');
  if (format >= 0) argv[format + 1] = 'stream-json'; else argv.push('--output-format', 'stream-json');
  return [...argv, '--verbose', turn.sessionId ? '--resume' : '--session-id', sessionId, '--strict-mcp-config', '--mcp-config', mcpConfigPath];
}

/** Returns the error text for an invalid report, or the parsed report. Schema shape is checked by the MCP server. */
export function checkReport(input: LiveReport): string | null {
  return input.state === 'awaiting' && !input.human_action?.trim() ? 'human_action is required when state is awaiting' : null;
}

export const claudeLive: LiveBackend = {
  name: 'claude',
  confinable: true,
  promptStdin: getAgent('claude').promptStdin,
  async run(turn: LiveTurn) {
    const sessionId = turn.sessionId ?? turn.newSessionId ?? randomUUID();
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
    let configPath: string | undefined;
    try {
      const mcp = await server.start();
      if (!turn.mcpConfigDir) throw new Error('el turno vivo necesita mcpConfigDir, fuera de los montajes escribibles del sandbox'); // T41
      const dir = hostDir(turn.mcpConfigDir, turn.cwd);
      configPath = join(dir, `mcp-${randomUUID()}.json`);
      writeFileSync(configPath, JSON.stringify({ mcpServers: { ...turn.mcpServers, [SERVER]: mcp } }), { mode: 0o600 });
      const path = configPath, base = getAgent('claude');
      let stdoutForMonitor = '';
      let stdoutDiagnostic = '';
      const adapter: AgentAdapter = {
        ...base,
        command: (prompt, options) => liveClaudeArgv(base.command(prompt, { ...options, mcpConfig: undefined }), turn, sessionId, path),
        parse(stdout) {
          const parsed = parseClaudeStream(stdout);
          if (parsed.result) {
            // Conserva la entrada histórica del monitor: el objeto result de Claude.
            stdoutForMonitor = parsed.line;
            return parsed.result;
          }
          stdoutDiagnostic = stdout.trimEnd().split('\n').reverse()
            .find(line => !line.trimStart().startsWith('{') && NOT_FOUND.test(line))?.trim() ?? '';
          // Con frames parciales, deja que runAgent use stderr como diagnóstico.
          return parsed.hasFrame ? { text: '' } : null;
        },
      };
      let run;
      try {
        run = await runAgent(adapter, turn.prompt, turn.cwd, turn.timeoutMs, {
          confine: turn.confine, model: turn.model, claudeProjects: turn.claudeProjects, mcpConfig: path, envDecl: turn.envDecl, scrub: turn.scrub, capturePath: turn.capturePath, signal: turn.signal, onSpawn: turn.onSpawn,
        });
      } catch (e) {
        if (turn.sessionId && NOT_FOUND.test((e as Error).message)) throw new SessionNotFoundError(sessionId, (e as Error).message);
        throw e;
      }
      if (turn.sessionId && run.exitCode !== 0 && NOT_FOUND.test(`${run.stderr ?? ''}\n${stdoutForMonitor || stdoutDiagnostic}`)) {
        throw new SessionNotFoundError(sessionId, run.stderr?.trim() || (!stdoutForMonitor ? stdoutDiagnostic : ''));
      }
      return { ...run, stdoutForMonitor, sessionId, attemptId: turn.attemptId, reports };
    } finally {
      if (configPath) rmSync(configPath, { force: true });
      await server.close();
    }
  },
};
