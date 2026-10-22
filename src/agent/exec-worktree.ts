import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export interface ExecWorktreeOptions {
  repo: string;
  name?: string;
  root?: string;
  signal?: AbortSignal;
}

export interface ExecWorktreeResult {
  path: string;
  branch: string;
  created: boolean;
}

const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

const GIT_TIMEOUT_MS = 30_000;

async function runGit(args: string[], cwd: string, signal?: AbortSignal, timeoutMs = GIT_TIMEOUT_MS): Promise<{ code: number; stdout: string; stderr: string }> {
  signal?.throwIfAborted();
  const proc = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: GIT_ENV,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      reject(new Error(`Git command timed out after ${timeoutMs}ms: git ${args.join(' ')}`));
    }, timeoutMs);
  });

  const abortHandler = () => {
    try { proc.kill(); } catch {}
  };
  signal?.addEventListener('abort', abortHandler, { once: true });

  try {
    const [stdout, stderr, code] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timeoutPromise,
    ]);
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', abortHandler);
  }
}

export async function prepareExecWorktree(options: ExecWorktreeOptions): Promise<ExecWorktreeResult> {
  options.signal?.throwIfAborted();
  const repoCwd = resolve(options.repo);

  // 1. Validate git repository
  const topRes = await runGit(['rev-parse', '--show-toplevel'], repoCwd, options.signal);
  if (topRes.code !== 0) {
    throw new Error('Working directory is not a git repository');
  }
  const repoRoot = topRes.stdout;

  // 2. Resolve root directory and create if it doesn't exist
  const defaultRoot = process.env.FABRICA_HOME
    ? resolve(process.env.FABRICA_HOME, 'worktrees')
    : resolve(process.env.HOME ?? '.', '.fabrica', 'worktrees');
  const root = options.root ? resolve(options.root) : defaultRoot;
  await mkdir(root, { recursive: true });

  // 3. Compute target path: <root>/<8 hex hash of repo>/<repo name>/
  const repoHash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 8);
  const repoName = basename(repoRoot);
  const targetPath = join(root, repoHash, repoName);

  // 4. Resolve branch name
  let branch: string;
  if (options.name && options.name.trim()) {
    branch = options.name.trim();
    const checkRes = await runGit(['check-ref-format', '--branch', branch], repoRoot, options.signal);
    if (checkRes.code !== 0) {
      throw new Error(`Invalid branch name: ${branch}`);
    }
  } else {
    const branchRes = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], repoRoot, options.signal);
    if (branchRes.code === 0 && branchRes.stdout) {
      branch = `${branchRes.stdout}-wt`;
    } else {
      const revRes = await runGit(['rev-parse', '--short', 'HEAD'], repoRoot, options.signal);
      branch = `head-${revRes.stdout}-wt`;
    }
  }

  // 5. Inspect existing worktrees
  const wtListRes = await runGit(['worktree', 'list', '--porcelain'], repoRoot, options.signal);
  const existingWorktrees: Array<{ path: string; branch?: string }> = [];
  if (wtListRes.code === 0) {
    const blocks = wtListRes.stdout.split('\n\n');
    for (const b of blocks) {
      const lines = b.split('\n').map(l => l.trim()).filter(Boolean);
      let p = '';
      let br: string | undefined;
      for (const line of lines) {
        if (line.startsWith('worktree ')) p = line.slice('worktree '.length).trim();
        if (line.startsWith('branch refs/heads/')) br = line.slice('branch refs/heads/'.length).trim();
      }
      if (p) existingWorktrees.push({ path: p, branch: br });
    }
  }

  const existingWithBranch = existingWorktrees.find(w => w.branch === branch);
  if (existingWithBranch) {
    if (existingWithBranch.path !== targetPath) {
      throw new Error(`Branch '${branch}' is already checked out at '${existingWithBranch.path}'`);
    }
    // Already checked out at targetPath
    return { path: targetPath, branch, created: false };
  }

  // 6. If targetPath already exists on disk as a worktree with another branch, error out (never delete an existing worktree)
  const existingAtPath = existingWorktrees.find(w => w.path === targetPath);
  if (existingAtPath) {
    throw new Error(`Target path '${targetPath}' already belongs to worktree with branch '${existingAtPath.branch}': la ruta ya pertenece al worktree de la rama ${existingAtPath.branch}`);
  }

  // Ensure parent directory of targetPath exists
  await mkdir(dirname(targetPath), { recursive: true });

  // 7. Check if branch exists in repository
  const showRefRes = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot, options.signal);
  const branchExists = showRefRes.code === 0;

  let created = false;
  if (branchExists) {
    const addRes = await runGit(['worktree', 'add', targetPath, branch], repoRoot, options.signal);
    if (addRes.code !== 0) {
      throw new Error(`Failed to add worktree for branch '${branch}': ${addRes.stderr || addRes.stdout}`);
    }
  } else {
    created = true;
    const addRes = await runGit(['worktree', 'add', '-b', branch, targetPath, 'HEAD'], repoRoot, options.signal);
    if (addRes.code !== 0) {
      throw new Error(`Failed to create worktree with branch '${branch}': ${addRes.stderr || addRes.stdout}`);
    }
  }

  // Check cancellation before returning
  if (options.signal?.aborted) {
    try {
      await runGit(['worktree', 'remove', '--force', targetPath], repoRoot);
      if (created) await runGit(['branch', '-D', branch], repoRoot);
    } catch {}
    options.signal.throwIfAborted();
  }

  return { path: targetPath, branch, created };
}
