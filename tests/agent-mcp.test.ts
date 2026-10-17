import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpManager } from '../src/agent/mcp.ts';
import { runCodingAgent } from '../src/agent/engine.ts';
import type { ModelProvider, ToolContext } from '../src/agent/types.ts';

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function context(): Promise<ToolContext> {
  const cwd = await mkdtemp(join(tmpdir(), 'fab-mcp-')); roots.push(cwd);
  return { cwd, autonomy: 'medium', interactionMode: 'auto', sandbox: 'required', signal: new AbortController().signal };
}
const fixture = fileURLToPath(new URL('../scripts/mcp-fixture.ts', import.meta.url));
const config = () => ({ command: process.execPath, args: ['--no-env-file', fixture], env: { MCP_ALLOWED: 'explicit' }, readOnlyTools: ['echo'] });

test('stdio MCP negotiates, paginates, preserves state and scrubs the environment', async () => {
  const c = await context(), manager = new McpManager({ local: config() }, c);
  const old = process.env.FAB_MCP_HOST_SECRET; process.env.FAB_MCP_HOST_SECRET = 'synthetic-host-only';
  try {
    const tools = await manager.tools(); expect(tools.map(t => t.schema.function.name)).toEqual(['local___echo','local___write','local___hang']);
    const write = tools.find(t => t.schema.function.name === 'local___write')!;
    expect(write.effect).toBe('execute'); // Server readOnlyHint cannot grant local authority.
    await tools[0]!.run({ value: 0 }, c);
    const result: any = await tools[0]!.run({ value: 42 }, c);
    await write.run({ text: 'data' }, c);
    expect(result.structuredContent).toEqual({input:{value:42},calls:2,allowed:'explicit',leaked:false});
    expect(await Bun.file(join(c.cwd,'mcp-out.txt')).text()).toBe('data');
  } finally { await manager.close(); if(old===undefined) delete process.env.FAB_MCP_HOST_SECRET; else process.env.FAB_MCP_HOST_SECRET=old; }
});

test('MCP timeout kills the owned server namespace and delayed descendants', async () => {
  const c = await context(), manager = new McpManager({ local: { ...config(), timeoutMs: 35 } }, c);
  try {
    const hang = (await manager.tools()).find(t => t.schema.function.name === 'local___hang')!;
    await expect(hang.run({},c)).rejects.toThrow(/timed out|cancelled/);
    await Bun.sleep(250); expect(await Bun.file(join(c.cwd,'late.txt')).exists()).toBe(false);
  } finally { await manager.close(); }
});

test('unattended off autonomy denies MCP execution despite server annotations', async () => {
  const c = await context(); let n = 0, error = '';
  const provider: ModelProvider = { id:'fixture', async complete(request) {
    if (!n++) return {text:'',finishReason:'tool_calls',toolCalls:[{id:'write',type:'function',function:{name:'local___write',arguments:'{"text":"denied"}'}}]};
    error = request.messages.at(-1)!.content as string; return {text:'done',finishReason:'stop',toolCalls:[]};
  } };
  expect((await runCodingAgent({prompt:'try write',cwd:c.cwd,provider,autonomy:'off',mcpServers:{local:config()}})).ok).toBe(true);
  expect(error).toContain('autonomy'); expect(await Bun.file(join(c.cwd,'mcp-out.txt')).exists()).toBe(false);
});

test('HTTP MCP uses auth/session headers, JSON and SSE, and closes the remote session', async () => {
  const c = await context(); let deleted = false, cancelled = false;
  const session = crypto.randomUUID(), seen: string[] = [];
  const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req) {
    expect(req.headers.get('authorization')).toBe('Bearer synthetic-token');
    if(req.method==='DELETE'){deleted=true; expect(req.headers.get('MCP-Session-Id')).toBe(session); return new Response(null,{status:204});}
    const frame = await req.json() as any; seen.push(frame.method ?? 'response');
    if(frame.method==='initialize') return Response.json({jsonrpc:'2.0',id:frame.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}},{headers:{'MCP-Session-Id':session}});
    expect(req.headers.get('MCP-Session-Id')).toBe(session); expect(req.headers.get('MCP-Protocol-Version')).toBe('2025-11-25');
    if(frame.method==='notifications/initialized' || !frame.method) return new Response(null,{status:202});
    if(frame.method==='tools/list') return Response.json({jsonrpc:'2.0',id:frame.id,result:{tools:[{name:'echo',inputSchema:{type:'object'}}]}});
    if(frame.method==='tools/call') {
      const stream = new ReadableStream({start(controller){
        const frames=[{jsonrpc:'2.0',method:'ping',id:'server-ping'},{jsonrpc:'2.0',id:frame.id,result:{content:[{type:'image',mimeType:'image/png',data:'synthetic-base64'}],structuredContent:{answer:42}}}];
        for(const f of frames) controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(f)+'\n\n'));
      },cancel(){cancelled=true;}});
      return new Response(stream,{headers:{'content-type':'text/event-stream'}});
    }
    return new Response(null,{status:400});
  }});
  const manager = new McpManager({remote:{url:server.url.href,headers:{authorization:'Bearer synthetic-token'},readOnlyTools:['echo']}},c);
  try {
    const tools = await manager.tools(), result:any = await tools[0]!.run({},c);
    expect(result.structuredContent).toEqual({answer:42}); expect(result.content[0].type).toBe('image');
    await manager.close(); expect(deleted).toBe(true); expect(cancelled).toBe(true); expect(seen).toContain('response');
  } finally {await manager.close();server.stop(true);}
});

