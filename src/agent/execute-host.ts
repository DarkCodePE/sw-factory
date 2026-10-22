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
export interface ExecuteHostForegroundResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  sandboxed: boolean;
  sandboxReason: string;
  permissionMode: 'yolo';
  network: { requested: boolean; enabled: boolean; access: 'host' };
}

export interface ExecuteBackgroundResult {
  taskId: string;
  pid: number;
  status: 'running';
}

export function executeHost(input: { background: true; [key: string]: unknown }, context: ToolContext): Promise<ExecuteBackgroundResult>;
export function executeHost(input: unknown, context: ToolContext): Promise<ExecuteHostForegroundResult>;
export async function executeHost(input: unknown, context: ToolContext): Promise<any> {
  const command = hostCommand(input);
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('YOLO host execution supports Linux and macOS');
  const p = input as Record<string, unknown>;
  if (p.background === true) {
    if (!context.tasks) throw new Error('Background execution requires task runtime');
    return context.tasks.spawnProcess({
      command,
      argv: ['/bin/sh', '-c', command],
      cwd: context.cwd,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homedir(), TMPDIR: tmpdir() },
      sandboxed: false,
      sandboxReason: 'YOLO: ejecución en el host',
      permissionMode: 'yolo',
      network: { requested: requestsNetwork(input), enabled: true, access: 'host' },
    });
  }
  const result = await runProcess(['/bin/sh', '-c', command], context.cwd,
    { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homedir(), TMPDIR: tmpdir() }, context.signal, 256 * 1024, true);
  return { ...result, sandboxed: false, sandboxReason: 'YOLO: ejecución en el host', permissionMode: 'yolo',
    network: { requested: requestsNetwork(input), enabled: true, access: 'host' } };
}
