import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgent, runAgent } from '../src/agents.ts';
import { assertConfinement, confineAgent } from '../src/sandbox/confine.ts';

let canConfine = false;
try { assertConfinement('simulated'); canConfine = true; } catch {}
const hostPytest = existsSync('/usr/bin/python3') && Bun.spawnSync(['/usr/bin/python3', '-m', 'pytest', '--version']).exitCode === 0;

test.skipIf(!canConfine || !hostPytest)('confinement exposes pytest with read-only user packages and launcher', async () => {
  const root = mkdtempSync('/tmp/fab-pytest-');
  try {
    expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0);
    const launcher = !!process.env.HOME && existsSync(join(process.env.HOME, '.local/bin/pytest'));
    const run = await runAgent({
      name: 'simulated',
      command: () => ['python3', '-c', `import errno,os,pathlib,site,subprocess,pytest
subprocess.run(['python3','-m','pytest','--version'],check=True)
if ${launcher ? 'True' : 'False'}:
 subprocess.run(['pytest','--version'],check=True)
paths=[(pytest.__file__,os.O_WRONLY)]
user_site=pathlib.Path(site.getusersitepackages())
if user_site.is_dir(): paths.append((str(user_site/${JSON.stringify(root.split('/').pop())}),os.O_WRONLY|os.O_CREAT|os.O_EXCL))
for path,flags in paths:
 try:
  fd=os.open(path,flags)
 except OSError as e:
  assert e.errno==errno.EROFS, (path,e)
 else:
  os.close(fd)
  if flags & os.O_CREAT: os.unlink(path)
  raise AssertionError('writable user package: '+path)
if ${launcher ? 'True' : 'False'}:
 try: fd=os.open('/home/agent/.local/bin/pytest',os.O_WRONLY)
 except OSError as e: assert e.errno==errno.EROFS
 else:
  os.close(fd)
  raise AssertionError('writable pytest launcher')
print('STATUS: done')`],
    }, '', root, 10_000, { confine: true });
    expect(run.ok).toBe(true);
    expect(run.stdout).toContain('pytest');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(!canConfine)('confinement works without a host user site or pytest launcher', async () => {
  const root = mkdtempSync('/tmp/fab-no-user-site-');
  const original = process.env.HOME;
  try {
    expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0);
    process.env.HOME = root;
    const confined = confineAgent('simulated', ['sh', '-c', 'test ! -e /home/agent/.local'], root);
    try {
      expect(await confined.spawn('ignore').exited).toBe(0);
    } finally { confined.cleanup(); }
  } finally { process.env.HOME = original; rmSync(root, { recursive: true, force: true }); }
});

test('allowlist confinement hides symlinks, parent proc and sibling worktrees; leaves Git usable', async () => {
  const root = mkdtempSync('/tmp/fab-boundary-');
  try {
    const repo = join(root, 'repo'), wt = join(root, 'wt');
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', '-c', 'user.name=test', '-c', 'user.email=test@local', ...args]);
      if (p.exitCode) throw new Error(p.stderr.toString());
    };
    git('init', '-q', repo);
    writeFileSync(join(repo, 'control'), 'visible');
    git('-C', repo, 'add', '.'); git('-C', repo, 'commit', '-qm', 'base');
    git('-C', repo, 'worktree', 'add', '-qb', 'test', wt);
    const secret = join(root, 'secret'); writeFileSync(secret, 'hidden');
    symlinkSync(secret, join(wt, 'link'));
    const other = join(root, 'other'); mkdirSync(other); git('init', '-q', other); writeFileSync(join(other, 'private'), 'hidden');
    const adapter = {
      name: 'simulated',
      env: () => ({ FABRICA_HOME: root, UNTRUSTED_STATE: secret }),
      command: () => ['python3', '-c', `import pathlib,json,os,subprocess
assert pathlib.Path('control').read_text()=='visible'
r={}
for p in ${JSON.stringify([secret, `${wt}/../secret`, join(wt, 'link'), join(other, 'private'), `/proc/${process.pid}/root${secret}`])}:
 try: pathlib.Path(p).read_bytes(); r[p]=True
 except OSError: r[p]=False
assert 'FABRICA_HOME' not in os.environ and 'UNTRUSTED_STATE' not in os.environ
pathlib.Path('new').write_text('ok')
subprocess.run(['git','add','new'],check=True)
subprocess.run(['git','commit','-qm','inside'],check=True)
pathlib.Path('result.json').write_text(json.dumps(r))
print('STATUS: done')`],
    };
    const runs = await Promise.all([runAgent(adapter, '', wt, 10_000, { confine: true }), runAgent({ ...adapter, command: () => ['sh', '-c', 'test ! -e "$1/new" && echo "STATUS: done"', 'test', wt] }, '', other, 10_000, { confine: true })]);
    expect(runs.every(r => r.ok)).toBe(true);
    expect(Object.values(JSON.parse(readFileSync(join(wt, 'result.json'), 'utf8')))).toEqual(Array(5).fill(false));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('confinement fails closed when bwrap is missing or broken', async () => {
  const root = mkdtempSync('/tmp/fab-bwrap-fail-');
  const original = process.env.PATH;
  try {
    process.env.PATH = root;
    expect(() => assertConfinement('fake')).toThrow(/requiere bubblewrap/);
    writeFileSync(join(root, 'bwrap'), '#!/bin/sh\necho mount-denied >&2\nexit 1\n', { mode: 0o755 });
    expect(() => assertConfinement('fake')).toThrow(/mount-denied/);
    // Preflight succeeds but the real mount fails: the worker must never run.
    process.env.PATH = `${root}:/usr/bin:/bin`;
    Bun.spawnSync(['git', 'init', '-q', join(root, 'repo')]);
    writeFileSync(join(root, 'bwrap'), '#!/bin/sh\nfor arg do if [ "$arg" = "--chdir" ]; then echo mount-denied >&2; exit 1; fi; done\nexec /usr/bin/bwrap "$@"\n', { mode: 0o755 });
    const fake = getAgent('fake');
    await expect(runAgent(fake, '', join(root, 'repo'), 10_000, { confine: true })).rejects.toThrow(/--confine:.*mount-denied/);
  } finally { process.env.PATH = original; rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(!canConfine)('T98: una preparación rechazada elimina el scratch', () => {
  const root = mkdtempSync('/tmp/fab-confine-prep-');
  const temp = join(root, 'temp');
  const saved = process.env.TMPDIR;
  try {
    mkdirSync(temp);
    process.env.TMPDIR = temp;
    expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0);
    expect(() => confineAgent('claude', ['sh', '-c', 'true'], root, {}, join(root, '.git', 'projects'))).toThrow(/preparación falló: .*escribible/);
    expect(readdirSync(temp)).toEqual([]);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!canConfine).each(['lanzamiento', 'lectura', 'cancelación'])('T98: limpia el scratch ante un fallo de %s', async phase => {
  const root = mkdtempSync('/tmp/fab-confine-error-');
  const launch = Bun.spawn;
  let home: string | undefined;
  let pid: number | undefined;
  let exited: Promise<number> | undefined;
  const hook = spyOn(Bun, 'spawn').mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
    const argv = args[0];
    if (!Array.isArray(argv) || !argv.includes('--chdir')) return launch(...args);
    home = argv[argv.indexOf('/home/agent') - 1];
    if (phase === 'lanzamiento') throw new Error('detalle-interno-sintético');
    const child = launch(...args);
    pid = child.pid;
    exited = child.exited;
    // Response.text() falla al intentar leer el otro extremo de este pipe bloqueado.
    if (phase === 'lectura') (child.stdout as ReadableStream).getReader();
    return child;
  }) as typeof Bun.spawn);
  try {
    expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0);
    const adapter = { name: 'fake', command: () => ['sh', '-c', 'exec sleep 30'] };
    const ac = new AbortController();
    const error = await runAgent(adapter, '', root, 4000, {
      confine: true,
      signal: ac.signal,
      onSpawn: () => { if (phase === 'cancelación') ac.abort(); },
    }).catch(e => e);
    if (phase !== 'lanzamiento') {
      expect(pid).toBeDefined();
      expect(() => process.kill(pid!, 0)).toThrow();
    }
    expect(home).toBeDefined();
    expect(existsSync(home!)).toBe(false);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(phase === 'cancelación' ? 'agente o montaje falló' : phase);
    expect(error.message).not.toContain('detalle-interno-sintético');
  } finally {
    hook.mockRestore();
    if (pid !== undefined) {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
      await exited;
    }
    if (home) rmSync(join(home, '..'), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

async function collect(c: ReturnType<typeof confineAgent>) {
  try {
    const child = c.spawn('ignore');
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout, stderr };
  } finally { c.cleanup(); }
}

// T40: `claude --resume` needs the transcript to outlive the ephemeral sandbox HOME.
function inSandbox(script: string, cwd: string, claudeProjects?: string) {
  const c = confineAgent('claude', ['sh', '-c', script], cwd, {}, claudeProjects);
  expect(c.inspection.mountsClaudeProjects).toBe(claudeProjects !== undefined);
  return collect(c);
}

test.skipIf(!canConfine)('claudeProjects persists /home/agent/.claude/projects across confined calls of one worktree', async () => {
  const root = mkdtempSync('/tmp/fab-proj-'), state = mkdtempSync('/tmp/fab-proj-state-');
  try {
    expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0);
    const projects = join(state, 'live', 'abc', 'claude-projects');
    const w = await inSandbox('echo transcript > /home/agent/.claude/projects/s.jsonl', root, projects);
    expect(w.exitCode).toBe(0);
    const r = await inSandbox('cat /home/agent/.claude/projects/s.jsonl', root, projects);
    expect(r.stdout.trim()).toBe('transcript');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); }
});

test.skipIf(!canConfine)('claudeProjects inside a writable mount (git dir, or a symlink into it) fails closed', () => {
  const root = mkdtempSync('/tmp/fab-proj-esc-'), state = mkdtempSync('/tmp/fab-proj-esc-state-');
  try {
    expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0);
    expect(() => inSandbox('true', root, join(root, '.git', 'fab-live', 'claude-projects'))).toThrow(/escribible/);
    // The agent swaps the dir for a symlink; the host would otherwise mount the target.
    mkdirSync(join(root, '.git', 'fab-live'), { recursive: true });
    const link = join(state, 'link');
    symlinkSync(join(root, '.git', 'fab-live'), link);
    expect(() => inSandbox('true', root, link)).toThrow(/symlink|escribible/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); }
});

test.skipIf(!canConfine)('T41: claude-projects dentro del git dir y cambiado por un symlink a una víctima falla cerrado y no escribe en ella', () => {
  const root = mkdtempSync('/tmp/fab-proj-sym-'), victim = mkdtempSync('/tmp/fab-proj-victim-');
  try {
    expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0);
    const live = join(root, '.git', 'state', 'live', 'abc');
    mkdirSync(live, { recursive: true });
    symlinkSync(victim, join(live, 'claude-projects'));
    expect(() => inSandbox('echo PWNED > /home/agent/.claude/projects/x', root, join(live, 'claude-projects'))).toThrow(/symlink/);
    expect(existsSync(join(victim, 'x'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(victim, { recursive: true, force: true }); }
});

test.skipIf(!canConfine)('without claudeProjects nothing persists: each confined call gets a fresh HOME', async () => {
  const root = mkdtempSync('/tmp/fab-noproj-');
  try {
    expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0);
    const w = await inSandbox('mkdir -p /home/agent/.claude/projects && echo transcript > /home/agent/.claude/projects/s.jsonl', root);
    expect(w.exitCode).toBe(0);
    const r = await inSandbox('test -e /home/agent/.claude/projects/s.jsonl', root);
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(join(root, '.git', 'fab-live'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(!canConfine)('T41: mcpConfig se monta en solo lectura en una ruta fija y sustituye todas las apariciones en el argv; falla cerrado si falta, hay symlink o cae en un montaje escribible', async () => {
  const root = mkdtempSync('/tmp/fab-mcp-'), state = mkdtempSync('/tmp/fab-mcp-state-'), victim = mkdtempSync('/tmp/fab-mcp-victim-');
  try {
    expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0);
    const cfg = join(state, 'mcp.json');
    writeFileSync(cfg, '{"t":1}');
    const run = (file: string, argv: string[], mcp = file) => {
      const c = confineAgent('claude', argv, root, {}, undefined, mcp);
      expect(c.inspection.mountsMcpConfigReadOnly).toBe(true);
      return collect(c);
    };
    const ok = await run(cfg, ['sh', '-c', 'cat /opt/fab-mcp/mcp.json && ! (echo x >> /opt/fab-mcp/mcp.json) && test "$0" = /opt/fab-mcp/mcp.json && test "$1" = /opt/fab-mcp/mcp.json', cfg, cfg]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toBe('{"t":1}');
    expect(() => run(cfg, ['sh', '-c', 'true'])).toThrow(/argv/); // ruta ausente del argv
    const live = join(root, '.git', 'state', 'live', 'abc');
    mkdirSync(join(live, 'mcp'), { recursive: true });
    writeFileSync(join(live, 'mcp', 'm.json'), '{}');
    expect(() => run(join(live, 'mcp', 'm.json'), ['sh', '-c', 'true', join(live, 'mcp', 'm.json')])).toThrow(/escribible/);
    symlinkSync(victim, join(state, 'link'));
    expect(() => run(join(state, 'link', 'm.json'), ['sh', '-c', 'true', join(state, 'link', 'm.json')])).toThrow(/symlink/);
    expect(readdirSync(victim)).toEqual([]);
  } finally { for (const d of [root, state, victim]) rmSync(d, { recursive: true, force: true }); }
});
