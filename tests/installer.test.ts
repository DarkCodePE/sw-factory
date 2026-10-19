import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../scripts/install.sh', import.meta.url));
const roots: string[] = [];
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
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
cp "$TEST_ASSETS/\${url##*/}" "$out"
`);
  const payload = '#!/bin/sh\nprintf "fab 0.1.0\\n"\n';
  for (const platform of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']) {
    const asset = `fab-${platform}`;
    await writeFile(join(assets, asset), payload);
    await writeFile(join(assets, asset + '.sha256'), `${new Bun.CryptoHasher('sha256').update(payload).digest('hex')}  ${asset}\n`);
  }
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: temp, TEST_OS: os, TEST_ARCH: arch, TEST_ROOT: root, TEST_ASSETS: assets };
  const run = async (args: string[] = [], overrides: Record<string, string> = {}, stdin = false) => {
    const child = Bun.spawn(['/bin/sh', ...(stdin ? ['-s', '--'] : [installer]), ...args], { env: { ...env, ...overrides }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    if (stdin) child.stdin.write(await readFile(installer));
    child.stdin.end();
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out, err };
  };
  return { root, bin, assets, home, temp, env, run, payload, target: join(home, '.local/bin/fab') };
}

test('installer selects all four asset names and installs verified executables without Bun or sudo', async () => {
  for (const [os, arch, asset] of [['Linux', 'x86_64', 'linux-x64'], ['Linux', 'aarch64', 'linux-arm64'], ['Darwin', 'x86_64', 'darwin-x64'], ['Darwin', 'arm64', 'darwin-arm64']]) {
    const f = await fixture(os, arch), r = await f.run();
    expect(r.code).toBe(0); expect(await readFile(f.target, 'utf8')).toBe(f.payload);
    expect(await readFile(join(f.root, 'urls'), 'utf8')).toBe(`https://github.com/DarkCodePE/sw-factory/releases/latest/download/fab-${asset}\nhttps://github.com/DarkCodePE/sw-factory/releases/latest/download/fab-${asset}.sha256\n`);
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
  for (const name of ['mktemp', 'awk', 'cp', 'chmod', 'mv', 'mkdir', 'rm', 'shasum']) {
    const source = Bun.which(name, { PATH: '/usr/bin:/bin' });
    if (!source) throw new Error(`Test requires ${name}`);
    await symlink(source, join(f.bin, name));
  }
  const r = await f.run(['--version', 'v0.1.0'], { PATH: f.bin }, true);
  expect(r.code).toBe(0); expect(await readFile(f.target, 'utf8')).toBe(f.payload);
  expect(await Array.fromAsync(new Bun.Glob('*').scan(f.temp))).toEqual([]);
});
