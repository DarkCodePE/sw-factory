import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, readlinkSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  discardBundle, importResult, makeJobBundle, receiveJob, sealResult, type Bundle,
} from '../src/runners/bundle.ts';

let root: string;
let home: string;
let worktree: string;
let cache: string;
let head: string;
let bundles: Bundle[];
let witness: string;

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
  bundles = [];
  witness = join(root, 'witness');
  mkdirSync(witness);
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
  for (const bundle of bundles) discardBundle(bundle);
  rmSync(root, { recursive: true, force: true });
});

async function jobBundle(sha = head, have: string[] = []) {
  const bundle = await makeJobBundle(home, sha, have);
  bundles.push(bundle);
  return bundle;
}

async function receive(jobId = 'first') {
  return receiveJob(cache, await jobBundle(), head, jobId);
}

async function seal(repo: string) {
  const result = await sealResult(cache, repo, join(dirname(repo), 'index'), head);
  if (result) bundles.push(result.bundle);
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
  expect(result.bundle.bytes).toBeLessThan(16 * 1024); // no repite la historia que casa ya tiene
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

/** Crea un ejecutable que deja un testigo en `witness` si alguien lo ejecuta. */
function trap(name: string): string {
  const path = join(root, 'traps', name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\ntouch '${join(witness, name)}'\n`, { mode: 0o755 });
  return path;
}

function plantHooks(dir: string, names: string[]) {
  mkdirSync(dir, { recursive: true });
  for (const name of names) writeFileSync(join(dir, name), readFileSync(trap(`hook-${name}`)), { mode: 0o755 });
}

const HOOKS = ['reference-transaction', 'post-index-change', 'post-merge', 'post-checkout', 'pre-commit', 'post-commit'];

test('A4: sellar no ejecuta nada del clon ni de la caché y usa el índice indicado', async () => {
  const clone = await receive();
  git(clone, 'config', 'core.fsmonitor', trap('clone-fsmonitor'));
  git(clone, 'config', 'core.hooksPath', join(root, 'traps'));
  git(clone, 'config', 'filter.canary.clean', trap('clone-filter'));
  git(clone, 'config', 'filter.canary.required', 'true');
  git(clone, 'config', 'core.sshCommand', trap('clone-ssh'));
  plantHooks(join(clone, '.git', 'hooks'), HOOKS);
  git(cache, 'config', 'core.fsmonitor', trap('cache-fsmonitor'));
  git(cache, 'config', 'core.hooksPath', join(root, 'hooks-cache'));
  git(cache, 'config', 'diff.external', trap('cache-diff'));
  plantHooks(join(root, 'hooks-cache'), HOOKS);
  plantHooks(join(cache, 'hooks'), HOOKS);
  writeFileSync(join(clone, '.gitattributes'), '*.txt filter=canary\n');
  writeFileSync(join(clone, 'new.txt'), 'bytes intactos\n');
  const cloneIndex = join(clone, '.git', 'index');
  const before = readFileSync(cloneIndex);
  const indexFile = join(dirname(clone), 'index');
  const result = (await seal(clone))!;
  expect(readdirSync(witness)).toEqual([]);
  expect(readFileSync(cloneIndex)).toEqual(before);
  expect(existsSync(indexFile)).toBe(true);
  expect(existsSync(join(cache, 'index'))).toBe(false);
  expect(git(cache, 'show', `${result.sha}:new.txt`)).toBe('bytes intactos');
});

test('A4: importar no ejecuta nada de la configuración de casa', async () => {
  const result = await changedResult();
  git(home, 'config', 'core.fsmonitor', trap('home-fsmonitor'));
  git(home, 'config', 'core.hooksPath', join(root, 'hooks-home'));
  git(home, 'config', 'diff.external', trap('home-diff'));
  git(home, 'config', 'core.sshCommand', trap('home-ssh'));
  plantHooks(join(root, 'hooks-home'), HOOKS);
  plantHooks(join(home, '.git', 'hooks'), HOOKS);
  expect(await importResult(home, worktree, head, result, 'first')).toBe(result.head);
  expect(readdirSync(witness)).toEqual([]);
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

test('H1: un .git anidado en el resultado se rechaza, sin sellar un enlace a submódulo', async () => {
  const other = join(root, 'ajeno');
  git(root, 'init', '-q', '-b', 'main', other);
  writeFileSync(join(other, 'secreto'), 'x');
  git(other, 'add', '-A');
  git(other, '-c', 'user.name=T', '-c', 'user.email=t@localhost', 'commit', '-qm', 'ajeno');

  for (const kind of ['repositorio', 'gitdir'] as const) {
    const clone = await receive(kind);
    if (kind === 'repositorio') {
      git(root, 'init', '-q', '-b', 'main', join(clone, 'dep'));
      writeFileSync(join(clone, 'dep', 'lib.js'), 'trabajo del agente\n');
      git(join(clone, 'dep'), 'add', '-A');
      git(join(clone, 'dep'), '-c', 'user.name=T', '-c', 'user.email=t@localhost', 'commit', '-qm', 'dep');
    } else {
      mkdirSync(join(clone, 'espia'));
      writeFileSync(join(clone, 'espia', '.git'), `gitdir: ${join(other, '.git')}\n`);
    }
    await expect(seal(clone)).rejects.toThrow(/repositorio anidado/);
  }
});

test('H1: un resultado sin repositorios anidados sigue sellándose', async () => {
  const clone = await receive();
  mkdirSync(join(clone, 'src', 'lib'), { recursive: true });
  writeFileSync(join(clone, 'src', 'lib', 'a.txt'), 'a\n');
  expect(await seal(clone)).not.toBeNull();
});

test('H5: un resultado rechazado no deja objetos en el repositorio de casa', async () => {
  const clone = await receive();
  const tree = git(clone, 'rev-parse', 'HEAD^{tree}');
  const commit = (...parents: string[]) => git(clone,
    '-c', 'user.name=Test', '-c', 'user.email=test@localhost',
    'commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', `fixture ${Math.random()}`);
  const stranger = commit();
  git(clone, 'update-ref', 'refs/heads/fixture', commit(stranger));
  const path = join(root, 'stranger.bundle');
  git(clone, 'bundle', 'create', path, 'refs/heads/fixture');
  const before = files(join(home, '.git', 'objects')).sort();
  await expect(importResult(home, worktree, head, describeBundle(path, git(clone, 'rev-parse', 'fixture')), 'first'))
    .rejects.toThrow(/padre/);
  expect(files(join(home, '.git', 'objects')).sort()).toEqual(before);
  expectHomeUnchanged();
});

test('H7: discardBundle borra el directorio temporal y nada más', async () => {
  const bundle = await makeJobBundle(home, head, []);
  expect(existsSync(bundle.path)).toBe(true);
  discardBundle(bundle);
  expect(existsSync(dirname(bundle.path))).toBe(false);
  const keep = join(root, 'fab-bundle-ajeno', 'transfer.bundle');
  mkdirSync(dirname(keep));
  writeFileSync(keep, 'x');
  discardBundle({ ...bundle, path: keep });
  expect(existsSync(keep)).toBe(true);
});

// H3: cada defensa de rutas del runner, vigilando que el directorio víctima no reciba nada.
function victimDir() {
  const victim = join(root, 'victima');
  mkdirSync(victim);
  return victim;
}

test('H3: jobId inválido se rechaza antes de tocar el disco', async () => {
  const bundle = await jobBundle();
  for (const id of ['..', 'a/b', '', 'x'.repeat(81)]) {
    await expect(receiveJob(cache, bundle, head, id)).rejects.toThrow(/jobId/);
  }
  expect(existsSync(join(root, 'runner'))).toBe(false);
});

test.each(['directorio', 'colgante'] as const)('H3: un symlink %s en el directorio del encargo no se sigue', async (kind) => {
  const victim = victimDir();
  const jobs = join(root, 'runner', 'jobs');
  mkdirSync(jobs, { recursive: true });
  symlinkSync(kind === 'directorio' ? victim : join(victim, 'ausente'), join(jobs, 'first'));
  await expect(receiveJob(cache, await jobBundle(), head, 'first')).rejects.toThrow();
  expect(readdirSync(victim)).toEqual([]);
  expect(lstatSync(join(jobs, 'first')).isSymbolicLink()).toBe(true);
});

test.each([
  ['jobs', join('runner', 'jobs'), /raíz del runner/],
  ['cache', join('runner', 'cache'), /raíz del runner/],
  ['la caché', join('runner', 'cache', 'project.git'), /caché inesperado/],
  ['la caché colgante', join('runner', 'cache', 'project.git'), /caché inesperado/],
] as const)('H3: %s como symlink se rechaza sin escribir en el destino', async (name, link, error) => {
  const victim = victimDir();
  mkdirSync(join(root, 'runner', name.startsWith('la caché') ? 'cache' : '.'), { recursive: true });
  symlinkSync(name.endsWith('colgante') ? join(victim, 'ausente') : victim, join(root, link));
  await expect(receiveJob(cache, await jobBundle(), head, 'first')).rejects.toThrow(error);
  expect(readdirSync(victim)).toEqual([]);
});

test('H3: sellar rechaza un directorio Git o un índice que caen dentro o fuera por un symlink', async () => {
  const clone = await receive();
  const victim = victimDir();
  symlinkSync(clone, join(root, 'enlace-al-clon'));
  symlinkSync(join(victim, 'indice'), join(root, 'indice-enlace'));
  symlinkSync(clone, join(root, 'repo-enlace'));
  cpSync(cache, join(clone, 'copia.git'), { recursive: true });
  const outside = join(root, 'indice');
  for (const [cacheDir, repoDir, indexFile] of [
    [cache, clone, join(clone, 'indice-dentro')],
    [cache, clone, clone],
    [cache, clone, join(root, 'enlace-al-clon', 'indice')],
    [cache, clone, join(root, 'indice-enlace')],
    [cache, join(root, 'repo-enlace'), outside],
    [join(clone, 'copia.git'), clone, outside],
  ] as const) {
    await expect(sealResult(cacheDir, repoDir, indexFile, head)).rejects.toThrow(/fuera del clon/);
  }
  expect(readdirSync(victim)).toEqual([]);
  expect(existsSync(join(clone, 'indice-dentro'))).toBe(false);
  expect(existsSync(outside)).toBe(false);
});

// H4: formas de bundle y comprobaciones de casa.
test('H4: un bundle que es un symlink se rechaza', async () => {
  const result = await changedResult();
  const link = join(root, 'enlace.bundle');
  symlinkSync(result.path, link);
  await expect(importResult(home, worktree, head, { ...result, path: link }, 'first')).rejects.toThrow();
  expectHomeUnchanged();
  await expect(receiveJob(cache, { ...(await jobBundle()), path: link }, head, 'first')).rejects.toThrow();
});

test('H4: el tope de 64 MiB se aplica antes de leer el contenido', async () => {
  const big = join(root, 'grande.bundle');
  writeFileSync(big, '');
  truncateSync(big, 64 * 1024 * 1024 + 1);
  await expect(importResult(home, worktree, head, describeBundle(big, head), 'first')).rejects.toThrow(/fuera de límite/);
});

test('H4: el bundle anuncia solo el head declarado y este es un commit', async () => {
  const tree = git(home, 'rev-parse', 'HEAD^{tree}');
  const extra = git(home, '-c', 'user.name=T', '-c', 'user.email=t@localhost', 'commit-tree', tree, '-p', head, '-m', 'extra');
  git(home, 'update-ref', 'refs/heads/extra', extra);
  const two = join(root, 'dos.bundle');
  git(home, 'bundle', 'create', two, 'refs/heads/extra', 'refs/heads/main');
  await expect(importResult(home, worktree, head, describeBundle(two, extra), 'first')).rejects.toThrow(/anunciar solo/);
  const one = join(root, 'uno.bundle');
  git(home, 'bundle', 'create', one, 'refs/heads/extra');
  await expect(importResult(home, worktree, head, describeBundle(one, head), 'first')).rejects.toThrow(/anunciar solo/);

  const blob = Bun.spawnSync(['git', 'hash-object', '-w', '--stdin'], { cwd: home, stdin: Buffer.from('no soy un commit') })
    .stdout.toString().trim();
  const pack = Bun.spawnSync(['git', 'pack-objects', '--stdout'], { cwd: home, stdin: Buffer.from(`${blob}\n`) }).stdout;
  const fake = join(root, 'blob.bundle');
  writeFileSync(fake, Buffer.concat([Buffer.from(`# v2 git bundle\n${blob} refs/heads/x\n\n`), pack]));
  await expect(importResult(home, worktree, head, describeBundle(fake, blob), 'first')).rejects.toThrow(/no es un commit/);
  expectHomeUnchanged();
});

test('H4: makeJobBundle limita las puntas de have a 64', async () => {
  const have = Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(40, '0'));
  await expect(makeJobBundle(home, head, have)).rejects.toThrow(/demasiadas/);
});

