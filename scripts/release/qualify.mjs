import { chmod, cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { binaryPath, platformAsset, validateManifest } from '../../packaging/npm/runtime.mjs';
import { assert, hashFile, readJson, run, sourceSha, writeJson } from './common.mjs';
import { smoke } from './smoke.mjs';

const directory = resolve(process.argv[2] ?? 'dist/candidate'), manifest = validateManifest(await readJson(join(directory, 'release-manifest.json')));
assert(manifest.sourceSha === sourceSha(), 'Qualification source differs from manifest');
const packages = (await readdir(directory)).filter(name => name.endsWith('.tgz')); assert(packages.length === 1, 'Expected one npm tarball');
const tarball = join(directory, packages[0]), temporary = await mkdtemp(join(tmpdir(), 'fab-stranger-'));
try {
  const name = platformAsset(), artifact = join(directory, name), home = join(temporary, 'home'), prefix = join(temporary, 'prefix');
  assert(await hashFile(artifact) === manifest.assets[name].sha256, 'Candidate bytes differ');
  const target = binaryPath(manifest, name, home);
  // Only prepublication qualification seeds the verified cache: GitHub draft assets
  // cannot be downloaded anonymously. Public qualification never seeds this cache.
  const { mkdir } = await import('node:fs/promises'); await mkdir(resolve(target, '..'), { recursive: true });
  await cp(artifact, target); await chmod(target, 0o755);
  run('npm', ['install', '--global', '--prefix', prefix, '--cache', join(temporary, 'npm-cache'), '--ignore-scripts', '--offline', '--no-audit', '--no-fund', tarball], { env: { ...process.env, HOME: home } });
  const result = await smoke(join(prefix, 'bin/fab'), manifest.version, { home });
  const receipt = { ...result, sourceSha: manifest.sourceSha, packageSha256: await hashFile(tarball), nativeSha256: manifest.assets[name].sha256, installMode: 'packed npm, fresh home, verified preseeded cache', entrypoint: 'prefix/bin/fab' };
  await writeJson(join(directory, `qualification-${process.platform}-${process.arch}.json`), receipt);
  console.log(JSON.stringify(receipt));
} finally { await rm(temporary, { recursive: true, force: true }); }
