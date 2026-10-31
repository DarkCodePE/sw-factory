import { mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicReplace, readWorkspaceFile, withWorkspaceFile } from './files.ts';
import { runProcess } from './process.ts';
import { wrapCommand } from '../sandbox/index.ts';
import type { AgentOptions, ToolContext } from './types.ts';
import type { MissionState } from './mission-contract.ts';

export const missionDirectory = (opts: AgentOptions, id: string) => opts.sessionDir
  ? resolve(opts.sessionDir, '..', 'missions', id) : join(tmpdir(), `fab-mission-${id}`);
const inside = (root: string, path: string) => { const p = relative(root, path); return !p || p !== '..' && !p.startsWith('../') && !isAbsolute(p); };
const gitEnv = () => ({ PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' });

export async function missionGit(c: ToolContext, args: string[]) {
  const wrapped = await wrapCommand(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    workdir: c.cwd, mode: 'required', allowNetwork: false, env: gitEnv(), readOnlyPaths: [c.cwd],
  });
  return runProcess(wrapped.argv, c.cwd, wrapped.env, c.signal, 2 * 1024 * 1024);
}
export async function createMissionDirectory(c: ToolContext, directory: string) {
  if (inside(c.cwd, directory)) throw new Error('Mission persistence must be outside the writable workspace');
  // A worktree may make another repository's metadata writable for commits.
  for (const flag of ['--absolute-git-dir', '--git-common-dir']) {
    const git = await missionGit(c, ['rev-parse', flag]);
    if (!git.exitCode && inside(resolve(c.cwd, git.stdout.trim()), directory)) throw new Error('Mission persistence must be outside writable Git metadata');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory) throw new Error('Mission metadata symlinks are not supported');
}
export async function writeMissionFile(directory: string, name: string, value: unknown, raw = false) {
  const data = raw ? String(value) : JSON.stringify(value, null, 2) + '\n';
  await withWorkspaceFile(directory, name, true, (parent, file) => atomicReplace(parent, file, data, new AbortController().signal));
}
export async function writeMissionState(state: MissionState) {
  await writeMissionFile(state.directory, 'state.json', { version: state.version, missionId: state.missionId, state: state.state,
    workingDirectory: state.workingDirectory, createdAt: state.createdAt, updatedAt: state.updatedAt,
    features: state.features, validations: state.validations });
}
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Bounded source identity: tracked/nonignored files for Git; otherwise files
 * excluding .git/node_modules. Reject unreadable/symlink inputs rather than
 * asserting that validators examined bytes we could not identify. */
/** The files that make up the mission source: tracked and non-ignored for Git, else all but .git/node_modules. */
export async function listSourceFiles(c: ToolContext): Promise<string[]> {
  const listed = await missionGit(c, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const paths = new Set<string>();
  if (!listed.exitCode) for (const path of listed.stdout.split('\0').filter(Boolean)) paths.add(path);
  else for await (const path of new Bun.Glob('**/*').scan({ cwd: c.cwd, dot: true, onlyFiles: true, followSymlinks: false })) {
    if (!/(^|\/)(\.git|node_modules)(\/|$)/.test(path)) paths.add(path);
    if (paths.size > 10_000) throw new Error('Mission source exceeds 10,000 files');
  }
  if (paths.size > 10_000) throw new Error('Mission source exceeds 10,000 files');
  return [...paths].sort();
}

/** Top-level directories the source ignores (dependencies, virtualenvs): bound read-only for verifiers. */
export async function listIgnoredDirectories(c: ToolContext): Promise<string[]> {
  const listed = await missionGit(c, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
  if (listed.exitCode) return ['node_modules'];
  return listed.stdout.split('\0').filter(p => p.endsWith('/') && !p.slice(0, -1).includes('/') && !p.startsWith('.git/')).map(p => p.slice(0, -1)).slice(0, 100);
}

export async function fingerprintWorkspace(c: ToolContext): Promise<string> {
  let bytes = 0;
  const manifest: unknown[] = [];
  for (const path of await listSourceFiles(c)) {
    c.signal.throwIfAborted();
    try {
      const file = await readWorkspaceFile(c.cwd, path); bytes += file.data.length;
      if (bytes > 32 * 1024 * 1024) throw new Error('Mission source exceeds 32 MiB');
      manifest.push([path, file.mode, createHash('sha256').update(file.data).digest('hex')]);
    } catch (e: any) { if (e.code !== 'ENOENT') throw e; manifest.push([path, 'deleted']); }
  }
  return digest(manifest);
}

/** Content digest per workspace-relative path; a missing file is recorded as 'deleted'. */
export async function digestPaths(c: ToolContext, paths: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const path of paths) {
    c.signal.throwIfAborted();
    try { out[path] = createHash('sha256').update((await readWorkspaceFile(c.cwd, path)).data).digest('hex'); }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; out[path] = 'deleted'; }
  }
  return out;
}
