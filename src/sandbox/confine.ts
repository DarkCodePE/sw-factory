// Confidentiality boundary for improve workers. Deliberately separate from the
// general write sandbox: no host root, home, factory code or state is mounted.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export function assertConfinement(agent: string): void {
  if (!['claude', 'codex', 'fake', 'simulated'].includes(agent)) throw new Error(`--confine: adaptador ${agent} no soportado`);
  const bwrap = Bun.which('bwrap', { PATH: process.env.PATH });
  if (!bwrap) throw new Error('--confine requiere bubblewrap (bwrap); no se ejecutará sin aislar');
  const p = Bun.spawnSync([bwrap, '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--unshare-pid', '--proc', '/proc', '--dev', '/dev', '--', '/bin/true']);
  if (p.exitCode !== 0) throw new Error(`--confine: bubblewrap no funciona: ${p.stderr.toString().trim()}`);
}

export function confineAgent(name: string, argv: string[], cwd: string, extra: Record<string, string> = {}, claudeProjects?: string) {
  assertConfinement(name);
  const scratch = mkdtempSync(join(tmpdir(), 'fab-confine-'));
  try {
    const home = join(scratch, 'home');
    mkdirSync(home);
    const args = ['--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session',
      '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
      '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--bind', home, '/home/agent'];
    for (const path of ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/ssl/certs', '/etc/ca-certificates', '/etc/passwd', '/etc/group'])
      if (existsSync(path)) args.push('--ro-bind', path, path);
    const worktree = realpathSync(cwd);
    args.push('--bind', worktree, worktree);
    // Linked worktrees point outside cwd. Only their Git metadata is needed;
    // neither the source checkout nor the sibling state directory is exposed.
    for (const flag of ['--absolute-git-dir', '--git-common-dir']) {
      const p = Bun.spawnSync(['git', '-C', worktree, 'rev-parse', flag]);
      if (p.exitCode !== 0) throw new Error('--confine: no se pudo resolver .git');
      const path = realpathSync(resolve(worktree, p.stdout.toString().trim()));
      if (!path.startsWith(worktree + '/')) args.push('--bind', path, path);
    }
    const binary = Bun.which(argv[0]!);
    if (!binary) throw new Error(`--confine: ejecutable ausente: ${argv[0]}`);
    const command = [...argv];
    if (!realpathSync(binary).startsWith('/usr/')) {
      args.push('--ro-bind', realpathSync(binary), '/opt/fab-agent/agent');
      command[0] = '/opt/fab-agent/agent';
    }
    const bun = Bun.which('bun');
    if (bun) args.push('--ro-bind', realpathSync(bun), '/opt/fab-runtime/bun');
    const hostHome = process.env.HOME ?? '';
    // Expose only Python's user packages, never the rest of ~/.local. Detect the
    // system version without executing user site-packages or startup hooks.
    if (hostHome && existsSync('/usr/bin/python3')) {
      const python = Bun.spawnSync(['/usr/bin/python3', '-I', '-S', '-c', 'import sys; print("python%d.%d" % sys.version_info[:2])']);
      const version = python.stdout.toString().trim();
      if (python.exitCode === 0 && /^python\d+\.\d+$/.test(version)) {
        const site = join('.local', 'lib', version, 'site-packages');
        if (existsSync(join(hostHome, site))) args.push('--ro-bind', join(hostHome, site), join('/home/agent', site));
      }
    }
    const pytest = join(hostHome, '.local', 'bin', 'pytest');
    if (hostHome && existsSync(pytest)) args.push('--ro-bind', pytest, '/home/agent/.local/bin/pytest');
    if (name === 'claude') {
      mkdirSync(join(home, '.claude'));
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
      const credentials = join(hostHome, '.claude', '.credentials.json');
      if (existsSync(credentials)) args.push('--ro-bind', credentials, '/home/agent/.claude/.credentials.json');
      // Live turns resume by session id, so the transcript must outlive this ephemeral HOME. Only this per-worktree dir persists.
      if (claudeProjects) { mkdirSync(claudeProjects, { recursive: true, mode: 0o700 }); args.push('--bind', claudeProjects, '/home/agent/.claude/projects'); }
      // No user/project hooks, plugins, MCP servers or host config.
      command.push('--setting-sources', '');
      // A live turn already brings its own `--mcp-config` (the `report` tool): a second, empty one appended last could win and drop it.
      if (!command.includes('--mcp-config')) command.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
    } else if (name === 'codex') {
      mkdirSync(join(home, '.codex'));
      const auth = join(hostHome, '.codex/auth.json');
      if (existsSync(auth)) args.push('--ro-bind', auth, '/home/agent/.codex/auth.json');
    }
    const env: Record<string, string> = { PATH: '/opt/fab-runtime:/usr/local/bin:/usr/bin:/bin:/home/agent/.local/bin', HOME: '/home/agent', TMPDIR: '/tmp', LANG: 'C.UTF-8',
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'fab', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'fab@local' };
    const allowed = name === 'claude' ? ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_BASE_URL']
      : name === 'codex' ? ['OPENAI_API_KEY'] : ['FABRICA_FAKE_SLEEP', 'FABRICA_FAKE_STATUS', 'FABRICA_FAKE_TOUCH'];
    for (const key of allowed) { const v = extra[key] ?? process.env[key]; if (v !== undefined) env[key] = v; }
    args.push('--clearenv');
    for (const [key, value] of Object.entries(env)) args.push('--setenv', key, value);
    args.push('--chdir', worktree, '--', ...command);
    return { argv: [Bun.which('bwrap', { PATH: process.env.PATH })!, ...args], env, cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
  } catch (e) {
    rmSync(scratch, { recursive: true, force: true });
    throw new Error(`--confine: preparación falló: ${(e as Error).message}`, { cause: e });
  }
}
