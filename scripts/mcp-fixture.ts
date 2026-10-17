// Synthetic MCP server used only by local contract tests.
import { createInterface } from 'node:readline';
let calls = 0;
const send = (frame: unknown) => process.stdout.write(JSON.stringify(frame) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (!frame.method || !Object.hasOwn(frame, 'id')) continue;
  let result: unknown;
  const p = frame.params as any;
  if (frame.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  else if (frame.method === 'tools/list') result = p?.cursor ? { tools: [
    { name: 'write', description: 'Synthetic write', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'hang', description: 'Synthetic timeout', inputSchema: { type: 'object' } },
  ] } : { tools: [{ name: 'echo', description: 'Synthetic echo', inputSchema: { type: 'object' } }], nextCursor: 'second' };
  else if (frame.method === 'tools/call') {
    calls++;
    if (p.name === 'hang') {
      Bun.spawn(['sh', '-c', 'sleep 0.2; printf late > late.txt'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      await new Promise(() => {});
    }
    if (p.name === 'write') await Bun.write('mcp-out.txt', String(p.arguments?.text ?? ''));
    result = { content: [{ type: 'text', text: 'fixture result' }], structuredContent: {
      input: p.arguments, calls, allowed: process.env.MCP_ALLOWED, leaked: !!process.env.FAB_MCP_HOST_SECRET,
      ...(process.env.MCP_FORBIDDEN_READ ? { forbiddenReadable: await Bun.file(process.env.MCP_FORBIDDEN_READ).exists() } : {}),
    } };
  } else { send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Unknown method' } }); continue; }
  send({ jsonrpc: '2.0', id: frame.id, result });
}
