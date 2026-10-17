import { realpath } from 'node:fs/promises';
import { atomicReplace, readAnchored, readWorkspaceFile, withWorkspaceFile } from './files.ts';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { wrapCommand } from '../sandbox/index.ts';
import { runScript } from '../script-runtime/index.ts';
import { runProcess } from './process.ts';
import type { AgentTool, ToolContext } from './types.ts';

export function inputObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tool input must be an object');
  return input as Record<string, unknown>;
}
export function stringArg(input: Record<string, unknown>, key: string): string {
  if (typeof input[key] !== 'string') throw new Error(`${key} must be a string`);
  return input[key];
}
const within = (root: string, path: string) => { const r = relative(root, path); return !r || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r)); };

/** Extra file authority exists only for this invocation's owned mission metadata.
 * Model-editable planning inputs cannot overwrite the runner's state/handoffs. */
export function fileRoot(c: ToolContext, path: string, writing = false): string {
  const absolute = resolve(c.cwd, path), mission = c.missionDir;
  if (!mission || !within(mission, absolute)) return c.cwd;
  const name = relative(mission, absolute);
  if (writing && (c.missionReadOnly || !/^(features\.json|AGENTS\.md|validation-contract\.md|skills\/[\w-]+\/SKILL\.md)$/.test(name))) throw new Error('Mission metadata path is read-only');
  return mission;
}

export async function workspacePath(root: string, path: string, creating = false): Promise<string> {
  const base = await realpath(root), target = resolve(base, path);
  if (!within(base, target)) throw new Error('Path is outside the workspace');
  let current = target;
  while (true) {
    try {
      const actual = await realpath(current);
      if (!within(base, actual)) throw new Error('Symlink escapes the workspace');
      break;
    } catch (error: any) {
      if (error.code !== 'ENOENT' || !creating || current === base) throw error;
      current = dirname(current);
    }
  }
  return target;
}

export function tool(name: string, effect: AgentTool['effect'], properties: Record<string, unknown>,
  required: string[], run: AgentTool['run'], description: string): AgentTool {
  return { effect, schema: { type: 'function', function: { name, description,
    parameters: { type: 'object', properties, required, additionalProperties: false } } }, run };
}
const str = { type: 'string' };
const limitText = (s: string, max = 64 * 1024) => Buffer.byteLength(s) <= max ? s : Buffer.from(s).subarray(0, max).toString('utf8') + '\n[output truncated]';

