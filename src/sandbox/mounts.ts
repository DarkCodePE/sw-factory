import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function withinMount(path: string, mount: string): boolean {
  const rel = relative(mount, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}

/** Inventario de escritura compartido con el lanzamiento confinado. */
export function writableMounts(cwd: string): string[] {
  const worktree = realpathSync(cwd);
  const mounts = new Set([worktree]);
  for (const flag of ['--absolute-git-dir', '--git-common-dir']) {
    const p = Bun.spawnSync(['git', '-C', worktree, 'rev-parse', flag]);
    if (p.exitCode !== 0) throw new Error('--confine: no se pudo resolver .git');
    const path = realpathSync(resolve(worktree, p.stdout.toString().replace(/\n$/, '')));
    if (!withinMount(path, worktree)) mounts.add(path);
  }
  return [...mounts];
}
