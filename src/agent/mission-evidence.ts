// Runtime-observed evidence for mission attempts. A handoff is the model's claim; these records
// are what the runtime actually saw. Validation success is derived from observations and from
// verifier commands the runner executes itself, never from validatorsPassed/commandsRun text.
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readWorkspaceFile } from './files.ts';
import { listIgnoredDirectories, listSourceFiles } from './mission-files.ts';
import { runProcess } from './process.ts';
import { wrapCommand } from '../sandbox/index.ts';
import type { ToolContext } from './types.ts';
import type { FeatureHandoff } from './mission-contract.ts';

export interface ObservedCommand {
  command: string;
  exitCode: number | null;
  isError: boolean;
}

export interface VerifierResult {
  command: string;
  exitCode: number;
  output: string;
}

const MAX_OBSERVED = 200;
const normalize = (command: string) => command.trim().replace(/\s+/g, ' ');

/**
 * Records every Execute the attempt's own dispatcher ran, including calls nested inside Script.
 * Fed by the dispatcher itself, so it cannot be bypassed by routing a command through another tool.
 */
export function createCommandObserver() {
  const observed: ObservedCommand[] = [];
  const observe = (name: string, input: unknown, value: unknown, isError: boolean) => {
    if (observed.length >= MAX_OBSERVED) return;
    if (name === 'Execute') {
      const command = (input as { command?: unknown } | null)?.command;
      if (typeof command !== 'string') return;
      const exitCode = (value as { exitCode?: unknown } | null)?.exitCode;
      observed.push({ command, exitCode: !isError && typeof exitCode === 'number' ? exitCode : null, isError });
    } else if (name === 'TaskOutput' && value && typeof value === 'object') {
      const v = value as { command?: unknown; exitCode?: unknown };
      if (typeof v.command === 'string' && typeof v.exitCode === 'number' && !isError) {
        const match = observed.find(o => normalize(o.command) === normalize(v.command as string) && o.exitCode === null);
        if (match) {
          match.exitCode = v.exitCode;
          match.isError = v.exitCode !== 0;
        }
      }
    }
  };
  return { observe, observed: () => observed.slice() };
}

/** Claimed verification commands that the runtime never observed with the claimed exit code. */
export function unobservedClaims(handoff: FeatureHandoff, observed: readonly ObservedCommand[]): string[] {
  return handoff.handoff.verification.commandsRun
    .filter(claim => !observed.some(o => !o.isError && o.exitCode === claim.exitCode && normalize(o.command) === normalize(claim.command)))
    .map(claim => `${claim.command} (exit ${claim.exitCode})`);
}

/** A validator counts only if it actually ran at least one command that succeeded. */
export const observedSuccessfulCommand = (observed: readonly ObservedCommand[]) =>
  observed.some(o => !o.isError && o.exitCode === 0);

/** Characters that only mean something to a shell. Unquoted they are refused; quoted they are literal text. */
const SHELL_OPERATORS = new Set(['|', '&', ';', '<', '>', '`', '$', '(', ')', '{', '}', '*', '?', '[', ']', '~', '#', '!']);

/**
 * Tokenize a verifier like a POSIX shell would split words, without ever running a shell:
 * single quotes are literal, double quotes group words (and may escape \ and "), and a backslash
 * outside quotes escapes the next character. Any unquoted operator, expansion or glob is refused,
 * as are newlines and unterminated quotes, so the argv means exactly what it says.
 */
export function verifierArgv(command: string, maxLength = 1000): string[] {
  const fail = (why: string): never => { throw new Error(`Verifier must be a simple command without shell syntax (${why}): ${command}`); };
  if (!command.trim() || command.length > maxLength) fail('empty or exceeds command length limit');
  if (/[\n\r\0]/.test(command)) fail('newline or NUL');
  const argv: string[] = [];
  let word = '', inWord = false, i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === ' ' || ch === '\t') { if (inWord) { argv.push(word); word = ''; inWord = false; } i++; continue; }
    inWord = true;
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) fail('unterminated single quote');
      word += command.slice(i + 1, end); i = end + 1;
    } else if (ch === '"') {
      i++;
      for (;;) {
        if (i >= command.length) fail('unterminated double quote');
        const c = command[i]!;
        if (c === '"') { i++; break; }
        if (c === '$' || c === '`') fail('expansion inside double quotes');
        if (c === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) { word += command[i + 1]; i += 2; continue; }
        word += c; i++;
      }
    } else if (ch === '\\') {
      if (i + 1 >= command.length) fail('trailing backslash');
      word += command[i + 1]; i += 2;
    } else {
      if (SHELL_OPERATORS.has(ch)) fail(`unquoted ${ch}`);
      word += ch; i++;
    }
  }
  if (inWord) argv.push(word);
  if (!argv.length) fail('no command');
  return argv;
}

/** Environment variables a verifier may inherit: locale and tool locations, nothing that injects code. */
const VERIFIER_ENV = ['LANG', 'LC_ALL', 'TZ', 'TERM', 'BUN_INSTALL'] as const;

/**
 * Build a writable throwaway copy of exactly the fingerprinted source, with dependency directories
 * the source ignores (node_modules, .venv, ...) bound read-only. Test runners can write caches and
 * coverage into the copy; nothing they write reaches the workspace, and the bytes they test are the
 * bytes that were fingerprinted.
 */
async function verifierWorkspace(context: ToolContext) {
  const root = await mkdtemp(join(tmpdir(), 'fab-verify-'));
  const binds: Array<{ source: string; target: string }> = [];
  try {
    for (const path of await listSourceFiles(context)) {
      const file = await readWorkspaceFile(context.cwd, path);
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.data, { mode: file.mode & 0o777 });
    }
    for (const dir of await listIgnoredDirectories(context)) {
      const source = join(context.cwd, dir), target = join(root, dir);
      const info = await lstat(source).catch(() => undefined);
      if (!info?.isDirectory()) continue;
      await mkdir(target, { recursive: true });
      binds.push({ source, target });
    }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  return { root, binds, dispose: () => rm(root, { recursive: true, force: true }) };
}

/**
 * Run one contract verifier as the runner, not as the model: OS sandbox required, no network,
 * allow-listed environment, on a disposable copy of the frozen source. A non-zero exit or any
 * failure is a failed check.
 */
export async function runVerifier(context: ToolContext, command: string): Promise<VerifierResult> {
  const argv = verifierArgv(command);
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp', CI: '1' };
  for (const key of VERIFIER_ENV) if (process.env[key]) env[key] = process.env[key]!;
  const space = await verifierWorkspace(context);
  try {
    const wrapped = await wrapCommand(argv, { workdir: space.root, mode: 'required', allowNetwork: false, env, readOnlyBinds: space.binds });
    const r = await runProcess(wrapped.argv, space.root, wrapped.env, context.signal, 1024 * 1024);
    return { command, exitCode: r.exitCode, output: (r.stdout + r.stderr).slice(-4000) };
  } catch (error) {
    context.signal.throwIfAborted();
    return { command, exitCode: -1, output: error instanceof Error ? error.message : String(error) };
  } finally { await space.dispose(); }
}
