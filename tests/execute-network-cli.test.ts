import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
test('exec CLI propagates network policy, high auto authorizes, and batch ask never waits or silently runs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'fab-network-cli-')); dirs.push(cwd);
  let turn = 0, seen: any;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json() as any;
    if (++turn % 2 === 0) seen = body.messages.findLast((m: any) => m.role === 'tool');
    return Response.json({ choices: [{ message: turn % 2 ? { role: 'assistant', content: null, tool_calls: [{ id: `cli-${turn}`, type: 'function', function: { name: 'Execute', arguments: JSON.stringify({ command: 'pwd', network: true }) } }] } : { role: 'assistant', content: 'fixture complete' }, finish_reason: turn % 2 ? 'tool_calls' : 'stop' }] });
  } });
  const run = async (policy: string) => {
    const child = Bun.spawn([process.execPath, 'src/cli.ts', 'exec', '--cwd', cwd, '--session-dir', join(cwd, 'sessions'), '--auto', 'high', '--sandbox-network', policy,
      '--base-url', server.url.href + 'v1', '-m', 'fixture', '-o', 'json', '--timeout-ms', '5000', 'network test'],
    { env: { PATH: process.env.PATH ?? '', HOME: cwd }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };
  try {
    expect((await run('auto')).code).toBe(0); expect(JSON.parse(seen.content).network.enabled).toBe(true);
    expect((await run('ask')).code).toBe(0); expect(seen.content).toContain('network approval required');
    expect((await run('deny')).code).toBe(0); expect(seen.content).toContain('denied by policy');
    const bad = await run('allow'); expect(bad.code).toBe(1); expect(bad.stderr).toContain('Network policy');
  } finally { server.stop(true); }
});
