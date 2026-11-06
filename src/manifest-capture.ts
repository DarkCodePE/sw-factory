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
  // Use the CLI's drainable stdio queues. Bun.write to an fd-backed sink can
  // stop after a partial write when its destination is a native pipe.
  await Promise.all(([[process.stdout, stdout], [process.stderr, stderr]] as const).map(([stream, text]) =>
    new Promise<void>((resolve, reject) => {
      stream.write(text, error => error ? reject(error) : resolve());
    })));

  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);
  return code;
}
if (import.meta.main) process.exit(await captureMain(process.argv.slice(2)));
