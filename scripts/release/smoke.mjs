// Native executable and actual agent loop, driven by an offline provider.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assert, hashFile, sourceSha, version, writeJson } from './common.mjs';

export async function smoke(binary, expectedVersion, { home: selectedHome } = {}) {
  binary = resolve(binary);
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'fab-artifact-'))), home = selectedHome ?? join(temp, 'home'), cwd = join(temp, 'workspace');
  await mkdir(home, { recursive: true }); await mkdir(cwd); await writeFile(join(cwd, 'calc.txt'), 'a - b\n');
  const env = { PATH: process.env.PATH ?? '', HOME: home, FABRICA_HOME: home, TERM: 'dumb' };
  const execute = (args, input = '') => new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] }); let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err }); }); child.stdin.end(input);
  });
  let turns = 0, receivedToolResults = 0;
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); turns++;
      receivedToolResults = body.messages.filter(message => message.role === 'tool').length;
      if (turns >= 2) assert(body.messages.some(message => message.tool_call_id === 'probe-1' && message.content.includes('a - b')), 'Read did not return the file contents');
      if (turns >= 3) assert(body.messages.some(message => message.tool_call_id === 'probe-2' && JSON.parse(message.content).success === true), 'Edit did not report success');
      const tool = turns === 1 ? { name: 'Read', arguments: JSON.stringify({ file_path: join(cwd, 'calc.txt') }) }
        : turns === 2 ? { name: 'Edit', arguments: JSON.stringify({ file_path: join(cwd, 'calc.txt'), old_str: 'a - b', new_str: 'a + b' }) } : undefined;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: tool ? { role: 'assistant', content: null, tool_calls: [{ id: `probe-${turns}`, type: 'function', function: tool }] }
        : { role: 'assistant', content: 'validated artifact task' }, finish_reason: tool ? 'tool_calls' : 'stop' }] }));
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const actual = await execute(['--version']); assert(actual.code === 0 && actual.out.trim() === `fab ${expectedVersion}`, 'Executable version mismatch');
    const help = await execute(['--help']); assert(help.code === 0 && ['fab tui', 'fab exec', 'fab mcp'].every(text => help.out.includes(text)), 'CLI help missing commands');
    const settings = join(temp, 'settings.json');
    await writeFile(settings, JSON.stringify({ modelId: 'custom:probe', customModels: [{ id: 'custom:probe', model: 'probe', provider: 'generic-chat-completion-api', baseUrl: `http://127.0.0.1:${server.address().port}/v1` }] }));
    const task = await execute(['exec', '--cwd', cwd, '--settings', settings, '--auto', 'low', '--timeout-ms', '15000', '-o', 'json', 'Read calc.txt and replace subtraction with addition.']);
    const result = JSON.parse(task.out);
    assert(task.code === 0 && result.ok === true && result.toolCalls === 2 && turns === 3 && receivedToolResults === 2, `Agent loop failed: ${task.err} ${task.out}`);
    assert(await readFile(join(cwd, 'calc.txt'), 'utf8') === 'a + b\n', 'Tool effect absent');
    await writeFile(join(cwd, 'calc.txt'), 'a - b\n'); turns = 0; receivedToolResults = 0;
    const chat = await execute(['tui', '--cwd', cwd, '--settings', settings, '--auto', 'low', '--timeout-ms', '15000'], 'Read calc.txt and replace subtraction with addition.\n/rewind\n/help\n/plugins\n/exit\n');
    assert(chat.code === 0 && chat.out.includes('/skill') && chat.out.includes('marketplace'), `Piped TUI commands failed: ${chat.err} ${chat.out}`);
    assert(turns === 3 && receivedToolResults === 2 && chat.out.includes('validated artifact task'), `TUI agent task failed: ${chat.err} ${chat.out}`);
    assert(await readFile(join(cwd, 'calc.txt'), 'utf8') === 'a - b\n', 'TUI rewind did not restore the file');
    const mcp = await execute(['mcp', 'list', '--settings', settings]); assert(mcp.code === 0, 'MCP configuration command failed');
    return { version: expectedVersion, platform: process.platform, arch: process.arch, checks: { version: true, help: true, readEditTask: true, toolCalls: result.toolCalls, turns, tuiCommands: true, tuiAgentTask: true, tuiRewind: true, mcpList: true }, sha256: await hashFile(binary) };
  } finally { await new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await rm(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const result = await smoke(process.argv[2], await version());
  const receipt = { ...result, sourceSha: sourceSha() };
  if (process.argv[3]) await writeJson(resolve(process.argv[3]), receipt);
  console.log(JSON.stringify(receipt));
}
