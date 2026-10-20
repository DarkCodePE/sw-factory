import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateMain } from '../src/update/index.ts';
import { compareVersions, parseVersion, updateChannel } from '../src/update/version.ts';
import { runOwnedCommand } from '../src/update/process.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = (bytes: string, algorithm = 'sha256', encoding: 'hex' | 'base64' = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
async function npmFixture(current = '0.1.0-rc.5', candidate = '0.1.0-rc.6') {
  const root = await mkdtemp(join(tmpdir(), 'fab-update-test-')); roots.push(root);
  const home = join(root, 'home'), prefix = join(root, 'prefix with spaces'), packageRoot = join(prefix, 'lib/node_modules/@okuanb/fab');
  const bytes = 'previous native bytes', digest = hash(bytes), name = `fab-${process.platform}-${process.arch}`;
  const executable = join(home, '.cache/fab', current, digest, name), commands = join(root, 'commands');
  await mkdir(packageRoot, { recursive: true }); await mkdir(join(executable, '..'), { recursive: true }); await mkdir(commands);
  await writeFile(executable, bytes);
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@okuanb/fab', version: current }));
  await writeFile(join(packageRoot, 'release-manifest.json'), JSON.stringify({ version: current, assets: { [name]: { sha256: digest } } }));
  const archive = 'sealed npm archive fixture';
  const metadata = { name: '@okuanb/fab', version: candidate, dist: { tarball: 'https://registry.npmjs.org/@okuanb/fab/-/fab.tgz', integrity: `sha512-${hash(archive, 'sha512', 'base64')}` } };
  const index = { 'dist-tags': { next: candidate, latest: candidate }, versions: { [candidate]: metadata } };
  let requests = 0;
  const fetcher = async () => { requests++; return requests === 1 ? Response.json(index) : new Response(archive); };
  const npm = join(commands, 'npm');
  await writeFile(npm, `#!/bin/sh\nset -eu\nprintf '%s\\n' "$@" > "$HOME/args"\nenv > "$HOME/child-env"\nfor last; do :; done\ncp "$last" "$HOME/archive"\nprintf '%s' '${JSON.stringify({ name: '@okuanb/fab', version: candidate })}' > '${join(packageRoot, 'package.json')}'\n`);
  await chmod(npm, 0o755);
  const output: string[] = [], errors: string[] = [];
  const context = { version: current, executable, compiled: true, fetcher,
    env: { PATH: `${commands}:/usr/bin:/bin`, HOME: home, FAB_NPM_PACKAGE_ROOT: packageRoot, NPM_TOKEN: 'secret-not-forwarded', NODE_AUTH_TOKEN: 'secret-not-forwarded', FAB_CHANNEL: undefined },
    log: (s: string) => output.push(s), error: (s: string) => errors.push(s) };
  return { root, home, prefix, packageRoot, executable, archive, index, metadata, context, output, errors, requests: () => requests };
}

test('SemVer ordering and channel inference distinguish stable, RCs, huge numeric versions and invalid pins', () => {
  for (const [a, b] of [['0.1.0-rc.2', '0.1.0-rc.10'], ['0.1.0-rc.10', '0.1.0'], ['0.1.0', '0.2.0-rc.1'], ['1.0.0-a', '1.0.0-a.1'], ['1.0.0-9', '1.0.0-a'], ['9999999999999999.0.0', '10000000000000000.0.0']])
    expect(compareVersions(a!, b!)).toBe(-1);
  expect(compareVersions('v1.0.0+build.1', '1.0.0+build.2')).toBe(0);
  expect(updateChannel('0.1.0-rc.6')).toBe('prerelease'); expect(updateChannel('0.1.0')).toBe('stable');
  expect(updateChannel('0.1.0', 'prerelease')).toBe('prerelease');
  for (const value of ['../path', '1.0', '01.0.0', '1.0.0-01']) expect(() => parseVersion(value)).toThrow();
});

test('help and source execution never overwrite the Bun runtime or call a provider', async () => {
  const output: string[] = [], errors: string[] = [];
  expect(await updateMain(['--help'], { log: s => output.push(s) })).toBe(0); expect(output.join()).toContain('--check');
  expect(await updateMain([], { compiled: false, env: {}, error: s => errors.push(s) })).toBe(1);
  expect(errors.join()).toContain('no se reemplaza Bun');
});