test('H4: importar exige un worktree limpio, del repositorio y en su raíz', async () => {
  const result = await changedResult();
  writeFileSync(join(worktree, 'sucio.txt'), 'trabajo local\n');
  await expect(importResult(home, worktree, head, result, 'dirty')).rejects.toThrow(/cambios locales/);
  expect(readFileSync(join(worktree, 'sucio.txt'), 'utf8')).toBe('trabajo local\n');
  unlinkSync(join(worktree, 'sucio.txt'));

  mkdirSync(join(worktree, 'sub'));
  await expect(importResult(home, join(worktree, 'sub'), head, result, 'sub')).rejects.toThrow(/pertenece/);
  const other = join(root, 'otro');
  git(root, 'clone', '-q', home, other);
  await expect(importResult(home, other, head, result, 'other')).rejects.toThrow(/pertenece/);
  expectHomeUnchanged();
  expect(git(other, 'rev-parse', 'HEAD')).toBe(head);
});

test('H4: si falla el final de receiveJob, no queda la ref de entrada ni el directorio del encargo', async () => {
  await receiveJob(cache, await jobBundle(), head, 'first');
  writeFileSync(join(cache, 'refs', 'fab', 'cache', 'head.lock'), '');
  await expect(receiveJob(cache, await jobBundle(), head, 'second')).rejects.toThrow();
  expect(git(cache, 'for-each-ref', 'refs/fab/in')).not.toContain('second');
  expect(existsSync(join(root, 'runner', 'jobs', 'second'))).toBe(false);
});

test('H2: los atributos y las exclusiones de casa no alteran lo que se importa ni lo que se considera limpio', async () => {
  const result = await changedResult();
  writeFileSync(join(root, 'atributos'), '*.txt eol=crlf\n');
  writeFileSync(join(root, 'exclusiones'), 'sucio.txt\n');
  git(home, 'config', 'core.attributesFile', join(root, 'atributos'));
  git(home, 'config', 'core.excludesFile', join(root, 'exclusiones'));
  writeFileSync(join(worktree, 'sucio.txt'), 'trabajo local\n');
  await expect(importResult(home, worktree, head, result, 'first')).rejects.toThrow(/cambios locales/);
  unlinkSync(join(worktree, 'sucio.txt'));
  await importResult(home, worktree, head, result, 'retry');
  expect(readFileSync(join(worktree, 'new.txt'), 'utf8')).toBe('resultado\n');
});
