import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { importResult, makeJobBundle, receiveJob, sealResult } from '../src/runners/bundle.ts';

let root: string;
let home: string;
let worktree: string;
let cache: string;
let head: string;
let bundles: Set<string>;

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fab-runner-bundle-test-'));
  home = join(root, 'home');
  worktree = join(root, 'worktree');
  cache = join(root, 'runner', 'cache', 'project.git');
  bundles = new Set();
  git(root, 'init', '-q', '--object-format=sha1', '-b', 'main', home);
  git(home, 'config', 'user.name', 'Test');
  git(home, 'config', 'user.email', 'test@localhost');
  writeFileSync(join(home, 'history.bin'), randomBytes(128 * 1024));
  writeFileSync(join(home, 'delete.txt'), 'borrar\n');
  writeFileSync(join(home, 'script.sh'), 'texto\n', { mode: 0o644 });
  git(home, 'add', '-A');
  git(home, 'commit', '-qm', 'base');
  head = git(home, 'rev-parse', 'HEAD');
  git(home, 'worktree', 'add', '-qb', 'fab/change', worktree);
});

afterEach(() => {
  for (const dir of bundles) rmSync(dir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

async function jobBundle(sha = head, have: string[] = []) {
  const bundle = await makeJobBundle(home, sha, have);
  bundles.add(dirname(bundle.path));
  return bundle;
}

async function receive(jobId = 'first') {
  return receiveJob(cache, await jobBundle(), head, jobId);
}

async function seal(repo: string) {
  const result = await sealResult(cache, repo, join(dirname(repo), 'index'), head);
  if (result) bundles.add(dirname(result.bundle.path));
  return result;
}

async function changedResult() {
  const clone = await receive();
  writeFileSync(join(clone, 'new.txt'), 'resultado\n');
  const result = (await seal(clone))!;
  return { ...result.bundle, head: result.sha, expectChanges: true };
}

function digest(data: Uint8Array) {
  return createHash('sha256').update(data).digest('hex');
}

function describeBundle(path: string, sha: string) {
  const data = readFileSync(path);
  return { path, head: sha, bytes: data.length, sha256: digest(data), expectChanges: true };
}

function expectHomeUnchanged() {
  expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(home, 'rev-parse', 'refs/heads/fab/change')).toBe(head);
  expect(git(home, 'rev-parse', 'refs/heads/main')).toBe(head);
  expect(git(worktree, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  expect(git(home, 'for-each-ref', 'refs/fab')).toBe('');
}

test('sella un árbol limpio sobre un repo real y devuelve null', async () => {
  expect(typeof sealResult).toBe('function');
  expect(await seal(await receive())).toBeNull();
});

test('ciclo local: conserva altas, bajas, modo y symlink; solo importa el commit del runner', async () => {
  const clone = await receive();
  expect(git(clone, 'remote')).toBe('');
  expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');

  writeFileSync(join(clone, 'committed.txt'), 'commit del agente\n');
  git(clone, 'add', 'committed.txt');
  git(clone, '-c', 'user.name=Agent', '-c', 'user.email=agent@localhost', 'commit', '-qm', 'local');
  const agentCommit = git(clone, 'rev-parse', 'HEAD');
  writeFileSync(join(clone, 'untracked.txt'), 'sin seguimiento\n');
  unlinkSync(join(clone, 'delete.txt'));
  chmodSync(join(clone, 'script.sh'), 0o755);
  symlinkSync('untracked.txt', join(clone, 'link'));

  const result = (await seal(clone))!;
  expect(await importResult(home, worktree, head, {
    ...result.bundle, head: result.sha, expectChanges: true,
  }, 'first')).toBe(result.sha);
  expect(git(worktree, 'rev-list', '--parents', `${head}..HEAD`)).toBe(`${result.sha} ${head}`);
  expect(git(worktree, 'log', '-1', '--format=%an')).toBe('fab');
  expect(git(home, 'rev-parse', 'main')).toBe(head);
  expect(git(home, 'for-each-ref', 'refs/fab')).toBe('');
  expect(readFileSync(join(worktree, 'committed.txt'), 'utf8')).toBe('commit del agente\n');
  expect(readFileSync(join(worktree, 'untracked.txt'), 'utf8')).toBe('sin seguimiento\n');
  expect(existsSync(join(worktree, 'delete.txt'))).toBe(false);
  expect(statSync(join(worktree, 'script.sh')).mode & 0o111).toBe(0o111);
  expect(lstatSync(join(worktree, 'link')).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(worktree, 'link'))).toBe('untracked.txt');
  expect(Bun.spawnSync(['git', 'cat-file', '-e', agentCommit], { cwd: home }).exitCode).not.toBe(0);
});

test('segundo encargo incremental usa las puntas conocidas e ignora las ausentes', async () => {
  const first = await jobBundle();
  await receiveJob(cache, first, head, 'first');
  writeFileSync(join(worktree, 'next.txt'), 'segundo encargo\n');
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-qm', 'siguiente');
  const next = git(worktree, 'rev-parse', 'HEAD');
  const second = await jobBundle(next, [head, 'f'.repeat(40)]);
  expect(second.bytes).toBeLessThan(first.bytes);
  const clone = await receiveJob(cache, second, next, 'second');
  expect(readFileSync(join(clone, 'next.txt'), 'utf8')).toBe('segundo encargo\n');
  expect(git(clone, 'rev-parse', 'HEAD')).toBe(next);
});

test.each(['dos commits', 'otro padre', 'commit de fusión'] as const)('A3: rechaza %s', async (kind) => {
  const clone = await receive();
  const tree = git(clone, 'rev-parse', 'HEAD^{tree}');
  const commit = (...parents: string[]) => git(clone,
    '-c', 'user.name=Test', '-c', 'user.email=test@localhost',
    'commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', 'fixture');
  const other = commit();
  const parent = kind === 'dos commits' ? commit(head) : other;
  const sha = kind === 'commit de fusión' ? commit(head, other) : commit(parent);
  git(clone, 'update-ref', 'refs/heads/fixture', sha);
  const path = join(root, 'wrong.bundle');
  git(clone, 'bundle', 'create', path, 'refs/heads/fixture');
  await expect(importResult(home, worktree, head, describeBundle(path, sha), 'first')).rejects.toThrow(/padre/);
  expectHomeUnchanged();
});

test('A3: rechaza tamaño, hash, pack corrupto y bundle de solo lectura', async () => {
  const result = await changedResult();
  const data = readFileSync(result.path);
  const corruptPath = join(root, 'corrupt.bundle');
  data[data.length - 1] = data[data.length - 1]! ^ 1;
  writeFileSync(corruptPath, data);

  for (const [bundle, error] of [
    [{ ...result, bytes: result.bytes + 1 }, /tamaño/],
    [{ ...result, sha256: '0'.repeat(64) }, /sha256/],
    [describeBundle(corruptPath, result.head), /pack/],
    [{ ...result, expectChanges: false }, /solo lectura/],
  ] as const) {
    await expect(importResult(home, worktree, head, bundle, 'first')).rejects.toThrow(error);
    expectHomeUnchanged();
  }
});

test('A3: rechaza un pack íntegro cuyo commit no supera fsck', async () => {
  const clone = await receive();
  const tree = git(clone, 'rev-parse', 'HEAD^{tree}');
  const object = Bun.spawnSync(['git', 'hash-object', '--literally', '-w', '-t', 'commit', '--stdin'], {
    cwd: clone,
    stdin: Buffer.from([
      `tree ${tree}`, `parent ${head}`, 'author Test test@localhost 1730000000 +0000',
      'committer Test <test@localhost> 1730000000 +0000', '', 'fixture', '',
    ].join('\n')),
  });
  expect(object.exitCode).toBe(0);
  const sha = object.stdout.toString().trim();
  git(clone, 'update-ref', 'refs/heads/fixture', sha);
  const path = join(root, 'invalid-object.bundle');
  git(clone, 'bundle', 'create', path, 'refs/heads/fixture', `^${head}`);
  await expect(importResult(home, worktree, head, describeBundle(path, sha), 'first')).rejects.toThrow(/index-pack/);
  expectHomeUnchanged();
});

test('A4: sella con el índice y la configuración de la caché', async () => {
  const clone = await receive();
  const notExecutable = join(root, 'helper-inexistente');
  git(clone, 'config', 'core.fsmonitor', notExecutable);
  git(clone, 'config', 'core.hooksPath', join(root, 'hooks-inexistentes'));
  git(clone, 'config', 'filter.canary.clean', notExecutable);
  git(clone, 'config', 'filter.canary.required', 'true');
  git(clone, 'config', 'core.sshCommand', notExecutable);
  writeFileSync(join(clone, '.gitattributes'), '*.txt filter=canary\n');
  writeFileSync(join(clone, 'new.txt'), 'bytes intactos\n');
  const index = join(clone, '.git', 'index');
  const before = readFileSync(index);
  const result = (await seal(clone))!;
  expect(readFileSync(index)).toEqual(before);
  expect(git(cache, 'show', `${result.sha}:new.txt`)).toBe('bytes intactos');
});

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

test('A5: el clon y la caché tienen objetos independientes', async () => {
  const clone = await receive();
  const cached = files(cache).map(path => ({ path, inode: statSync(path).ino, sha: digest(readFileSync(path)) }));
  const objects = files(join(clone, '.git', 'objects'));
  expect(objects.length).toBeGreaterThan(0);
  const cacheInodes = new Set(cached.map(file => file.inode));
  for (const path of files(clone)) expect(cacheInodes.has(statSync(path).ino)).toBe(false);
  for (const path of objects) {
    chmodSync(path, 0o600);
    writeFileSync(path, 'clon modificado');
  }
  for (const file of cached) expect(digest(readFileSync(file.path))).toBe(file.sha);
});

test('A11: la transferencia truncada deja el HEAD enviado y un reintento puede avanzar', async () => {
  const result = await changedResult();
  const data = readFileSync(result.path);
  const partial = join(root, 'partial.bundle');
  for (const bytes of [0, Math.floor(data.length / 2)]) {
    writeFileSync(partial, data.subarray(0, bytes));
    await expect(importResult(home, worktree, head, { ...result, path: partial }, 'first')).rejects.toThrow(/tamaño/);
    expectHomeUnchanged();
  }
  expect(await importResult(home, worktree, head, result, 'retry')).toBe(result.head);
});

test('A11: un resultado tardío conserva el HEAD actual, aunque sea ancestro del enviado', async () => {
  writeFileSync(join(worktree, 'next.txt'), 'siguiente\n');
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-qm', 'enviado');
  const current = head;
  head = git(worktree, 'rev-parse', 'HEAD');
  const result = await changedResult();
  git(worktree, 'reset', '--hard', current);
  await expect(importResult(home, worktree, head, result, 'stale')).rejects.toThrow(/HEAD/);
  expect(git(worktree, 'rev-parse', 'HEAD')).toBe(current);
  expect(existsSync(join(worktree, 'new.txt'))).toBe(false);
  expect(git(home, 'for-each-ref', 'refs/fab')).toBe('');
});

test('A11: si Git no puede avanzar la rama, restaura el índice y los ficheros', async () => {
  const result = await changedResult();
  const lock = join(home, '.git', 'refs', 'heads', 'fab', 'change.lock');
  writeFileSync(lock, '');
  try {
    await expect(importResult(home, worktree, head, result, 'locked')).rejects.toThrow(/git merge/);
    expectHomeUnchanged();
    expect(existsSync(join(worktree, 'new.txt'))).toBe(false);
  } finally {
    unlinkSync(lock);
  }
  expect(await importResult(home, worktree, head, result, 'retry')).toBe(result.head);
});

test('una punta que ya está en caché admite un bundle con pack vacío', async () => {
  const first = await jobBundle();
  await receiveJob(cache, first, head, 'first');
  const second = await jobBundle(head, [head]);
  expect(second.bytes).toBeLessThan(first.bytes);
  const clone = await receiveJob(cache, second, head, 'second');
  expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);
});

test('el resultado no activa los filtros que casa tiene configurados', async () => {
  const clone = await receive();
  writeFileSync(join(clone, '.gitattributes'), '*.txt filter=canary\n');
  writeFileSync(join(clone, 'new.txt'), 'resultado\n');
  const result = (await seal(clone))!;
  git(home, 'config', 'filter.canary.smudge', join(root, 'helper-inexistente'));
  git(home, 'config', 'filter.canary.required', 'true');
  await importResult(home, worktree, head, {
    ...result.bundle, head: result.sha, expectChanges: true,
  }, 'first');
  expect(readFileSync(join(worktree, 'new.txt'), 'utf8')).toBe('resultado\n');
});