test('standalone updates use the embedded installer, infer their channel and strip credentials', async () => {
  const f = await npmFixture();
  const args: string[][] = []; let input = '', childEnv: Record<string, string> = {};
  const run: typeof runOwnedCommand = async (argv, options) => { args.push(argv); input = options.input!; childEnv = options.env; return 0; };
  const executable = join(f.root, 'fab'); await writeFile(executable, 'old');
  const context = { ...f.context, executable, run, env: { PATH: '/usr/bin:/bin', HOME: f.home, NODE_AUTH_TOKEN: 'secret' } };
  expect(await updateMain([], context)).toBe(0);
  expect(args[0]).toContain('prerelease'); expect(args[0]).toContain(f.root); expect(input).toContain('FAB_INSTALLER_MODE=source');
  expect(childEnv).toMatchObject({ PATH: '/usr/bin:/bin', HOME: f.home }); expect(childEnv.TMPDIR).toContain('fab-update-');
  expect(Object.keys(childEnv).sort()).toEqual(['HOME', 'PATH', 'TMPDIR']); expect(await Bun.file(childEnv.TMPDIR!).exists()).toBe(false);
  expect(await updateMain(['--channel', 'stable', '--check'], context)).toBe(0); expect(args[1]).toContain('stable'); expect(args[1]).toContain('--check');
  expect(await readFile(executable, 'utf8')).toBe('old');
});

test('npm updates the owning global prefix from a verified tarball and preserves the old cache bytes', async () => {
  const f = await npmFixture(); expect(await updateMain([], f.context)).toBe(0);
  const args = (await readFile(join(f.home, 'args'), 'utf8')).trim().split('\n');
  expect(args).toContain('--global'); expect(args).toContain(f.prefix); expect(args).toContain('--userconfig'); expect(args).toContain('--globalconfig');
  expect(await readFile(join(f.home, 'archive'), 'utf8')).toBe(f.archive);
  expect(await readFile(join(f.home, 'child-env'), 'utf8')).not.toContain('secret-not-forwarded');
  expect(await readFile(f.executable, 'utf8')).toBe('previous native bytes'); expect(await Bun.file(args.at(-1)!).exists()).toBe(false);
});

test('npm check is read-only and automatic downgrade/RC-as-latest cannot silently change channels', async () => {
  const f = await npmFixture(); expect(await updateMain(['--check'], f.context)).toBe(0); expect(f.requests()).toBe(1);
  expect(await Bun.file(join(f.home, 'args')).exists()).toBe(false);
  const stable = await npmFixture('0.1.0', '0.2.0-rc.1'); expect(await updateMain([], stable.context)).toBe(1); expect(stable.errors.join()).toContain('latest contiene una prerelease');
  const downgrade = await npmFixture('0.2.0-rc.1', '0.1.0-rc.6'); expect(await updateMain([], downgrade.context)).toBe(1); expect(downgrade.errors.join()).toContain('rollback explícito');
});

test('npm rejects foreign package identity, altered tarballs, credential URLs and unrelated executable paths before installing', async () => {
  for (const failure of ['name', 'integrity', 'url', 'executable']) {
    const f = await npmFixture();
    if (failure === 'name') f.metadata.name = 'other';
    if (failure === 'integrity') f.metadata.dist.integrity = `sha512-${hash('wrong bytes', 'sha512', 'base64')}`;
    if (failure === 'url') f.metadata.dist.tarball = 'https://user:password@registry.npmjs.org/pkg.tgz';
    if (failure === 'executable') { const other = join(f.root, 'other'); await writeFile(other, 'other'); f.context.executable = other; }
    expect(await updateMain([], f.context)).toBe(1); expect(await Bun.file(join(f.home, 'args')).exists()).toBe(false);
    expect(f.errors.join()).not.toContain('password'); expect(await readFile(f.executable, 'utf8')).toBe('previous native bytes');
  }
});

test('npm metadata or body stalls obey the total deadline even when cancellation is ignored', async () => {
  for (const stage of ['headers', 'body']) {
    const f = await npmFixture();
    f.context.fetcher = async () => stage === 'headers' ? new Promise<Response>(() => {}) : new Response(new ReadableStream({ cancel() { return new Promise(() => {}); } }));
    const start = performance.now(); expect(await updateMain([], { ...f.context, timeoutMs: 40 })).toBe(1);
    expect(performance.now() - start).toBeLessThan(1000); expect(f.errors.join()).toContain('Tiempo total');
  }
});

test('aborting an owned installer kills delayed descendants before they can write', async () => {
  const f = await npmFixture(), marker = join(f.root, 'late-write'); const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('stop owned updater')), 30);
  try {
    await expect(runOwnedCommand(['sh', '-c', '(sleep 0.15; printf bad > "$1") & wait', 'sh', marker], { env: { PATH: '/usr/bin:/bin' }, signal: controller.signal })).rejects.toThrow('stop owned updater');
    await Bun.sleep(200); expect(await Bun.file(marker).exists()).toBe(false);
  } finally { clearTimeout(timer); }
});
