import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgent, runAgent } from '../src/agents.ts';
import { assertConfinement } from '../src/sandbox/confine.ts';

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
