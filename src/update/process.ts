export interface CommandOptions { env: Record<string, string>; signal: AbortSignal; input?: string }
export async function runOwnedCommand(argv: string[], options: CommandOptions): Promise<number> {
  options.signal.throwIfAborted();
  const child = Bun.spawn(argv, { env: options.env, stdin: 'pipe', stdout: 'inherit', stderr: 'inherit', detached: true });
  let force: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: 'SIGTERM' | 'SIGKILL') => {
    try { process.kill(-child.pid, signal); }
    catch { try { child.kill(signal); } catch { /* Already exited. */ } }
  };
  const stop = () => {
    kill('SIGTERM');
    force = setTimeout(() => kill('SIGKILL'), 200);
  };
  options.signal.addEventListener('abort', stop, { once: true });
  try {
    if (options.input) child.stdin.write(options.input);
    child.stdin.end();
    if (options.signal.aborted) stop();
    const code = await child.exited;
    options.signal.throwIfAborted();
    return code;
  } finally {
    options.signal.removeEventListener('abort', stop);
    if (force) clearTimeout(force);
    if (options.signal.aborted) kill('SIGKILL');
  }
}
