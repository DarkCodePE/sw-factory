import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseVersion, compareVersions, type Channel } from './version.ts';
import { runOwnedCommand } from './process.ts';

export type UpdateFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;
export interface NpmUpdateOptions {
  packageRoot: string; executable: string; current: string; channel: Channel; pin?: string; check: boolean;
  home: string; temporary: string; env: Record<string, string>; signal: AbortSignal;
  fetcher?: UpdateFetch; run?: typeof runOwnedCommand; log: (text: string) => void;
}
async function untilAborted<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void task.catch(() => {}); throw signal.reason; }
  let stop: (() => void) | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true });
    })]);
  } finally { if (stop) signal.removeEventListener('abort', stop); }
}
async function bounded(response: Response, limit: number, signal: AbortSignal) {
  if (!response.ok || !response.body) throw new Error(`Registro npm no disponible: HTTP ${response.status}`);
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted(); const next = await untilAborted(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new Error('La respuesta npm supera el límite de bytes');
      chunks.push(next.value);
    }
  } finally { void reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
export async function updateNpm(options: NpmUpdateOptions) {
  const root = await realpath(options.packageRoot), modules = dirname(dirname(root)), lib = dirname(modules), prefix = dirname(lib);
  if (basename(modules) !== 'node_modules' || basename(lib) !== 'lib' || root !== join(prefix, 'lib/node_modules/@okuanb/fab'))
    throw new Error('Esta instalación npm no es global; actualízala con su gestor de paquetes.');
  const packageFile = join(root, 'package.json'), manifestFile = join(root, 'release-manifest.json');
  for (const path of [packageFile, manifestFile]) { const info = await stat(path); if (!info.isFile() || info.size > 65536) throw new Error('Identidad npm inválida'); }
  const pkg = JSON.parse(await readFile(packageFile, 'utf8')), manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const name = `fab-${process.platform}-${process.arch}`, digest = manifest.assets?.[name]?.sha256;
  if (pkg.name !== '@okuanb/fab' || pkg.version !== options.current || manifest.version !== options.current || !/^[a-f0-9]{64}$/.test(digest ?? ''))
    throw new Error('La identidad del paquete npm no coincide con este FAB');
  const expected = join(options.home, '.cache/fab', options.current, digest, name);
  if (await realpath(options.executable) !== await realpath(expected)) throw new Error('El paquete npm no corresponde al ejecutable actual');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(expected, { signal: options.signal })) hash.update(chunk);
  if (hash.digest('hex') !== digest) throw new Error('El ejecutable actual no coincide con el manifest npm');
  const fetcher = options.fetcher ?? fetch;
  const request = (url: string | URL) => untilAborted(fetcher(url, { signal: options.signal, redirect: 'error' }), options.signal);
  const response = await request('https://registry.npmjs.org/@okuanb%2ffab');
  const index = JSON.parse((await bounded(response, 8 * 1024 * 1024, options.signal)).toString('utf8'));
  const candidate = options.pin ?? index['dist-tags']?.[options.channel === 'stable' ? 'latest' : 'next'];
  if (typeof candidate !== 'string') throw new Error(`No hay versión npm para el canal ${options.channel}`);
  const parsed = parseVersion(candidate);
  if (!options.pin && options.channel === 'stable' && parsed.pre.length) throw new Error('npm latest contiene una prerelease; usa --channel prerelease hasta que exista una estable');
  const metadata = index.versions?.[parsed.value];
  if (metadata?.name !== '@okuanb/fab' || metadata.version !== parsed.value) throw new Error('Identidad de la versión npm inválida');
  const url = new URL(metadata.dist?.tarball);
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.port || url.username || url.password || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(metadata.dist?.integrity ?? ''))
    throw new Error('Origen o integridad de paquete npm inválidos');
  if (!options.pin && compareVersions(parsed.value, options.current) < 0) throw new Error('La versión instalada es más nueva; usa --version para un rollback explícito');
  options.log(`FAB ${options.current} → ${parsed.value} · npm · canal ${options.channel}`);
  if (options.check || parsed.value === options.current) return 0;
  const archive = await bounded(await request(url), 16 * 1024 * 1024, options.signal);
  if (`sha512-${createHash('sha512').update(archive).digest('base64')}` !== metadata.dist.integrity) throw new Error('La integridad del tarball npm no coincide; no se instaló');
  const tarball = join(options.temporary, 'fab.tgz'), userconfig = join(options.temporary, 'user.npmrc'), globalconfig = join(options.temporary, 'global.npmrc');
  await writeFile(tarball, archive, { flag: 'wx', mode: 0o600 }); await writeFile(userconfig, ''); await writeFile(globalconfig, '');
  const code = await (options.run ?? runOwnedCommand)(['npm', 'install', '--global', '--prefix', prefix, '--registry=https://registry.npmjs.org', '--userconfig', userconfig, '--globalconfig', globalconfig, '--no-audit', '--no-fund', tarball], { env: options.env, signal: options.signal });
  if (code !== 0) throw new Error(`npm terminó con código ${code}; revisa la instalación con npm`);
  const installed = JSON.parse(await readFile(packageFile, 'utf8'));
  if (installed.name !== '@okuanb/fab' || installed.version !== parsed.value) throw new Error('npm no instaló la versión solicitada; revisa el prefix indicado');
  return 0;
}
