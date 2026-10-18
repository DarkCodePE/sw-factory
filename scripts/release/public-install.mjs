import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assert, hashFile, run, writeJson } from './common.mjs';
import { verifyCandidate } from './seal.mjs';
import { smoke } from './smoke.mjs';
import { binaryPath, platformAsset } from '../../packaging/npm/runtime.mjs';
const directory = resolve('dist/candidate'), { manifest, receipt } = await verifyCandidate(directory, { metadataOnly: true });
const temporary = await mkdtemp(join(tmpdir(), 'fab-public-')), name = platformAsset();
const channel = process.argv.includes('--github-only') ? 'github' : 'npm';
async function download(url, path) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) }); assert(response.ok, `Public download failed: ${response.status}`);
  const { open } = await import('node:fs/promises'), file = await open(path, 'wx', 0o600);
  try { for await (const bytes of response.body) await file.writeFile(bytes); } finally { await file.close(); }
}
try {
  const home = join(temporary, 'home'), prefix = join(temporary, 'prefix'); await mkdir(home); await mkdir(prefix);
  let executable, digest;
  if (channel === 'github') {
    const installer = join(temporary, 'install.sh');
    await download(`https://github.com/DarkCodePE/sw-factory/releases/download/${receipt.tag}/install.sh`, installer);
    assert(await hashFile(installer) === receipt.installerSha256, 'Public installer differs from source seal');
    run('sh', [installer, '--version', receipt.tag, '--install-dir', prefix], { env: { PATH: process.env.PATH ?? '', HOME: home } });
    executable = join(prefix, 'fab'); digest = await hashFile(executable);
  } else {
    const metadata = JSON.parse(run('npm', ['view', `${receipt.package.name}@${receipt.version}`, 'dist', '--json']));
    assert(new URL(metadata.tarball).hostname === 'registry.npmjs.org', 'Unexpected npm artifact origin');
    const tarball = join(temporary, 'published.tgz'); await download(metadata.tarball, tarball);
    assert(await hashFile(tarball) === receipt.package.sha256, 'npm bytes differ from preflight seal');
    run('npm', ['install', '--global', '--prefix', prefix, '--cache', join(temporary, 'npm-cache'), '--no-audit', '--no-fund', '--foreground-scripts', tarball], { env: { PATH: process.env.PATH ?? '', HOME: home } });
    executable = join(prefix, 'bin/fab'); digest = await hashFile(binaryPath(manifest, name, home));
  }
  assert(digest === manifest.assets[name].sha256, 'Installed native bytes differ from preflight');
  const result = await smoke(executable, receipt.version, { home });
  const publication = { ...result, channel, sourceSha: receipt.sourceSha, packageSha256: receipt.package.sha256, nativeSha256: digest, freshHome: true, publicDownload: true };
  await writeJson(resolve(`dist/publication-${channel}-${process.platform}-${process.arch}.json`), publication); console.log(JSON.stringify(publication));
} finally { await rm(temporary, { recursive: true, force: true }); }
