import { chmod, cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assets, assert, hashFile, readJson, root, run, sourceSha, version, writeJson } from './common.mjs';

const directory = resolve(process.argv[2] ?? 'dist/candidate'), staging = resolve('dist/npm-stage');
const currentVersion = await version(), sha = sourceSha();
const manifest = { schemaVersion: 1, version: currentVersion, tag: `v${currentVersion}`, sourceSha: sha, assets: {} };
await mkdir(directory, { recursive: true });
for (const name of assets) {
  const path = join(directory, name), receipt = await readJson(path + '.receipt.json');
  const digest = await hashFile(path);
  assert(receipt.sourceSha === sha && receipt.version === currentVersion && receipt.sha256 === digest && receipt.checks.readEditTask && receipt.checks.tuiCommands, `Unverified native artifact ${name}`);
  assert(name === `fab-${receipt.platform}-${receipt.arch}`, `Wrong platform identity: ${name}`);
  manifest.assets[name] = { filename: name, sha256: digest, bytes: (await stat(path)).size };
  await writeFile(path + '.sha256', `${digest}  ${name}\n`);
}
await rm(staging, { recursive: true, force: true });
await cp(join(root, 'packaging/npm'), staging, { recursive: true });
const pkg = await readJson(join(staging, 'package.json')); pkg.version = currentVersion;
await writeJson(join(staging, 'package.json'), pkg); await writeJson(join(staging, 'release-manifest.json'), manifest);
await chmod(join(staging, 'bin/fab.mjs'), 0o755);
const [packed] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], { cwd: staging }));
const inventory = ['README.md', 'package.json', 'bin/fab.mjs', 'runtime.mjs', 'postinstall.mjs', 'release-manifest.json'];
assert(packed.files.length === inventory.length && packed.files.every(file => inventory.includes(file.path)), 'Unexpected npm package payload');
await writeJson(join(directory, 'release-manifest.json'), manifest);
await cp(join(root, 'scripts/install.sh'), join(directory, 'install.sh'));
await writeFile(join(directory, packed.filename + '.sha256'), `${await hashFile(join(directory, packed.filename))}  ${packed.filename}\n`);
console.log(JSON.stringify({ package: packed.filename, version: currentVersion, sourceSha: sha, sha256: await hashFile(join(directory, packed.filename)) }));
