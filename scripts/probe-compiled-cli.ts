// Offline artifact check: a synthetic local provider drives Script in the compiled binary.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binary = resolve(process.argv[2] ?? 'dist/fab');
const hash = new Bun.CryptoHasher('sha256').update(await Bun.file(binary).arrayBuffer()).digest('hex');
const root = await mkdtemp(join(tmpdir(), 'fab-compiled-probe-'));
const cwd = join(root, 'workspace'), home = join(root, 'home');
await mkdir(cwd); await writeFile(join(cwd, 'input.txt'), 'callback fixture');
let phase = 0, mode = 'callback', observed = false;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const body = await req.json() as { messages: Array<{ role: string; content: unknown }> };
  if (phase++ === 0) {
    const code = mode === 'timeout' ? 'while(true) {}'
      : `const value = await tools.Read({file_path:${JSON.stringify(join(cwd, 'input.txt'))}}); return {answer:42,read:value};`;
    return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'script-call', type: 'function',
      function: { name: 'Script', arguments: JSON.stringify({ code }) } }] }, finish_reason: 'tool_calls' }] });
  }
  const tool = body.messages.findLast(m => m.role === 'tool');
  if (typeof tool?.content === 'string') {
    const value = JSON.parse(tool.content);
    observed = value.ok === true && value.sandboxed === true && value.output?.answer === 42 && tool.content.includes('callback fixture');
  }
  return Response.json({ choices: [{ message: { role: 'assistant', content: 'compiled callback complete' }, finish_reason: 'stop' }] });
} });
const settings = join(root, 'settings.json');
const results: object[] = [];
try {
  await writeFile(settings, JSON.stringify({ modelId: 'custom:fixture', customModels: [{ id: 'custom:fixture', model: 'fixture',
    provider: 'generic-chat-completion-api', baseUrl: server.url.href + 'v1' }] }));
  for (mode of ['callback', 'timeout']) {
    phase = 0; observed = false;
    const p = Bun.spawn([binary, 'exec', '--cwd', cwd, '--settings', settings, '--auto', 'low',
      '--timeout-ms', mode === 'timeout' ? '1000' : '5000', '-o', 'json', 'synthetic'], {
      env: { PATH: process.env.PATH ?? '', HOME: home, FABRICA_HOME: home }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), 10000);
    try {
      const [exit, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
      const result = JSON.parse(out);
      if (mode === 'callback' && (!result.ok || !observed || exit !== 0)) throw new Error('Compiled callback failed: ' + JSON.stringify({ result, observed, err }));
      if (mode === 'timeout' && (result.ok || result.error?.type !== 'timeout' || result.toolCalls !== 1 || exit !== 1)) {
        throw new Error('Compiled timeout failed: ' + JSON.stringify({ result, exit, err }));
      }
      results.push({ case: mode, exit, ok: result.ok, error: result.error?.type, sandboxedCallbackObserved: observed,
        toolCalls: result.toolCalls, durationMs: result.durationMs });
    } finally { clearTimeout(timer); if (p.exitCode === null) { p.kill('SIGKILL'); await p.exited; } }
  }
  console.log(JSON.stringify({ binary, sha256: hash, results }));
} finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
