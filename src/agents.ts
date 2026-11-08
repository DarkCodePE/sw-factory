// Headless coding-agent adapters. Each turns (prompt, cwd) into one non-interactive run.
// The factory never edits code itself; it hands one activity to one agent run.
import { confineAgent } from './sandbox/confine.ts';
import { atomicEvidence } from './manifest.ts';
import { existsSync, readFileSync } from 'node:fs';
import { selfCommand } from './self.ts';
import { parseReportStatus, reportStatusLine } from './prompts.ts';

export interface AgentRunStatus {
  kind: 'done' | 'blocked' | 'missing';
  reason: string;
}

/** What the agent reports about its own consumption; absent when the CLI does not report it (codex, agy, droid, native). */
export interface AgentUsage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AgentRun {
  ok: boolean;
  output: string;
  exitCode: number;
  durationMs: number;
  status: AgentRunStatus;
  usage?: AgentUsage;
  stdout?: string;
  stderr?: string;
}

export interface AgentAdapter {
  name: string;
  command(prompt: string, options?: { readOnly?: boolean }): string[];
  env?(): Record<string, string>;
  /** Extracts the report text and usage from structured stdout; null means stdout is plain text. */
  parse?(stdout: string): { text: string; usage?: AgentUsage } | null;
  /** The agent cannot write Git metadata (its sandbox mounts .git read-only); the factory commits for it. */
  factoryCommits?: boolean;
}

const claude: AgentAdapter = {
  name: 'claude',
  command: (prompt) => [
    'claude',
    '-p',
    prompt,
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    [
      'Read', 'Edit', 'Write', 'Glob', 'Grep',
      'Bash(git:*)', 'Bash(python3:*)', 'Bash(python:*)', 'Bash(pytest:*)',
      'Bash(npm ci:*)', 'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(npm run lint:*)', 'Bash(npx vitest:*)', 'Bash(npx tsc:*)',
      'Bash(bun test:*)', 'Bash(ls:*)', 'Bash(cat:*)',
      // The user's global RTK hook rewrites `git ...`/`pytest ...` to `rtk git ...` before the
      // permission check, so the rewritten form must be allowed too.
      'Bash(rtk:*)',
    ].join(','),
    '--output-format',
    'json',
  ],
  parse: parseClaudeJson,
};

/** `claude -p --output-format json` prints one result object; input tokens include cache reads and writes. */
export function parseClaudeJson(stdout: string): { text: string; usage?: AgentUsage } | null {
  let r: any;
  try { r = JSON.parse(stdout); } catch { return null; }
  if (r?.type !== 'result') return null;
  const u = r.usage ?? {};
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
  const usage = typeof r.total_cost_usd === 'number' && Number.isFinite(r.total_cost_usd) && r.total_cost_usd >= 0
    ? { costUsd: r.total_cost_usd, inputTokens: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens), outputTokens: n(u.output_tokens) }
    : undefined;
  return { text: typeof r.result === 'string' ? r.result : '', ...(usage ? { usage } : {}) };
}

