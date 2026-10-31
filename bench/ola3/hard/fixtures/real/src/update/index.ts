import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import installer from '../../scripts/install.sh' with { type: 'text' };
import pkg from '../../package.json' with { type: 'json' };
import { isCompiled } from '../self.ts';
import { parseVersion, updateChannel } from './version.ts';
import { runOwnedCommand } from './process.ts';
import { updateNpm, type UpdateFetch } from './npm.ts';

export interface UpdateContext {
  version?: string; executable?: string; compiled?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number;
  fetcher?: UpdateFetch; run?: typeof runOwnedCommand; log?: (text: string) => void; error?: (text: string) => void;
}
export async function updateMain(argv: string[], context: UpdateContext = {}): Promise<number> {
  const log = context.log ?? console.log, report = context.error ?? console.error;
  let temporary: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const { values } = parseArgs({ args: argv, allowPositionals: false, options: { channel: { type: 'string' }, version: { type: 'string' }, check: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
    if (values.help) {
      log('fab update [--channel stable|prerelease] [--version VERSION] [--check]\nActualiza la instalación actual. Sin canal explícito conserva stable/prerelease según la versión instalada.\n--check consulta sin instalar. El binario independiente requiere curl y python3; npm conserva su prefix global.');
      return 0;
    }
    const current = context.version ?? pkg.version, inherited = context.env ?? process.env;
    const channel = updateChannel(current, values.channel ?? inherited.FAB_CHANNEL), pin = values.version ? parseVersion(values.version).value : undefined;
    const compiled = context.compiled ?? isCompiled(), executable = context.executable ?? process.execPath;
    if (!compiled && !inherited.FAB_NPM_PACKAGE_ROOT && !values.check) throw new Error('FAB se está ejecutando desde código fuente; no se reemplaza Bun. Instala un binario de release o usa --check.');
    if (!inherited.FAB_NPM_PACKAGE_ROOT && !values.check && basename(executable) !== 'fab') throw new Error('Instala el binario independiente como fab antes de actualizarlo; no se reemplazan otros ejecutables.');
    const deadline = context.timeoutMs ?? 300_000;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 600_000) throw new Error('Timeout de actualización inválido');
    const controller = new AbortController(); timer = setTimeout(() => controller.abort(new Error('Tiempo total de actualización agotado')), deadline);
    cancel = () => controller.abort(new Error('Actualización cancelada'));
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    temporary = await mkdtemp(join(tmpdir(), 'fab-update-'));
    const home = inherited.HOME ?? homedir(), env = { PATH: inherited.PATH ?? '', HOME: home, TMPDIR: temporary };
    if (inherited.FAB_NPM_PACKAGE_ROOT) return await updateNpm({ packageRoot: inherited.FAB_NPM_PACKAGE_ROOT, executable, current, channel, pin, check: !!values.check, home, temporary, env, signal: controller.signal, fetcher: context.fetcher, run: context.run, log });
    const destination = dirname(await realpath(executable));
    const args = ['sh', '-s', '--', '--channel', channel, '--current-version', current, '--install-dir', destination, ...(pin ? ['--version', pin] : []), ...(values.check ? ['--check'] : [])];
    log(`Consultando FAB · canal ${channel}`);
    const code = await (context.run ?? runOwnedCommand)(args, { env, input: installer, signal: controller.signal });
    if (code !== 0) throw new Error(`El instalador terminó con código ${code}; no se completó la actualización.`);
    return 0;
  } catch (error) { report(`fab update: ${error instanceof Error ? error.message : 'actualización fallida'}`); return 1; }
  finally {
    if (timer) clearTimeout(timer);
    if (cancel) { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
