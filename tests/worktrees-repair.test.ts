import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { branchFor, ensureWorktree, WorktreeNeedsRepair } from '../src/worktrees.ts';
import { Store } from '../src/store.ts';
import { runPool } from '../src/pool.ts';

let dir: string, repo: string, state: string, store: Store, id: string, path: string, marker: string;
function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args]);
  if (p.exitCode) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-t10-'));
  repo = join(dir, 'repo'); state = join(dir, "state's space");
  mkdirSync(repo); mkdirSync(state);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'initial'), 'keep'); git(repo, 'add', '.');
  git(repo, '-c', 'user.name=test', '-c', 'user.email=t@t', 'commit', '-qm', 'initial');
  store = new Store(join(state, 'fabrica.db'));
  const ws = store.createWorkstream({ slug: 't10', goal: 'g', repo, agent: 'fake', requireChangeApproval: false });
  store.setWorkstreamState(ws.id, 'active');
  id = store.createChange(ws.id, 'repair', 'desc').id;
  path = join(state, 'worktrees', id.slice(0, 8));
  marker = join(state, 'worktrees', `.${id.slice(0, 8)}.preparing`);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
async function cli(...args: string[]) {
  const p = Bun.spawn([process.execPath, '--no-env-file', resolve(import.meta.dir, '../src/cli.ts'), ...args], {
    env: { ...process.env, FABRICA_HOME: state }, stdout: 'pipe', stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out, err };
}
function mark() { mkdirSync(join(state, 'worktrees'), { recursive: true }); writeFileSync(marker, branchFor(id)); }

test('repair validates a marked worktree, preserves dirty files and resumes via existing retry', async () => {
  await ensureWorktree(repo, state, id); mark();
  writeFileSync(join(path, 'dirty'), 'preserve');
  await runPool(store, { workstream: 't10', stateDir: state, untilIdle: true, log: () => {} });
  expect(store.getChange(id).status).toBe('blocked');
  const repaired = await cli('worktree', 'repair', id.slice(0, 8));
  expect(repaired.code).toBe(0); expect(repaired.out).toContain('marca eliminada');
  expect(repaired.out).toContain('fab retry'); expect(existsSync(marker)).toBe(false);
  expect((await ensureWorktree(repo, state, id)).path).toBe(path);
  expect(existsSync(join(path, 'dirty'))).toBe(true);
  expect((await cli('retry', id)).code).toBe(0);
  await runPool(store, { workstream: 't10', stateDir: state, untilIdle: true, log: () => {} });
  expect(store.listActivities({ changeId: id }).at(-1)?.status).toBe('completed');
});

test('repair invalid marked checkout reports exact shell commands without deleting anything', async () => {
  mark(); git(repo, 'worktree', 'add', '--no-checkout', '-b', branchFor(id), path);
  const result = await cli('worktree', 'repair', id);
  expect(result.code).toBe(1); expect(result.out).toContain('incomplete or locked');
  expect(result.out).toContain('git -C'); expect(result.out).toContain('worktree remove --force');
  expect(result.out).toContain('rm --'); expect(result.out).toContain("'\\''");
  expect(existsSync(marker)).toBe(true); expect(existsSync(path)).toBe(true);
});

test('repair --discard removes invalid checkout and marker but preserves branch and commits', async () => {
  await ensureWorktree(repo, state, id);
  writeFileSync(join(path, 'saved'), 'committed'); git(path, 'add', '.');
  git(path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'saved');
  const head = git(path, 'rev-parse', 'HEAD');
  git(path, 'checkout', '--detach'); mark();
  const result = await cli('worktree', 'repair', id, '--discard');
  expect(result.code).toBe(0); expect(result.out).toContain('rama conservada');
  expect(existsSync(marker)).toBe(false); expect(existsSync(path)).toBe(false);
  expect(git(repo, 'rev-parse', branchFor(id))).toBe(head);
  expect((await ensureWorktree(repo, state, id)).branch).toBe(branchFor(id));
});

for (const present of [false, true]) {
  test(`repair missing/partial directory (present=${present}) needs discard`, async () => {
    mark(); if (present) { mkdirSync(path); writeFileSync(join(path, 'partial'), 'keep'); }
    expect((await cli('worktree', 'repair', id)).code).toBe(1);
    expect(existsSync(marker)).toBe(true); expect(existsSync(path)).toBe(present);
    expect((await cli('worktree', 'repair', id, '--discard')).code).toBe(0);
    expect(existsSync(marker)).toBe(false); expect(existsSync(path)).toBe(false);
  });
}

for (const valid of [false, true]) {
  test(`repair without marker exits zero and reports state (valid=${valid})`, async () => {
    if (valid) await ensureWorktree(repo, state, id);
    const result = await cli('worktree', 'repair', id, '--discard');
    expect(result.code).toBe(0); expect(result.out).toContain('sin marca');
    expect(existsSync(path)).toBe(valid);
  });
}

test('verify errors use a dedicated type', async () => {
  mark(); await expect(ensureWorktree(repo, state, id)).rejects.toBeInstanceOf(WorktreeNeedsRepair);
});

test('repair never discards a worktree owned by another repository', async () => {
  const foreign = join(dir, 'foreign'); git(dir, 'clone', '-q', repo, foreign);
  mark(); git(foreign, 'worktree', 'add', '-b', branchFor(id), path);
  writeFileSync(join(path, 'their-work'), 'uncommitted');
  const result = await cli('worktree', 'repair', id);
  expect(result.code).toBe(1); expect(result.out).toContain('another repository');
  expect(result.out).toContain('worktree remove --force');
  expect(existsSync(path)).toBe(true); expect(existsSync(marker)).toBe(true);
  const discarded = await cli('worktree', 'repair', id, '--discard');
  expect(discarded.code).toBe(1); expect(discarded.out).toContain('No se descarta');
  expect(existsSync(join(path, 'their-work'))).toBe(true); expect(existsSync(marker)).toBe(true);
  expect(git(foreign, 'branch', '--list', branchFor(id))).toContain(branchFor(id));
});

test('repair --discard removes a missing registered worktree and retains its branch', async () => {
  await ensureWorktree(repo, state, id); mark(); rmSync(path, { recursive: true });
  const result = await cli('worktree', 'repair', id, '--discard');
  expect(result.code).toBe(0); expect(existsSync(marker)).toBe(false);
  expect(git(repo, 'branch', '--list', branchFor(id))).toContain(branchFor(id));
  expect((await ensureWorktree(repo, state, id)).path).toBe(path);
});

test('repair refuses an activity held by a worker without removing its marker', async () => {
  mark(); expect(store.claimActivity('t10', 'active')).not.toBeNull();
  const result = await cli('worktree', 'repair', id, '--discard');
  expect(result.code).toBe(1); expect(result.err).toContain('workers en curso');
  expect(existsSync(marker)).toBe(true);
});
