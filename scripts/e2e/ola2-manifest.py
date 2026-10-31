#!/usr/bin/env python3
"""Real fab/fake evidence, isolated in /tmp; no LLM or production repo writes."""
import json, os, pathlib, shutil, signal, subprocess, tempfile, time

root = pathlib.Path(__file__).resolve().parents[2]
tmp = pathlib.Path(tempfile.mkdtemp(prefix='fab-ola2-real-'))
repo, state = tmp / 'toy-calc', tmp / 'state'
shutil.copytree('/home/orlando/Desktop/factory/examples/toy-calc', repo,
                ignore=shutil.ignore_patterns('.git', '__pycache__', '.pytest_cache'))
env = dict(os.environ, FABRICA_HOME=str(state))

def run(*argv, custom_env=None, check=True):
    print('$', ' '.join(map(str, argv)), flush=True)
    p = subprocess.run(list(map(str, argv)), env=custom_env or env, text=True,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print(p.stdout, end='', flush=True)
    if check and p.returncode: raise RuntimeError(f'exit {p.returncode}')
    return p.stdout.strip()

def fab(*argv): return run('bun', root / 'src/cli.ts', *argv)
def git(*argv): return run('git', '-C', repo, *argv)
def change(title):
    added = fab('signal', 'add', 'demo', title)
    fab('triage', added.split()[1])
    data = json.loads(subprocess.check_output(['bun', '-e',
        "import {Database} from 'bun:sqlite'; const d=new Database(process.argv[1]); console.log(JSON.stringify(d.query('SELECT id FROM changes ORDER BY rowid DESC LIMIT 1').get()));",
        str(state / 'fabrica.db')], text=True))
    return data['id']
def show(cid):
    path = state / 'runs' / cid / 'run.json'
    print('$ cat', path, flush=True)
    data = json.loads(path.read_text())
    print(json.dumps(data, indent=2), flush=True)
    return data

git('init', '-q', '-b', 'main')
git('config', 'user.name', 'demo'); git('config', 'user.email', 'demo@localhost')
git('add', '.'); git('commit', '-qm', 'base toy-calc')
fab('ws', 'create', 'demo', '--repo', repo, '--goal', 'manifest demo', '--agent', 'fake',
    '--no-change-approval', '--no-spec-approval')
fab('ws', 'state', 'demo', 'active')
completed = change('completado con fake')
fab('run', 'demo', '--once')
fab('merge', completed)
assert show(completed)['status'] == 'completed'
canceled = change('cancelado con fake')
fab('run', 'demo', '--once')
fab('reject', canceled)
m = show(canceled)
assert m['status'] == 'canceled' and m['cleanup']['worktree'] == 'absent'
crashed = change('merge interrumpido')
fab('run', 'demo', '--once')
# fake produces no commit. Make a real change on its branch, so recovery must
# prove the merged SHA is an ancestor rather than relying on an empty branch.
wt = state / 'worktrees' / crashed[:8]
(wt / 'recovery.txt').write_text('recover me\n')
run('git', '-C', wt, 'add', '.')
run('git', '-C', wt, 'commit', '-qm', 'commit recuperable')
expected = subprocess.check_output(['git', '-C', wt, 'rev-parse', 'HEAD'], text=True).strip()
real_git = shutil.which('git')
bindir = tmp / 'bin'; bindir.mkdir()
marker = tmp / 'merged'
# Stop the child after the real git merge, before fab can observe completion.
# No production failpoint or timing race is needed.
wrapper = bindir / 'git'
wrapper.write_text('''#!/usr/bin/env python3
import os, subprocess, sys, signal
code = subprocess.call([os.environ['REAL_GIT'], *sys.argv[1:]])
if 'merge' in sys.argv and '--no-edit' in sys.argv and code == 0:
    open(os.environ['MERGE_MARKER'], 'w').write(str(os.getpid()))
    os.kill(os.getpid(), signal.SIGSTOP)
sys.exit(code)
''')
wrapper.chmod(0o755)
crash_env = dict(env, PATH=str(bindir) + os.pathsep + env['PATH'], REAL_GIT=real_git, MERGE_MARKER=str(marker))
argv = ['bun', str(root / 'src/cli.ts'), 'merge', crashed]
print('$', ' '.join(argv), '(git wrapper stops after actual merge)', flush=True)
p = subprocess.Popen(argv, env=crash_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
deadline = time.monotonic() + 20
while not marker.exists():
    if p.poll() is not None: raise RuntimeError(p.communicate()[0])
    if time.monotonic() > deadline: p.kill(); raise RuntimeError('merge barrier timeout')
    time.sleep(.02)
# The event has committed before launching git. Verify it before killing fab.
assert 'merge_started' in fab('events', 'demo')
assert 'operación en curso' in run('bun', root / 'src/cli.ts', 'merge', crashed, check=False)
assert 'merge en curso' in run('bun', root / 'src/cli.ts', 'reject', crashed, check=False)
code = 'import {Store} from ' + json.dumps(str(root / 'src/store.ts')) + '; const s = new Store(process.argv[1], {clock:()=>new Date("2100-01-01T00:00:00Z")}); if (s.requeueOrphans("demo") !== 0 || !s.listActivities({status:"in_progress"}).some(a=>a.workerId?.startsWith("merge:"))) throw Error("merge requeued"); s.close(); console.log("PASS: lease de merge resiste migración y requeueOrphans en 2100");'
run('bun', '-e', code, state / 'fabrica.db')
print('$ kill -9', p.pid, flush=True)
os.kill(p.pid, signal.SIGKILL); p.wait()
os.kill(int(marker.read_text()), signal.SIGKILL)
print('fab interrumpido:', p.returncode, flush=True)
assert p.returncode == -9
assert subprocess.check_output(['git', '-C', repo, 'rev-parse', 'HEAD'], text=True).strip() == expected
fab('merge', crashed)
m = show(crashed)
assert m['status'] == 'completed' and m['head'] == expected
assert m['cleanup'] == {'worktree':'absent', 'branch':'absent'}
assert (repo / 'recovery.txt').read_text() == 'recover me\n'
print('PASS: completed, canceled, kill -9 recovery; evidence:', tmp, flush=True)
