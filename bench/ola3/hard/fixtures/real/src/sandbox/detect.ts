import type { SandboxDetectionResult } from './types.ts';

const PROBE_FLAGS = [
  '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
  '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session',
];

let cachedDetectionPromise: Promise<SandboxDetectionResult> | null = null;
let mockDetectionForTesting: SandboxDetectionResult | null = null;

/**
 * Probes the host system to determine whether bubblewrap ('bwrap') is available
 * and functional. Runs an actual minimal container execution ('bwrap ... true')
 * to verify unprivileged user namespaces and filesystem mount permissions.
 */
async function runBwrapProbe(): Promise<SandboxDetectionResult> {
  try {
    // Probe with the same namespace and mount flags wrapCommand uses, so a passing probe means the
    // real invocation will work too (a bare `--ro-bind / / true` can pass while --proc/--unshare-pid fail).
    const probeProc = Bun.spawn(['bwrap', ...PROBE_FLAGS, 'true'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const timeoutMs = 3000;
    const timer = setTimeout(() => {
      try {
        probeProc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, timeoutMs);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(probeProc.stdout).text(),
      new Response(probeProc.stderr).text(),
      probeProc.exited,
    ]);
    clearTimeout(timer);

    if (exitCode === 0) {
      // Basic sandbox works! Check network namespace isolation capability.
      let networkSupported = true;
      try {
        const netProc = Bun.spawn(['bwrap', ...PROBE_FLAGS, '--unshare-net', 'true'], {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const netExit = await netProc.exited;
        if (netExit !== 0) {
          networkSupported = false;
        }
      } catch {
        networkSupported = false;
      }

      return {
        backend: 'bwrap',
        available: true,
        reason: 'bubblewrap is available and functional',
        network: networkSupported,
      };
    }

    // bwrap exited with an error. Provide a precise diagnostic reason.
    const errText = (stderr.trim() || stdout.trim());
    let reason = `bwrap execution failed (exit code ${exitCode}): ${errText || 'unknown error'}`;

    if (errText.includes('setting up uid map: Permission denied') || errText.includes('Permission denied')) {
      let isAppArmorRestricted = false;
      try {
        const sysctlVal = await Bun.file('/proc/sys/kernel/apparmor_restrict_unprivileged_userns').text();
        if (sysctlVal.trim() === '1') {
          isAppArmorRestricted = true;
        }
      } catch {
        // file unreadable or not on Linux
      }

      if (isAppArmorRestricted) {
        reason = 'bwrap failed: setting up uid map: Permission denied (unprivileged user namespaces restricted by AppArmor; kernel.apparmor_restrict_unprivileged_userns=1)';
      } else {
        reason = `bwrap failed: ${errText}`;
      }
    }

    return {
      backend: 'none',
      available: false,
      reason,
      network: false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isNotFound = msg.includes('ENOENT') || msg.includes('Failed to spawn') || msg.includes('not found');
    return {
      backend: 'none',
      available: false,
      reason: isNotFound ? 'bwrap binary not found in PATH' : `bwrap probe failed: ${msg}`,
      network: false,
    };
  }
}

/**
 * Detects sandbox availability. Probes bwrap execution and caches the result.
 *
 * @param forceRefresh When true, bypasses the cache and probes again.
 */
export function detectSandbox(forceRefresh = false): Promise<SandboxDetectionResult> {
  if (mockDetectionForTesting !== null) {
    return Promise.resolve(mockDetectionForTesting);
  }
  if (!cachedDetectionPromise || forceRefresh) {
    cachedDetectionPromise = runBwrapProbe();
  }
  return cachedDetectionPromise;
}

/**
 * Resets the cached detection result. Useful in tests or after applying system remediation.
 */
export function clearSandboxCache(): void {
  cachedDetectionPromise = null;
  mockDetectionForTesting = null;
}

/**
 * Test helper: injects a mock detection result without altering host state.
 */
export function _setSandboxDetectionForTesting(mock: SandboxDetectionResult | null): void {
  mockDetectionForTesting = mock;
  cachedDetectionPromise = null;
}
