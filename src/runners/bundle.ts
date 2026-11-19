import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, createReadStream, createWriteStream, fstatSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, realpathSync, renameSync, rmSync, writeFileSync, constants,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GIT_SAFE_FLAGS } from '../worktrees.ts';

// Los ficheros devueltos viven en directorios temporales propios del llamador.
export interface Bundle {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ResultBundle extends Bundle {
  head: string;
  expectChanges: boolean;
}

export class RunnerResultRejected extends Error {
  constructor(cause: unknown) {
    super(`RUNNER_RESULT_REJECTED: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'RunnerResultRejected';
  }
}

const MAX_RESULT_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 1024 * 1024;
const SHA1 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const JOB_ID = /^[A-Za-z0-9_-]{1,80}$/;
const SAFE_FLAGS = [
  ...GIT_SAFE_FLAGS,
  '-c', 'core.attributesFile=/dev/null',
  '-c', 'core.excludesFile=/dev/null',
  '-c', 'core.quotePath=true',
  '-c', 'core.fileMode=true',
  '-c', 'core.symlinks=true',
  '-c', 'core.autocrlf=false',
  '-c', 'core.sparseCheckout=false',
  '-c', 'maintenance.auto=false',
  '-c', 'protocol.allow=never',
  '-c', 'rerere.enabled=false',
  '-c', 'submodule.recurse=false',
];

interface Git {
  cwd: string;
  flags?: string[];
  env?: Record<string, string>;
}

function startGit(context: Git, args: string[], stdin: Bun.Spawn.Writable = 'ignore') {
  return Bun.spawn(['git', ...SAFE_FLAGS, ...(context.flags ?? []), ...args], {
    cwd: context.cwd,
    env: {
      PATH: process.env.PATH,
      LC_ALL: 'C',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_NO_LAZY_FETCH: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...context.env,
    },
    stdin,
    stdout: 'pipe',
    stderr: 'ignore',
  });
}

async function run(context: Git, ...args: string[]) {
  const child = startGit(context, args);
  const [data, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited]);
  return { data: Buffer.from(data), code };
}

async function gitBytes(context: Git, ...args: string[]): Promise<Buffer> {
  const { data, code } = await run(context, ...args);
  if (code !== 0) throw new Error(`git ${args[0]} falló (código ${code})`);
  return data;
}

async function commitId(context: Git, sha: string) {
  const result = await run(context, 'cat-file', '-t', sha);
  return result.code === 0 && result.data.toString().trim() === 'commit';
}

function checkedHead(sha: string) {
  if (!SHA1.test(sha)) throw new Error('head debe ser un SHA-1 completo');
  return sha.toLowerCase();
}

function checkJobId(jobId: string) {
  if (!JOB_ID.test(jobId)) throw new Error('jobId inválido');
}

async function writeBundle(write: (path: string) => Promise<void>, maxBytes = Infinity): Promise<Bundle> {
  const dir = mkdtempSync(join(tmpdir(), 'fab-bundle-'));
  const path = join(dir, 'transfer.bundle');
  try {
    await write(path);
    const bytes = lstatSync(path).size;
    if (bytes > maxBytes) throw new Error('tamaño del bundle fuera de límite');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return { path, bytes, sha256: hash.digest('hex') };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function createBundle(context: Git, head: string, exclude: string[], maxBytes?: number) {
  const ref = `refs/fab/bundle/${randomUUID()}`;
  return writeBundle(async path => {
    await gitBytes(context, 'update-ref', ref, head, '0'.repeat(40));
    try {
      await gitBytes(context, 'bundle', 'create', '--version=2', path, ref, ...exclude.map(sha => `^${sha}`));
    } finally {
      await gitBytes(context, 'update-ref', '-d', ref, head);
    }
  }, maxBytes);
}

/** Usa un fichero privado para que Git lea exactamente los bytes que se verificaron. */
async function verifyBytes(bundle: Bundle, operation: (path: string) => Promise<void>, maxBytes = Infinity) {
  if (!Number.isSafeInteger(bundle.bytes) || bundle.bytes <= 0 || bundle.bytes > maxBytes) {
    throw new Error('tamaño del bundle fuera de límite');
  }
  if (!SHA256.test(bundle.sha256)) throw new Error('sha256 del bundle inválido');

  const dir = mkdtempSync(join(tmpdir(), 'fab-incoming-bundle-'));
  try {
    const path = join(dir, 'incoming.bundle');
    const fd = openSync(bundle.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== bundle.bytes) throw new Error('tamaño del bundle distinto del declarado');

      const hash = createHash('sha256');
      let bytes = 0;
      await pipeline(
        createReadStream(bundle.path, { fd, autoClose: false, end: bundle.bytes - 1 }),
        async function* (chunks) {
          for await (const chunk of chunks) {
            bytes += chunk.length;
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(path, { mode: 0o600 }),
      );
      if (bytes !== bundle.bytes || fstatSync(fd).size !== bundle.bytes) {
        throw new Error('tamaño del bundle distinto del declarado');
      }
      if (hash.digest('hex') !== bundle.sha256.toLowerCase()) throw new Error('sha256 del bundle distinto del declarado');
    } finally {
      closeSync(fd);
    }
    await operation(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function unpackBundle(context: Git, path: string, head: string) {
  const input = Bun.file(path);
  const header = Buffer.from(await input.slice(0, MAX_HEADER_BYTES).arrayBuffer());
  const end = header.indexOf('\n\n');
  if (end < 0) throw new Error('cabecera del bundle incompleta o demasiado grande');

  await gitBytes(context, 'bundle', 'verify', '--quiet', path);
  const advertised = (await gitBytes(context, 'bundle', 'list-heads', path)).toString().trimEnd();
  if (!advertised.startsWith(`${head} `) || advertised.includes('\n')) {
    throw new Error('el bundle debe anunciar solo el head declarado');
  }

  // En el transporte de bundles, git fetch no pasa fetch.fsckObjects a index-pack.
  const stream = Readable.toWeb(createReadStream(path, { start: end + 2 }), { strategy: { highWaterMark: 1 } });
  // Bun y Node declaran por separado el tipo del mismo stream WHATWG.
  const pack = stream as unknown as ReadableStream<Uint8Array>;
  const git = startGit(context, ['index-pack', '--stdin', '--fix-thin', '--strict'], pack);
  const [, code] = await Promise.all([new Response(git.stdout).arrayBuffer(), git.exited]);
  if (code !== 0) throw new Error('git index-pack rechazó el pack del bundle');
  if (!await commitId(context, head)) throw new Error('head recibido no es un commit');
}

export async function makeJobBundle(repo: string, head: string, have: string[]): Promise<Bundle> {
  const sha = checkedHead(head);
  if (have.length > 64) throw new Error('demasiadas puntas en have');
  const context = { cwd: repo };
  if (!await commitId(context, sha)) throw new Error('head no es un commit local');
  const exclude: string[] = [];
  for (const tip of new Set(have.map(checkedHead))) {
    if (!await commitId(context, tip)) continue;
    const ancestor = await run(context, 'merge-base', '--is-ancestor', sha, tip);
    if (ancestor.code === 0) {
      // bundle create rehúsa un pack vacío. Git genera el pack; la cabecera declara
      // como prerrequisito la punta que el runner ya tiene y que va a usar.
      return writeBundle(async path => {
        const pack = await gitBytes(context, 'pack-objects', '--stdout');
        const header = Buffer.from(`# v2 git bundle\n-${sha} head en caché\n${sha} refs/fab/cached\n\n`);
        writeFileSync(path, Buffer.concat([header, pack]), { mode: 0o600 });
      });
    }
    if (ancestor.code !== 1) throw new Error('git merge-base falló al comprobar have');
    exclude.push(tip);
  }
  return createBundle(context, sha, exclude);
}