const codex: AgentAdapter = {
  name: 'codex',
  // codex-cli's workspace-write sandbox always mounts .git read-only, even with --add-dir.
  factoryCommits: true,
  // `--full-auto` was removed in codex-cli 0.160; workspace-write keeps writes inside the worktree.
  // A linked worktree keeps its index and objects in the main repository's .git, which must also be
  // writable or `git commit` fails; read-only activities keep the default read-only sandbox.
  command: (prompt, options) => options?.readOnly
    ? ['codex', 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', prompt]
    : ['codex', 'exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', prompt],
};

/** Antigravity CLI in print mode; uses the signed-in Google AI subscription. */
const agy: AgentAdapter = {
  name: 'agy',
  command: (prompt) => ['agy', '-p', prompt, '--dangerously-skip-permissions', '--output-format', 'text'],
};

/**
 * Factory's droid CLI in airgap mode with a bring-your-own model.
 * Requires FABRICA_DROID_HOME (a home dir whose .factory/settings.json defines customModels)
 * and FABRICA_DROID_MODEL (e.g. custom:qwen-capture).
 */
const droid: AgentAdapter = {
  name: 'droid',
  command: (prompt) => [
    'droid',
    'exec',
    '-m',
    process.env.FABRICA_DROID_MODEL ?? 'custom:qwen-local',
    '--auto',
    'medium',
    '--output-format',
    'text',
    prompt,
  ],
  env: () => {
    const env: Record<string, string> = { FACTORY_AIRGAP_ENABLED: '1' };
    if (process.env.FABRICA_DROID_HOME) env.FACTORY_HOME_OVERRIDE = process.env.FABRICA_DROID_HOME;
    return env;
  },
};

/** Deterministic stand-in used by tests: echoes a fixed report without touching files. */
const fake: AgentAdapter = {
  name: 'fake',
  command: (prompt) => [
    'sh',
    '-c',
    'if [ -n "$FABRICA_FAKE_SLEEP" ]; then sleep "$FABRICA_FAKE_SLEEP"; fi; if [ -n "$FABRICA_FAKE_TOUCH" ]; then touch "$FABRICA_FAKE_TOUCH-$$"; fi; printf "STATUS: %s\\n\\nfake agent handled: %s\\n" "${FABRICA_FAKE_STATUS:-done}" "$1"',
    'fake',
    prompt.slice(0, 80),
  ],
};

const native: AgentAdapter = {
  name: 'native',
  command: (prompt, options) => [...selfCommand('exec', new URL('./agent/exec.ts', import.meta.url)),
    '--require-status',
    '--auto', process.env.FABRICA_AGENT_AUTONOMY ?? 'medium',
    ...(process.env.FABRICA_AGENT_SETTINGS ? ['--settings', process.env.FABRICA_AGENT_SETTINGS] : []),
    ...(process.env.FABRICA_AGENT_TIMEOUT_MS ? ['--timeout-ms', process.env.FABRICA_AGENT_TIMEOUT_MS] : []),
    ...(process.env.FABRICA_AGENT_MAX_TURNS ? ['--max-turns', process.env.FABRICA_AGENT_MAX_TURNS] : []),
    ...(options?.readOnly ? ['--use-spec'] : []), prompt],
};

const ADAPTERS: Record<string, AgentAdapter> = { claude, codex, agy, droid, native, fake };

export function getAgent(name: string): AgentAdapter {
  const a = Object.hasOwn(ADAPTERS, name) ? ADAPTERS[name] : undefined;
  if (!a) throw new Error(`unknown agent "${name}" (available: ${Object.keys(ADAPTERS).join(', ')})`);
  return a;
}

export const AGENT_NAMES = Object.keys(ADAPTERS);

/** Preserve the factory decision line when retaining a bounded report tail. */
export function boundedAgentOutput(text: string): string {
  const max = 20_000;
  const output = text.trim();
  if (output.length <= max) return output;
  const status = reportStatusLine(output);
  const prefix = (status ? status.slice(0, 1024) + '\n\n' : '') + '[Report body truncated]\n';
  return prefix + output.slice(-(max - prefix.length));
}

export async function runAgent(
  agent: AgentAdapter,
  prompt: string,
  cwd: string,
  timeoutMs = 20 * 60_000,
  options: { readOnly?: boolean; confine?: boolean; capturePath?: string; signal?: AbortSignal; onSpawn?: (pgid: number) => void } = {}
): Promise<AgentRun> {
  const start = Date.now();
  const confined = options.confine ? confineAgent(agent.name, agent.command(prompt, options), cwd, agent.env?.()) : undefined;
  let proc;
  try {
    proc = Bun.spawn(confined?.argv ?? agent.command(prompt, options), {
      cwd,
      env: confined?.env ?? { ...process.env, ...(agent.env?.() ?? {}) },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true,
    });
  } catch (e) {
    confined?.cleanup();
    if (options.confine) throw new Error(`--confine: lanzamiento falló: ${(e as Error).message}`, { cause: e });
    throw e;
  }

  if (options.onSpawn) {
    try {
      options.onSpawn(proc.pid);
    } catch {}
  }

  let killed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const killGroup = (sig: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') => {
    try {
      process.kill(-proc.pid, sig);
    } catch {
      try {
        proc.kill(sig);
      } catch {}
    }
  };

  const terminateWithEscalation = () => {
    if (killed) return;
    killed = true;
    killGroup('SIGTERM');
    killTimer = setTimeout(() => {
      killGroup('SIGKILL');
    }, 2000);
    killTimer.unref?.();
  };

  const onAbort = () => {
    terminateWithEscalation();
  };

  if (options.signal?.aborted) {
    onAbort();
  } else if (options.signal) {
    options.signal.addEventListener('abort', onAbort, { once: true });
  }

  const timeoutTimer = setTimeout(() => {
    terminateWithEscalation();
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  confined?.cleanup();
  clearTimeout(timeoutTimer);
  if (killTimer) {
    clearTimeout(killTimer);
  }
  if (options.signal) {
    options.signal.removeEventListener('abort', onAbort);
  }

  if (options.capturePath) atomicEvidence(options.capturePath, (existsSync(options.capturePath) ? readFileSync(options.capturePath, 'utf8') : '') + stdout + (stderr ? '\n[stderr]\n' + stderr : ''));
  if (options.confine && exitCode !== 0) throw new Error(`--confine: agente o montaje falló (exit ${exitCode}): ${stderr.trim()}`);
  const parsed = agent.parse?.(stdout) ?? null;
  const rawOutput = (parsed ? parsed.text : stdout).trim() || stderr.trim();
  const status = parseReportStatus(rawOutput);
  const output = boundedAgentOutput(rawOutput);
  const wasAborted = !!options.signal?.aborted;

  return {
    ok: exitCode === 0 && output.length > 0 && !wasAborted,
    output,
    exitCode,
    durationMs: Date.now() - start,
    status: { kind: status.kind, reason: status.reason },
    ...(parsed?.usage ? { usage: parsed.usage } : {}),
    stdout,
    stderr,
  };
}
