import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PullRequestGateway, PullRequestRef } from './types.ts';

export type CommandRunner = (cmd: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runCommand: CommandRunner = async (cmd, cwd) => {
  const child = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
};

export function validateRepo(repo: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repo) || ['.', '..'].includes(repo.split('/')[1]!)) {
    throw new Error('Repositorio GitHub inválido: usa owner/name');
  }
}

export function validateBranch(branch: string): void {
  if (!branch || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.') || branch === '@' ||
    /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(branch) || branch.includes('..') || branch.includes('@{') ||
    branch.split('/').some(p => !p || p.startsWith('.') || p.endsWith('.lock'))) throw new Error('Rama Git inválida');
}

export function repoSlugFromRemote(remote: string): string | undefined {
  let path: string;
  const scp = /^git@github\.com:([^\s]+)$/.exec(remote.trim());
  if (scp) path = scp[1]!;
  else {
    try {
      const url = new URL(remote.trim());
      if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname !== 'github.com' || url.port && !(url.protocol === 'ssh:' && url.port === '22') || url.search || url.hash) return;
      path = url.pathname.replace(/^\//, '');
    } catch { return; }
  }
  const repo = path.replace(/\.git$/, '');
  try { validateRepo(repo); return repo; } catch { return; }
}

function pullNumber(url: string, repo: string): number | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) return;
    const match = /^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)$/.exec(parsed.pathname);
    if (match?.[1]!.toLowerCase() !== repo.toLowerCase() || !Number.isSafeInteger(Number(match?.[2]))) return;
    return Number(match![2]);
  } catch { return; }
}

export function createGhGateway(opts: { run?: CommandRunner } = {}): PullRequestGateway {
  const run = opts.run ?? runCommand;
  async function execute(cmd: string[], cwd: string) {
    let result: Awaited<ReturnType<CommandRunner>>;
    try { result = await run(cmd, cwd); } catch { throw new Error(`No se pudo ejecutar ${cmd[0]}`); }
    if (result.code !== 0) throw new Error(`${cmd[0]} ${cmd[1]} falló (código ${result.code})`);
    return result.stdout;
  }
  async function bodyFile<T>(body: string, use: (path: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'fab-pr-'));
    try {
      const path = join(directory, 'body.md');
      await writeFile(path, body, { mode: 0o600 });
      return await use(path);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async function find(repo: string, branch: string, cwd = process.cwd()): Promise<PullRequestRef | undefined> {
    validateRepo(repo); validateBranch(branch);
    let result: Awaited<ReturnType<CommandRunner>>;
    try { result = await run(['gh', 'pr', 'view', branch, '--repo', repo, '--json', 'number,url,headRefName,baseRefName,state'], cwd); }
    catch { throw new Error('No se pudo consultar el PR en GitHub'); }
    if (result.code !== 0) {
      if (/no pull requests? found|no pull request associated|could not resolve to a pull request/i.test(result.stderr)) return;
      throw new Error(`No se pudo consultar el PR en GitHub (código ${result.code})`);
    }
    let pr: Record<string, unknown>;
    try { pr = JSON.parse(result.stdout); } catch { throw new Error('Respuesta de GitHub inválida al consultar el PR'); }
    if (!pr || typeof pr !== 'object') throw new Error('Respuesta de GitHub inválida al consultar el PR');
    if (pr.state !== undefined && pr.state !== 'OPEN') return;
    if (!Number.isSafeInteger(pr.number) || Number(pr.number) < 1 || typeof pr.url !== 'string' ||
      pullNumber(pr.url, repo) !== pr.number || pr.headRefName !== branch || typeof pr.baseRefName !== 'string') {
      throw new Error('Respuesta de GitHub inválida al consultar el PR');
    }
    return { repo, number: pr.number as number, url: pr.url, branch, base: pr.baseRefName };
  }
  return {
    find: (repo, branch) => find(repo, branch),
    async open(input) {
      validateRepo(input.repo); validateBranch(input.branch); validateBranch(input.base);
      await execute(['git', 'push', '-u', 'origin', input.branch], input.cwd);
      const existing = await find(input.repo, input.branch, input.cwd);
      if (existing) return existing;
      const output = await bodyFile(input.body, path => execute(['gh', 'pr', 'create', '--repo', input.repo,
        '--head', input.branch, '--base', input.base, '--title', input.title, '--body-file', path,
        ...(input.draft ? ['--draft'] : [])], input.cwd));
      const url = output.trim();
      const number = pullNumber(url, input.repo);
      if (number !== undefined) {
        return { repo: input.repo, number, url, branch: input.branch, base: input.base };
      }
      const created = await find(input.repo, input.branch, input.cwd);
      if (!created) throw new Error('GitHub no devolvió el PR creado; consulta la rama antes de reintentar');
      return created;
    },
    async comment(pr, markdown) {
      validateRepo(pr.repo);
      if (!Number.isSafeInteger(pr.number) || pr.number < 1) throw new Error('Número de PR inválido');
      await bodyFile(markdown, path => execute(['gh', 'pr', 'comment', String(pr.number), '--repo', pr.repo, '--body-file', path], process.cwd()));
    },
  };
}
