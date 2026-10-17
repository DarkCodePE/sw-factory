// Headless coding-agent adapters. Each turns (prompt, cwd) into one non-interactive run.
// The factory never edits code itself; it hands one activity to one agent run.

export interface AgentRun {
  ok: boolean;
  output: string;
  exitCode: number;
  durationMs: number;
}

export interface AgentAdapter {
  name: string;
  command(prompt: string): string[];
  env?(): Record<string, string>;
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
      'Bash(npm test:*)', 'Bash(bun test:*)', 'Bash(ls:*)', 'Bash(cat:*)',
      // The user's global RTK hook rewrites `git ...`/`pytest ...` to `rtk git ...` before the
      // permission check, so the rewritten form must be allowed too.
      'Bash(rtk:*)',
    ].join(','),
    '--output-format',
    'text',
  ],
};

const codex: AgentAdapter = {
  name: 'codex',
  command: (prompt) => ['codex', 'exec', '--full-auto', '--skip-git-repo-check', prompt],
};

/**
 * Factory's droid CLI in airgap mode with a bring-your-own model.
 * Requires FABRICA_DROID_HOME (a home dir whose .factory/settings.json defines customModels)
 * and FABRICA_DROID_MODEL (e.g. custom:qwen-capture). See doc/droid-re/reports/05.
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
    'printf "STATUS: %s\\n\\nfake agent handled: %s\\n" "${FABRICA_FAKE_STATUS:-done}" "$1"',
    'fake',
    prompt.slice(0, 80),
  ],
};

const ADAPTERS: Record<string, AgentAdapter> = { claude, codex, droid, fake };

export function getAgent(name: string): AgentAdapter {
  const a = ADAPTERS[name];
  if (!a) throw new Error(`unknown agent "${name}" (available: ${Object.keys(ADAPTERS).join(', ')})`);
  return a;
}

export const AGENT_NAMES = Object.keys(ADAPTERS);

export async function runAgent(
  agent: AgentAdapter,
  prompt: string,
  cwd: string,
  timeoutMs = 20 * 60_000
): Promise<AgentRun> {
  const start = Date.now();
  const proc = Bun.spawn(agent.command(prompt), {
    cwd,
    env: { ...process.env, ...(agent.env?.() ?? {}) },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill('SIGTERM'), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const output = (stdout.trim() || stderr.trim()).slice(-20_000);
  return { ok: exitCode === 0 && output.length > 0, output, exitCode, durationMs: Date.now() - start };
}
