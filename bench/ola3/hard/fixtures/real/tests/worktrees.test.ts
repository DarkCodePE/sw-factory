import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { branchFor, commitWorktree, ensureWorktree, mergeAndCleanup, removeWorktree } from '../src/worktrees.ts';
import { runPool } from '../src/pool.ts';
import { Store } from '../src/store.ts';

let dir: string;
let repo: string;
let stateDir: string;
let store: Store;

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-worktrees-test-'));
  repo = join(dir, 'repo');
  stateDir = join(dir, 'state');
  git(dir, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@test.com');
  writeFileSync(join(repo, 'init.txt'), 'initial\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'initial commit');
  store = new Store(join(dir, 'fab.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('mergeAndCleanup: merges change, deletes worktree and deletes branch fab/<id>', async () => {
  const changeId = '12345678abcdef01';
  const { path: wtPath, branch } = await ensureWorktree(repo, stateDir, changeId);
  expect(existsSync(wtPath)).toBe(true);
  expect(branch).toBe('fab/12345678');
  expect(git(repo, 'branch', '--list', branch)).toContain('fab/12345678');

  // Make a commit in the worktree
  writeFileSync(join(wtPath, 'feature.txt'), 'feature content\n');
  const committed = await commitWorktree(wtPath, 'implement feature');
  expect(committed).toBe(true);

  // Merge and cleanup
  const out = await mergeAndCleanup(repo, stateDir, changeId);
  expect(out).toBeDefined();

  // Verify commit is on main
  expect(existsSync(join(repo, 'feature.txt'))).toBe(true);

  // Verify worktree is removed
  expect(existsSync(wtPath)).toBe(false);

  // Verify branch is deleted
  expect(git(repo, 'branch', '--list', branch)).toBe('');
});

test('mergeAndCleanup: handles branch deletion failure gracefully and returns warning in output', async () => {
  const changeId = 'abcdef1234567890';
  const { path: wtPath, branch } = await ensureWorktree(repo, stateDir, changeId);
  writeFileSync(join(wtPath, 'feature.txt'), 'content\n');
  await commitWorktree(wtPath, 'commit for change');

  // Create a lock file on the branch reference to simulate deletion failure
  const lockDir = join(repo, '.git', 'refs', 'heads', 'fab');
  mkdirSync(lockDir, { recursive: true });
  const lockFile = join(lockDir, `${changeId.slice(0, 8)}.lock`);
  writeFileSync(lockFile, 'locked');

  try {
    const out = await mergeAndCleanup(repo, stateDir, changeId);

    // Merge succeeded: file is present
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true);

    // Worktree was removed
    expect(existsSync(wtPath)).toBe(false);

    // Output includes warning about branch deletion
    expect(out).toContain(`aviso: no se pudo borrar la rama ${branch}`);
  } finally {
    if (existsSync(lockFile)) rmSync(lockFile, { force: true });
  }
});

test('removeWorktree: rejects change, removes worktree and force deletes branch fab/<id>', async () => {
  const changeId = 'fedcba9876543210';
  const { path: wtPath, branch } = await ensureWorktree(repo, stateDir, changeId);
  expect(existsSync(wtPath)).toBe(true);

  // Make an unmerged commit in the worktree
  writeFileSync(join(wtPath, 'discard.txt'), 'will be discarded\n');
  await commitWorktree(wtPath, 'discarded commit');

  // Remove worktree
  await removeWorktree(repo, stateDir, changeId);

  // Verify worktree is deleted
  expect(existsSync(wtPath)).toBe(false);

  // Verify branch is deleted even though it had unmerged commits
  expect(git(repo, 'branch', '--list', branch)).toBe('');
});

test('removeWorktree: never deletes a branch that is not fab/<id>', async () => {
  // Create branches that must never be deleted
  git(repo, 'branch', 'other-branch');
  git(repo, 'branch', 'feature');

  // Try various non-fab/<id> changeIds
  await removeWorktree(repo, stateDir, '');
  await removeWorktree(repo, stateDir, 'main');
  await removeWorktree(repo, stateDir, 'other-branch');
  await removeWorktree(repo, stateDir, '../feature');
  await removeWorktree(repo, stateDir, 'fab/extra/slash');

  // Verify protected branches still exist
  expect(git(repo, 'branch', '--list', 'main')).toContain('main');
  expect(git(repo, 'branch', '--list', 'other-branch')).toContain('other-branch');
  expect(git(repo, 'branch', '--list', 'feature')).toContain('feature');
});

test('blocked change: preserves both worktree and branch for retry', async () => {
  process.env.FABRICA_FAKE_STATUS = 'blocked - cannot reproduce';
  try {
    const ws = store.createWorkstream({ slug: 'test-ws', goal: 'g', repo, agent: 'fake', requireChangeApproval: false });
    store.setWorkstreamState(ws.id, 'active');
    const c = store.createChange(ws.id, 'failing change', 'desc');

    await runPool(store, { workstream: ws.id, stateDir, untilIdle: true, log: () => {} });

    const [inv] = store.listActivities({ changeId: c.id });
    expect(inv?.status).toBe('blocked');

    const shortId = c.id.slice(0, 8);
    const wtPath = join(stateDir, 'worktrees', shortId);
    const branch = branchFor(c.id);

    // Both worktree and branch MUST be preserved for retry
    expect(existsSync(wtPath)).toBe(true);
    expect(git(repo, 'branch', '--list', branch)).toContain(branch);

    // After retryChange, worktree and branch are still preserved
    const retryAct = store.retryChange(c.id);
    expect(retryAct.status).toBe('pending');
    expect(existsSync(wtPath)).toBe(true);
    expect(git(repo, 'branch', '--list', branch)).toContain(branch);
  } finally {
    delete process.env.FABRICA_FAKE_STATUS;
  }
});

test('removeWorktree: cleans up branch even if worktree directory was already deleted on disk', async () => {
  const changeId = 'aabbccdd11223344';
  const { path: wtPath, branch } = await ensureWorktree(repo, stateDir, changeId);
  expect(existsSync(wtPath)).toBe(true);
  expect(git(repo, 'branch', '--list', branch)).toContain(branch);

  // Manually remove worktree folder from disk
  rmSync(wtPath, { recursive: true, force: true });
  expect(existsSync(wtPath)).toBe(false);

  // removeWorktree should prune worktree metadata and delete the branch
  await removeWorktree(repo, stateDir, changeId);
  expect(git(repo, 'branch', '--list', branch)).toBe('');
});

test('removeWorktree: succeeds silently if branch does not exist', async () => {
  const changeId = '0011223344556677';
  await expect(removeWorktree(repo, stateDir, changeId)).resolves.toBeUndefined();
});

test('D5: git operations in worktrees ignore repository hooks (core.hooksPath=/dev/null)', async () => {
  const hooksDir = join(repo, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });

  const markerCheckout = join(dir, 'hook-post-checkout-executed');
  const markerCommit = join(dir, 'hook-pre-commit-executed');

  const postCheckoutHook = join(hooksDir, 'post-checkout');
  writeFileSync(postCheckoutHook, `#!/bin/sh\ntouch "${markerCheckout}"\n`);
  Bun.spawnSync(['chmod', '+x', postCheckoutHook]);

  const preCommitHook = join(hooksDir, 'pre-commit');
  writeFileSync(preCommitHook, `#!/bin/sh\ntouch "${markerCommit}"\n`);
  Bun.spawnSync(['chmod', '+x', preCommitHook]);

  const changeId = 'd5test1234567890';
  const { path: wtPath } = await ensureWorktree(repo, stateDir, changeId);
  expect(existsSync(markerCheckout)).toBe(false);

  writeFileSync(join(wtPath, 'change.txt'), 'hello\n');
  await commitWorktree(wtPath, 'test commit without hooks');
  expect(existsSync(markerCommit)).toBe(false);
});

