import { hookSettings } from './hooks.ts';
import { serveStreamInput } from './stream-input.ts';
import { resolveExecutionPolicy, YOLO_NOTICE } from './execution-policy.ts';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { listAgentTools, listConfiguredToolCatalog, runCodingAgent } from './engine.ts';
import { loadExecSettings } from './settings.ts';
import { serveExecRpc } from './rpc.ts';
import { describeTool } from './catalog.ts';
import { McpManager, McpRuntime } from './mcp.ts';
import type { AgentTool, Autonomy } from './types.ts';
import { validateReportStatus } from '../prompts.ts';
import { networkPolicy } from './network-policy.ts';
import { buildProviders, hasToolPrefixSelector, parseExecArgs, resolveToolSelection } from './exec-flags.ts';
import { prepareExecWorktree } from './exec-worktree.ts';
import { SessionStore } from './session.ts';

const HELP = `fab exec — independent coding-agent runtime
  fab exec [prompt] [-f file] [--cwd path] [-m model] [--base-url url]
    [--yolo] [--auto off|low|medium|high] [--use-spec|--mission] [-r effort]
    [--spec-model id] [--spec-reasoning-effort effort]
    [--worker-model id] [--worker-reasoning-effort effort]
    [--validator-model id] [--validator-reasoning-effort effort]
    [-w, --worktree [name]] [--worktree-dir path]
    [-o text|json|stream-json|stream-jsonrpc] [--input-format stream-jsonrpc|stream-json] [--hooks]
    [--session-id id|--fork id] [--session-dir path] [--session-title title]
    [--only-tools names] [--add-tools names] [--remove-tools names] [--tag name]
    [--append-system-prompt text|--append-system-prompt-file path]
    [--disable-builtin-skills]
    [--timeout-ms N] [--max-turns N] [--max-context-tokens N]
    [--sandbox required|best-effort] [--sandbox-network auto|ask|deny]
    [--settings file] [--list-tools] [--with-mcp-status] [--require-status]
YOLO: no approvals, host execution and network; invocation-only.
Network auto: Execute requests are approved automatically only at --auto high; otherwise approval is required.
Model settings: FABRICA_LLM_MODEL, FABRICA_LLM_BASE_URL, FABRICA_LLM_API_KEY.
Unsupported Droid flags fail explicitly; the native runtime never invokes Droid.
`;

