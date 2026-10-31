// Egress probe with positive control for native engine sandbox verification.
//
// Verifies whether network isolation (such as bubblewrap --unshare-net) is functional
// before executing network tools or operations.
//
// Positive Control:
// Establishes a local loopback TCP connection and data exchange inside the wrapped command.
// If positive control fails (e.g. broken socket syscalls, broken environment, or crash),
// the probe records positiveControl: false and decided: false, ensuring an unreachable canary
// is never treated as a false negative.
//
// Canary Reachability:
// When positive control passes, attempts to connect to an external canary endpoint.
// In a severed/unshared network, the connect fails with ENETUNREACH/OSError immediately,
// returning reachable: false, decided: true.

import { wrapCommand } from './wrap.ts';
import type { SandboxMode } from './types.ts';

export interface EgressProbeResult {
  reachable: boolean;
  decided: boolean;
  positiveControl: boolean;
  details?: string;
  probedAt: string;
  durationMs: number;
}

export interface EgressProbeOptions {
  workdir?: string;
  allowNetwork?: boolean;
  canaryHost?: string;
  canaryPort?: number;
  timeoutMs?: number;
  mode?: SandboxMode;
  forceFailure?: boolean;
  customRunner?: (
    argv: string[],
    env: Record<string, string>,
    cwd: string
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

let lastEgressProbe: EgressProbeResult | null = null;

export function getLastEgressProbe(): EgressProbeResult | null {
  return lastEgressProbe;
}

export function setLastEgressProbe(probe: EgressProbeResult | null): void {
  lastEgressProbe = probe;
}

export function buildProbeScript(canaryHost: string, canaryPort: number, forceFailure: boolean): string {
  const forceArg = forceFailure ? '1' : '0';
  return `
PYTHON_CODE="import socket, sys
force_fail = sys.argv[1] == '1' if len(sys.argv) > 1 else False
canary_host = sys.argv[2] if len(sys.argv) > 2 else '1.1.1.1'
canary_port = int(sys.argv[3]) if len(sys.argv) > 3 else 80

pos_ok = False
if not force_fail:
    try:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.bind(('127.0.0.1', 0))
        srv.listen(1)
        port = srv.getsockname()[1]
        cli = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        cli.settimeout(2.0)
        cli.connect(('127.0.0.1', port))
        conn, _ = srv.accept()
        cli.sendall(b'probe')
        data = conn.recv(5)
        if data == b'probe':
            pos_ok = True
        cli.close()
        conn.close()
        srv.close()
    except Exception:
        pos_ok = False

if pos_ok:
    print('PROBE positive_control ok')
else:
    print('PROBE positive_control fail')
    sys.exit(2)

try:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(2.0)
    s.connect((canary_host, canary_port))
    s.close()
    print('PROBE canary reachable')
except Exception as e:
    print('PROBE canary unreachable ' + type(e).__name__)
"

NODE_CODE="const net = require('net');
const forceFail = process.argv[2] === '1';
const canaryHost = process.argv[3] || '1.1.1.1';
const canaryPort = parseInt(process.argv[4] || '80', 10);

if (forceFail) {
  console.log('PROBE positive_control fail');
  process.exit(2);
}

const srv = net.createServer((c) => {
  c.on('data', () => { srv.close(); c.end(); });
});
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port;
  const client = net.connect(port, '127.0.0.1', () => {
    client.write('probe');
    client.on('end', () => {
      console.log('PROBE positive_control ok');
      const canary = net.connect(canaryPort, canaryHost, () => {
        console.log('PROBE canary reachable');
        canary.destroy();
      });
      canary.on('error', (e) => {
        console.log('PROBE canary unreachable ' + e.code);
      });
      canary.setTimeout(2000, () => {
        console.log('PROBE canary unreachable timeout');
        canary.destroy();
      });
    });
  });
  client.on('error', (e) => {
    console.log('PROBE positive_control fail ' + e.message);
    process.exit(2);
  });
});
"

if command -v python3 >/dev/null 2>&1; then
  exec python3 -c "$PYTHON_CODE" ${forceArg} "${canaryHost}" ${canaryPort}
elif command -v node >/dev/null 2>&1; then
  exec node -e "$NODE_CODE" ${forceArg} "${canaryHost}" ${canaryPort}
else
  echo "PROBE positive_control fail no_runtime"
  exit 2
fi
`;
}

export async function probeEgress(opts: EgressProbeOptions = {}): Promise<EgressProbeResult> {
  const start = Date.now();
  const workdir = opts.workdir ?? process.cwd();
  const allowNetwork = opts.allowNetwork ?? false;
  const canaryHost = opts.canaryHost ?? '1.1.1.1';
  const canaryPort = opts.canaryPort ?? 80;
  const mode = opts.mode ?? 'best-effort';
  const timeoutMs = opts.timeoutMs ?? 6000;

  const script = buildProbeScript(canaryHost, canaryPort, !!opts.forceFailure);
  const probeArgv = ['/bin/sh', '-c', script];

  const wrapped = await wrapCommand(probeArgv, {
    workdir,
    allowNetwork,
    mode,
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: workdir,
    },
  });

  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  if (opts.customRunner) {
    const res = await opts.customRunner(wrapped.argv, wrapped.env, workdir);
    stdout = res.stdout;
    stderr = res.stderr;
    exitCode = res.exitCode;
  } else {
    const proc = Bun.spawn(wrapped.argv, {
      cwd: workdir,
      env: wrapped.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
    }, timeoutMs);

    const [outText, errText, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    stdout = outText;
    stderr = errText;
    exitCode = code;
  }

  let positiveControl = false;
  let reachable = false;
  let decided = false;
  const lines = (stdout + '\n' + stderr).split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('PROBE positive_control ok')) {
      positiveControl = true;
    } else if (trimmed.startsWith('PROBE positive_control fail')) {
      positiveControl = false;
    } else if (trimmed.startsWith('PROBE canary reachable')) {
      reachable = true;
    } else if (trimmed.startsWith('PROBE canary unreachable')) {
      reachable = false;
    }
  }

  // If positive control passed and we got a clear canary result, it is decided.
  // If positive control failed, we cannot decide whether the boundary is actually closed
  // vs the probe being broken, so decided must be false.
  if (positiveControl && exitCode === 0) {
    decided = true;
  } else {
    decided = false;
    reachable = false;
  }

  const result: EgressProbeResult = {
    reachable: decided ? reachable : false,
    decided,
    positiveControl,
    details: (stdout.trim() || stderr.trim()).slice(0, 500),
    probedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
  };

  setLastEgressProbe(result);
  return result;
}
