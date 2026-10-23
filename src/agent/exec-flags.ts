import { parseArgs } from 'node:util';
import { configuredProviders, type ExecSettings } from './settings.ts';
import { selectToolNames } from './catalog.ts';
import type { Autonomy, ModelProvider } from './types.ts';
import { networkPolicy } from './network-policy.ts';

export function normalizeExecArgv(argv: string[]): { args: string[]; worktreeName?: string } {
  let worktreeName: string | undefined;
  const normalized: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-w' || arg === '--worktree') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        normalized.push('--worktree=');
        worktreeName = '';
      } else {
        // Lookahead: is next the worktree branch name or the single positional prompt?
        // If there are other positional arguments after next (or a -f/--file flag in argv),
        // next is the worktree branch name.
        const remainingNonFlags = argv.slice(i + 2).filter(a => !a.startsWith('-'));
        const hasFileFlag = argv.includes('-f') || argv.includes('--file');
        if (remainingNonFlags.length > 0 || hasFileFlag) {
          normalized.push(`--worktree=${next}`);
          worktreeName = next;
          i++; // skip next since consumed as worktree name
        } else {
          normalized.push('--worktree=');
          worktreeName = '';
        }
      }
    } else if (arg.startsWith('--worktree=')) {
      worktreeName = arg.slice('--worktree='.length);
      normalized.push(arg);
    } else {
      normalized.push(arg);
    }
  }

  return { args: normalized, worktreeName };
}

export function hasToolPrefixSelector(rawOnly?: string, rawAdd?: string, rawRemove?: string): boolean {
  for (const s of [rawOnly, rawAdd, rawRemove]) {
    if (s && (s.includes('MCP:') || s.includes('___'))) return true;
  }
  return false;
}

export function resolveToolSelection(
  rawOnly?: string,
  rawAdd?: string,
  rawRemove?: string,
  availableToolNames?: string[],
) {
  const selected = (s?: string) => selectToolNames(s?.split(',').map(x => x.trim()).filter(Boolean));
  const expand = (names?: string[]) => {
    if (!names) return undefined;
    if (!availableToolNames || availableToolNames.length === 0) return names;
    const result: string[] = [];
    for (const name of names) {
      if (name.endsWith('___')) {
        const matches = availableToolNames.filter(t => t.startsWith(name));
        if (matches.length > 0) {
          result.push(...matches);
        } else {
          result.push(name);
        }
      } else {
        result.push(name);
      }
    }
    return result;
  };

  const rawOnlyList = selected(rawOnly);
  const rawAddList = selected(rawAdd);
  const rawRemoveList = selected(rawRemove);

  const only = expand(rawOnlyList);
  const add = expand(rawAddList);
  const remove = expand(rawRemoveList);

  // Negative validation: --add-tools with --only-tools that does not include it
  if (only && add) {
    for (const tool of add) {
      const isAllowed = only.includes(tool) || (tool.includes('___') && only.some(o => o.endsWith('___') && tool.startsWith(o)));
      if (!isAllowed) {
        throw new Error(`Cannot add tool '${tool}' not included in only-tools`);
      }
    }
  }

  // Effective onlyTools and removeTools resolution: only -> + add -> - remove
  let effectiveOnlyTools: string[] | undefined;
  let effectiveRemoveTools: string[] | undefined;

  if (only) {
    const combined = [...new Set([...only, ...(add ?? [])])];
    effectiveOnlyTools = combined.filter(t => !remove?.includes(t));
    effectiveRemoveTools = undefined;
  } else {
    effectiveOnlyTools = undefined;
    if (remove) {
      const activeRemove = remove.filter(t => !add?.includes(t));
      if (activeRemove.length > 0) {
        const hasMcpRemove = activeRemove.some(t => t.includes('___'));
        if (hasMcpRemove && availableToolNames && availableToolNames.length > 0) {
          effectiveOnlyTools = availableToolNames.filter(t => !activeRemove.includes(t));
          effectiveRemoveTools = undefined;
        } else {
          effectiveRemoveTools = activeRemove;
        }
      }
    }
  }

  return {
    onlyTools: effectiveOnlyTools,
    removeTools: effectiveRemoveTools,
    rawOnly: only,
    rawAdd: add,
    rawRemove: remove,
  };
}

