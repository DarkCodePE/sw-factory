import path from 'node:path';
import fs from 'node:fs';
import { detectSandbox } from './detect.ts';
import {
  SandboxUnavailableError,
  type WrapCommandOptions,
  type WrapCommandResult,
} from './types.ts';

/**
 * Wraps an execution command with bubblewrap sandbox isolation when available.
 *
 * Isolation guarantees (bwrap):
 * - Read-only system root: --ro-bind / /
 * - Device and proc filesystem mounts: --dev /dev --proc /proc
 * - Private in-memory /tmp: --tmpfs /tmp
 * - Writable workdir: --bind <workdir> <workdir> (and --chdir <workdir>)
 * - Additional writable or read-only paths if specified
 * - Namespaces and process lifecycle: --unshare-pid --unshare-ipc --unshare-uts --die-with-parent --new-session
 * - Network isolation: --unshare-net unless opts.allowNetwork is true
 * - Environment scrubbing: --clearenv with explicit environment (PATH, HOME=workdir, plus opts.env)
 *
 * Fallback behavior:
 * - If sandbox is unavailable:
 *   - mode: 'required' -> Throws SandboxUnavailableError with exact remediation steps.
 *   - mode: 'best-effort' (default) -> Returns unwrapped argv with degraded: true and diagnostic reason.
 *   - Never fakes isolation.
 */
export async function wrapCommand(
  argv: string[],
  opts: WrapCommandOptions
): Promise<WrapCommandResult> {
  if (!argv || argv.length === 0 || !argv[0]) {
    throw new Error("wrapCommand: 'argv' must contain at least one element");
  }
  if (!opts || !opts.workdir) {
    throw new Error("wrapCommand: 'opts.workdir' is required");
  }

  const mode = opts.mode ?? 'best-effort';
  const detection = await detectSandbox();

  if (!detection.available || detection.backend !== 'bwrap') {
    if (mode === 'required') {
      throw new SandboxUnavailableError(detection.reason);
    }
    // Best-effort mode: return unwrapped command. Never fake isolation.
    return {
      argv: [...argv],
      env: { ...(opts.env ?? {}) },
      backend: 'none',
      degraded: true,
      reason: detection.reason,
    };
  }

  // Bubblewrap is verified to be available and functional.
  const resolvedWorkdir = path.resolve(opts.workdir);

  // Ensure workdir exists on host if it does not already
  if (!fs.existsSync(resolvedWorkdir)) {
    try {
      fs.mkdirSync(resolvedWorkdir, { recursive: true });
    } catch {
      // ignore
    }
  }

  const bwrapArgs: string[] = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--bind', resolvedWorkdir, resolvedWorkdir,
    '--chdir', resolvedWorkdir,
  ];

  // Additional writable paths
  if (opts.writablePaths && opts.writablePaths.length > 0) {
    for (const p of opts.writablePaths) {
      const absPath = path.resolve(p);
      if (absPath !== resolvedWorkdir) {
        bwrapArgs.push('--bind', absPath, absPath);
      }
    }
  }

  // Additional read-only paths
  if (opts.readOnlyPaths && opts.readOnlyPaths.length > 0) {
    for (const p of opts.readOnlyPaths) {
      const absPath = path.resolve(p);
      bwrapArgs.push('--ro-bind', absPath, absPath);
    }
  }

  // Namespaces and session lifecycle
  bwrapArgs.push(
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--die-with-parent',
    '--new-session'
  );

  // Network isolation (unless explicitly allowed)
  if (!opts.allowNetwork) {
    bwrapArgs.push('--unshare-net');
  }

  // Environment isolation: --clearenv with explicit variables
  bwrapArgs.push('--clearenv');

  const pathEnv = opts.env?.PATH ?? process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  const homeEnv = opts.env?.HOME ?? resolvedWorkdir;

  const finalEnv: Record<string, string> = {
    PATH: pathEnv,
    HOME: homeEnv,
    ...(opts.env ?? {}),
  };

  // Ensure HOME is set to workdir as mandated by Rule (1) unless explicitly provided
  if (!opts.env?.HOME) {
    finalEnv.HOME = resolvedWorkdir;
  }

  for (const [key, value] of Object.entries(finalEnv)) {
    bwrapArgs.push('--setenv', key, value);
  }

  bwrapArgs.push('--', ...argv);

  return {
    argv: ['bwrap', ...bwrapArgs],
    env: finalEnv,
    backend: 'bwrap',
    degraded: false,
    reason: 'bubblewrap sandbox active',
  };
}
