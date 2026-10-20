import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const policy = '  FAB_INSTALLER_MODE=source\n  FAB_INSTALLER_VERSION=';
export function renderInstaller(source, mode, version = '') {
  if (!['pinned', 'stable', 'prerelease'].includes(mode) || source.split(policy).length !== 2)
    throw new Error('Invalid installer policy template');
  if (mode === 'pinned' && !/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/.test(version)) throw new Error('Invalid installer version');
  return source.replace(policy, `  FAB_INSTALLER_MODE=${mode}\n  FAB_INSTALLER_VERSION=${mode === 'pinned' ? `v${version}` : ''}`);
}
export async function buildInstallers(directory, version) {
  const source = await readFile(new URL('../install.sh', import.meta.url), 'utf8');
  await mkdir(directory, { recursive: true });
  for (const [name, mode] of [['install.sh', 'pinned'], ['latest.sh', 'stable'], ['prerelease.sh', 'prerelease']])
    await writeFile(join(directory, name), renderInstaller(source, mode, version), { mode: 0o755 });
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename)
  await buildInstallers(resolve(process.argv[2]), process.argv[3]);