export async function execMain(argv: string[]): Promise<number> {
  try {
    const { v, positionals, worktreeName, isHelp } = parseExecArgs(argv);
    if (isHelp) { console.log(HELP); return 0; }

    const format = v['output-format'] ?? 'text';
    const loaded = await hookSettings(v.settings, loadExecSettings);
    const settings = loaded.settings;
    const executionNetwork = networkPolicy(v['sandbox-network'] ?? settings.sandboxNetwork);
    const execution = {
      permissionMode: v.yolo ? 'yolo' as const : 'standard' as const,
      autonomy: v.auto as Autonomy | undefined,
      interactionMode: v.mission ? 'mission' as const : v['use-spec'] ? 'spec' as const : 'auto' as const,
      sandbox: v.sandbox as 'required' | 'best-effort' | undefined,
      networkPolicy: executionNetwork,
    };
    const policy = resolveExecutionPolicy(execution);
    if (v.yolo) console.error(YOLO_NOTICE);

    const emitEvent = format === 'stream-json'
      ? (e: import('./types.ts').AgentEvent) => console.log(JSON.stringify(e))
      : undefined;

    const { configured, provider, specProvider, mission } = buildProviders(v, settings, emitEvent);
    const settingsPolicy = { modelIds: Object.keys(configured.providers), maxAutonomy: policy.effectiveAutonomy, networkPolicy: executionNetwork };

    let effectiveCwd = resolve(v.cwd ?? process.cwd());
    const sessionDir = resolve(v['session-dir'] ?? resolve(process.env.FABRICA_HOME ?? resolve(process.env.HOME ?? '.', '.fabrica'), 'agent-sessions'));

    const controller = new AbortController();
    const stop = () => controller.abort(new Error('Interrupted by user'));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);

    try {
      if (v.worktree !== undefined) {
        if (v['worktree-dir']) console.error('Warning: --worktree-dir is deprecated; set worktreeDirectory in settings instead');
        const worktreeRoot = v['worktree-dir'] ?? settings.worktreeDirectory;
        const wt = await prepareExecWorktree({
          repo: effectiveCwd,
          name: worktreeName || undefined,
          root: worktreeRoot,
          signal: controller.signal,
        });
        console.error(`Worktree: branch ${wt.branch} at ${wt.path}`);
        effectiveCwd = wt.path;

        if (v['session-id']) {
          const store = await SessionStore.create(sessionDir);
          const s = await store.inspect(v['session-id']);
          if (s.cwd !== effectiveCwd) {
            throw new Error(`Session cwd (${s.cwd}) does not match worktree cwd (${effectiveCwd})`);
          }
        }
      }

      if (format === 'stream-jsonrpc') {
        if (v.file || positionals.length || v['session-id'] || v.fork || v.auto || v['use-spec'] || v.mission ||
            v['only-tools'] || v['add-tools'] || v['remove-tools'] || v['require-status'] ||
            v['spec-model'] || v['spec-reasoning-effort'] || v['worker-reasoning-effort'] || v['validator-reasoning-effort'] ||
            v['session-title']) {
          throw new Error('RPC session settings and prompts must be sent through requests');
        }
        await serveExecRpc(Bun.stdin.stream(), line => { process.stdout.write(line); }, {
          cwd: effectiveCwd,
          sessionDir,
          defaultModelId: configured.defaultModelId,
          providers: configured.providers,
          signal: controller.signal,
          hooksDefault: !!(v.hooks || loaded.enabled),
          agent: {
            permissionMode: execution.permissionMode,
            mcpServers: settings.mcpServers,
            sandbox: v.sandbox as 'required' | 'best-effort' | undefined,
            networkPolicy: executionNetwork,
            timeoutMs: v['timeout-ms'] ? Number(v['timeout-ms']) : undefined,
            maxTurns: v['max-turns'] ? Number(v['max-turns']) : undefined,
            maxContextTokens: v['max-context-tokens'] ? Number(v['max-context-tokens']) : undefined,
          },
        });
        return controller.signal.aborted ? 130 : 0;
      }

      let availableToolNames: string[] | undefined;
      if (hasToolPrefixSelector(v['only-tools'], v['add-tools'], v['remove-tools'])) {
        const mode = v.mission ? 'mission' : v['use-spec'] ? 'spec' : 'auto';
        try {
          const fullCatalog = await listConfiguredToolCatalog({
            ...execution,
            prompt: '',
            cwd: effectiveCwd,
            provider,
            mcpServers: settings.mcpServers,
            settingsPolicy,
            interactionMode: mode,
          }, controller.signal);
          availableToolNames = fullCatalog.map(t => t.schema.function.name);
        } catch {
          availableToolNames = listAgentTools({
            ...execution,
            prompt: '',
            cwd: effectiveCwd,
            provider,
            mcpServers: settings.mcpServers,
            settingsPolicy,
            interactionMode: mode,
          }).map(t => t.schema.function.name);
        }
      }
      const toolSel = resolveToolSelection(v['only-tools'], v['add-tools'], v['remove-tools'], availableToolNames);

      if (v['list-tools']) {
        const mode = v.mission ? 'mission' : v['use-spec'] ? 'spec' : 'auto';
        let mcpStatuses: import('./mcp-oauth.ts').McpServerStatus[] = [];
        let catalogTools: Array<Pick<AgentTool, 'schema' | 'effect'>> = [];

        if (settings.mcpServers && Object.keys(settings.mcpServers).length > 0) {
          // One manager per server: a server that needs OAuth or fails must not hide the others.
          const managers: McpManager[] = [];
          const remote: AgentTool[] = [];
          for (const [name, config] of Object.entries(settings.mcpServers)) {
            const one = new McpManager({ [name]: config }, {
              cwd: effectiveCwd,
              signal: controller.signal,
              autonomy: 'off',
              interactionMode: 'spec',
              sandbox: 'required',
            }, { only: toolSel.onlyTools, remove: toolSel.removeTools });
            managers.push(one);
            try {
              remote.push(...await one.tools());
            } catch (error) {
              const known = McpRuntime.status().find(s => s.server === name);
              if (!known || known.state === 'connecting') {
                McpRuntime.setStatus(name, { ...(known ?? { server: name, transport: config.type ?? (config.url ? 'http' : 'stdio'), fingerprint: '' }), state: 'failed' } as import('./mcp-oauth.ts').McpServerStatus);
              }
              if (!v['with-mcp-status']) console.error(`MCP server ${name}: ${(error as Error).message}`);
            }
          }
          const manager = { close: async () => { await Promise.allSettled(managers.map(m => m.close())); } };
          mcpStatuses = McpRuntime.status();
          catalogTools = listAgentTools({
            ...execution,
            prompt: '',
            cwd: effectiveCwd,
            provider,
            mcpServers: settings.mcpServers,
            tools: remote,
            settingsPolicy,
            onlyTools: toolSel.onlyTools,
            removeTools: toolSel.removeTools,
            interactionMode: mode,
          }).map(({ schema, effect }) => ({ schema, effect }));
          await manager.close();
        } else {
          catalogTools = listAgentTools({
            ...execution,
            prompt: '',
            cwd: effectiveCwd,
            provider,
            settingsPolicy,
            onlyTools: toolSel.onlyTools,
            removeTools: toolSel.removeTools,
            interactionMode: mode,
          }).map(({ schema, effect }) => ({ schema, effect }));
        }

        let tools = catalogTools.map(t => describeTool(
          t,
          policy.effectiveAutonomy,
          mode,
          toolSel.onlyTools ?? toolSel.rawOnly,
          toolSel.removeTools ?? toolSel.rawRemove,
          policy,
          toolSel.rawAdd,
        ));

        if (v['disable-builtin-skills']) {
          tools = tools.map(t => ({ ...t, builtinSkills: false }));
        }

        if (v['with-mcp-status']) {
          if (format === 'text') {
            const toolLines = tools.map(t => `${t.id}\t${t.category}`);
            const mcpLines = mcpStatuses.map(s => `mcp\t${s.server}\t${s.state}`);
            console.log([...toolLines, ...mcpLines].join('\n'));
          } else {
            console.log(JSON.stringify({ tools, mcpServers: mcpStatuses }));
          }
          return 0;
        }

        if (format === 'text') console.log(tools.map(t => `${t.id}\t${t.category}`).join('\n'));
        else console.log(JSON.stringify(tools));
        return 0;
      }

      let prompt = v['input-format'] === 'stream-json' ? '' : v.file ? await readFile(resolve(v.file), 'utf8') : positionals.join(' ');
      if (v['input-format'] !== 'stream-json' && !prompt && !process.stdin.isTTY) prompt = await Bun.stdin.text();
      if (v['input-format'] !== 'stream-json' && !prompt.trim()) throw new Error('An agent prompt is required');

      const append = [v['append-system-prompt'], v['append-system-prompt-file'] ? await readFile(resolve(v['append-system-prompt-file']), 'utf8') : ''].filter(Boolean).join('\n');

      const options: import('./types.ts').AgentOptions = {
        hooks: v.hooks || loaded.enabled,
        ...execution,
        prompt,
        mcpServers: settings.mcpServers,
        cwd: effectiveCwd,
        provider,
        specProvider,
        settingsPolicy,
        autonomy: execution.autonomy,
        interactionMode: v.mission ? 'mission' : v['use-spec'] ? 'spec' : 'auto',
        mission,
        sandbox: v.sandbox as 'required' | 'best-effort' | undefined,
        networkPolicy: executionNetwork,
        timeoutMs: v['timeout-ms'] ? Number(v['timeout-ms']) : undefined,
        maxTurns: v['max-turns'] ? Number(v['max-turns']) : undefined,
        maxContextTokens: v['max-context-tokens'] ? Number(v['max-context-tokens']) : undefined,
        sessionDir,
        sessionId: v['session-id'] ?? v.fork,
        fork: !!v.fork,
        tags: v.tag,
        appendSystemPrompt: append,
        onlyTools: toolSel.onlyTools,
        removeTools: toolSel.removeTools,
        signal: controller.signal,
        validateFinal: v['require-status'] ? validateReportStatus : undefined,
        onEvent: format === 'stream-json' ? (e: import('./types.ts').AgentEvent) => console.log(JSON.stringify(e)) : undefined,
      };
      if (v['input-format'] === 'stream-json') {
        console.error('stream-json deprecado, usa stream-jsonrpc');
        await serveStreamInput(Bun.stdin.stream(), options);
        return controller.signal.aborted ? 130 : 0;
      }
      const result = await runCodingAgent(options);

      if (v['session-title']) {
        const store = await SessionStore.create(sessionDir);
        try {
          await store.acquire(result.sessionId);
          const s = await store.load(result.sessionId);
          s.title = v['session-title'];
          await store.save(s);
        } finally {
          await store.close();
        }
      }

      if (format === 'json') console.log(JSON.stringify(result));
      else if (format === 'text') {
        if (result.ok) console.log(result.text); else console.error(`${result.error?.type}: ${result.error?.message}`);
        if (result.mission) console.log(`Mission: ${result.mission.state}; ${result.mission.completed}/${result.mission.total} features completed`);
      }
      return result.ok ? 0 : controller.signal.aborted ? 130 : 1;
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exit(await execMain(process.argv.slice(2)));