test('stdio MCP cannot read unrelated files from the host home', async () => {
  const c = await context(), outside = await mkdtemp(join(homedir(),'.fab-mcp-fixture-')); roots.push(outside);
  const secret = join(outside,'private'); await writeFile(secret,'synthetic-private-data');
  const manager = new McpManager({local:{...config(),env:{MCP_FORBIDDEN_READ:secret}}},c);
  try {
    const result:any = await (await manager.tools())[0]!.run({},c);
    expect(result.structuredContent.forbiddenReadable).toBe(false);
  } finally {await manager.close();}
});

test('onlyTools excluding an MCP server does not start its command', async () => {
  const c = await context();
  const result = await runCodingAgent({prompt:'read only',cwd:c.cwd,autonomy:'medium',onlyTools:['Read'],
    mcpServers:{excluded:{command:'fab-nonexistent-mcp-fixture-command'}},
    provider:{id:'fixture',complete:async()=>({text:'done',toolCalls:[],finishReason:'stop'})}});
  expect(result.ok).toBe(true);
});

test('HTTP timeout delivers cancellation independently of the aborted request', async () => {
  const c = await context(); let receivedCancel = false;
  const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req) {
    const frame = await req.json() as any;
    if(frame.method==='initialize') return Response.json({jsonrpc:'2.0',id:frame.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}}}});
    if(frame.method==='tools/list') return Response.json({jsonrpc:'2.0',id:frame.id,result:{tools:[{name:'hang',inputSchema:{type:'object'}}]}});
    if(frame.method==='tools/call') return new Promise<Response>(()=>{});
    if(frame.method==='notifications/cancelled') receivedCancel=true;
    return new Response(null,{status:202});
  }});
  const manager = new McpManager({remote:{url:server.url.href,readOnlyTools:['hang'],timeoutMs:30}},c);
  try {
    const tools = await manager.tools(); await expect(tools[0]!.run({},c)).rejects.toThrow();
    expect(receivedCancel).toBe(true);
  } finally {await manager.close();server.stop(true);}
});

test('untrusted MCP catalogs have bounded pagination and aggregate bytes', async () => {
  for(const oversized of [false,true]) {
    const c=await context(); let pages=0;
    const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
      const f=await req.json() as any;
      if(f.method==='initialize') return Response.json({jsonrpc:'2.0',id:f.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}}}});
      if(f.method==='tools/list') {pages++; return Response.json({jsonrpc:'2.0',id:f.id,result:oversized?
        {tools:[{name:'large',inputSchema:{type:'object'},description:'x'.repeat(512*1024)}]}:{tools:[],nextCursor:String(pages)}});}
      return new Response(null,{status:202});
    }});
    const manager=new McpManager({remote:{url:server.url.href}},c);
    try {await expect(manager.tools()).rejects.toThrow(oversized?'512 KiB':'pagination');expect(pages).toBe(oversized?1:16);}
    finally {await manager.close();server.stop(true);}
  }
});

test('abort during MCP teardown cannot become a successful agent result', async () => {
  const c = await context(), controller = new AbortController(); let terminal = false, deleted = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    if (req.method === 'DELETE') { deleted = true; controller.abort(new Error('Stopped during cleanup')); await Bun.sleep(20); return new Response(null, { status: 204 }); }
    const f = await req.json() as any;
    if (f.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: f.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } } }, { headers: { 'MCP-Session-Id': 'owned-fixture' } });
    if (f.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: f.id, result: { tools: [] } });
    return new Response(null, { status: 202 });
  } });
  try {
    const result = await runCodingAgent({ prompt: 'finish', cwd: c.cwd, signal: controller.signal,
      mcpServers: { local: { url: server.url.href } }, provider: { id: 'fixture', complete: async () => ({ text: 'done', toolCalls: [], finishReason: 'stop' }) },
      onEvent: e => { if (e.type === 'result') terminal = true; } });
    expect(deleted).toBe(true); expect(terminal).toBe(false);
    expect(result).toMatchObject({ ok: false, error: { type: 'aborted' } });
  } finally { server.stop(true); }
});
