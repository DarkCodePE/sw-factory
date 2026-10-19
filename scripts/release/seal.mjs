import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assets, assert, hashFile, junit, readJson, run, sourceSha, version, writeJson } from './common.mjs';
import { validateManifest } from '../../packaging/npm/runtime.mjs';

export async function verifyCandidate(directory, { metadataOnly = false } = {}) {
  const manifest = validateManifest(await readJson(join(directory, 'release-manifest.json'))), receipt = await readJson(join(directory, 'candidate-receipt.json'));
  assert(receipt.schemaVersion === 1 && receipt.sourceSha === sourceSha() && manifest.sourceSha === receipt.sourceSha
    && receipt.version === await version() && manifest.version === receipt.version && receipt.tag === `v${receipt.version}`, 'Candidate source/version mismatch');
  assert(/^[a-z0-9][a-z0-9._-]*\.tgz$/.test(receipt.package.filename), 'Invalid package filename');
  assert(await hashFile(join(directory, receipt.package.filename)) === receipt.package.sha256, 'Packed npm bytes differ from seal');
  assert(await hashFile(join(directory, 'release-manifest.json')) === receipt.manifestSha256, 'Release manifest differs from seal');
  assert(await hashFile(join(directory, 'install.sh')) === receipt.installerSha256, 'Installer differs from seal');
  for (const name of assets) {
    const path = join(directory, name);
    if (!metadataOnly) assert(await hashFile(path) === manifest.assets[name].sha256 && (await stat(path)).size === manifest.assets[name].bytes, `Sealed asset differs: ${name}`);
    const qualified = await readJson(join(directory, name.replace('fab-', 'qualification-') + '.json'));
    const binding = receipt.qualifications.find(item => item.asset === name);
    assert(binding && await hashFile(join(directory, name.replace('fab-', 'qualification-') + '.json')) === binding.receiptSha256
      && qualified.packageSha256 === receipt.package.sha256 && qualified.nativeSha256 === manifest.assets[name].sha256
      && qualified.sourceSha === receipt.sourceSha, `Qualification changed: ${name}`);
  }
  assert(receipt.qa.tests > 0 && receipt.qa.failures === 0 && receipt.qa.skipped === 0 && receipt.qualifications.length === 4, 'Incomplete seal');
  return { manifest, receipt };
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const directory = resolve(process.argv[2] ?? 'dist/candidate');
  if (process.argv.includes('--verify')) { await verifyCandidate(directory, { metadataOnly: process.argv.includes('--metadata-only') }); console.log('Candidate seal verified'); }
  else {
    assert(run('git', ['status', '--porcelain', '--untracked-files=no']) === '', 'Tracked checkout is dirty');
    const manifest = validateManifest(await readJson(join(directory, 'release-manifest.json'))), sha = sourceSha();
    assert(manifest.sourceSha === sha && manifest.version === await version(), 'Wrong source/version');
    const names = (await readdir(directory)).filter(name => name.endsWith('.tgz')); assert(names.length === 1, 'Expected one source-bound npm package');
    const packageSha256 = await hashFile(join(directory, names[0])), qualifications = [];
    for (const name of assets) {
      const native = await readJson(join(directory, name + '.receipt.json'));
      if (native.platform === 'linux') assert(native.scriptIsolation === true && native.scriptReceiptSha256 === await hashFile(join(directory, name + '.script.json')), `Linux Script qualification missing: ${name}`);
      const qualified = await readJson(join(directory, name.replace('fab-', 'qualification-') + '.json'));
      for (const report of [native, qualified]) {
        assert(report.sourceSha === sha && report.version === manifest.version && report.checks.version && report.checks.help
          && report.checks.readEditTask && report.checks.toolCalls === 2 && report.checks.turns === 3 && report.checks.tuiCommands
          && report.checks.tuiLinkedCatalog && report.checks.tuiRejectedCatalog
          && report.checks.tuiAgentTask && report.checks.tuiRewind && report.checks.mcpList, `Qualification failed: ${name}`);
        if (report.platform === 'linux') assert(report.checks.scriptIsolation && report.checks.scriptTimeout, `Installed Script qualification failed: ${name}`);
      }
      assert(await hashFile(join(directory, name)) === native.sha256 && qualified.nativeSha256 === native.sha256 && qualified.packageSha256 === packageSha256, `Qualification bytes mismatch: ${name}`);
      qualifications.push({ asset: name, receiptSha256: await hashFile(join(directory, name.replace('fab-', 'qualification-') + '.json')) });
    }
    const qa = junit(await readFile(join(directory, 'qa.xml'), 'utf8'));
    const receipt = { schemaVersion: 1, sourceSha: sha, version: manifest.version, tag: manifest.tag,
      package: { filename: names[0], name: (await readJson(resolve('packaging/npm/package.json'))).name, sha256: packageSha256 },
      manifestSha256: await hashFile(join(directory, 'release-manifest.json')), installerSha256: await hashFile(join(directory, 'install.sh')), qa, qualifications,
      run: { id: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null }, createdUtc: new Date().toISOString() };
    await writeJson(join(directory, 'candidate-receipt.json'), receipt); await verifyCandidate(directory); console.log(JSON.stringify(receipt));
  }
}
