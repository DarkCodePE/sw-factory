import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGates, runVerifierAt } from '../src/gates.ts';
import { Store } from '../src/store.ts';
import { processActivity, runPool } from '../src/pool.ts';
import { mergeBlocker } from '../src/validators/publish.ts';
import { ensureWorktree } from '../src/worktrees.ts';

let dir: string, repo: string, store: Store;
const signal = () => new AbortController().signal;
function git(...args: string[]) {
  const p = Bun.spawnSync(['git', '-c', 'user.name=test', '-c', 'user.email=test@test', ...args], { cwd: repo });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-gates-test-'));
  repo = join(dir, 'repo');
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'code.txt'), 'original\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  git('add', '.'); git('commit', '-qm', 'initial');
  store = new Store(join(dir, 'fabrica.db'));
});
afterEach(() => {
  delete process.env.FABRICA_FAKE_STATUS;
  delete process.env.FAB_GATES_SECRET;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup(verify?: string[]) {
  const ws = store.createWorkstream({ slug: 'gates', goal: 'goal', repo, agent: 'fake', verify,
    requireChangeApproval: false, requireApproval: false });
  store.setWorkstreamState(ws.id, 'active');
  const change = store.createChange(ws.id, 'Feature', 'Small change');
  return { ws, change };
}
const pool = (ws: string) => runPool(store, { workstream: ws, stateDir: dir, untilIdle: true, log: () => {} });

test('exit code alone decides pass; all steps run after nonzero and unexecutable argv', async () => {
  const result = await runGates(repo, [
    ['sh', '-c', 'echo ERROR; exit 0'], ['sh', '-c', 'echo passed; exit 7'],
    ['fab-no-such-executable'], ['printf', 'last step'],
  ], signal());
  expect(result.passed).toBe(false);
  expect(result.steps[0]!.exitCode).toBe(0);
  expect(result.steps[1]!.exitCode).toBe(7);
  expect(result.steps[2]!.exitCode).not.toBe(0);
  expect(result.steps[3]!.exitCode).toBe(0);
  expect(result.steps[3]!.output).toBe('last step');
  expect((await runGates(repo, [['sh', '-c', 'echo FAILED; exit 0']], signal())).passed).toBe(true);
});

test('timeout fails one step, preserves its output, and runs remaining steps', async () => {
  const result = await runGates(repo, [['sh', '-c', 'echo started; sleep 10'], ['echo', 'after']], signal(), undefined, 300);
  expect(result.passed).toBe(false);
  expect(result.steps[0]!.timedOut).toBe(true);
  expect(result.steps[0]!.output).toContain('started');
  expect(result.steps[1]!.exitCode).toBe(0);
  expect(result.steps[1]!.output).toContain('after');
});

test('verifier denies network with a reachable positive control on the host', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reachable') });
  try {
    expect(await (await fetch(`http://127.0.0.1:${server.port}`)).text()).toBe('reachable');
    const result = await runVerifierAt(repo, ['python3', '-c', `import socket; socket.create_connection(('127.0.0.1', ${server.port}), 1)`], signal());
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/Permission|Network|refused|unreachable/i);
  } finally { server.stop(true); }
});

test('disposable source, read-only dependencies and filtered environment are preserved', async () => {
  mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'dependency');
  process.env.FAB_GATES_SECRET = 'must-not-inherit';
  const result = await runGates(repo, [
    ['sh', '-c', 'echo changed > code.txt; mkdir coverage; cat node_modules/dep/index.js; test -z "$FAB_GATES_SECRET"'],
    ['sh', '-c', 'echo damaged > node_modules/dep/index.js'],
  ], signal());
  expect(result.steps[0]!.exitCode).toBe(0);
  expect(result.steps[1]!.exitCode).not.toBe(0);
  expect(readFileSync(join(repo, 'code.txt'), 'utf8')).toBe('original\n');
  expect(existsSync(join(repo, 'coverage'))).toBe(false);
  expect(readFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('dependency');
});

test('full output beyond the old 1 MiB limit is retained', async () => {
  const result = await runVerifierAt(repo, ['python3', '-c', 'print("BEGIN" + "x" * 1100000 + "END")'], signal());
  expect(result.exitCode).toBe(0);
  expect(result.output.startsWith('BEGIN')).toBe(true);
  expect(result.output.trimEnd().endsWith('END')).toBe(true);
  expect(result.output.length).toBeGreaterThan(1100000);
});

