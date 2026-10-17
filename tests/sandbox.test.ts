// Sandbox contract: never claims isolation it cannot provide, and when bwrap works the wrapped
// command really runs read-only, without network and with a scrubbed environment.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SandboxUnavailableError,
  _setSandboxDetectionForTesting,
  clearSandboxCache,
  detectSandbox,
  wrapCommand,
} from '../src/sandbox/index.ts';

const unavailable = { backend: 'none' as const, available: false, reason: 'test: no bwrap', network: false };

afterEach(() => clearSandboxCache());

async function run(argv: string[], env: Record<string, string>) {
  const p = Bun.spawn(argv, { env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

describe('when the sandbox is unavailable', () => {
  test('best-effort returns the command unchanged and marks it degraded', async () => {
    _setSandboxDetectionForTesting(unavailable);
    const r = await wrapCommand(['echo', 'hi'], { workdir: '/tmp' });
    expect(r).toMatchObject({ argv: ['echo', 'hi'], backend: 'none', degraded: true, reason: 'test: no bwrap' });
  });

  test('required throws with remediation instead of running unisolated', async () => {
    _setSandboxDetectionForTesting(unavailable);
    const err = await wrapCommand(['echo'], { workdir: '/tmp', mode: 'required' }).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxUnavailableError);
    expect(String(err.message)).toContain('apparmor');
  });

  test('rejects empty argv and missing workdir', async () => {
    _setSandboxDetectionForTesting(unavailable);
    await expect(wrapCommand([], { workdir: '/tmp' })).rejects.toThrow();
    await expect(wrapCommand(['true'], { workdir: '' })).rejects.toThrow();
  });
});

describe('with a working bwrap', async () => {
  const probe = await detectSandbox(true);
  const it = probe.available ? test : test.skip;
  let work: string;

  const setup = () => (work = mkdtempSync(join(tmpdir(), 'fab-sbx-')));
  afterEach(() => work && rmSync(work, { recursive: true, force: true }));

  it('the workdir is writable and the rest of the system is read-only', async () => {
    setup();
    const w = await wrapCommand(['sh', '-c', 'echo ok > out.txt; touch /usr/fab-should-fail 2>/dev/null; echo $?'], { workdir: work });
    const r = await run(w.argv, w.env);
    expect(w.degraded).toBe(false);
    expect(readFileSync(join(work, 'out.txt'), 'utf8').trim()).toBe('ok');
    expect(r.out.trim()).not.toBe('0');
    expect(existsSync('/usr/fab-should-fail')).toBe(false);
  });

  it('has no network unless allowNetwork is set', async () => {
    setup();
    const w = await wrapCommand(['sh', '-c', 'cat /proc/net/dev | tail -n +3 | cut -d: -f1 | tr -d " "'], { workdir: work });
    const r = await run(w.argv, w.env);
    expect(r.out.trim().split('\n')).toEqual(['lo']);
  });

  it('only the explicit environment is visible', async () => {
    setup();
    const w = await wrapCommand(['sh', '-c', 'env'], { workdir: work, env: { FOO: 'bar' } });
    const r = await run(w.argv, { ...w.env, FAB_HOST_SECRET: 'leak' });
    expect(r.out).toContain('FOO=bar');
    expect(r.out).toContain(`HOME=${work}`);
    expect(r.out).not.toContain('FAB_HOST_SECRET');
  });

  it('runs in its own PID namespace', async () => {
    setup();
    const w = await wrapCommand(['sh', '-c', 'echo $$'], { workdir: work });
    const r = await run(w.argv, w.env);
    expect(Number(r.out.trim())).toBeLessThan(10);
  });
});
