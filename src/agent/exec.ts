import { resolveExecutionPolicy, YOLO_NOTICE } from './execution-policy.ts';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { listConfiguredToolCatalog, runCodingAgent } from './engine.ts';
import { loadExecSettings, configuredProviders } from './settings.ts';
import { serveExecRpc } from './rpc.ts';
import { describeTool, selectToolNames } from './catalog.ts';
import type { Autonomy } from './types.ts';
import { validateReportStatus } from '../prompts.ts';
import { networkPolicy } from './network-policy.ts';

const HELP = `fab exec — independent coding-agent runtime
  fab exec [prompt] [-f file] [--cwd path] [-m model] [--base-url url]
    [--yolo] [--auto off|low|medium|high] [--use-spec|--mission] [-r effort]
    [--worker-model id] [--validator-model id]
    [-o text|json|stream-json|stream-jsonrpc] [--input-format stream-jsonrpc]
    [--session-id id|--fork id] [--session-dir path]
    [--only-tools names] [--remove-tools names] [--tag name]
    [--append-system-prompt text|--append-system-prompt-file path]
    [--timeout-ms N] [--max-turns N] [--max-context-tokens N]
    [--sandbox required|best-effort] [--sandbox-network auto|ask|deny]
    [--settings file] [--list-tools] [--require-status]
YOLO: no approvals, host execution and network; invocation-only.
Network auto: Execute requests are approved automatically only at --auto high; otherwise approval is required.
Model settings: FABRICA_LLM_MODEL, FABRICA_LLM_BASE_URL, FABRICA_LLM_API_KEY.
Unsupported Droid flags fail explicitly; the native runtime never invokes Droid.
`;

