import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore } from '../src/agent/session.ts';

const roots: string[] = [];
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });
const entry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'fab-chat-cli-')); roots.push(dir);
  const cwd = join(dir, 'workspace'), home = join(dir, 'home'); await mkdir(cwd);
  const settings = join(dir, 'settings.json');
  await writeFile(settings, JSON.stringify({ modelId: 'custom:offline', customModels: [{ id: 'custom:offline', model: 'fixture', provider: 'generic-chat-completion-api', baseUrl: 'http://127.0.0.1:9/v1' }] }));
  const run = async (args: string[], input = '/exit\n') => {
    const p = Bun.spawn([process.execPath, '--no-env-file', entry, ...args], { cwd,
      env: { PATH: process.env.PATH ?? '', HOME: home, FABRICA_HOME: home }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    p.stdin.write(input); p.stdin.end();
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, out, err };
  };
  return { cwd, home, settings, run };
}

test('fab tui opens the agent command UI, handles piped lines and keeps settings model', async () => {
  const f = await fixture();
  const r = await f.run(['tui', '--cwd', f.cwd, '--settings', f.settings], '/status\n/tools\n/mode spec\n/exit\n');
  expect(r.code).toBe(0); expect(r.err).toBe(''); expect(r.out).toContain('custom:offline');
  expect(r.out).toContain('Task [execute]'); expect(r.out).toContain('spec · auto off');
});

test('root resume, --resume --last, fork and search operate on local snapshots', async () => {
  const f = await fixture(), store = await SessionStore.create(join(f.home, 'agent-sessions'));
  await store.acquire('saved'); await store.save({ id: 'saved', version: 1, cwd: f.cwd, provider: 'fixture', pending: [],
    messages: [{ role: 'user', content: 'buscar objetivo local' }], status: 'completed', turns: 1, tags: [] }, true); await store.close();
  for (const args of [['resume', 'saved'], ['--resume', '--last'], ['--fork', 'saved']]) {
    const r = await f.run([...args, '--cwd', f.cwd, '--settings', f.settings], '/status\n/exit\n');
    expect(r.code).toBe(0); expect(r.err).toBe(''); expect(r.out).toContain('sesión saved');
  }
  const found = await f.run(['search', 'objetivo local', '--cwd', f.cwd]);
  expect(found.code).toBe(0); expect(found.out).toContain('saved'); expect(found.out).toContain('objetivo local');
});

test('an initial prompt uses the own engine rather than treating the prompt as a directory', async () => {
  const f = await fixture(); let count = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    count++; const body = await req.json() as any;
    expect(body.messages.at(-1).content).toBe('hola agente');
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'respuesta local completa' }, finish_reason: 'stop' }] });
  } });
  await writeFile(f.settings, JSON.stringify({ modelId: 'custom:offline', customModels: [{ id: 'custom:offline', model: 'fixture', provider: 'generic-chat-completion-api', baseUrl: server.url.href + 'v1' }] }));
  try {
    const r = await f.run(['--cwd', f.cwd, '--settings', f.settings, 'hola agente']);
    expect(r.code).toBe(0); expect(r.err).toBe(''); expect(r.out).toContain('respuesta local completa'); expect(count).toBe(1);
  } finally { server.stop(true); }
});

test('CLI validates mission authority and lists MCP without connecting or exposing secrets', async () => {
  const f = await fixture();
  const mission = await f.run(['--mission', '--cwd', f.cwd, '--settings', f.settings]);
  expect(mission.code).toBe(1); expect(mission.err).toContain('--auto high');
  await writeFile(f.settings, JSON.stringify({ mcpServers: { local: { command: 'must-not-run', env: { SECRET: 'never-print-this' } } } }));
  const mcp = await f.run(['mcp', 'list', '--settings', f.settings]);
  expect(mcp.code).toBe(0); expect(mcp.out).toContain('local: configurado'); expect(mcp.out).not.toContain('never-print-this');
  const unsupported = await f.run(['mcp', 'auth', '--settings', f.settings]); expect(unsupported.code).toBe(1);
  const daemon = await f.run(['daemon']); expect(daemon.code).toBe(1); expect(daemon.err).toContain('falta un backend propio');
});