test('gate fail enters inbox without LLM validators and retry returns to implementation', async () => {
  const { ws, change } = setup(['sh -c \'echo broken; exit 2\'', 'echo final']);
  await pool(ws.id);
  const acts = store.listActivities({ changeId: change.id });
  expect(acts.filter(a => a.validator)).toHaveLength(0);
  const gate = acts.find(a => a.kind === 'gates')!;
  expect(gate.status).toBe('blocked');
  expect(gate.retryCount).toBe(0);
  expect(store.inbox(ws.id).map(a => a.id)).toContain(gate.id);
  expect(gate.error).toContain('broken');
  expect(gate.error).toContain('final');
  const manifest = JSON.parse(readFileSync(join(dir, 'runs', change.id, 'run.json'), 'utf8'));
  const evidence = manifest.activities.find((a: any) => a.id === gate.id);
  expect(evidence.verdict).toBe('fail');
  expect(evidence.steps).toHaveLength(2);
  expect(readFileSync(join(dir, 'runs', change.id, evidence.steps[0].log), 'utf8')).toContain('broken');
  const retry = store.retryChange(change.id);
  expect(retry.kind).toBe('implementation');
  expect(retry.validator).toBeNull();
});

test('only gate pass enqueues LLM validators, all tied to verified HEAD; no duplicate pending gates', async () => {
  process.env.FABRICA_FAKE_STATUS = 'done\nVERDICT: pass\n\nReviewed';
  const { ws, change } = setup(['echo verified']);
  const options = { workstream: ws.id, stateDir: dir, log: () => {} };
  for (let i = 0; i < 2; i++) {
    const a = store.claimActivity(ws.id, 'worker')!;
    await processActivity(store, a, 'worker', options);
  }
  expect(store.listActivities({ changeId: change.id }).filter(a => a.validator)).toHaveLength(0);
  expect(store.requestValidation(change.id, ['qa'])).toHaveLength(0);
  expect(store.requestValidation(change.id, ['qa'])).toHaveLength(0);
  const gate = store.claimActivity(ws.id, 'worker')!;
  expect(gate.kind).toBe('gates');
  await processActivity(store, gate, 'worker', options);
  const completed = store.getActivity(gate.id);
  const validators = store.listActivities({ changeId: change.id }).filter(a => a.validator);
  expect(validators).toHaveLength(3);
  expect(validators.every(a => a.verifiedHead === completed.verifiedHead)).toBe(true);
  await pool(ws.id);
  expect(store.validationSummary(change.id).passed).toBe(true);
  expect(store.getChange(change.id).status).toBe('implemented');
});

test('changed HEAD between gate and LLM blocks the review and invalidates earlier approvals on retry', async () => {
  const { ws, change } = setup(['true']);
  const options = { workstream: ws.id, stateDir: dir, log: () => {} };
  for (let i = 0; i < 3; i++) await processActivity(store, store.claimActivity(ws.id, 'worker')!, 'worker', options);
  const tree = await ensureWorktree(repo, dir, change.id);
  Bun.spawnSync(['git', '-c', 'user.name=test', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'head changed'], { cwd: tree.path });
  const validator = store.claimActivity(ws.id, 'worker')!;
  await processActivity(store, validator, 'worker', options);
  expect(store.getActivity(validator.id).error).toContain('GATE_HEAD_CHANGED');
  expect(store.getChange(change.id).status).toBe('blocked');
  expect(store.retryChange(change.id).kind).toBe('implementation');
  expect(store.validationSummary(change.id).passed).toBe(false);
});

test('without --verify the existing manual validator flow remains intact', async () => {
  const { ws, change } = setup();
  await pool(ws.id);
  expect(store.listActivities({ changeId: change.id }).map(a => a.kind)).toEqual(['investigation', 'implementation']);
  expect(store.requestValidation(change.id, ['code_review', 'security_audit', 'qa'])).toHaveLength(3);
});

