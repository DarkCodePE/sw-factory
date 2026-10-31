import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { Store } from '../../src/store.ts';

export interface BenchCase {
  id: string;
  repo: 'toy-calc' | 'real';
  category: 'test_caught' | 'semantic' | 'clean';
  is_bug: boolean;
  caught_by_tests: boolean;
  title: string;
  description: string;
  test_cmd: string;
  patch_file: string;
}

export interface CaseResult {
  id: string;
  repo: string;
  category: string;
  is_bug: boolean;
  caught_by_tests: boolean;
  verdict: string;
  detected: boolean;
  false_rejection: boolean;
  duration_s: number;
  cost: string;
  summary: string;
  error?: string;
}

async function runCmd(cmd: string[], cwd: string, env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

export async function runBenchCase(
  c: BenchCase,
  cliDir: string,
  mode: 'baseline' | 'gates',
  agent: string = 'codex',
  rootDir: string = process.env.E2E_ROOT ?? join(homedir(), '.cache/fab-ola3-bench')
): Promise<CaseResult> {
  const caseRoot = join(rootDir, c.id);
  rmSync(caseRoot, { recursive: true, force: true });
  mkdirSync(caseRoot, { recursive: true });

  const repoDir = join(caseRoot, 'repo');
  const fixtureDir = resolve(cliDir, 'bench/ola3/fixtures', c.repo);
  const patchPath = resolve(cliDir, 'bench/ola3', c.patch_file);
  const fabricaHome = join(caseRoot, 'home');
  mkdirSync(fabricaHome, { recursive: true });

  // 1. Prepare target repo from fixture
  const cpRes = await runCmd(['cp', '-r', fixtureDir, repoDir], caseRoot);
  if (cpRes.exitCode !== 0) throw new Error(`Failed to copy fixture: ${cpRes.stderr}`);

  await runCmd(['git', 'init', '-q', '-b', 'main'], repoDir);
  await runCmd(['git', '-c', 'user.name=bench', '-c', 'user.email=bench@local', 'add', '-A'], repoDir);
  await runCmd(['git', '-c', 'user.name=bench', '-c', 'user.email=bench@local', 'commit', '-qm', 'initial commit'], repoDir);

  const baseShaRes = await runCmd(['git', 'rev-parse', 'HEAD'], repoDir);
  const baseSha = baseShaRes.stdout;

  // 2. Create workstream in fab
  const wsSlug = `ws-${c.id}`;
  const wsCreateArgs = [
    'bun',
    join(cliDir, 'src/cli.ts'),
    'ws',
    'create',
    wsSlug,
    '--repo',
    repoDir,
    '--goal',
    c.title,
    '--agent',
    agent,
    '--no-change-approval',
    '--no-spec-approval',
    '--protect-none',
  ];

  if (mode === 'gates') {
    wsCreateArgs.push('--verify', c.test_cmd);
  }

  const wsRes = await runCmd(wsCreateArgs, caseRoot, { FABRICA_HOME: fabricaHome });
  if (wsRes.exitCode !== 0) {
    throw new Error(`fab ws create failed (${wsRes.exitCode}): ${wsRes.stderr}\n${wsRes.stdout}`);
  }

  await runCmd(['bun', join(cliDir, 'src/cli.ts'), 'ws', 'state', wsSlug, 'active'], caseRoot, { FABRICA_HOME: fabricaHome });

  // 3. Create change in store and apply patch to git branch
  const dbPath = join(fabricaHome, 'fabrica.db');
  const store = new Store(dbPath);
  const ws = store.getWorkstream(wsSlug);

  const change = store.createChange(ws.id, c.title, c.description);
  const shortId = change.id.slice(0, 8);
  const branch = `fab/${shortId}`;

  // Clear initial activity and set change to implemented
  const db = (store as any).db as Database;
  db.query('DELETE FROM activities WHERE change_id = ?').run(change.id);
  db.query(`UPDATE changes SET status = 'implemented', branch = ?, base_sha = ? WHERE id = ?`).run(branch, baseSha, change.id);

  // Apply patch on branch
  await runCmd(['git', 'branch', branch, 'main'], repoDir);
  const tempWt = join(caseRoot, `wt-impl-${c.id}`);
  await runCmd(['git', 'worktree', 'add', tempWt, branch], repoDir);
  const applyRes = await runCmd(['git', 'apply', patchPath], tempWt);
  if (applyRes.exitCode !== 0) {
    throw new Error(`git apply failed on ${c.id}: ${applyRes.stderr}`);
  }
  await runCmd(['git', '-c', 'user.name=impl', '-c', 'user.email=impl@local', 'add', '-A'], tempWt);
  await runCmd(['git', '-c', 'user.name=impl', '-c', 'user.email=impl@local', 'commit', '-qm', c.title], tempWt);
  await runCmd(['git', 'worktree', 'remove', tempWt, '--force'], repoDir);

  // 4. Request QA validation
  store.requestValidation(change.id, ['qa']);
  store.close();

  // 5. Run fab pool
  const startTs = Date.now();
  const runRes = await runCmd(
    ['bun', join(cliDir, 'src/cli.ts'), 'run', wsSlug, '--agent', agent, '--once', '--accept-agent-binaries'],
    caseRoot,
    { FABRICA_HOME: fabricaHome }
  );
  const durationS = Math.round((Date.now() - startTs) / 100) / 10;

  // 6. Inspect outcome from SQLite and run manifest
  const storeAfter = new Store(dbPath);
  const activities = storeAfter.listActivities({ changeId: change.id });
  const qaAct = activities.find((a) => a.validator === 'qa') ?? activities[activities.length - 1];

  let verdict = 'unknown';
  let summary = '';
  let errDesc = '';

  if (qaAct) {
    if (qaAct.status === 'completed') {
      if (qaAct.reviewStatus === 'approved') verdict = 'pass';
      else if (qaAct.reviewStatus === 'declined') verdict = 'fail';
      else if (qaAct.reviewStatus === 'commented') verdict = 'needs_human';
      else verdict = qaAct.reviewStatus ?? 'pass';
    } else if (qaAct.status === 'blocked') {
      verdict = 'blocked';
      errDesc = qaAct.error ?? '';
    } else if (qaAct.status === 'failed') {
      verdict = 'fail';
      errDesc = qaAct.error ?? '';
    } else {
      verdict = qaAct.status;
    }
    summary = (qaAct.reviewComment || qaAct.result || qaAct.error || '').slice(0, 300).replace(/\r?\n/g, ' ');
  } else {
    verdict = 'no_activity';
  }
  storeAfter.close();

  // Check cost and tokens from manifest
  let costStr = 'suscripción ($0.00)';
  const runJsonPath = join(fabricaHome, 'runs', change.id, 'run.json');
  if (existsSync(runJsonPath)) {
    try {
      const manifestData = JSON.parse(readFileSync(runJsonPath, 'utf8'));
      if (manifestData.tokens) costStr = `${manifestData.tokens} tokens`;
    } catch {}
  }

  // Metric calculation:
  // For bugs: detected if verdict is NOT 'pass' (i.e. 'fail', 'needs_human', 'blocked')
  // For clean: false_rejection if verdict is NOT 'pass'
  const isPass = verdict === 'pass';
  const detected = c.is_bug ? !isPass : false;
  const falseRejection = !c.is_bug ? !isPass : false;

  return {
    id: c.id,
    repo: c.repo,
    category: c.category,
    is_bug: c.is_bug,
    caught_by_tests: c.caught_by_tests,
    verdict,
    detected,
    false_rejection: falseRejection,
    duration_s: durationS,
    cost: costStr,
    summary,
    error: errDesc || undefined,
  };
}
