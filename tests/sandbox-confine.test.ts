import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test.skipIf(!canConfine)('confinement works without a host user site or pytest launcher', () => {
  const root = mkdtempSync('/tmp/fab-no-user-site-');
  const original = process.env.HOME;
  try {
    expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0);
    process.env.HOME = root;
    const confined = confineAgent('simulated', ['sh', '-c', 'test ! -e /home/agent/.local'], root);
    try {
      expect(Bun.spawnSync(confined.argv, { env: confined.env }).exitCode).toBe(0);
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
    writeFileSync(join(root, 'bwrap'), '#!/bin/sh\nfor arg do if [ "$arg" = "--clearenv" ]; then echo mount-denied >&2; exit 1; fi; done\nexec /usr/bin/bwrap "$@"\n', { mode: 0o755 });
    const fake = getAgent('fake');
    await expect(runAgent(fake, '', join(root, 'repo'), 10_000, { confine: true })).rejects.toThrow(/--confine:.*mount-denied/);
  } finally { process.env.PATH = original; rmSync(root, { recursive: true, force: true }); }
});

// T40: `claude --resume` needs the transcript to outlive the ephemeral sandbox HOME.
function inSandbox(script: string, cwd: string, claudeProjects?: string) {
  const c = confineAgent('claude', ['sh', '-c', script], cwd, {}, claudeProjects);
  try { return Bun.spawnSync(c.argv, { env: c.env }); } finally { c.cleanup(); }
}

test.skipIf(!canConfine)('claudeProjects persists /home/agent/.claude/projects across confined calls of one worktree', () => {
  const root = mkdtempSync('/tmp/fab-proj-');
  try {
    expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0);
    const projects = join(root, '.git', 'fab-live', 'claude-projects');
    const w = inSandbox('echo transcript > /home/agent/.claude/projects/s.jsonl', root, projects);
    expect(w.exitCode).toBe(0);
    const r = inSandbox('cat /home/agent/.claude/projects/s.jsonl', root, projects);
    expect(r.stdout.toString().trim()).toBe('transcript');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(!canConfine)('without claudeProjects nothing persists: each confined call gets a fresh HOME', () => {
  const root = mkdtempSync('/tmp/fab-noproj-');
  try {
    expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0);
    inSandbox('mkdir -p /home/agent/.claude/projects && echo transcript > /home/agent/.claude/projects/s.jsonl', root);
    const r = inSandbox('test -e /home/agent/.claude/projects/s.jsonl', root);
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(join(root, '.git', 'fab-live'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
