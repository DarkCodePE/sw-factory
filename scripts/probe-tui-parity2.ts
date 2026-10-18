// Offline fixture driver: same PTY and network namespace as its own loopback provider.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const binary = resolve(process.argv[2] ?? 'dist/fab');
if (!process.argv[3]) throw new Error('Provide an owned fixture directory');
const root = resolve(process.argv[3]), cwd = join(root, 'workspace'), home = join(root, 'home');
await mkdir(join(cwd, '.agents/skills/probe-skill'), { recursive: true });
await mkdir(join(cwd, '.agents/commands'), { recursive: true }); await mkdir(home, { recursive: true });
await writeFile(join(cwd, 'AGENTS.md'), 'Synthetic fixture. Do not execute tools.');
await writeFile(join(cwd, '.agents/skills/probe-skill/SKILL.md'), '---\nname: probe-skill\ndescription: Skill de prueba local\n---\nInspect the workspace and report observed files. $ARGUMENTS');
await writeFile(join(cwd, '.agents/commands/probe-command.md'), '---\ndescription: Comando local de prueba\n---\nReport the given arguments: $ARGUMENTS');
const requests: Array<{ reasoning?: string; messages: unknown }> = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const body = await req.json() as { reasoning_effort?: string; messages: unknown };
  requests.push({ reasoning: body.reasoning_effort, messages: body.messages });
  await writeFile(join(root, 'requests.json'), JSON.stringify(requests));
  return Response.json({ choices: [{ message: { role: 'assistant', content: '# Recurso recibido\nPrompt local y argumentos recibidos por el proveedor sintético.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
} });
const settings = join(root, 'settings.json');
await writeFile(settings, JSON.stringify({ modelId: 'custom:fixture', customModels: ['fixture', 'second'].map((id, i) => ({ id: `custom:${id}`, model: id,
  displayName: i ? 'Segundo modelo' : 'Modelo de prueba', provider: 'generic-chat-completion-api', baseUrl: server.url.href + 'v1' })), mcpServers: { fixture: { command: '/bin/false' } } }));
const child = Bun.spawn([binary, 'tui', '--cwd', cwd, '--settings', settings], {
  env: { PATH: process.env.PATH ?? '', TERM: process.env.TERM ?? 'xterm-256color', HOME: home, FABRICA_HOME: home }, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
});
const stop = () => child.kill('SIGTERM'); process.on('SIGTERM', stop);
try { process.exitCode = await child.exited; } finally { server.stop(true); process.removeListener('SIGTERM', stop); }
