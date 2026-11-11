// One git worktree per change, on branch fab/<short-change-id>, under <state>/worktrees/.
import { existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
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

/**
 * Base del change: exito del merge-base del HEAD del repo con la rama del change.
 * Si la rama ya existía (reintento o worker caído que dejó commits del agente),
 * el HEAD del worktree ya puede incluir trabajo del agente: el punto de partida
 * correcto es la fusión común con el HEAD del repo (F2).
 */
async function baseSha(repoPath: string, branch: string, existed: boolean): Promise<string> {
  if (existed) {
    try {
      const mergeBase = await git(repoPath, 'merge-base', 'HEAD', branch);
      if (mergeBase) return mergeBase;
    } catch { /* rama sin ancestro común con HEAD: cae al HEAD actual. */ }
  }
  return await git(repoPath, 'rev-parse', 'HEAD');
}

/** Inspired by copilot-superagent/vscode/src/worktree.ts ticketAt/prepare (MIT).
 * Worktrees created before the `.preparing` marker existed are reused if they pass these checks.
 */
async function verifyWorktree(repoPath: string, path: string, branch: string): Promise<void> {
  try {
    if (!lstatSync(join(path, '.git')).isFile()) throw new Error('path is not a linked worktree');
    if (realpathSync(await git(path, 'rev-parse', '--show-toplevel')) !== realpathSync(path)) {
      throw new Error('path is not the worktree root');
    }
    const common = (cwd: string) => git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    if (realpathSync(await common(path)) !== realpathSync(await common(repoPath))) {
      throw new Error('worktree belongs to another repository');
    }
    if (await git(path, 'symbolic-ref', '--quiet', '--short', 'HEAD') !== branch) {
      throw new Error(`worktree branch changed; expected ${branch}`);
    }
    const admin = await git(path, 'rev-parse', '--absolute-git-dir');
    if (!existsSync(join(admin, 'index')) || existsSync(join(admin, 'index.lock')) || existsSync(join(admin, 'locked'))) {
      throw new Error('worktree preparation is incomplete or locked');
    }
    await git(path, 'rev-parse', '--verify', 'HEAD^{commit}');
  } catch (error) {
    throw new Error(`Cannot reuse worktree ${path}: ${(error as Error).message}; inspect it manually`, { cause: error });
  }
}

/** Create (or reuse) the worktree for a change. Investigation and implementation share it. */
export async function ensureWorktree(repo: string, stateDir: string, changeId: string): Promise<{ path: string; branch: string; baseSha: string }> {
  const repoPath = resolve(repo);
  if (!existsSync(join(repoPath, '.git'))) throw new Error(`${repoPath} is not a git repository`);
  const branch = branchFor(changeId);
  const path = resolve(stateDir, 'worktrees', changeId.slice(0, 8));
  // Persist intent before Git starts: a crash (even after checkout) must fail closed on reuse.
  const preparing = resolve(stateDir, 'worktrees', `.${changeId.slice(0, 8)}.preparing`);
  if (existsSync(preparing)) throw new Error(`Worktree preparation is incomplete at ${path}; inspect it, then delete ${preparing}`);
  if (existsSync(path)) {
    await verifyWorktree(repoPath, path, branch);
    return { path, branch, baseSha: await baseSha(repoPath, branch, true) };
  }
  mkdirSync(resolve(stateDir, 'worktrees'), { recursive: true });
  const branches = await git(repoPath, 'branch', '--list', branch);
  writeFileSync(preparing, `${branch}\n`, { flag: 'wx', mode: 0o600 });
  try {
    if (branches) await git(repoPath, 'worktree', 'add', path, branch);
    else await git(repoPath, 'worktree', 'add', '-b', branch, path, 'HEAD');
  } catch (error) {
    // Nothing was created: drop the marker so a later attempt can retry. A partial checkout keeps it (fail closed).
    if (!existsSync(path)) unlinkSync(preparing);
    throw error;
  }
  await verifyWorktree(repoPath, path, branch);
  const base = await baseSha(repoPath, branch, !!branches);
  unlinkSync(preparing);
  return { path, branch, baseSha: base };
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

/** Record only the paths explicitly approved by a human, preserving unrelated work. */
export async function commitProtectedPaths(worktree: string, paths: string[], message: string): Promise<void> {
  if (!(await git(worktree, '--literal-pathspecs', 'status', '--porcelain', '--', ...paths))) return;
  await git(worktree, '--literal-pathspecs', 'add', '-f', '-A', '--', ...paths);
  await git(worktree, '--literal-pathspecs', '-c', 'user.name=fab', '-c', 'user.email=fab@localhost',
    'commit', '--only', '-q', '-m', message, '--', ...paths);
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
