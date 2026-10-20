import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assets, assert, hashFile, run, sourceSha, writeJson } from './common.mjs';
import { verifyCandidate } from './seal.mjs';
const repository = 'DarkCodePE/sw-factory', directory = resolve('dist/candidate');
assert(process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_WORKFLOW === 'FAB protected release' && process.env.GITHUB_REPOSITORY === repository, 'Local publication is forbidden');
const { receipt } = await verifyCandidate(directory);
assert(process.env.GITHUB_SHA === sourceSha() && process.env.GITHUB_REF === `refs/tags/${receipt.tag}`, 'Tag/source mismatch');
const prerelease = receipt.version.includes('-');
if (!prerelease) {
  const main = JSON.parse(run('gh', ['api', `repos/${repository}/branches/main`]));
  assert(main.commit.sha === receipt.sourceSha, 'Stable publication requires exact main SHA');
}
const files = [...assets.flatMap(name => [name, name + '.sha256']), 'install.sh', 'latest.sh', 'prerelease.sh', 'release-manifest.json', 'candidate-receipt.json', receipt.package.filename, receipt.package.filename + '.sha256'];
let existing;
try { existing = JSON.parse(run('gh', ['release', 'view', receipt.tag, '--repo', repository, '--json', 'targetCommitish,isDraft,assets'])); }
catch (error) { assert(error.status === 1 && /(?:not found|HTTP 404)/i.test(String(error.stderr)), 'Failed to inspect existing release'); }
if (existing) {
  assert(existing.targetCommitish === receipt.sourceSha && existing.assets.every(asset => files.includes(asset.name)), 'Existing release has a different source or inventory');
  for (const name of files) if (!existing.assets.some(asset => asset.name === name)) {
    assert(existing.isDraft, 'Public release inventory is immutable');
    run('gh', ['release', 'upload', receipt.tag, join(directory, name), '--repo', repository]);
  }
} else {
  run('gh', ['release', 'create', receipt.tag, ...files.map(name => join(directory, name)), '--repo', repository, '--target', receipt.sourceSha,
    '--draft', ...(prerelease ? ['--prerelease'] : []), '--title', `FAB ${receipt.version}`, '--notes', `Source: ${receipt.sourceSha}\nCandidate and per-platform qualification receipts bind the exact published bytes. macOS has no tool sandbox equivalent; Linux isolation requires bubblewrap.`]);
}
const check = resolve('dist/github-byte-check'); await mkdir(check, { recursive: true });
run('gh', ['release', 'download', receipt.tag, '--repo', repository, '--dir', check]);
for (const name of files) assert(await hashFile(join(check, name)) === await hashFile(join(directory, name)), `Uploaded bytes differ: ${name}`);
if (!existing || existing.isDraft) run('gh', ['release', 'edit', receipt.tag, '--repo', repository, '--draft=false']);
await writeJson(resolve('dist/github-publication.json'), { sourceSha: receipt.sourceSha, version: receipt.version, tag: receipt.tag, url: `https://github.com/${repository}/releases/tag/${receipt.tag}`, inventoryVerified: files, status: 'published; public-install qualification follows' });
console.log(`GitHub release bytes verified: ${receipt.tag}`);