test('verify argv is validated before storing commands and survives reopening the database', () => {
  expect(() => setup(['echo yes && false'])).toThrow('shell syntax');
  const { ws } = setup(['python3 -m pytest -q', "printf 'two words'"]);
  expect(ws.verify).toEqual([['python3', '-m', 'pytest', '-q'], ['printf', 'two words']]);
  store.close();
  store = new Store(join(dir, 'fabrica.db'));
  expect(store.getWorkstream(ws.id).verify).toEqual(ws.verify);
});

test('manual --only waits for a gate and enqueues only the requested LLM', async () => {
  const { ws, change } = setup(['true']);
  store.db.query('DELETE FROM activities WHERE change_id = ?').run(change.id);
  store.db.query("UPDATE changes SET status = 'implemented' WHERE id = ?").run(change.id);
  const requested = store.requestValidation(change.id, ['qa']);
  expect(requested.map(a => a.kind)).toEqual(['gates']);
  const gate = store.claimActivity(ws.id, 'worker')!;
  await processActivity(store, gate, 'worker', { workstream: ws.id, stateDir: dir, log: () => {} });
  expect(store.listActivities({ changeId: change.id }).filter(a => a.validator).map(a => a.validator)).toEqual(['qa']);
});

test('aborting a gate retains partial step evidence and never enqueues LLM', async () => {
  const controller = new AbortController();
  const steps: string[] = [];
  await expect(runGates(repo, [['echo', 'observed'], ['echo', 'must not run']], controller.signal, step => {
    steps.push(step.output);
    controller.abort();
  })).rejects.toThrow();
  expect(steps).toEqual(['observed\n']);
});

test('manifest preserves complete per-step logs and redacts secrets', async () => {
  const { ws, change } = setup(["python3 -c 'print(\"BEGIN\" + \"x\" * 1100000 + \"END\"); print(\"Bearer abcdefghijklmnopqrstuvwxyz\"); exit(1)'"]);
  await pool(ws.id);
  const manifestPath = join(dir, 'runs', change.id, 'run.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const gate = manifest.activities.find((a: any) => a.kind === 'gates');
  const output = readFileSync(join(dir, 'runs', change.id, gate.steps[0].log), 'utf8');
  expect(output).toContain('BEGIN'); expect(output).toContain('END');
  expect(output.length).toBeGreaterThan(1100000);
  expect(output).toContain('Bearer [REDACTED]');
  expect(output).not.toContain('abcdefghijklmnopqrstuvwxyz');
  expect(readFileSync(manifestPath, 'utf8')).not.toContain('Bearer abcdefghijklmnopqrstuvwxyz');
});


test('retry of investigation with --verify preserves investigation and spec approval', () => {
  const ws = store.createWorkstream({ slug: 'approval', goal: 'goal', repo, agent: 'fake', verify: ['true'],
    requireChangeApproval: false, requireApproval: true });
  store.setWorkstreamState(ws.id, 'active');
  const change = store.createChange(ws.id, 'Feature', 'desc');
  const first = store.claimActivity(ws.id, 'worker')!;
  expect(first.kind).toBe('investigation');
  store.blockActivity(first.id, 'worker', 'Need clarification');
  const retry = store.retryChange(change.id);
  expect(retry.kind).toBe('investigation');
  const claimed = store.claimActivity(ws.id, 'worker')!;
  store.completeActivity(claimed.id, 'worker', 'STATUS: done');
  expect(store.getActivity(claimed.id).reviewStatus).toBe('awaiting');
  expect(store.getChange(change.id).status).toBe('in_review');
});

test('merge remains blocked when gates are missing or canceled after worker abortion', async () => {
  const { ws, change } = setup(['true']);
  store.db.query('DELETE FROM activities WHERE change_id = ?').run(change.id);
  store.db.query("UPDATE changes SET status = 'implemented' WHERE id = ?").run(change.id);
  expect(mergeBlocker(store.validationSummary(change.id))).toContain('gates');
  store.requestValidation(change.id, ['qa']);
  const gate = store.claimActivity(ws.id, 'worker')!;
  store.releaseActivity(gate.id, 'worker');
  expect(store.getChange(change.id).status).toBe('implemented');
  expect(store.getActivity(gate.id).status).toBe('canceled');
  expect(mergeBlocker(store.validationSummary(change.id))).toContain('gates');
  expect(store.validationSummary(change.id).passed).toBe(false);
});
