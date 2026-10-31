// Compare protected paths independently against the immutable base, disk and branch HEAD.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { GIT_SAFE_FLAGS } from '../worktrees.ts';

export const DEFAULT_PROTECTED_PATHS = [
  'tests/**', 'test/**', '**/*.test.*', '**/*.spec.*', 'package.json',
  'bun.lock', 'bunfig.toml', 'tsconfig*.json', '*vitest*', '*jest*',
  'pyproject.toml', 'pytest.ini', 'setup.cfg', 'conftest.py', 'Makefile',
  '.github/**', '.gitattributes', '.gitmodules',
];
export type GateSnapshot = Record<string, { disk: string | null; head: string | null }>;

async function gitRaw(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...GIT_SAFE_FLAGS, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`integrity git ${args[0]}: ${err.trim()}`);
  return out;
}

async function tree(cwd: string, ref: string): Promise<Map<string, string>> {
  const entries = (await gitRaw(cwd, 'ls-tree', '-rz', '--full-tree', ref)).split('\0');
  const result = new Map<string, string>();
  for (const entry of entries) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [mode, , oid] = entry.slice(0, tab).split(' ');
    result.set(entry.slice(tab + 1), `${mode}:${oid}`);
  }
  return result;
}

// Never follow links, including links to directories outside the worktree.
function diskTree(root: string, algorithm: string, matches: (path: string) => boolean): Map<string, string> {
  const result = new Map<string, string>();
  function walk(relative: string) {
    for (const entry of readdirSync(join(root, relative))) {
      if (!relative && entry === '.git') continue;
      const path = relative ? `${relative}/${entry}` : entry;
      const absolute = join(root, path);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) { walk(path); continue; }
      if (!matches(path)) continue;
      if (!stat.isFile() && !stat.isSymbolicLink()) { result.set(path, 'special'); continue; }
      const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
      const oid = createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      const mode = stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644';
      result.set(path, `${mode}:${oid}`);
    }
  }
  walk('');
  return result;
}

export async function protectedIntegrity(
  worktree: string, baseSha: string, patterns: string[], allowed: GateSnapshot = {},
): Promise<{ tampered: string[]; snapshot: GateSnapshot }> {
  if (!patterns.length) return { tampered: [], snapshot: {} };
  const [base, head, algorithm] = await Promise.all([
    tree(worktree, baseSha), tree(worktree, 'HEAD'), gitRaw(worktree, 'rev-parse', '--show-object-format'),
  ]);
  const globs = patterns.map(p => new Bun.Glob(p));
  const matches = (path: string) => globs.some(glob => glob.match(path) || glob.match(path + '/'));
  const disk = diskTree(worktree, algorithm.trim(), matches);
  const paths = [...new Set([...base.keys(), ...head.keys(), ...disk.keys(), ...Object.keys(allowed)])]
    .filter(matches).sort();
  const snapshot: GateSnapshot = {};
  const tampered: string[] = [];
  for (const path of paths) {
    const b = base.get(path) ?? null, d = disk.get(path) ?? null, h = head.get(path) ?? null;
    snapshot[path] = { disk: d, head: h };
    const override = Object.hasOwn(allowed, path) ? allowed[path] : undefined;
    // An explicitly reviewed disk change may subsequently be committed by the factory.
    if (override ? d !== override.disk || (h !== override.head && h !== override.disk) : d !== b || h !== b) tampered.push(path);
  }
  return { tampered, snapshot };
}

export function validateProtectedPatterns(patterns: string[]): void {
  for (const p of patterns) {
    if (!p.trim() || p.startsWith('/') || p.split('/').includes('..') || p.includes('\0') || p.startsWith('!')) {
      throw new Error(`invalid protected path pattern: ${p}`);
    }
    new Bun.Glob(p);
  }
}
