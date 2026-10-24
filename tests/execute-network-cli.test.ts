import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
test('exec CLI propagates network policy, high auto authorizes, and batch ask never waits or silently runs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'fab-network-cli-')); dirs.push(cwd);
  const nested = join(cwd, 'nested'); await mkdir(nested);
  const script = 'process.stdout.write(process.env.JIRA_ENV_FILE + ":" + process.cwd())';
  const command = `cd ${quote(nested)} && export JIRA_ENV_FILE=cli-fixture && ${quote(process.execPath)} -e ${quote(script)}`;
  let turn = 0, seen: any, firstRequest: any;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json() as any;
    if (!firstRequest) firstRequest = body;
    if (++turn % 2 === 0) seen = body.messages.findLast((m: any) => m.role === 'tool');
    return Response.json({ choices: [{ message: turn % 2 ? { role: 'assistant', content: null, tool_calls: [{ id: `cli-${turn}`, type: 'function', function: { name: 'Execute', arguments: JSON.stringify({ command, network: true }) } }] } : { role: 'assistant', content: 'fixture complete' }, finish_reason: turn % 2 ? 'tool_calls' : 'stop' }] });
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
    expect(JSON.parse(seen.content).stdout).toBe(`cli-fixture:${nested}`);
    const system = firstRequest.messages.find((m: any) => m.role === 'system')?.content ?? '';
    expect(system).toContain('Network access is per Execute call');
    expect(system).toContain('set network: true on every command that needs it');
    const execute = firstRequest.tools.find((t: any) => t.function.name === 'Execute');
    expect(execute.function.description).toContain('network:true on every command that needs it');
    expect(execute.function.parameters.properties.network.description).toContain('per Execute call');
    expect((await run('ask')).code).toBe(0); expect(seen.content).toContain('network approval required');
    expect((await run('deny')).code).toBe(0); expect(seen.content).toContain('denied by policy');
    const bad = await run('allow'); expect(bad.code).toBe(1); expect(bad.stderr).toContain('Network policy');
  } finally { server.stop(true); }
});
