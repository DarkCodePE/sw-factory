// One git worktree per change, on branch fab/<short-change-id>, under <state>/worktrees/.
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const GIT_SAFE_FLAGS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external='];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...GIT_SAFE_FLAGS, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
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

/**
 * Commit everything the agent left in the worktree, on behalf of an agent that cannot write Git
 * metadata. Returns false when there was nothing to commit.
 */
export async function commitWorktree(worktree: string, message: string): Promise<boolean> {
  if (!(await git(worktree, 'status', '--porcelain'))) return false;
  await git(worktree, 'add', '-A');
  await git(worktree, '-c', 'user.name=fab', '-c', 'user.email=fab@localhost', 'commit', '-q', '-m', message);
  return true;
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
  const shortId = typeof changeId === 'string' ? changeId.slice(0, 8) : '';
  const path = resolve(stateDir, 'worktrees', shortId);
  if (shortId && existsSync(path)) {
    await git(repoPath, 'worktree', 'remove', '--force', path);
  } else {
    try { await git(repoPath, 'worktree', 'prune'); } catch {}
  }
  if (shortId && /^fab\/[A-Za-z0-9_-]+$/.test(branch)) {
    try {
      await git(repoPath, 'branch', '-d', branch);
    } catch (err: any) {
      const warning = `aviso: no se pudo borrar la rama ${branch}: ${err?.message ?? err}`;
      return out ? `${out}\n${warning}` : warning;
    }
  }
  return out;
}

export async function removeWorktree(repo: string, stateDir: string, changeId: string): Promise<void> {
  const repoPath = resolve(repo);
  const shortId = typeof changeId === 'string' ? changeId.slice(0, 8) : '';
  if (!shortId) return;
  const path = resolve(stateDir, 'worktrees', shortId);
  if (existsSync(path)) {
    await git(repoPath, 'worktree', 'remove', '--force', path);
  } else {
    try { await git(repoPath, 'worktree', 'prune'); } catch {}
  }
  const branch = branchFor(changeId);
  if (branch === `fab/${shortId}` && /^fab\/[A-Za-z0-9_-]+$/.test(branch)) {
    const branches = await git(repoPath, 'branch', '--list', branch);
    if (branches) {
      await git(repoPath, 'branch', '-D', branch);
    }
  }
}
