import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../scripts/install.sh', import.meta.url));
const roots: string[] = [];
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
function release(tag = 'v0.1.0', overrides: Record<string, unknown> = {}) {
  const names = ['install.sh', 'release-manifest.json', 'candidate-receipt.json'];
  for (const os of ['linux', 'darwin']) for (const arch of ['x64', 'arm64']) names.push(`fab-${os}-${arch}`, `fab-${os}-${arch}.sha256`);
  return { tag_name: tag, draft: false, prerelease: tag.includes('-'), assets: names.map((name, i) => ({ name, id: i + 1, size: 10 })), ...overrides };
}
async function fixture(os = 'Linux', arch = 'x86_64') {
  const root = await mkdtemp(join(tmpdir(), 'fab-installer-test-')); roots.push(root);
  const bin = join(root, 'commands'), home = join(root, 'home'), assets = join(root, 'assets'), temp = join(root, 'tmp');
  await Promise.all([bin, home, assets, temp].map(p => mkdir(p)));
  const executable = async (name: string, body: string) => { const p = join(bin, name); await writeFile(p, '#!/bin/sh\nset -eu\n' + body); await chmod(p, 0o755); };
  await executable('uname', 'if [ "$1" = -s ]; then echo "$TEST_OS"; else echo "$TEST_ARCH"; fi\n');
  await executable('getconf', '[ "${TEST_MUSL:-0}" != 1 ]\n');
  await executable('curl', `out=; url=
while [ "$#" -gt 0 ]; do
  case "$1" in --output) out=$2; shift 2 ;; *) url=$1; shift ;; esac
done
printf '%s\\n' "$url" >> "$TEST_ROOT/urls"
[ "\${TEST_HTTP_FAIL:-0}" != 1 ] || exit 22
case "$url" in
  *api.github.com*/releases\\?*) cp "$TEST_ASSETS/page-\${url##*page=}.json" "$out" ;;
  *api.github.com*/releases/tags/*) cp "$TEST_ASSETS/tag-\${url##*/}.json" "$out" ;;
  *) cp "$TEST_ASSETS/\${url##*/}" "$out" ;;
esac
`);
  const payload = '#!/bin/sh\nprintf "fab 0.1.0\\n"\n';
  for (const platform of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']) {
    const asset = `fab-${platform}`;
    await writeFile(join(assets, asset), payload);
    await writeFile(join(assets, asset + '.sha256'), `${new Bun.CryptoHasher('sha256').update(payload).digest('hex')}  ${asset}\n`);
  }
  const setReleases = async (items: ReturnType<typeof release>[], page = 1) => {
    await writeFile(join(assets, `page-${page}.json`), JSON.stringify(items));
    for (const item of items) await writeFile(join(assets, `tag-${item.tag_name}.json`), JSON.stringify(item));
  };
  await setReleases([release()]);
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: temp, TEST_OS: os, TEST_ARCH: arch, TEST_ROOT: root, TEST_ASSETS: assets };
  const run = async (args: string[] = [], overrides: Record<string, string> = {}, stdin = false, source = installer) => {
    const child = Bun.spawn(['/bin/sh', ...(stdin ? ['-s', '--'] : [source]), ...args], { env: { ...env, ...overrides }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    if (stdin) child.stdin.write(await readFile(source));
    child.stdin.end();
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out, err };
  };
  return { root, bin, assets, home, temp, env, run, payload, setReleases, target: join(home, '.local/bin/fab') };
}

test('installer selects all four asset names and installs verified executables without Bun or sudo', async () => {
  for (const [os, arch, asset] of [['Linux', 'x86_64', 'linux-x64'], ['Linux', 'aarch64', 'linux-arm64'], ['Darwin', 'x86_64', 'darwin-x64'], ['Darwin', 'arm64', 'darwin-arm64']]) {
    const f = await fixture(os, arch), r = await f.run();
    expect(r.code).toBe(0); expect(await readFile(f.target, 'utf8')).toBe(f.payload);
    expect(await readFile(join(f.root, 'urls'), 'utf8')).toBe(`https://api.github.com/repos/DarkCodePE/sw-factory/releases?per_page=100&page=1\nhttps://github.com/DarkCodePE/sw-factory/releases/download/v0.1.0/fab-${asset}\nhttps://github.com/DarkCodePE/sw-factory/releases/download/v0.1.0/fab-${asset}.sha256\n`);
    expect(r.out).toContain('fab tui'); expect(await Array.fromAsync(new Bun.Glob('*').scan(f.temp))).toEqual([]);
  }
});