export async function execMain(argv: string[]): Promise<number> {
  try {
    const { positionals, values: v } = parseArgs({ args: argv, allowPositionals: true, options: {
      cwd: { type: 'string' }, model: { type: 'string', short: 'm' }, 'base-url': { type: 'string' },
      yolo: { type: 'boolean' }, auto: { type: 'string' }, 'use-spec': { type: 'boolean' }, 'reasoning-effort': { type: 'string', short: 'r' },
      mission: { type: 'boolean' }, 'worker-model': { type: 'string' }, 'validator-model': { type: 'string' },
      'output-format': { type: 'string', short: 'o' }, file: { type: 'string', short: 'f' },
      'input-format': { type: 'string' }, settings: { type: 'string' },
      'session-id': { type: 'string', short: 's' }, fork: { type: 'string' }, 'session-dir': { type: 'string' },
      'only-tools': { type: 'string' }, 'remove-tools': { type: 'string' },
      tag: { type: 'string', multiple: true }, 'append-system-prompt': { type: 'string' },
      'append-system-prompt-file': { type: 'string' }, 'timeout-ms': { type: 'string' },
      'max-turns': { type: 'string' }, 'max-context-tokens': { type: 'string' },
      sandbox: { type: 'string' }, 'sandbox-network': { type: 'string' }, 'list-tools': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      'require-status': { type: 'boolean' },
    } });
    if (v.help) { console.log(HELP); return 0; }
    const format = v['output-format'] ?? 'text';
    if (!['text', 'json', 'stream-json', 'stream-jsonrpc'].includes(format)) throw new Error('Unsupported output format');
    if (v['input-format'] && v['input-format'] !== 'stream-jsonrpc') throw new Error('Unsupported input format');
    if ((format === 'stream-jsonrpc') !== (v['input-format'] === 'stream-jsonrpc')) throw new Error('stream-jsonrpc requires matching input and output formats');
    if (v['session-id'] && v.fork) throw new Error('session-id and fork are mutually exclusive');
    if (v.mission && v['use-spec']) throw new Error('mission and use-spec are mutually exclusive');
    if (!v.mission && (v['worker-model'] || v['validator-model'])) throw new Error('worker-model/validator-model require mission');
    if (v.sandbox && !['required', 'best-effort'].includes(v.sandbox)) throw new Error('Invalid sandbox mode');
    const selected = (s?: string) => selectToolNames(s?.split(',').map(x => x.trim()).filter(Boolean));
    const settings = await loadExecSettings(v.settings);
    const executionNetwork = networkPolicy(v['sandbox-network'] ?? settings.sandboxNetwork);
    const execution = { permissionMode: v.yolo ? 'yolo' as const : 'standard' as const, autonomy: v.auto as Autonomy | undefined,
      interactionMode: v.mission ? 'mission' as const : v['use-spec'] ? 'spec' as const : 'auto' as const,
      sandbox: v.sandbox as 'required' | 'best-effort' | undefined, networkPolicy: executionNetwork };
    const policy = resolveExecutionPolicy(execution);
    if (v.yolo) console.error(YOLO_NOTICE);
    if (v.model) settings.modelId = v.model;
    const configured = configuredProviders(settings, { model: process.env.FABRICA_LLM_MODEL ?? 'qwen3.5-32k',
      baseUrl: v['base-url'] ?? process.env.FABRICA_LLM_BASE_URL, apiKey: process.env.FABRICA_LLM_API_KEY, reasoningEffort: v['reasoning-effort'] });
    const provider = configured.providers[configured.defaultModelId]!;
    const roleProvider = (name?: string) => {
      if (!name) return undefined;
      if (!Object.hasOwn(configured.providers, name)) throw new Error(`Unknown configured mission model: ${name}`);
      return configured.providers[name]!;
    };
    const mission = v.mission ? { workerProvider: roleProvider(v['worker-model']), validatorProvider: roleProvider(v['validator-model']) } : undefined;
    if (format === 'stream-jsonrpc') {
      if (v.file || positionals.length || v['session-id'] || v.fork || v.auto || v['use-spec'] || v.mission || v['only-tools'] || v['remove-tools'] || v['require-status']) throw new Error('RPC session settings and prompts must be sent through requests');
      const controller = new AbortController(), stop = () => controller.abort(new Error('RPC interrupted'));
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try {
        await serveExecRpc(Bun.stdin.stream(), line => { process.stdout.write(line); }, {
          cwd: resolve(v.cwd ?? process.cwd()), sessionDir: resolve(v['session-dir'] ?? resolve(process.env.FABRICA_HOME ?? resolve(process.env.HOME ?? '.', '.fabrica'), 'agent-sessions')),
          defaultModelId: configured.defaultModelId, providers: configured.providers, signal: controller.signal,
          agent: { permissionMode: execution.permissionMode, mcpServers: settings.mcpServers, sandbox: v.sandbox as 'required' | 'best-effort' | undefined, networkPolicy: executionNetwork,
            timeoutMs: v['timeout-ms'] ? Number(v['timeout-ms']) : undefined, maxTurns: v['max-turns'] ? Number(v['max-turns']) : undefined,
            maxContextTokens: v['max-context-tokens'] ? Number(v['max-context-tokens']) : undefined },
        });
      } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
      return controller.signal.aborted ? 130 : 0;
    }
    if (v['list-tools']) {
      const tools = (await listConfiguredToolCatalog({ ...execution, prompt: '', cwd: resolve(v.cwd ?? process.cwd()), provider,
        mcpServers: settings.mcpServers, interactionMode: v.mission ? 'mission' : v['use-spec'] ? 'spec' : 'auto' })).map(t => describeTool(t, policy.effectiveAutonomy, v.mission ? 'mission' : v['use-spec'] ? 'spec' : 'auto', selected(v['only-tools']), selected(v['remove-tools']), policy));
      if (format === 'text') console.log(tools.map(t => `${t.id}\t${t.category}`).join('\n'));
      else console.log(JSON.stringify(tools));
      return 0;
    }
    let prompt = v.file ? await readFile(resolve(v.file), 'utf8') : positionals.join(' ');
    if (!prompt && !process.stdin.isTTY) prompt = await Bun.stdin.text();
    if (!prompt.trim()) throw new Error('An agent prompt is required');
    const append = [v['append-system-prompt'], v['append-system-prompt-file'] ? await readFile(resolve(v['append-system-prompt-file']), 'utf8') : ''].filter(Boolean).join('\n');
    const controller = new AbortController();
    const stop = () => controller.abort(new Error('Interrupted by user'));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      const result = await runCodingAgent({ ...execution, prompt, mcpServers: settings.mcpServers, cwd: resolve(v.cwd ?? process.cwd()), provider,
        autonomy: execution.autonomy, interactionMode: v.mission ? 'mission' : v['use-spec'] ? 'spec' : 'auto', mission,
        sandbox: v.sandbox as 'required' | 'best-effort' | undefined, networkPolicy: executionNetwork,
        timeoutMs: v['timeout-ms'] ? Number(v['timeout-ms']) : undefined,
        maxTurns: v['max-turns'] ? Number(v['max-turns']) : undefined,
        maxContextTokens: v['max-context-tokens'] ? Number(v['max-context-tokens']) : undefined,
        sessionDir: resolve(v['session-dir'] ?? resolve(process.env.FABRICA_HOME ?? resolve(process.env.HOME ?? '.', '.fabrica'), 'agent-sessions')),
        sessionId: v['session-id'] ?? v.fork, fork: !!v.fork, tags: v.tag, appendSystemPrompt: append,
        onlyTools: selected(v['only-tools']), removeTools: selected(v['remove-tools']), signal: controller.signal,
        validateFinal: v['require-status'] ? validateReportStatus : undefined,
        onEvent: format === 'stream-json' ? e => console.log(JSON.stringify(e)) : undefined });
      if (format === 'json') console.log(JSON.stringify(result));
      else if (format === 'text') {
        if (result.ok) console.log(result.text); else console.error(`${result.error?.type}: ${result.error?.message}`);
        if (result.mission) console.log(`Mission: ${result.mission.state}; ${result.mission.completed}/${result.mission.total} features completed`);
      }
      return result.ok ? 0 : controller.signal.aborted ? 130 : 1;
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
}
if (import.meta.main) process.exit(await execMain(process.argv.slice(2)));
