// Live backend over Claude Code CLI: one `claude -p` per turn, resumable by session id.
// Design: techdocs/docs/investigacion/inspiracion/06-integracion-superagent-fab.md §5.2.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgent, runAgent, type AgentAdapter } from '../agents.ts';
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
  return [...argv, turn.sessionId ? '--resume' : '--session-id', sessionId, '--strict-mcp-config', '--mcp-config', mcpConfigPath];
}

/** Where the config file can live: inside the git dir, which `--confine` binds (the sandbox's /tmp is a tmpfs) and `git status` ignores. */
function configDir(cwd: string): string {
  const r = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--absolute-git-dir']);
  return r.exitCode === 0 ? join(r.stdout.toString().trim(), 'fab-live') : join(tmpdir(), 'fab-live');
}

/** Returns the error text for an invalid report, or the parsed report. Schema shape is checked by the MCP server. */
export function checkReport(input: LiveReport): string | null {
  return input.state === 'awaiting' && !input.human_action?.trim() ? 'human_action is required when state is awaiting' : null;
}

export const claudeLive: LiveBackend = {
  name: 'claude',
  confinable: true,
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
      const dir = configDir(turn.cwd);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      configPath = join(dir, `mcp-${randomUUID()}.json`);
      writeFileSync(configPath, JSON.stringify({ mcpServers: { [SERVER]: mcp } }), { mode: 0o600 });
      const path = configPath, base = getAgent('claude');
      const adapter: AgentAdapter = { ...base, command: (prompt, options) => liveClaudeArgv(base.command(prompt, options), turn, sessionId, path) };
      let run;
      try {
        run = await runAgent(adapter, turn.prompt, turn.cwd, turn.timeoutMs, {
          confine: turn.confine, claudeProjects: turn.claudeProjects, capturePath: turn.capturePath, signal: turn.signal, onSpawn: turn.onSpawn,
        });
      } catch (e) {
        if (turn.sessionId && NOT_FOUND.test((e as Error).message)) throw new SessionNotFoundError(sessionId, (e as Error).message);
        throw e;
      }
      if (turn.sessionId && run.exitCode !== 0 && NOT_FOUND.test(`${run.stderr}${run.stdout}`)) throw new SessionNotFoundError(sessionId, run.stderr?.trim());
      return { ...run, sessionId, attemptId: turn.attemptId, reports };
    } finally {
      if (configPath) rmSync(configPath, { force: true });
      await server.close();
    }
  },
};