export function parseExecArgs(argv: string[]) {
  const { args, worktreeName } = normalizeExecArgv(argv);
  const { positionals, values: v } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      cwd: { type: 'string' },
      model: { type: 'string', short: 'm' },
      'base-url': { type: 'string' },
      yolo: { type: 'boolean' },
      hooks: { type: 'boolean' },
      auto: { type: 'string' },
      'use-spec': { type: 'boolean' },
      'reasoning-effort': { type: 'string', short: 'r' },
      'spec-model': { type: 'string' },
      'spec-reasoning-effort': { type: 'string' },
      mission: { type: 'boolean' },
      'worker-model': { type: 'string' },
      'worker-reasoning-effort': { type: 'string' },
      'validator-model': { type: 'string' },
      'validator-reasoning-effort': { type: 'string' },
      worktree: { type: 'string', short: 'w' },
      'worktree-dir': { type: 'string' },
      'output-format': { type: 'string', short: 'o' },
      file: { type: 'string', short: 'f' },
      'input-format': { type: 'string' },
      settings: { type: 'string' },
      'session-id': { type: 'string', short: 's' },
      fork: { type: 'string' },
      'session-dir': { type: 'string' },
      'session-title': { type: 'string' },
      'only-tools': { type: 'string' },
      'add-tools': { type: 'string' },
      'remove-tools': { type: 'string' },
      tag: { type: 'string', multiple: true },
      'append-system-prompt': { type: 'string' },
      'append-system-prompt-file': { type: 'string' },
      'disable-builtin-skills': { type: 'boolean' },
      'timeout-ms': { type: 'string' },
      'max-turns': { type: 'string' },
      'max-context-tokens': { type: 'string' },
      sandbox: { type: 'string' },
      'sandbox-network': { type: 'string' },
      'list-tools': { type: 'boolean' },
      'with-mcp-status': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      'require-status': { type: 'boolean' },
    },
  });

  if (v.help) return { v, positionals, worktreeName, isHelp: true };

  const format = v['output-format'] ?? 'text';
  if (!['text', 'json', 'stream-json', 'stream-jsonrpc'].includes(format)) throw new Error('Unsupported output format');
  if (v['input-format'] && !['stream-jsonrpc', 'stream-json'].includes(v['input-format'])) throw new Error('Unsupported input format');
  if ((format === 'stream-jsonrpc') !== (v['input-format'] === 'stream-jsonrpc')) throw new Error('stream-jsonrpc requires matching input and output formats');
  if (v['session-id'] && v.fork) throw new Error('session-id and fork are mutually exclusive');
  if (v.mission && v['use-spec']) throw new Error('mission and use-spec are mutually exclusive');
  if (!v.mission && (v['worker-model'] || v['validator-model'] || v['worker-reasoning-effort'] || v['validator-reasoning-effort'])) {
    throw new Error('worker-model, validator-model, worker-reasoning-effort and validator-reasoning-effort require mission');
  }
  if (!v['use-spec'] && (v['spec-model'] || v['spec-reasoning-effort'])) {
    throw new Error('spec-model and spec-reasoning-effort require use-spec');
  }
  if (v.sandbox && !['required', 'best-effort'].includes(v.sandbox)) throw new Error('Invalid sandbox mode');

  if (v['session-title'] !== undefined) {
    if (v['session-title'].includes('\n') || v['session-title'].includes('\r')) {
      throw new Error('Session title cannot contain newlines');
    }
    if (v['session-title'].length > 200) {
      throw new Error('Session title cannot exceed 200 characters');
    }
  }

  if (v['input-format'] === 'stream-json' && (v['output-format'] !== 'stream-json' || positionals.length || v.file || v.mission))
    throw new Error('stream-json input requires -o stream-json and forbids prompt, --file and --mission');
  return { v, positionals, worktreeName, isHelp: false };
}

export function buildProviders(
  v: ReturnType<typeof parseExecArgs>['v'],
  settings: ExecSettings,
  onEvent?: (event: import('./types.ts').AgentEvent) => void,
) {
  if (v.model) settings.modelId = v.model;
  const fallbackModel = process.env.FABRICA_LLM_MODEL ?? 'qwen3.5-32k';
  const baseUrl = v['base-url'] ?? process.env.FABRICA_LLM_BASE_URL;
  const apiKey = process.env.FABRICA_LLM_API_KEY;

  const configured = configuredProviders(settings, {
    model: fallbackModel,
    baseUrl,
    apiKey,
    reasoningEffort: v['reasoning-effort'],
  }, onEvent);
  const provider = configured.providers[configured.defaultModelId]!;

  // Build specProvider if in spec mode and spec model/reasoning specified
  let specProvider: ModelProvider | undefined;
  if (v['use-spec'] && (v['spec-model'] || v['spec-reasoning-effort'])) {
    const specModelId = v['spec-model'] ?? settings.modelId ?? configured.defaultModelId;
    const specConfigured = configuredProviders({ ...settings, modelId: specModelId }, {
      model: specModelId,
      baseUrl,
      apiKey,
      reasoningEffort: v['spec-reasoning-effort'] ?? v['reasoning-effort'],
    }, onEvent);
    specProvider = specConfigured.providers[specConfigured.defaultModelId];
  }

  // Build mission role providers if in mission mode
  const roleProvider = (name?: string, effort?: string): ModelProvider | undefined => {
    if (!name && !effort) return undefined;
    const modelId = name ?? settings.modelId ?? configured.defaultModelId;
    const roleConfigured = configuredProviders({ ...settings, modelId }, {
      model: modelId,
      baseUrl,
      apiKey,
      reasoningEffort: effort ?? v['reasoning-effort'],
    }, onEvent);
    return roleConfigured.providers[roleConfigured.defaultModelId];
  };

  const mission = v.mission ? {
    workerProvider: roleProvider(v['worker-model'], v['worker-reasoning-effort']),
    validatorProvider: roleProvider(v['validator-model'], v['validator-reasoning-effort']),
  } : undefined;

  return { configured, provider, specProvider, mission };
}
