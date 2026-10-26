import { setTimeout as sleep } from 'node:timers/promises';
import { run } from './common.mjs';

function isE404(error) {
  if (typeof error?.code === 'string') return error.code === 'E404';
  const outputs = [error?.stdout, error?.stderr, error?.message].map(output => output?.toString() ?? '');
  for (const text of outputs) {
    try {
      const code = JSON.parse(text)?.error?.code;
      if (typeof code === 'string') return code === 'E404';
    } catch { /* npm also emits plain stderr. */ }
  }
  return outputs.some(text => /^\s*(?:npm\s+(?:ERR!|error)\s+(?:code\s+)?)?E404(?:\s|:|$)/m.test(text));
}

/** Retry only the registry's version-not-yet-visible response, within a wall-clock budget. */
export async function npmViewDist(packageName, version, {
  execute = run, wait = sleep, now = () => performance.now(), env = process.env,
} = {}) {
  const interval = Number(env.FAB_NPM_VIEW_RETRY_INTERVAL_MS ?? 15_000);
  const timeout = Number(env.FAB_NPM_VIEW_RETRY_TIMEOUT_MS ?? 300_000);
  if (!Number.isSafeInteger(interval) || interval <= 0 || !Number.isSafeInteger(timeout) || timeout < 0) {
    throw new Error('FAB_NPM_VIEW_RETRY_INTERVAL_MS must be a positive integer and FAB_NPM_VIEW_RETRY_TIMEOUT_MS a nonnegative integer (milliseconds)');
  }
  const spec = `${packageName}@${version}`, deadline = now() + timeout;
  let lastError;
  const expired = () => new Error(`npm registry still returns E404 for ${spec} after ${timeout} ms; version propagation timed out`, { cause: lastError });
  for (;;) {
    if (lastError && now() >= deadline) throw expired();
    try { return await execute('npm', ['view', spec, 'dist', '--json']); }
    catch (error) {
      if (!isE404(error)) throw error;
      lastError = error;
      const remaining = deadline - now();
      if (remaining <= 0) throw expired();
      await wait(Math.min(interval, remaining));
    }
  }
}
