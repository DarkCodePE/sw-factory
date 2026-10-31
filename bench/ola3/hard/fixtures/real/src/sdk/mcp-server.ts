import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { McpConfig } from '../agent/mcp.ts';
import { validateToolInput } from './tools.ts';
import type { JsonSchema, SdkMcpServer, SdkTool } from './types.ts';

type McpOptions = { name: string; tools: SdkTool[] };
const MAX_BODY = 4 * 1024 * 1024;
const text = (message: string) => [{ type: 'text', text: message }];
const response = (id: unknown, result: unknown) => Response.json({ jsonrpc: '2.0', id, result });
const rpcError = (id: unknown, code: number, message: string) => Response.json({ jsonrpc: '2.0', id, error: { code, message } });
function validateSchema(schema: JsonSchema, depth = 0): void {
  const allowed = new Set(['type', 'properties', 'required', 'enum', 'items', 'additionalProperties', 'description', 'title']);
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 16 || Object.keys(schema).some(key => !allowed.has(key)) ||
      schema.type !== undefined && !['object', 'string', 'number', 'integer', 'boolean', 'array', 'null'].includes(schema.type) ||
      schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length > 256) ||
      schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string')) ||
      schema.properties !== undefined && (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties) || Object.keys(schema.properties).length > 128) ||
      schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') throw new Error('Unsupported or invalid SDK MCP input schema');
  for (const child of Object.values(schema.properties ?? {})) validateSchema(child, depth + 1);
  if (schema.items) validateSchema(schema.items, depth + 1);
}

export function createSdkMcpServer(options: McpOptions): SdkMcpServer {
  if (!/^[\w-]{1,32}$/.test(options.name) || !Array.isArray(options.tools) || options.tools.length > 128) throw new Error('Invalid SDK MCP server');
  const tools = new Map(options.tools.map(item => [item.name, item]));
  if (tools.size !== options.tools.length) throw new Error('Duplicate SDK MCP tool name');
  for (const item of tools.values()) validateSchema(item.inputSchema);
  let server: ReturnType<typeof Bun.serve> | undefined;
  let token: string | undefined;
  let closing = false;
  const active = new Set<AbortController>();

  const instance: SdkMcpServer = {
    name: options.name,
    async start(): Promise<McpConfig> {
      if (server && token) return { type: 'http', url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: `Bearer ${token}` } };
      if (closing) throw new Error('SDK MCP server is closed');
      token = randomBytes(32).toString('hex');
      server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
        const supplied = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') ?? '')?.[1];
        const expected = token;
        if (!supplied || !expected || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return new Response('Unauthorized', { status: 401 });
        const length = Number(request.headers.get('content-length') ?? 0);
        if (length > MAX_BODY) return new Response('Request too large', { status: 413 });
        const raw = await request.text();
        if (Buffer.byteLength(raw) > MAX_BODY) return new Response('Request too large', { status: 413 });
        let frame: any;
        try { frame = JSON.parse(raw); } catch { return rpcError(null, -32700, 'Parse error'); }
        if (!frame || frame.jsonrpc !== '2.0' || typeof frame.method !== 'string') return rpcError(frame?.id ?? null, -32600, 'Invalid request');
        const hasId = Object.hasOwn(frame, 'id');
        if (frame.method === 'notifications/initialized' || frame.method === 'notifications/cancelled') return new Response(null, { status: 202 });
        if (frame.method === 'initialize') return response(frame.id, { protocolVersion: frame.params?.protocolVersion ?? '2025-11-25', capabilities: { tools: { listChanged: false } }, serverInfo: { name: options.name, version: '1.0.0' } });
        if (frame.method === 'ping') return response(frame.id, {});
        if (frame.method === 'tools/list') return response(frame.id, { tools: [...tools.values()].map(item => ({ name: item.name, description: item.description, inputSchema: item.inputSchema })) });
        if (frame.method !== 'tools/call') return hasId ? rpcError(frame.id, -32601, 'Method not found') : new Response(null, { status: 202 });
        const toolName = frame.params?.name;
        const selected = typeof toolName === 'string' ? tools.get(toolName) : undefined;
        if (!selected) return response(frame.id, { isError: true, content: text('Unknown tool') });
        const input = frame.params?.arguments ?? {};
        const invalid = validateToolInput(selected.inputSchema as JsonSchema, input);
        if (invalid) return response(frame.id, { isError: true, content: text(invalid) });
        const controller = new AbortController(); active.add(controller);
        const deadline = setTimeout(() => controller.abort(new Error('SDK MCP tool call timed out')), 60_000);
        const abort = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
        try {
          const result = await Promise.race([Promise.resolve(selected.handler(input)), abort]);
          const content = typeof result === 'string' ? text(result) : result?.content;
          if (!Array.isArray(content) || content.some(part => !part || typeof part !== 'object' || typeof (part as any).type !== 'string')) {
            return response(frame.id, { isError: true, content: text('SDK MCP handler must return text or a content array') });
          }
          return response(frame.id, { content });
        } catch (error) {
          return response(frame.id, { isError: true, content: text(error instanceof Error ? error.message : String(error)) });
        } finally { clearTimeout(deadline); active.delete(controller); }
      } });
      return { type: 'http', url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: `Bearer ${token}` } };
    },
    async close() {
      closing = true;
      for (const controller of active) controller.abort(new Error('SDK MCP server closed'));
      server?.stop(true); server = undefined; token = undefined;
    },
  };
  return instance;
}
