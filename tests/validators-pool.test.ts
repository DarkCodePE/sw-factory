import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPool } from '../src/pool.ts';
import { Store } from '../src/store.ts';
import { branchCommits } from '../src/worktrees.ts';

let dir: string;
let repo: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fabrica-validators-pool-'));
  repo = join(dir, 'repo');
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'code.ts'), 'export const answer = 42;\n');
  Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.']);
  Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'initial commit']);
  store = new Store(join(dir, 'test.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('validator report missing a valid VERDICT line is failed and retried', async () => {
  process.env.FABRICA_FAKE_STATUS = 'done\n\nNo verdict line here.';
  try {
    const ws = store.createWorkstream({ slug: 'ws-no-verdict', goal: 'goal', repo, agent: 'fake', requireChangeApproval: false });
    store.setWorkstreamState(ws.id, 'active');
    const c = store.createChange(ws.id, 'Feature', 'desc');
    store.db.query(`UPDATE changes SET status = 'implemented' WHERE id = ?`).run(c.id);

    store.requestValidation(c.id, ['code_review']);

    await runPool(store, { workstream: ws.id, stateDir: dir, untilIdle: true, log: () => {} });

    const [act] = store.listActivities({ changeId: c.id }).filter((a) => a.validator === 'code_review');
    expect(act).toBeDefined();
    // Failed after MAX_ACTIVITY_RETRIES retries
    expect(act?.status).toBe('failed');
    expect(act?.retryCount).toBe(3);
    expect(act?.error).toContain('report has no valid VERDICT line');
  } finally {
    delete process.env.FABRICA_FAKE_STATUS;
  }
});

test('qa validator that leaves modified or untracked files in the worktree fails without cleaning', async () => {
  // We use a custom fake script that touches a dirty file in the worktree
  const dirtyAgentScript = join(dir, 'dirty-agent.sh');
  writeFileSync(
    dirtyAgentScript,
    `#!/bin/sh
echo "dirty artifact" > dirty.tmp
printf "STATUS: done\\nVERDICT: pass\\n\\nQA passed but left dirty files.\\n"
`
  );
  Bun.spawnSync(['chmod', '+x', dirtyAgentScript]);

  const ws = store.createWorkstream({ slug: 'ws-qa-dirty', goal: 'goal', repo, agent: 'fake', requireChangeApproval: false });
  store.setWorkstreamState(ws.id, 'active');
  const c = store.createChange(ws.id, 'Feature QA', 'desc');
  store.db.query(`UPDATE changes SET status = 'implemented' WHERE id = ?`).run(c.id);

  store.requestValidation(c.id, ['qa']);

  // Temporarily override fake agent command to run dirtyAgentScript
  const agents = await import('../src/agents.ts');
  const fakeAdapter = agents.getAgent('fake');
  const originalCommand = fakeAdapter.command;
  fakeAdapter.command = () => [dirtyAgentScript];

  try {
    await runPool(store, { workstream: ws.id, stateDir: dir, untilIdle: true, log: () => {} });

    const [qaAct] = store.listActivities({ changeId: c.id }).filter((a) => a.validator === 'qa');
    expect(qaAct).toBeDefined();
    expect(qaAct?.status).toBe('failed');
    expect(qaAct?.error).toContain('qa dejó cambios en el worktree');
  } finally {
    fakeAdapter.command = originalCommand;
  }
});

test('full pipeline: signal -> triage -> investigation -> implementation -> 3 validators with fake agent', async () => {
  // Fake agent output containing both STATUS and VERDICT
  process.env.FABRICA_FAKE_STATUS = 'done\nVERDICT: pass\n\nAll checks passed successfully.';

  try {
    const ws = store.createWorkstream({
      slug: 'full-pipeline',
      goal: 'Deliver feature end-to-end',
      repo,
      agent: 'fake',
      requireChangeApproval: false,
      requireApproval: false,
    });
    store.setWorkstreamState(ws.id, 'active');

    // 1. Signal & triage
    const sig = store.addSignal(ws.id, 'Add authentication', 'Acceptance criteria: JWT verification.');
    const change = store.triageSignal(sig.id);
    expect(change.status).toBe('pending');

    // 2. Run investigation & implementation
    await runPool(store, { workstream: ws.id, stateDir: dir, untilIdle: true, log: () => {} });

    const implementedChange = store.getChange(change.id);
    expect(implementedChange.status).toBe('implemented');
    expect(implementedChange.branch).toBe(`fab/${change.id.slice(0, 8)}`);

    const initialActs = store.listActivities({ changeId: change.id });
    expect(initialActs.map((a) => a.kind)).toEqual(['investigation', 'implementation']);
    expect(initialActs.every((a) => a.status === 'completed')).toBe(true);

    const initialCommits = await branchCommits(repo, implementedChange.branch!);

    // 3. Request all 3 validators
    const validatorActs = store.requestValidation(change.id, ['code_review', 'security_audit', 'qa']);
    expect(validatorActs.length).toBe(3);

    // 4. Run validators via pool
    await runPool(store, { workstream: ws.id, stateDir: dir, untilIdle: true, log: () => {} });

    // 5. Change must STILL be implemented
    const afterChange = store.getChange(change.id);
    expect(afterChange.status).toBe('implemented');

    // 6. Validators must NOT create any new commits on the branch
    const postCommits = await branchCommits(repo, implementedChange.branch!);
    expect(postCommits.length).toBe(initialCommits.length);

    // 7. Validation summary must report all passed
    const summary = store.validationSummary(change.id);
    expect(summary.pending).toBe(false);
    expect(summary.passed).toBe(true);
    expect(summary.results.length).toBe(3);
    expect(summary.results.map((r) => r.validator)).toEqual(['code_review', 'security_audit', 'qa']);
    expect(summary.results.every((r) => r.verdict === 'pass')).toBe(true);
    expect(summary.results.every((r) => r.summary.includes('All checks passed successfully.'))).toBe(true);
  } finally {
    delete process.env.FABRICA_FAKE_STATUS;
  }
});