function ensureDirectory(path: string) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!lstatSync(path).isDirectory()) throw new Error('directorio inesperado en la raíz del runner');
}

async function ensureCache(path: string): Promise<Git> {
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    const scratch = mkdtempSync(join(dirname(path), '.init-'));
    try {
      await gitBytes({ cwd: scratch }, 'init', '--bare', '--object-format=sha1', '--template=');
      try {
        renameSync(scratch, path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  if (!lstatSync(path).isDirectory()) throw new Error('directorio de caché inesperado');
  const context = { cwd: dirname(path), flags: [`--git-dir=${path}`] };
  if ((await gitBytes(context, 'rev-parse', '--is-bare-repository', '--show-object-format')).toString() !== 'true\nsha1\n') {
    throw new Error('la caché debe ser un repositorio bare SHA-1');
  }
  return context;
}

/**
 * cacheDir es <raíz>/cache/<repoKey>.git. El transporte aplica el límite de ida.
 * Tras el éxito, el llamador limpia el job y refs/fab/in/<jobId>.
 */
export async function receiveJob(cacheDir: string, bundle: Bundle, head: string, jobId: string): Promise<string> {
  const sha = checkedHead(head);
  checkJobId(jobId);

  const root = dirname(dirname(resolve(cacheDir)));
  mkdirSync(root, { mode: 0o700, recursive: true });
  const canonicalRoot = realpathSync(root);
  const cachePath = join(canonicalRoot, relative(root, resolve(cacheDir)));
  const jobsDir = join(canonicalRoot, 'jobs');
  ensureDirectory(dirname(cachePath));
  ensureDirectory(jobsDir);

  const jobDir = join(jobsDir, jobId);
  const repoDir = join(jobDir, 'repo');
  mkdirSync(jobDir, { mode: 0o700 });
  const inputRef = `refs/fab/in/${jobId}`;
  try {
    const context = await ensureCache(cachePath);
    let imported = false;
    try {
      await verifyBytes(bundle, path => unpackBundle(context, path, sha));
      await gitBytes(context, 'update-ref', inputRef, sha, '0'.repeat(40));
      imported = true;

      await gitBytes({ cwd: jobDir, flags: ['-c', 'protocol.file.allow=always'] },
        'clone', '--no-hardlinks', '--no-checkout', '--no-tags',
        '--template=', '--', cachePath, repoDir);
      const clone = { cwd: repoDir };
      await gitBytes(clone, 'remote', 'remove', 'origin');
      await gitBytes(clone, 'checkout', '--detach', '--no-recurse-submodules', sha);
      await gitBytes(context, 'update-ref', 'refs/fab/cache/head', sha);
      return repoDir;
    } catch (error) {
      if (imported) await gitBytes(context, 'update-ref', '-d', inputRef, sha);
      throw error;
    }
  } catch (error) {
    rmSync(jobDir, { recursive: true, force: true });
    throw error;
  }
}

function within(parent: string, child: string) {
  const path = relative(parent, child);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

export async function sealResult(
  cacheDir: string, repoDir: string, indexFile: string, head: string,
): Promise<{ sha: string; bundle: Bundle } | null> {
  const parent = checkedHead(head);
  const cache = realpathSync(cacheDir);
  const worktree = realpathSync(repoDir);
  const index = resolve(indexFile);
  if (!lstatSync(repoDir).isDirectory() || within(worktree, cache) || within(worktree, index) ||
      within(worktree, realpathSync(dirname(index))) || lstatSync(index, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error('el directorio Git y el índice deben quedar fuera del clon');
  }

  const context = {
    cwd: dirname(cache),
    flags: [`--git-dir=${cache}`, `--work-tree=${worktree}`, '-c', 'user.name=fab', '-c', 'user.email=fab@localhost'],
    env: { GIT_INDEX_FILE: index },
  };
  if (!await commitId(context, parent)) throw new Error('head no es un commit en caché');
  await gitBytes(context, 'read-tree', parent);
  await gitBytes(context, 'add', '-A');
  const tree = (await gitBytes(context, 'write-tree')).toString().trim();
  const oldTree = (await gitBytes(context, 'rev-parse', `${parent}^{tree}`)).toString().trim();
  if (tree === oldTree) return null;

  const sha = (await gitBytes(context, 'commit-tree', tree, '-p', parent, '-m', 'Resultado del runner')).toString().trim();
  return { sha, bundle: await createBundle(context, sha, [parent], MAX_RESULT_BYTES) };
}

/** Impide que atributos del resultado seleccionen filtros ejecutables configurados en casa. */
async function withoutFilters(context: Git): Promise<Git> {
  const config = (await gitBytes(context, 'config', '--null', '--name-only', '--list')).toString().split('\0');
  const filters = new Set(config.flatMap(key => {
    const match = /^(filter\..+)\.(clean|smudge|process|required)$/.exec(key);
    return match ? [match[1]!] : [];
  }));
  const flags = [...filters].flatMap(key => [
    '-c', `${key}.clean=`, '-c', `${key}.smudge=`, '-c', `${key}.process=`, '-c', `${key}.required=false`,
  ]);
  return { ...context, flags: [...(context.flags ?? []), ...flags] };
}

async function assertExpectedWorktree(repo: Git, worktree: Git, head: string) {
  const commonDir = async (context: Git) => realpathSync(
    (await gitBytes(context, 'rev-parse', '--path-format=absolute', '--git-common-dir')).toString().trimEnd(),
  );
  const top = (await gitBytes(worktree, 'rev-parse', '--show-toplevel')).toString().trimEnd();
  if (realpathSync(top) !== realpathSync(worktree.cwd) || await commonDir(repo) !== await commonDir(worktree)) {
    throw new Error('el worktree no pertenece al repositorio');
  }
  if ((await gitBytes(worktree, 'rev-parse', '--verify', 'HEAD')).toString().trim() !== head) {
    throw new Error('el HEAD del worktree cambió desde el encargo');
  }
  if ((await gitBytes(worktree, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=all')).length) {
    throw new Error('el worktree contiene cambios locales');
  }
}

async function advanceWorktree(target: Git, parent: string, result: string) {
  try {
    await gitBytes(target, 'merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore',
      '--no-verify-signatures', '--no-stat', result);
  } catch (error) {
    // Git puede escribir el árbol antes de descubrir que la ref local está bloqueada.
    const head = (await gitBytes(target, 'rev-parse', '--verify', 'HEAD')).toString().trim();
    const index = await run(target, 'diff', '--cached', '--quiet', parent, '--');
    if (head === parent && index.code === 1) {
      await gitBytes(target, 'read-tree', '-m', '-u', result, parent);
    }
    throw error;
  }
}

export async function importResult(
  repo: string, worktree: string, sentHead: string, bundle: ResultBundle, jobId: string,
): Promise<string> {
  try {
    if (bundle.expectChanges !== true) throw new Error('el encargo es de solo lectura');
    checkJobId(jobId);
    const parent = checkedHead(sentHead);
    const sha = checkedHead(bundle.head);
    const source = { cwd: repo };
    const target = await withoutFilters({ cwd: worktree });
    const ref = `refs/fab/remote/${jobId}-${randomUUID()}`;

    await verifyBytes(bundle, path => unpackBundle(source, path, sha), MAX_RESULT_BYTES);
    await gitBytes(source, 'update-ref', ref, sha, '0'.repeat(40));
    try {
      const commit = (await gitBytes(source, 'cat-file', 'commit', sha)).toString();
      const parents = commit.slice(0, commit.indexOf('\n\n')).split('\n').filter(line => line.startsWith('parent '));
      if (parents.length !== 1 || parents[0] !== `parent ${parent}`) {
        throw new Error('el único padre del resultado debe ser el head enviado');
      }
    } finally {
      await gitBytes(source, 'update-ref', '-d', ref, sha);
    }
    await assertExpectedWorktree(source, target, parent);
    await advanceWorktree(target, parent, sha);
    return sha;
  } catch (error) {
    throw new RunnerResultRejected(error);
  }
}
