// Runs inside runAgent's existing process group: descendants remain abortable.
import { atomicEvidence } from './manifest.ts';

export async function captureMain(args: string[]): Promise<number> {
  const [path, ...command] = args;
  if (!path || !command.length) throw new Error('capture requires log path and command');
  // The group receives SIGTERM together. Keep the recorder alive until child pipes
  // close so a canceled activity retains output already emitted by the agent.
  const onSignal = () => {};
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  const proc = Bun.spawn(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  // Each attempt is complete, including stderr even when stdout is nonempty.
  const { readFileSync, existsSync } = await import('node:fs');
  atomicEvidence(path, (existsSync(path) ? readFileSync(path, 'utf8') : '') + stdout + (stderr ? '\n[stderr]\n' + stderr : ''));
  await Bun.write(Bun.stdout, stdout);
  await Bun.write(Bun.stderr, stderr);
  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);
  return code;
}
if (import.meta.main) process.exit(await captureMain(process.argv.slice(2)));