test('version-pinned installation supports a destination with spaces and atomic update', async () => {
  const f = await fixture(), dest = join(f.home, 'my bin'); await mkdir(dest); await writeFile(join(dest, 'fab'), 'old binary');
  const r = await f.run(['--version', 'v0.1.0', '--install-dir', dest]);
  expect(r.code).toBe(0); expect(await readFile(join(dest, 'fab'), 'utf8')).toBe(f.payload);
  expect(await readFile(join(f.root, 'urls'), 'utf8')).toContain('/releases/download/v0.1.0/');
  expect(await Array.fromAsync(new Bun.Glob('.fab-install.*').scan(dest))).toEqual([]);
});

test('tampering and malformed checksum never execute or replace the existing installation', async () => {
  for (const tamper of ['payload', 'wrong-name', 'extra-line']) {
    const f = await fixture(); await mkdir(join(f.home, '.local/bin'), { recursive: true }); await writeFile(f.target, 'original');
    const asset = join(f.assets, 'fab-linux-x64');
    if (tamper === 'payload') await writeFile(asset, `#!/bin/sh\ntouch '${f.root}/executed'\n`);
    else {
      const checksum = await readFile(asset + '.sha256', 'utf8');
      await writeFile(asset + '.sha256', tamper === 'wrong-name' ? checksum.replace('fab-linux-x64', '../other') : checksum + checksum);
    }
    const r = await f.run(); expect(r.code).not.toBe(0); expect(await readFile(f.target, 'utf8')).toBe('original');
    expect(await Bun.file(join(f.root, 'executed')).exists()).toBe(false);
    expect(await Array.fromAsync(new Bun.Glob('*').scan(f.temp))).toEqual([]);
  }
});

test('missing releases and version mismatches preserve the previous binary', async () => {
  const f = await fixture(); await mkdir(join(f.home, '.local/bin'), { recursive: true }); await writeFile(f.target, 'original');
  expect((await f.run([], { TEST_HTTP_FAIL: '1' })).err).toContain('release');
  await f.setReleases([release('v9.0.0')]);
  const mismatch = await f.run(['--version', 'v9.0.0']); expect(mismatch.code).not.toBe(0); expect(mismatch.err).toContain('no coincide');
  expect(await readFile(f.target, 'utf8')).toBe('original');
});

test('unsupported OS, architecture and musl fail before downloading; help and invalid options are explicit', async () => {
  for (const [os, arch, env] of [['MINGW64_NT', 'x86_64', {}], ['Linux', 'riscv64', {}], ['Linux', 'x86_64', { TEST_MUSL: '1' }]] as const) {
    const f = await fixture(os, arch); expect((await f.run([], env)).code).not.toBe(0); expect(await Bun.file(join(f.root, 'urls')).exists()).toBe(false);
  }
  const f = await fixture(); expect((await f.run(['--help'])).code).toBe(0);
  for (const args of [['--version'], ['--version', '../escape'], ['--install-dir', 'relative'], ['--unknown']]) expect((await f.run(args)).code).not.toBe(0);
  expect(await Bun.file(join(f.root, 'urls')).exists()).toBe(false);
});

test('a symlink destination is rejected without altering its target', async () => {
  const f = await fixture(); await mkdir(join(f.home, '.local/bin'), { recursive: true });
  const original = join(f.root, 'original'); await writeFile(original, 'keep'); await symlink(original, f.target);
  expect((await f.run()).code).not.toBe(0); expect(await readFile(original, 'utf8')).toBe('keep');
});

test('piped script uses shasum when sha256sum is absent from PATH', async () => {
  const f = await fixture('Darwin', 'arm64');
  for (const name of ['python3', 'cat', 'mktemp', 'awk', 'cp', 'chmod', 'mv', 'mkdir', 'rm', 'shasum']) {
    const source = Bun.which(name, { PATH: '/usr/bin:/bin' });
    if (!source) throw new Error(`Test requires ${name}`);
    await symlink(source, join(f.bin, name));
  }
  const r = await f.run(['--version', 'v0.1.0'], { PATH: f.bin }, true);
  expect(r.code).toBe(0); expect(await readFile(f.target, 'utf8')).toBe(f.payload);
  expect(await Array.fromAsync(new Bun.Glob('*').scan(f.temp))).toEqual([]);
});

