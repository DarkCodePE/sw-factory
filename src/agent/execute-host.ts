import { homedir, tmpdir } from 'node:os';
import { requestsNetwork } from './network-policy.ts';
import { runProcess } from './process.ts';
import type { ToolContext } from './types.ts';

export function hostCommand(input: unknown): string {
  requestsNetwork(input);
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== 'string' || !command.trim() || command.includes('\0') || Buffer.byteLength(command) > 16_384) {
    throw new Error('Execute command must be a nonempty string without NUL, at most 16 KiB');
  }
  return command;
}
export async function executeHost(input: unknown, context: ToolContext) {
  const command = hostCommand(input);
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('YOLO host execution supports Linux and macOS');
  const result = await runProcess(['/bin/sh', '-c', command], context.cwd,
    { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homedir(), TMPDIR: tmpdir() }, context.signal, 256 * 1024, true);
  return { ...result, sandboxed: false, sandboxReason: 'YOLO: ejecución en el host', permissionMode: 'yolo',
    network: { requested: requestsNetwork(input), enabled: true, access: 'host' } };
}
