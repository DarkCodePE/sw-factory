// One git worktree per change, on branch fab/<short-change-id>, under <state>/worktrees/.
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${err.trim() || out.trim()}`);
  return out.trim();
}

export const branchFor = (changeId: string): string => `fab/${changeId.slice(0, 8)}`;

/** Create (or reuse) the worktree for a change. Investigation and implementation share it. */
export async function ensureWorktree(repo: string, stateDir: string, changeId: string): Promise<{ path: string; branch: string }> {
  const repoPath = resolve(repo);
  if (!existsSync(join(repoPath, '.git'))) throw new Error(`${repoPath} is not a git repository`);
  const branch = branchFor(changeId);
  const path = resolve(stateDir, 'worktrees', changeId.slice(0, 8));
  if (existsSync(path)) return { path, branch };
  mkdirSync(resolve(stateDir, 'worktrees'), { recursive: true });
  const branches = await git(repoPath, 'branch', '--list', branch);
  if (branches) await git(repoPath, 'worktree', 'add', path, branch);
  else await git(repoPath, 'worktree', 'add', '-b', branch, path, 'HEAD');
  return { path, branch };
}

/** Commits on the change branch that are not on the repo's current HEAD. */
export async function branchCommits(repo: string, branch: string): Promise<string[]> {
  const out = await git(resolve(repo), 'log', '--oneline', `HEAD..${branch}`);
  return out ? out.split('\n') : [];
}

/** Fast-forward-or-merge the change branch into the repo's current branch, then drop the worktree. */
export async function mergeAndCleanup(repo: string, stateDir: string, changeId: string): Promise<string> {
  const repoPath = resolve(repo);
  const branch = branchFor(changeId);
  const out = await git(repoPath, 'merge', '--no-edit', branch);
  const path = resolve(stateDir, 'worktrees', changeId.slice(0, 8));
  if (existsSync(path)) await git(repoPath, 'worktree', 'remove', '--force', path);
  return out;
}

export async function removeWorktree(repo: string, stateDir: string, changeId: string): Promise<void> {
  const path = resolve(stateDir, 'worktrees', changeId.slice(0, 8));
  if (existsSync(path)) await git(resolve(repo), 'worktree', 'remove', '--force', path);
}
