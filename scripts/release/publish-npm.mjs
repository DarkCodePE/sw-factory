import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { assert, root, run, sourceSha } from './common.mjs';
import { verifyCandidate } from './seal.mjs';
import { npmPublishEnvironment } from './npm-auth.mjs';

assert(process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_WORKFLOW === 'FAB protected release'
  && process.env.GITHUB_REPOSITORY === 'DarkCodePE/sw-factory', 'npm publication runs only in the protected workflow');
const directory = resolve(root, 'dist/candidate'), { receipt } = await verifyCandidate(directory, { metadataOnly: true });
assert(process.env.GITHUB_SHA === sourceSha() && process.env.GITHUB_REF === `refs/tags/${receipt.tag}`, 'npm tag/source mismatch');
const env = npmPublishEnvironment(process.env);
if (env.NODE_AUTH_TOKEN) {
  // Register the normalized form too: GitHub may have masked only the raw secret.
  process.stdout.write(`::add-mask::${env.NODE_AUTH_TOKEN.replaceAll('%', '%25')}\n`);
  console.log('Using normalized npm publication token.');
} else console.log('Using npm trusted publishing (OIDC).');
const numbers = run('npm', ['--version'], { env }).split('.').map(Number);
assert(numbers[0] > 11 || numbers[0] === 11 && (numbers[1] > 5 || numbers[1] === 5 && numbers[2] >= 1), 'npm >=11.5.1 is required');
let exists = false;
try { exists = run('npm', ['view', `${receipt.package.name}@${receipt.version}`, 'version'], { env }) === receipt.version; }
catch { /* The registry may not contain the version yet; publish reports failures. */ }
if (exists) console.log('Version exists; public byte verification must match the seal.');
else execFileSync('npm', ['publish', join(directory, receipt.package.filename), '--access', 'public', '--tag', receipt.version.includes('-') ? 'next' : 'latest', '--provenance', '--ignore-scripts'], {
  cwd: root, env, stdio: 'inherit',
});
