import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assert, run, sourceSha } from './common.mjs';
import { collectNative } from './collect-native.mjs';
import { verifyCandidate } from './seal.mjs';
const sha = sourceSha(), repository = 'DarkCodePE/sw-factory';
assert(process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_WORKFLOW === 'FAB protected release' && process.env.GITHUB_REPOSITORY === repository, 'Publication runs only in the protected workflow');
assert(process.env.GITHUB_SHA === sha && process.env.GITHUB_REF?.startsWith('refs/tags/v'), 'Expected exact tagged source');
const runs = JSON.parse(run('gh', ['api', `repos/${repository}/actions/workflows/release-candidate-preflight.yml/runs?head_sha=${sha}&status=completed&per_page=100`]));
const candidate = runs.workflow_runs.find(item => item.head_sha === sha && item.conclusion === 'success' && item.event === 'push'
  && item.head_branch.startsWith('release/') && item.head_repository.full_name === repository);
assert(candidate, 'No successful preflight on this exact source SHA');
const blockers = JSON.parse(run('gh', ['api', `repos/${repository}/issues?state=open&labels=release-blocker&per_page=100`]));
assert(blockers.length === 0, 'Open release-blocker issues prevent publication');
run('gh', ['run', 'download', String(candidate.id), '--repo', repository, '--name', `fab-sealed-${sha}`, '--dir', resolve('dist/candidate')]);
const { manifest } = await verifyCandidate(resolve('dist/candidate'), { metadataOnly: true });
if (!process.argv.includes('--metadata-only')) for (const platform of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']) {
  const temporary = await mkdtemp(join(tmpdir(), 'fab-native-'));
  try {
    run('gh', ['run', 'download', String(candidate.id), '--repo', repository, '--name', `fab-native-${platform}-${sha}`, '--dir', temporary]);
    await collectNative(temporary, resolve('dist/candidate'), `fab-${platform}`, manifest);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ sourceSha: sha, candidateRunId: candidate.id, candidateRunUrl: candidate.html_url }));