test('F2: baseSha es el merge-base cuando la rama fab/<id> ya existe con commits del agente', async () => {
  const changeId = 'f2sha1234567890';
  const branch = branchFor(changeId);

  // Base recién creada: HEAD del repo.
  const first = await ensureWorktree(repo, stateDir, changeId);
  expect(first.baseSha).toBe(git(repo, 'rev-parse', 'HEAD'));

  // Un commit del agente avanza la rama.
  writeFileSync(join(first.path, 'agent.txt'), 'trabajo del agente\n');
  await commitWorktree(first.path, 'commit del agente');
  const agentHead = git(first.path, 'rev-parse', 'HEAD');
  expect(agentHead).not.toBe(first.baseSha);

  // Reuso del mismo worktree: el base debe seguir siendo el merge-base, no el HEAD del worktree.
  const reuse = await ensureWorktree(repo, stateDir, changeId);
  expect(reuse.baseSha).toBe(git(repo, 'merge-base', 'HEAD', branch));
  expect(reuse.baseSha).toBe(first.baseSha);

  // El worktree se pierde (worker caído, limpieza) pero la rama persiste: base = commit anterior al del agente.
  rmSync(first.path, { recursive: true, force: true });
  git(repo, 'worktree', 'prune');
  const reattached = await ensureWorktree(repo, stateDir, changeId);
  expect(reattached.baseSha).toBe(first.baseSha);
  expect(reattached.baseSha).not.toBe(agentHead);
});
