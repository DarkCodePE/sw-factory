// Explicit opt-in integration probe: one harness + disposable repository.
// SMOKE_AGENT selects the worker (native by default; claude, codex, agy use their own CLI login).
// SMOKE_MODEL selects the native model (default local Ollama; `chatgpt:<model>` uses a Codex login).
// Commits belong only to this fixture; never run it against an existing repository.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { Store } from '../src/store.ts';
import { processActivity } from '../src/pool.ts';
import { branchCommits } from '../src/worktrees.ts';

const root = resolve(process.argv[2] ?? ''), resume = process.argv[3] === '--resume';
if (!process.argv[2] || !isAbsolute(process.argv[2]) || existsSync(root) && !resume) throw new Error('Supply a new absolute fixture directory');
if (resume && JSON.parse(readFileSync(join(root,'probe-contract.json'),'utf8')).native_factory_fixture !== 1) throw new Error('Not an owned fixture');
mkdirSync(root, { recursive: true }); const repo = join(root, 'repo');
const git = (...args: string[]) => {
  const result = Bun.spawnSync(['git', '-C', repo, ...args]);
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
if (!resume) {
mkdirSync(repo);
git('init', '-q', '-b', 'main'); git('config', 'user.name', 'local smoke fixture'); git('config', 'user.email', 'fixture@local');
writeFileSync(join(repo, 'calc.ts'), 'export function add(a: number, b: number) { return a - b; }\n');
writeFileSync(join(repo, 'calc.test.ts'), "import {test,expect} from 'bun:test'; import {add} from './calc'; test('add',()=>{expect(add(2,3)).toBe(5);expect(add(-1,4)).toBe(3);});\n");
git('add', '.'); git('commit', '-qm', 'Initial disposable fixture');
writeFileSync(join(root,'probe-contract.json'),JSON.stringify({native_factory_fixture:1}));
}
const initialHead = git('rev-parse', 'HEAD');
const stateDir = join(root, 'state'); mkdirSync(stateDir,{recursive:true});
process.env.FABRICA_HOME = stateDir;
const agent = process.env.SMOKE_AGENT ?? 'native';
process.env.FABRICA_LLM_MODEL = process.env.SMOKE_MODEL ?? 'qwen3.5-32k:latest';
process.env.FABRICA_LLM_BASE_URL = 'http://127.0.0.1:11434/v1';
process.env.FABRICA_LLM_API_KEY = '';
process.env.FABRICA_AGENT_TIMEOUT_MS = '180000';
process.env.FABRICA_AGENT_MAX_TURNS = '32';
delete process.env.FABRICA_AGENT_SETTINGS;
const store = new Store(join(stateDir, 'factory.db'));
try {
  const ws = resume ? store.getWorkstream('native-smoke') : store.createWorkstream({ slug: 'native-smoke', goal: `Fix add using the ${agent} runtime`, repo, agent,
    requireApproval: false, requireChangeApproval: false });
  if (ws.repo !== repo) throw new Error('Fixture repository mismatch');
  if (ws.state !== 'active') store.setWorkstreamState(ws.id, 'active');
  const change = resume ? store.listChanges(ws.id)[0]! : store.createChange(ws.id, 'Fix add', 'add subtracts instead of summing. Reproduce with bun test and implement the minimal fix.');
  if (!change) throw new Error('No fixture change to resume');
  for (const kind of resume ? ['implementation'] : ['investigation', 'implementation']) {
    const worker = `smoke-${kind}`, activity = store.claimActivity(ws.id, worker);
    if (!activity || activity.kind !== kind) throw new Error('Unexpected fixture activity transition');
    await processActivity(store, activity, worker, { workstream: ws.id, stateDir, log: console.log });
    const completed = store.listActivities({ changeId: change.id }).find(a => a.id === activity.id)!;
    writeFileSync(join(root, `${kind}${resume?"-retry":""}.json`), JSON.stringify(completed, null, 2));
    if (completed.status !== 'completed') throw new Error(`${kind} failed: ${completed.error}`);
  }
  const current = store.getChange(change.id), cwd = join(stateDir, 'worktrees', change.id.slice(0, 8));
  const verification = Bun.spawnSync([process.execPath, 'test'], { cwd });
  const result = { ok: current.status === 'implemented' && verification.exitCode === 0 && git('rev-parse', 'HEAD') === initialHead,
    agent: ws.agent, model: agent === 'native' ? process.env.FABRICA_LLM_MODEL : undefined, change: current, commits: await branchCommits(repo, current.branch!),
    verification: { exitCode: verification.exitCode, stdout: verification.stdout.toString(), stderr: verification.stderr.toString() } };
  writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1;
} finally { store.close(); }
