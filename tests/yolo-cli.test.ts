import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'fab-yolo-cli-')); roots.push(cwd);
  const run = async (args: string[], input = '') => {
    const child = Bun.spawn([process.execPath, 'src/cli.ts', ...args], { env: { PATH: process.env.PATH ?? '', HOME: cwd, FABRICA_HOME: cwd }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    child.stdin.write(input); child.stdin.end();
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, out, err };
  };
  return { cwd, run };
}
test('public entrypoints reject YOLO conflicts before provider work; settings network can be explicitly overridden', async () => {
  const { cwd, run } = await fixture();
  for (const entry of [[], ['tui'], ['exec']]) for (const conflict of [['--auto', 'off'], ['--auto', 'low'], ['--auto', 'medium'], ['--sandbox', 'required'], ['--sandbox', 'best-effort'], ['--use-spec'], ['--sandbox-network', 'deny'], ['--sandbox-network', 'ask']]) {
    const r = await run([...entry, '--yolo', ...conflict]); expect(r.code).toBe(1); expect(r.err).toContain('conflicts');
  }
  const settings = join(cwd, 'settings.json'); await writeFile(settings, JSON.stringify({ sandboxNetwork: 'deny' }));
  expect((await run(['exec', '--yolo', '--settings', settings, '--list-tools'])).err).toContain('--sandbox-network auto');
  const allowed = await run(['exec', '--yolo', '--settings', settings, '--sandbox-network', 'auto', '--list-tools', '-o', 'json']);
  expect(allowed.code).toBe(0); const tools = JSON.parse(allowed.out);
  expect(tools.find((t: any) => t.llmId === 'Execute')).toMatchObject({ currentlyAllowed: true, executionPolicy: { permissionMode: 'yolo' } });
  const dashboard = await run(['tui', 'some-workstream', '--yolo']); expect(dashboard.code).not.toBe(0);
});
test('RPC CLI announces YOLO only on stderr and keeps NDJSON stdout parseable', async () => {
  const { run } = await fixture();
  const frame = (id: string, method: string, params = {}) => JSON.stringify({ jsonrpc: '2.0', type: 'request', id, method: 'droid.' + method, params }) + '\n';
  const r = await run(['exec', '--yolo', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc'],
    frame('init', 'initialize_session', { machineId: 'local' }) + frame('close', 'close_session'));
  expect(r.code).toBe(0); expect(r.err).toContain('YOLO');
  const frames = r.out.trim().split('\n').map(s => JSON.parse(s));
  expect(frames.find(f => f.id === 'init').result.settings.fab_execution_policy.permissionMode).toBe('yolo');
});