test('stable selection ignores drafts, incomplete releases and RCs; prerelease compares numeric SemVer', async () => {
  const f = await fixture();
  await f.setReleases([release('v0.2.0-rc.2'), release('v0.1.0'), release('v0.2.0-rc.10'), release('v9.0.0', { draft: true }), release('v8.0.0', { assets: [] })]);
  expect((await f.run(['--check'])).out).toContain('FAB v0.1.0 · canal stable');
  expect((await f.run(['--channel', 'prerelease', '--check'])).out).toContain('FAB v0.2.0-rc.10');
  expect((await f.run(['--check'], { FAB_CHANNEL: 'prerelease' })).out).toContain('FAB v0.2.0-rc.10');
  expect(await Bun.file(f.target).exists()).toBe(false);
});

test('no stable release reports prerelease opt-in and inconsistent release flags never enter a channel', async () => {
  const f = await fixture(); await f.setReleases([release('v0.2.0-rc.1'), release('v1.0.0', { prerelease: true })]);
  const stable = await f.run(['--check']); expect(stable.code).toBe(1); expect(stable.err).toContain('--channel prerelease');
  expect((await f.run(['--channel', 'prerelease', '--check'])).out).toContain('v0.2.0-rc.1');
  const invalid = await f.run(['--channel', 'nightly']); expect(invalid.code).toBe(1);
});

test('complete pagination selects the highest version and failed or exhausted pagination never installs a partial result', async () => {
  const f = await fixture(), first = Array.from({ length: 100 }, (_, i) => release(`v0.0.${i}`));
  await f.setReleases(first); await f.setReleases([release('v0.1.0')], 2);
  expect((await f.run(['--check'])).out).toContain('v0.1.0');
  await rm(join(f.assets, 'page-2.json'));
  expect((await f.run()).code).toBe(1); expect(await Bun.file(f.target).exists()).toBe(false);
  for (let page = 2; page <= 20; page++) await f.setReleases(first, page);
  const exhausted = await f.run(['--check']); expect(exhausted.code).toBe(1); expect(exhausted.err).toContain('20 páginas');
});

test('automatic installation refuses downgrade; an explicit pin permits intentional rollback', async () => {
  const f = await fixture(); await mkdir(join(f.home, '.local/bin'), { recursive: true });
  const newer = '#!/bin/sh\nprintf "fab 0.2.0\\n"\n'; await writeFile(f.target, newer); await chmod(f.target, 0o755);
  const automatic = await f.run(); expect(automatic.code).toBe(1); expect(automatic.err).toContain('rollback explícito');
  expect(await readFile(f.target, 'utf8')).toBe(newer);
  expect((await f.run(['--version', '0.1.0'])).code).toBe(0); expect(await readFile(f.target, 'utf8')).toBe(f.payload);
});

test('generated release installers pin their own RC while latest/prerelease scripts force their channel', async () => {
  const f = await fixture();
  await f.setReleases([release(), release('v0.2.0-rc.2')]);
  const generator = fileURLToPath(new URL('../scripts/release/installers.mjs', import.meta.url));
  const build = Bun.spawn(['node', generator, f.root, '0.2.0-rc.2'], { stdout: 'pipe', stderr: 'pipe' });
  expect(await build.exited).toBe(0);
  const pinned = await f.run(['--check'], { FAB_VERSION: 'v0.1.0', FAB_CHANNEL: 'bogus' }, true, join(f.root, 'install.sh'));
  expect(pinned.code).toBe(0); expect(pinned.out).toContain('v0.2.0-rc.2');
  expect((await f.run(['--version', 'v0.1.0'], {}, false, join(f.root, 'install.sh'))).code).toBe(1);
  const stable = await f.run(['--check'], { FAB_CHANNEL: 'prerelease', FAB_VERSION: 'v0.2.0-rc.2' }, true, join(f.root, 'latest.sh'));
  expect(stable.code).toBe(0); expect(stable.out).toContain('FAB v0.1.0 · canal stable');
  const prerelease = await f.run(['--check'], { FAB_CHANNEL: 'stable', FAB_VERSION: 'v0.1.0' }, true, join(f.root, 'prerelease.sh'));
  expect(prerelease.code).toBe(0); expect(prerelease.out).toContain('v0.2.0-rc.2');
  expect((await f.run(['--channel', 'prerelease'], {}, false, join(f.root, 'latest.sh'))).code).toBe(1);
});
