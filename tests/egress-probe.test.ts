import { describe, expect, test } from 'bun:test';
import {
  probeEgress,
  getLastEgressProbe,
  setLastEgressProbe,
  buildProbeScript,
  type EgressProbeResult,
} from '../src/sandbox/index.ts';

describe('Egress Probe for Native Engine (Task 08)', () => {
  test('probe with severed network returns reachable: false and decided: true with positive control verified', async () => {
    setLastEgressProbe(null);
    const result = await probeEgress({
      allowNetwork: false, // Network severed with bwrap --unshare-net
      canaryHost: '1.1.1.1',
      canaryPort: 80,
    });

    // 1. Positive control MUST succeed, proving the probe environment and loopback socket work
    expect(result.positiveControl).toBe(true);

    // 2. Reachable MUST be false because network is severed
    expect(result.reachable).toBe(false);

    // 3. Decided MUST be true because positive control proved the boundary is verified, not broken
    expect(result.decided).toBe(true);

    // 4. Exposed via getLastEgressProbe()
    const last = getLastEgressProbe();
    expect(last).not.toBeNull();
    expect(last?.reachable).toBe(false);
    expect(last?.decided).toBe(true);
  });

  test('positive control failure prevents false negatives: returns decided: false when probe cannot verify', async () => {
    setLastEgressProbe(null);
    const result = await probeEgress({
      allowNetwork: false,
      forceFailure: true, // Forces positive control self-test failure
      canaryHost: '1.1.1.1',
      canaryPort: 80,
    });

    // When the probe cannot verify, positive control fails
    expect(result.positiveControl).toBe(false);

    // Decided MUST be false because an unverified probe cannot certify a closed boundary
    expect(result.decided).toBe(false);

    // Reachable is false
    expect(result.reachable).toBe(false);

    const last = getLastEgressProbe();
    expect(last?.decided).toBe(false);
    expect(last?.positiveControl).toBe(false);
  });

  test('probe with allowed network returns reachable: true and decided: true when internet is accessible', async () => {
    setLastEgressProbe(null);
    const result = await probeEgress({
      allowNetwork: true, // Network allowed (no --unshare-net)
      canaryHost: '1.1.1.1',
      canaryPort: 80,
    });

    // Positive control passes
    expect(result.positiveControl).toBe(true);

    // Reachable is true when host network is up
    expect(result.reachable).toBe(true);
    expect(result.decided).toBe(true);

    const last = getLastEgressProbe();
    expect(last?.reachable).toBe(true);
    expect(last?.decided).toBe(true);
  });

  test('custom runner simulates severed and open network with positive control', async () => {
    // 1. Simulated severed network
    const severedResult = await probeEgress({
      customRunner: async () => ({
        stdout: 'PROBE positive_control ok\nPROBE canary unreachable ENETUNREACH\n',
        stderr: '',
        exitCode: 0,
      }),
    });
    expect(severedResult.positiveControl).toBe(true);
    expect(severedResult.reachable).toBe(false);
    expect(severedResult.decided).toBe(true);

    // 2. Simulated positive control crash / missing runtime
    const brokenResult = await probeEgress({
      customRunner: async () => ({
        stdout: 'PROBE positive_control fail no_runtime\n',
        stderr: '',
        exitCode: 2,
      }),
    });
    expect(brokenResult.positiveControl).toBe(false);
    expect(brokenResult.decided).toBe(false);
    expect(brokenResult.reachable).toBe(false);

    // 3. Simulated open network
    const openResult = await probeEgress({
      customRunner: async () => ({
        stdout: 'PROBE positive_control ok\nPROBE canary reachable\n',
        stderr: '',
        exitCode: 0,
      }),
    });
    expect(openResult.positiveControl).toBe(true);
    expect(openResult.reachable).toBe(true);
    expect(openResult.decided).toBe(true);
  });

  test('buildProbeScript generates valid self-contained script with python and node fallbacks', () => {
    const script = buildProbeScript('1.1.1.1', 80, false);
    expect(script).toContain('PYTHON_CODE');
    expect(script).toContain('NODE_CODE');
    expect(script).toContain('PROBE positive_control ok');
    expect(script).toContain('PROBE canary reachable');
  });
});
