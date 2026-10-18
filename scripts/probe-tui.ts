// Deterministic local provider + compiled fab in the same isolated PTY/network namespace.
// Usage: bun scripts/probe-tui.ts /absolute/dist/fab /owned/temporary/root
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const binary = resolve(process.argv[2] ?? 'dist/fab');
const autonomy = process.argv[4] ?? 'low';
if (!['off', 'low'].includes(autonomy)) throw new Error('Probe admite solo autonomía off o low');
if (!process.argv[3]) throw new Error('Se requiere una carpeta temporal propia');
const root = resolve(process.argv[3]), cwd = join(root, 'workspace'), home = join(root, 'home');
await mkdir(cwd, { recursive: true }); await mkdir(home, { recursive: true });
let turn = 0;
const text = '# Verificación local\n**Completado** con `42`.\n- Sin proveedor comercial\n- Archivo creado y editado\n```ts\nconst resultado = 42;\n```\n| Prueba | Estado |\n| --- | --- |\n| Markdown | correcto |\n| Diff | correcto |\n';
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  await request.json(); const index = turn++;
  await Bun.sleep(index < 2 ? 1100 : 700);
  const tools = index === 0 ? { name: 'Create', input: { file_path: 'demo.ts', content: Array.from({ length: 28 }, (_, i) => `const valor${i} = ${i};`).join('\n') } }
    : index === 1 ? { name: 'Edit', input: { file_path: 'demo.ts', old_str: 'valor0 = 0', new_str: 'valor0 = 42' } } : undefined;
  if (tools) return Response.json({ choices: [{ message: { role: 'assistant', content: null,
    tool_calls: [{ id: `fixture-${index}`, type: 'function', function: { name: tools.name, arguments: JSON.stringify(tools.input) } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 100 + index * 20, completion_tokens: 16 } });
  const stream = new ReadableStream({ async start(controller) {
    const send = (data: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`));
    try {
      for (let at = 0; at < text.length; at += 18) {
        send({ choices: [{ index: 0, delta: { content: text.slice(at, at + 18) }, finish_reason: null }] });
        await Bun.sleep(90);
      }
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 150, completion_tokens: 45 } });
      send('[DONE]'); controller.close();
    } catch { /* A cancelled client may close its stream. */ }
  } });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
} });
const settings = join(root, 'settings.json');
await writeFile(settings, JSON.stringify({ modelId: 'custom:fixture', customModels: [{ id: 'custom:fixture', model: 'fixture',
  provider: 'generic-chat-completion-api', baseUrl: server.url.href + 'v1' }] }));
const child = Bun.spawn([binary, 'tui', '--cwd', cwd, '--settings', settings, '--auto', autonomy], {
  env: { PATH: process.env.PATH ?? '', HOME: home, FABRICA_HOME: home }, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
});
const stop = () => child.kill('SIGTERM'); process.on('SIGTERM', stop);
try { process.exitCode = await child.exited; }
finally { server.stop(true); process.removeListener('SIGTERM', stop); }
