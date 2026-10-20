// Exercise the compiled updater against an offline release, without touching the user's installation.
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { assert, hashFile, readJson, sourceSha, version, writeJson } from './common.mjs';

export async function probeUpdate(binary, current) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fab-update-proof-')));
  try {
    const bin = join(root, 'live bin'), helpers = join(root, 'helpers'), home = join(root, 'home');
    await Promise.all([bin, helpers, home].map(path => mkdir(path)));
    const live = join(bin, 'fab'), asset = `fab-${process.platform}-${process.arch}`;
    await copyFile(binary, live); await chmod(live, 0o755);
    const before = await hashFile(live), next = `${BigInt(current.split('.')[0]) + 1n}.0.0-rc.1`;
    const payload = `#!/bin/sh\nprintf '%s\\n' 'fab ${next}'\n`;
    const digest = createHash('sha256').update(payload).digest('hex');
    const names = ['install.sh', 'release-manifest.json', 'candidate-receipt.json'];
    for (const os of ['linux', 'darwin']) for (const arch of ['x64', 'arm64']) names.push(`fab-${os}-${arch}`, `fab-${os}-${arch}.sha256`);
    const release = { tag_name: `v${next}`, draft: false, prerelease: true, assets: names.map((name, i) => ({ name, id: i + 1, size: 1 })) };
    const mode = join(root, 'mode'); await writeFile(mode, 'corrupt');
    await writeFile(join(helpers, 'curl'), `#!${process.execPath}\n` +
      `const fs = require('node:fs'); const args = process.argv.slice(2), url = args.at(-1), output = args[args.indexOf('--output') + 1];\n` +
      `if (!output) process.exit(2); let body;\n` +
      `if (url.startsWith('https://api.github.com/repos/DarkCodePE/sw-factory/releases?')) body = ${JSON.stringify(JSON.stringify([release]))};\n` +
      `else if (url.endsWith('/${asset}.sha256')) body = (fs.readFileSync(${JSON.stringify(mode)}, 'utf8') === 'corrupt' ? '0'.repeat(64) : ${JSON.stringify(digest)}) + '  ${asset}\\n';\n` +
      `else if (url.endsWith('/${asset}')) body = ${JSON.stringify(payload)};\n` +
      `else process.exit(3); fs.writeFileSync(output, body);\n`, { mode: 0o755 });
    const execute = args => new Promise((resolve, reject) => {
      const child = spawn(live, args, { cwd: root, env: { PATH: `${helpers}:${process.env.PATH ?? ''}`, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err }); });
    });
    const failed = await execute(['update', '--channel', 'prerelease']);
    assert(failed.code !== 0 && failed.err.includes('Checksum SHA-256 incorrecto') && await hashFile(live) === before, `Compiled update did not preserve the original on corruption: ${failed.err}`);
    const check = await execute(['update', '--channel', 'prerelease', '--check']);
    assert(check.code === 0 && check.out.includes(`v${next}`) && await hashFile(live) === before, `Compiled check mutated the executable: ${check.err}`);
    await writeFile(mode, 'valid');
    const updated = await execute(['update', '--channel', 'prerelease']);
    assert(updated.code === 0 && await readFile(live, 'utf8') === payload && await hashFile(live) === digest, `Compiled updater did not replace its own executable: ${updated.err}`);
    const installed = await execute(['--version']);
    assert(installed.code === 0 && installed.out.trim() === `fab ${next}`, 'Updated executable did not run');
    return { corruptPreservesOriginal: true, checkPreservesOriginal: true, replacesExecutable: true, installedVersion: next };
  } finally { await rm(root, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const binary = resolve(process.argv[2]), receiptPath = resolve(process.argv[3]);
  const receipt = await readJson(receiptPath), current = await version();
  assert(receipt.sourceSha === sourceSha() && receipt.version === current && receipt.sha256 === await hashFile(binary), 'Updater probe must bind the existing native receipt');
  receipt.standaloneUpdate = await probeUpdate(binary, current);
  receipt.checks.standaloneUpdate = true;
  await writeJson(receiptPath, receipt); console.log(JSON.stringify(receipt.standaloneUpdate));
}
