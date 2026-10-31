import { spawn } from 'node:child_process';

/** Scrubbed environment, bounded output, owned process group and abort cleanup. */
export function runProcess(argv: string[], cwd: string, env: Record<string, string>, signal: AbortSignal,
  maxBytes = 256 * 1024, cleanupOnExit = false, onOutput?: (part: Buffer) => void): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    let bytes = 0, failure: Error | undefined;
    const kill = () => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch (error: any) {
        if (error?.code === 'ESRCH') return;
        if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch { /* Already gone. */ } }
      }
    };
    let drain: ReturnType<typeof setTimeout> | undefined;
    const finishPipes = () => {
      drain ??= setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 100);
    };
    if (cleanupOnExit) child.once('exit', () => { kill(); finishPipes(); });
    const abort = () => { failure = new Error('Agent process aborted'); kill(); if (cleanupOnExit) finishPipes(); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    for (const [stream, parts] of [[child.stdout, out], [child.stderr, err]] as const) stream.on('data', (part: Buffer) => {
      onOutput?.(part);
      bytes += part.length;
      if (bytes > maxBytes) { failure = new Error('Tool process output limit exceeded'); kill(); if (cleanupOnExit) finishPipes(); }
      else parts.push(part);
    });
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      if (drain) clearTimeout(drain);
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), exitCode: code ?? 1 });
    });
  });
}
