import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assert } from './common.mjs';

/** Qualify the actual executable on every native host and both installed channels. */
export async function smokeYolo(execute, cwd, temp) {
  let turns = 0, sawHost = false;
  const outside = join(temp, 'yolo-outside'), settings = join(temp, 'yolo-settings.json');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const server = createServer(async (req, res) => {
    if (req.url === '/probe') { res.end('HOST-NETWORK'); return; }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); turns++;
      const result = body.messages.find(m => m.role === 'tool');
      if (result) {
        const value = JSON.parse(result.content);
        assert(value.exitCode === 0 && value.sandboxed === false && value.permissionMode === 'yolo'
          && value.network.enabled && !value.network.requested && value.stdout === 'HOST-NETWORK:YOLO', 'YOLO host result mismatch');
        sawHost = true;
      }
      const command = `printf yolo | tr a-z A-Z > ${quote(outside)} && curl -fsS http://127.0.0.1:${server.address().port}/probe && printf : && cat ${quote(outside)}`;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: result ? { role: 'assistant', content: 'YOLO verified' }
        : { role: 'assistant', content: null, tool_calls: [{ id: 'yolo-probe', type: 'function', function: { name: 'Execute', arguments: JSON.stringify({ command, network: false }) } }] },
        finish_reason: result ? 'stop' : 'tool_calls' }] }));
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await writeFile(settings, JSON.stringify({ modelId: 'probe', customModels: [{ id: 'probe', model: 'probe', provider: 'generic-chat-completion-api', baseUrl: `http://127.0.0.1:${server.address().port}/v1` }] }));
    const task = await execute(['exec', '--yolo', '--cwd', cwd, '--settings', settings, '--timeout-ms', '10000', '-o', 'json', 'Run host probe']);
    const result = JSON.parse(task.out);
    assert(task.code === 0 && result.ok && result.executionPolicy?.permissionMode === 'yolo' && sawHost && turns === 2, `YOLO executable failed: ${task.err} ${task.out}`);
    assert(await readFile(outside, 'utf8') === 'YOLO', 'YOLO outside-workspace effect absent');
    assert(task.err.includes('YOLO'), 'YOLO notice missing from stderr');
    const chat = await execute(['tui', '--yolo', '--cwd', cwd, '--settings', settings], '/yolo\n/mode spec\n/mode auto\n/auto low\n/network deny\n/exit\n');
    assert(chat.code === 0 && chat.out.includes('sin aprobaciones') && chat.out.includes('YOLO suspendido')
      && chat.out.includes('YOLO exige high') && chat.out.includes('YOLO exige red auto'), `YOLO TUI failed: ${chat.out} ${chat.err}`);
    const conflict = await execute(['exec', '--yolo', '--auto', 'low', '--settings', settings, 'invalid']);
    assert(conflict.code !== 0 && conflict.err.includes('conflicts') && turns === 2, 'YOLO conflict reached provider');
    return { yoloHost: true, yoloTui: true, yoloConflict: true };
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
