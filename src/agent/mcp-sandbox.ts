import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { wrapCommand } from '../sandbox/index.ts';
import type { ToolContext } from './types.ts';

/** MCP programs receive system runtimes, workspace and explicitly configured
 * read paths. The rest of the home, /run and host /tmp are not mounted. */
export async function wrapMcpCommand(command: string, args: string[], env: Record<string, string>, context: ToolContext,
  writable: boolean, allowNetwork: boolean, readPaths: string[] = []) {
  const executable = await realpath(isAbsolute(command) ? command : Bun.which(command, { PATH: env.PATH }) ?? '');
  if (!executable || !(await stat(executable)).isFile()) throw new Error('MCP executable is unavailable');
  // Reuse the verified availability check and environment policy, not its broad filesystem mount.
  const verified = await wrapCommand([executable, ...args], { workdir: context.cwd, mode: 'required', env });
  const paths = new Set<string>();
  for (const path of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ld.so.cache', '/etc/ssl/certs', '/etc/resolv.conf', '/etc/hosts', '/etc/passwd', '/etc/group']) {
    if (await stat(path).then(() => true, () => false)) paths.add(path);
  }
  const configured = [executable, ...readPaths, ...args.filter(a => isAbsolute(a))];
  if (configured.length > 256) throw new Error('MCP read-path limit exceeded');
  for (const path of configured) {
    // Absolute existing file arguments are explicit caller-supplied read capabilities.
    // Missing arguments (e.g. an output filename) do not acquire a mount.
    const absolute = resolve(context.cwd, path);
    if (await stat(absolute).then(() => true, () => false)) paths.add(await realpath(absolute));
  }
  const argv = ['bwrap'];
  for (const path of [...paths].sort((a, b) => a.length - b.length)) argv.push('--ro-bind', path, path);
  argv.push('--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', writable ? '--bind' : '--ro-bind', context.cwd, context.cwd,
    '--chdir', context.cwd, '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session');
  if (!allowNetwork) argv.push('--unshare-net');
  argv.push('--clearenv');
  for (const [key, value] of Object.entries(verified.env)) argv.push('--setenv', key, value);
  argv.push('--', executable, ...args);
  return { argv, env: verified.env };
}
