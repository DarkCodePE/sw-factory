import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function platformAsset(platform = process.platform, arch = process.arch) {
  if (!['linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch))
    throw new Error(`FAB no publica binarios para ${platform}/${arch}; en Windows utiliza WSL.`);
  return `fab-${platform}-${arch}`;
}
export function validateManifest(manifest) {
  if (manifest.schemaVersion !== 1 || !/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/.test(manifest.version)
    || manifest.tag !== `v${manifest.version}` || !/^[a-f0-9]{40}$/.test(manifest.sourceSha)) throw new Error('Manifest de release inválido');
  for (const os of ['linux', 'darwin']) for (const arch of ['x64', 'arm64']) {
    const name = platformAsset(os, arch), asset = manifest.assets?.[name];
    if (!asset || asset.filename !== name || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > 512 * 1024 * 1024) throw new Error(`Artefacto inválido: ${name}`);
  }
  return manifest;
}
export function binaryPath(manifest, name, home = homedir()) {
  return join(home, '.cache', 'fab', manifest.version, manifest.assets[name].sha256, name);
}
async function download(url, signal, fetcher) {
  for (let redirects = 0; redirects <= 5; redirects++) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !(target.hostname === 'github.com' || target.hostname.endsWith('.githubusercontent.com')))
      throw new Error('Redirección de descarga fuera de GitHub HTTPS');
    const response = await fetcher(target, { signal, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) throw new Error('Redirección sin destino');
      url = new URL(location, target).href; continue;
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Descarga de FAB falló: HTTP ${response.status}`); }
    return response;
  }
  throw new Error('Demasiadas redirecciones');
}
export async function ensureBinary({ manifest, home = homedir(), platform = process.platform, arch = process.arch, fetcher = fetch } = {}) {
  manifest ??= JSON.parse(await readFile(new URL('./release-manifest.json', import.meta.url), 'utf8'));
  validateManifest(manifest);
  const name = platformAsset(platform, arch), expected = manifest.assets[name], target = binaryPath(manifest, name, home);
  // Revalidate cached bytes, including installations made with --ignore-scripts.
  try { if ((await stat(target)).size === expected.bytes && await digest(target) === expected.sha256) return target; } catch { /* Download below. */ }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`, hash = createHash('sha256'); let size = 0;
  try {
    const response = await download(`https://github.com/DarkCodePE/sw-factory/releases/download/${manifest.tag}/${name}`, AbortSignal.timeout(180_000), fetcher);
    await writeFile(temporary, '', { flag: 'wx', mode: 0o700 });
    const { open } = await import('node:fs/promises'), file = await open(temporary, 'a');
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > expected.bytes) throw new Error('Artefacto supera el tamaño sellado');
        hash.update(chunk); await file.writeFile(chunk);
      }
    } finally { await file.close(); }
    if (size !== expected.bytes || hash.digest('hex') !== expected.sha256) throw new Error('Checksum SHA-256 incorrecto; no se ejecutó el artefacto');
    await rename(temporary, target); return target;
  } finally { await rm(temporary, { force: true }); }
}