export function parseCommand(command: string): string[] | null {
  if (/[;&|$`<>\n\r]/.test(command)) return null;
  const tokens: string[] = [];
  const regex = /\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s"']+))/gy;
  let end = 0, match: RegExpExecArray | null;
  while ((match = regex.exec(command))) {
    tokens.push(match[1] !== undefined ? match[1].replace(/\\(["\\])/g, '$1') : match[2] ?? match[3]!);
    end = regex.lastIndex;
  }
  return command.slice(end).trim() || !tokens.length ? null : tokens;
}

function commandPolicy(input: unknown, context: ToolContext) {
  const args = inputObject(input), command = stringArg(args, 'command');
  if (command.length > 16_384 || /\bsudo\b|\bmkfs\b|\bshutdown\b|\breboot\b|\bdd\b.*\bof=\/dev\//.test(command)) {
    throw new Error('Command blocked by runtime safeguards');
  }
  let argv = parseCommand(command);
  if (!argv && command.includes('&&')) {
    const split = command.indexOf('&&'), prefix = parseCommand(command.slice(0, split));
    if (prefix?.length === 2 && prefix[0] === 'cd' && resolve(context.cwd, prefix[1]!) === context.cwd) argv = parseCommand(command.slice(split + 2));
  }
  const readGit = argv?.[0] === 'git' && ['status', 'diff', 'log', 'show', 'ls-files', 'rev-parse'].includes(argv[1] ?? '') &&
    !argv.some(a => /^(--output|--ext-diff|--textconv|--exec|--config|--no-index)(=|$)/.test(a));
  const development = argv && ((argv[0] === 'git' && ['add', 'commit'].includes(argv[1] ?? '')) ||
    (['bun', 'npm', 'pnpm'].includes(argv[0]!) && ['test', 'run'].includes(argv[1] ?? '')) ||
    (argv[0] === 'git' && readGit) || ['pwd', 'ls', 'cat', 'head', 'tail', 'rg'].includes(argv[0]!));
  const specRead = readGit || argv && (['pwd', 'ls', 'cat', 'head', 'tail', 'rg'].includes(argv[0]!) ||
    ['bun', 'npm', 'pnpm'].includes(argv[0]!) && ['test', 'run'].includes(argv[1] ?? '')) && ['medium', 'high'].includes(context.autonomy);
  return { argv, command, readGit, allowed: context.interactionMode === 'spec' ? !!specRead : !!readGit || context.autonomy === 'high' || context.autonomy === 'medium' && !!development };
}
function commandSequence(input: unknown, context: ToolContext): string[] | null {
  const command = stringArg(inputObject(input), 'command');
  if (command.length > 16_384) throw new Error('Command exceeds 16 KiB');
  const parts = command.split('&&').map(s => s.trim());
  if (parts.length > 16) throw new Error('Command sequence exceeds 16 entries');
  if (parts.length > 1) {
    const first = parseCommand(parts[0]!);
    if (first?.length === 2 && first[0] === 'cd' && resolve(context.cwd, first[1]!) === context.cwd) parts.shift();
  }
  return parts.every(p => parseCommand(p)) ? parts : null;
}
export const executeAllowed = (input: unknown, context: ToolContext) => {
  const parts = commandSequence(input, context);
  return parts ? parts.every(command => commandPolicy({ command }, context).allowed) : commandPolicy(input, context).allowed;
};
export const COMMAND_POLICY_HINT = 'Tool requires higher autonomy or explicit permission. At medium, use simple commands or && sequences; omit pipelines, redirections and ||. stdout and stderr are already captured. cwd is already the workspace.';
async function execute(input: unknown, context: ToolContext) {
  const parts = commandSequence(input, context);
  if (!parts || parts.length === 1) return executeOne(parts ? { command: parts[0] } : input, context);
  if (!executeAllowed(input, context)) throw new Error(COMMAND_POLICY_HINT);
  let stdout = '', stderr = '', exitCode = 0, sandboxed = true, sandboxReason = '';
  for (const command of parts) {
    context.signal.throwIfAborted();
    const r = await executeOne({ command }, context);
    stdout += r.stdout; stderr += r.stderr; exitCode = r.exitCode; sandboxed &&= r.sandboxed; sandboxReason = r.sandboxReason;
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 256 * 1024) throw new Error('Command sequence output exceeds 256 KiB');
    if (exitCode !== 0) break;
  }
  return { stdout, stderr, exitCode, sandboxed, sandboxReason };
}
async function executeOne(input: unknown, context: ToolContext) {
  const { argv, command, readGit, allowed } = commandPolicy(input, context);
  if (!allowed) {
    throw new Error(COMMAND_POLICY_HINT);
  }
  const gitWritable: string[] = [];
  if (argv?.[0] === 'git' && !readGit) {
    for (const option of ['--absolute-git-dir', '--git-common-dir']) {
      const r = await runProcess(['git', 'rev-parse', option], context.cwd, { PATH: process.env.PATH ?? '' }, context.signal);
      if (r.exitCode === 0) gitWritable.push(resolve(context.cwd, r.stdout.trim()));
    }
  }
  const commandArgv = readGit ? ['git', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat',
    '-c', 'diff.external=', '-c', 'core.hooksPath=/dev/null', ...argv!.slice(1)] : argv ?? ['sh', '-c', command];
  if (readGit && ['diff', 'log', 'show'].includes(argv![1]!)) {
    // Git requires these options before revisions and path operands, even
    // when the caller did not include the optional `--` separator.
    commandArgv.splice(commandArgv.length - argv!.length + 2, 0, '--no-textconv', '--no-ext-diff');
  }
  const missionReadOnly: string[] = [];
  if (context.missionDir) {
    try { missionReadOnly.push(await realpath(context.missionDir)); }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  }
  const wrapped = await wrapCommand(commandArgv, {
    workdir: context.cwd, mode: readGit || context.interactionMode === 'spec' ? 'required' : context.sandbox, allowNetwork: false,
    writablePaths: gitWritable, readOnlyPaths: [...(readGit || context.interactionMode === 'spec' ? [context.cwd] : []), ...missionReadOnly],
    env: { PATH: process.env.PATH ?? '', HOME: context.cwd, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  const result = await runProcess(wrapped.argv, context.cwd, wrapped.env, context.signal);
  return { ...result, sandboxed: !wrapped.degraded, sandboxReason: wrapped.reason };
}

/** Built-in names/schema are original implementations of the observed functional contracts. */
export function builtinTools(): AgentTool[] {
  return [
    tool('Read', 'read', { file_path: str, offset: { type: 'integer' }, limit: { type: 'integer' } }, ['file_path'], async (input, c) => {
      const args = inputObject(input), path = stringArg(args, 'file_path');
      if (!isAbsolute(path)) throw new Error('file_path must be an absolute path');
      const { text } = await readWorkspaceFile(fileRoot(c, path), path);
      const offset = args.offset ?? 0, limit = args.limit ?? 2000;
      if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1) throw new Error('Invalid Read range');
      return limitText(text.split('\n').slice(Number(offset), Number(offset) + Number(limit)).join('\n'));
    }, 'Read a UTF-8 workspace file using an absolute path.'),
    tool('LS', 'read', { directory_path: str }, [], async (input, c) => {
      const args = inputObject(input), path = typeof args.directory_path === 'string' ? args.directory_path : '.';
      const directory = await workspacePath(fileRoot(c, path), resolve(c.cwd, path));
      const { readdir } = await import('node:fs/promises');
      return (await readdir(directory, { withFileTypes: true })).slice(0, 1000).map(d => ({ name: d.name, directory: d.isDirectory() }));
    }, 'List entries in a workspace directory.'),
    tool('Create', 'write', { file_path: str, content: str }, ['file_path', 'content'], async (input, c) => {
      const args = inputObject(input), path = stringArg(args, 'file_path'), content = stringArg(args, 'content');
      return withWorkspaceFile(fileRoot(c, path, true), path, true, async (parent, name, absolute) => {
        await atomicReplace(parent, name, content.endsWith('\n') ? content : content + '\n', c.signal, 0o666);
        return { success: true, file_path: absolute };
      });
    }, 'Write a workspace file, creating parent directories and replacing existing content atomically.'),
    tool('Edit', 'write', { file_path: str, old_str: str, new_str: str, change_all: { type: 'boolean' } },
      ['file_path', 'old_str', 'new_str'], async (input, c) => {
        const args = inputObject(input), path = stringArg(args, 'file_path');
        return withWorkspaceFile(fileRoot(c, path, true), path, false, async (parent, name, absolute) => {
          const { text: before, mode } = await readAnchored(parent, name);
          const old = stringArg(args, 'old_str'), replacement = stringArg(args, 'new_str');
          if (!old || !before.includes(old)) throw new Error('Edit search text not found');
          if (!args.change_all && before.indexOf(old) !== before.lastIndexOf(old)) throw new Error('Edit search text is ambiguous');
          const after = args.change_all ? before.split(old).join(replacement) : before.replace(old, () => replacement);
          await atomicReplace(parent, name, after, c.signal, mode);
          return { success: true, file_path: absolute };
        });
      }, 'Replace exact text in a workspace file; ambiguous edits require change_all.'),
    tool('Glob', 'read', { patterns: { type: 'array', items: str }, folder: str }, ['patterns'], async (input, c) => {
      const args = inputObject(input), path = typeof args.folder === 'string' ? args.folder : '.';
      const root = await workspacePath(fileRoot(c, path), resolve(c.cwd, path));
      if (!Array.isArray(args.patterns) || args.patterns.some(p => typeof p !== 'string' || p.startsWith('/') || p.split('/').includes('..'))) throw new Error('Invalid glob patterns');
      const hits = new Set<string>();
      for (const pattern of args.patterns) {
        for await (const path of new Bun.Glob(pattern).scan({ cwd: root, dot: false, followSymlinks: false })) {
          c.signal.throwIfAborted();
          if (hits.size === 1000) return [...hits];
          hits.add(path);
        }
      }
      return [...hits].sort();
    }, 'Find workspace paths using relative glob patterns.'),
    tool('Grep', 'read', { pattern: str, path: str, case_insensitive: { type: 'boolean' }, literal: { type: 'boolean' } }, ['pattern'], async (input, c) => {
      const args = inputObject(input), target = typeof args.path === 'string' ? args.path : '.';
      const path = await workspacePath(fileRoot(c, target), resolve(c.cwd, target));
      const argv = ['rg', '--line-number', '--no-heading', '--max-count', '100', '--max-filesize', '1M'];
      if (args.case_insensitive) argv.push('-i'); if (args.literal) argv.push('-F');
      argv.push('--', stringArg(args, 'pattern'), path);
      const result = await runProcess(argv, c.cwd, { PATH: process.env.PATH ?? '' }, c.signal);
      if (result.exitCode > 1) throw new Error(limitText(result.stderr, 2000));
      return limitText(result.stdout);
    }, 'Search workspace text with ripgrep; return bounded matching lines.'),
    tool('Execute', 'execute', { command: str, riskLevel: str, summary: str }, ['command'], execute,
      'Run in workspace cwd; stdout/stderr are captured. Medium accepts simple development commands and && sequences, including an optional cd <workspace> prefix. Omit pipelines, redirections and || at medium. Each command is checked independently; the sequence stops on failure. riskLevel is advisory.'),
  ];
}

/** The script bridge routes nested calls back through the SAME policy dispatcher. */
export function scriptTool(dispatch: (name: string, input: unknown, signal: AbortSignal) => Promise<unknown>, names: () => string[]): AgentTool {
  return tool('Script', 'execute', { code: str }, ['code'], async (input, c) => {
    const running = new Set<Promise<unknown>>();
    const tools = Object.fromEntries(names().filter(n => n !== 'Script').map(n => [n, (v: unknown, scope: { signal: AbortSignal }) => {
      const work = dispatch(n, v, scope.signal);
      running.add(work);
      void work.finally(() => running.delete(work)).catch(() => {});
      return work;
    }]));
    try {
      const result = await runScript({ code: stringArg(inputObject(input), 'code'), tools, timeoutMs: 30_000, signal: c.signal, sandbox: c.sandbox });
      c.signal.throwIfAborted();
      if (!result.ok) throw new Error(`${result.error.origin}: ${result.error.message}`);
      return result;
    } finally {
      // Runtime return kills the VM and cancels its callback signals. Keep the agent's
      // workspace ownership until every dispatched callback has actually settled.
      await Promise.allSettled([...running]);
    }
  }, 'Run JavaScript with bounded timers and calls to the same permission-checked tools.');
}
