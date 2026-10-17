import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { wrapMcpCommand } from './mcp-sandbox.ts';
import { abortable } from './cancellation.ts';
import { sseData } from './provider.ts';
import type { AgentTool, ToolContext } from './types.ts';

export type McpServerConfig = {
  command: string; args?: string[]; env?: Record<string, string>; allowNetwork?: boolean; url?: never; headers?: never;
} | { url: string; headers?: Record<string, string>; command?: never; args?: never; env?: never; allowNetwork?: never };
export type McpConfig = McpServerConfig & { disabled?: boolean; readOnlyTools?: string[]; readPaths?: string[]; timeoutMs?: number };
const VERSION = '2025-11-25';
const SUPPORTED = [VERSION, '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BYTES = 4 * 1024 * 1024;
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
interface RemoteTool { name: string; description?: string; inputSchema: Record<string, unknown> }

/** Own MCP client: stdio and POST-based Streamable HTTP, bounded JSON/SSE.
 * It advertises roots only. Server instructions/annotations never grant authority. */
class McpConnection {
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private nextId = 1;
  private controller = new AbortController();
  private child?: ChildProcessWithoutNullStreams;
  private exited?: Promise<void>;
  private closing?: Promise<void>;
  private parentAbort?: () => void;
  private sessionId?: string;
  private version = VERSION;
  private closed = false;
  private messages = 0;
  private requests = new Set<Promise<void>>();
  private cancellations = new Set<Promise<void>>();
  private constructor(private readonly config: McpConfig, private readonly context: ToolContext, readonly writable: boolean) {}

  static async start(config: McpConfig, context: ToolContext, writable: boolean) {
    if ((typeof config.command === 'string') === (typeof config.url === 'string')) throw new Error('MCP requires exactly one transport');
    const connection = new McpConnection(config, context, writable);
    if ('command' in config && config.command) {
      if (typeof config.command !== 'string' || !config.command || config.command.includes('\0') ||
          config.args && (!Array.isArray(config.args) || config.args.length > 128 || config.args.some(a => typeof a !== 'string' || a.includes('\0')))) throw new Error('Invalid MCP command');
      if (config.env && (!object(config.env) || Object.entries(config.env).some(([k, v]) => !k || /[=\0]/.test(k) || typeof v !== 'string' || v.includes('\0')))) throw new Error('Invalid MCP environment');
      const wrapped = await wrapMcpCommand(config.command, config.args ?? [], { PATH: process.env.PATH ?? '', ...config.env },
        context, writable, config.allowNetwork === true, config.readPaths);
      context.signal.throwIfAborted();
      const child = connection.child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
        cwd: context.cwd, env: wrapped.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      connection.exited = new Promise(resolve => child.once('close', () => { connection.fail(new Error('MCP server exited')); resolve(); }));
      child.once('error', () => connection.fail(new Error('MCP server failed to start')));
      child.stdin.on('error', () => connection.fail(new Error('MCP server input closed')));
      // Drain stderr without forwarding potentially sensitive server diagnostics.
      child.stderr.on('data', () => {});
      const decoder = new TextDecoder('utf-8', { fatal: true }); let buffer = '';
      child.stdout.on('data', (part: Buffer) => {
        try {
          buffer += decoder.decode(part, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            if (!line.trim() || Buffer.byteLength(line) > MAX_BYTES) throw new Error('Invalid MCP frame');
            connection.receive(JSON.parse(line));
          }
          if (Buffer.byteLength(buffer) > MAX_BYTES) throw new Error('MCP frame exceeds byte limit');
        } catch { connection.fail(new Error('Invalid MCP server output')); }
      });
      child.stdout.once('end', () => { if (buffer.trim()) connection.fail(new Error('Truncated MCP frame')); });
    } else {
      if (typeof config.url !== 'string') throw new Error('MCP requires command or URL');
      const url = new URL(config.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid MCP URL');
      if (config.headers && (!object(config.headers) || Object.values(config.headers).some(v => typeof v !== 'string'))) throw new Error('Invalid MCP headers');
    }
    connection.parentAbort = () => connection.fail(new Error('MCP session aborted'));
    context.signal.addEventListener('abort', connection.parentAbort, { once: true });
    if (context.signal.aborted) connection.parentAbort();
    return connection;
  }
  private kill() {
    try { if (this.child?.pid) process.kill(-this.child.pid, 'SIGKILL'); } catch { this.child?.kill('SIGKILL'); }
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true; this.controller.abort(error); this.kill();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  private receive(frame: unknown) {
    if (!object(frame) || frame.jsonrpc !== '2.0' || ++this.messages > 100_000) throw new Error('Invalid MCP response');
    if (typeof frame.method === 'string') {
      if (Object.hasOwn(frame, 'id')) {
        const result = frame.method === 'ping' ? {} : frame.method === 'roots/list'
          ? { roots: [{ uri: pathToFileURL(this.context.cwd).href, name: 'Workspace' }] } : undefined;
        this.queueSend({ jsonrpc: '2.0', id: frame.id, ...(result ? { result } : { error: { code: -32601, message: 'Unsupported client capability' } }) });
      }
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    if (frame.error) pending.reject(new Error('MCP protocol error'));
    else if (!Object.hasOwn(frame, 'result')) pending.reject(new Error('Missing MCP result'));
    else pending.resolve(frame.result);
  }
  private queueSend(frame: unknown): Promise<void> {
    const deadline = setTimeout(() => this.fail(new Error('MCP transport acknowledgment timed out')),
      object(frame) && frame.method === 'tools/call' ? this.config.timeoutMs ?? 180_000 : 15_000);
    const work = this.send(frame).finally(() => clearTimeout(deadline));
    this.requests.add(work);
    void work.catch(() => this.fail(new Error('MCP transport failed'))).finally(() => this.requests.delete(work));
    return work;
  }
  private async send(frame: any) {
    if (this.closed) throw new Error('MCP connection is closed');
    const data = JSON.stringify(frame);
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('MCP request exceeds byte limit');
    if (this.child) {
      await new Promise<void>((resolve, reject) => this.child!.stdin.write(data + '\n', error => error ? reject(error) : resolve()));
      return;
    }
    const config = this.config as McpConfig & { url: string };
    const response = await fetch(config.url, { method: 'POST', redirect: 'error', signal: this.controller.signal,
      headers: { ...config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': this.version, ...(this.sessionId ? { 'MCP-Session-Id': this.sessionId } : {}) }, body: data });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`MCP HTTP ${response.status}`); }
    const session = response.headers.get('MCP-Session-Id');
    if (session) {
      if (!/^[\x21-\x7e]{1,512}$/.test(session)) throw new Error('Invalid MCP session header');
      this.sessionId = session;
    }
    if (!Object.hasOwn(frame, 'id') || !frame.method) {
      await response.body?.cancel();
      if (response.status !== 202) throw new Error('Invalid MCP notification acknowledgment');
      return;
    }
    if (!response.body) throw new Error('Missing MCP response body');
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      for await (const data of sseData(response.body, MAX_BYTES)) if (data) {
        const message = JSON.parse(data); this.receive(message);
        if (object(message) && message.id === frame.id && !message.method) break;
      }
    } else if (response.headers.get('content-type')?.includes('application/json')) {
      const reader = response.body.getReader(); let bytes = 0; const parts: Uint8Array[] = [];
      try {
        for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length;
          if (bytes > MAX_BYTES) throw new Error('MCP response exceeds byte limit'); parts.push(next.value); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      this.receive(JSON.parse(Buffer.concat(parts).toString('utf8')));
    } else { await response.body.cancel(); throw new Error('Unsupported MCP response format'); }
  }
  private cancelRequest(id: number) {
    const frame = { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Cancelled' } };
    if (!this.config.url) { void this.queueSend(frame).catch(() => {}); return; }
    // Independent bounded request: aborting the operation must not abort its cancellation.
    const work = fetch(this.config.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(500),
      headers: { ...this.config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': this.version, ...(this.sessionId ? { 'MCP-Session-Id': this.sessionId } : {}) },
      body: JSON.stringify(frame),
    }).then(async response => { await response.body?.cancel(); }).catch(() => {});
    this.cancellations.add(work);
    void work.finally(() => this.cancellations.delete(work));
  }
  async call(method: string, params: unknown, signal: AbortSignal, timeoutMs: number) {
    if (this.closed) throw new Error('MCP connection is closed'); signal.throwIfAborted();
    const id = this.nextId++;
    if (this.pending.size >= 64) throw new Error('MCP pending-request limit exceeded');
    const abort = () => {
      this.cancelRequest(id);
      this.fail(new Error('MCP request cancelled or timed out'));
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<any>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        signal.addEventListener('abort', abort, { once: true }); timer = setTimeout(abort, timeoutMs);
        void this.queueSend({ jsonrpc: '2.0', id, method, params }).catch(() => {});
        if (signal.aborted) abort();
      });
    } catch (error) { this.fail(error instanceof Error ? error : new Error('MCP failed')); await this.close(); throw error; }
    finally { if (timer) clearTimeout(timer); signal.removeEventListener('abort', abort); this.pending.delete(id); }
  }
  async initialize(signal = this.context.signal) {
    const result = await this.call('initialize', { protocolVersion: VERSION, capabilities: { roots: {} },
      clientInfo: { name: 'fab', version: '0.1.0' } }, signal, 15_000);
    if (!object(result) || !SUPPORTED.includes(result.protocolVersion) || !object(result.capabilities?.tools)) throw new Error('MCP tools/version negotiation failed');
    this.version = result.protocolVersion;
    try { await abortable(this.queueSend({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal); }
    catch (error) { this.fail(new Error('MCP initialization aborted')); await this.close(); throw error; }
  }
  async listTools(signal = this.context.signal): Promise<RemoteTool[]> {
    const tools: RemoteTool[] = [], cursors = new Set<string>(); let cursor: string | undefined, pages = 0, bytes = 0;
    do {
      if (++pages > 16) throw new Error('MCP catalog pagination limit exceeded');
      const page = await this.call('tools/list', cursor ? { cursor } : {}, signal, 15_000);
      bytes += Buffer.byteLength(JSON.stringify(page));
      if (bytes > 512 * 1024) throw new Error('MCP catalog exceeds 512 KiB');
      if (!object(page) || !Array.isArray(page.tools) || page.tools.some((t: any) => !object(t) || typeof t.name !== 'string' ||
          !/^[\w.-]{1,128}$/.test(t.name) || !object(t.inputSchema) || t.inputSchema.type !== 'object' || t.description !== undefined && typeof t.description !== 'string')) throw new Error('Invalid MCP tool catalog');
      tools.push(...page.tools);
      if (tools.length > 256 || new Set(tools.map(t => t.name)).size !== tools.length) throw new Error('MCP tool catalog limit or duplicate');
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (typeof cursor !== 'string' || !cursor || cursor.length > 1024 || cursors.has(cursor)) throw new Error('Invalid MCP pagination cursor');
        cursors.add(cursor);
      }
    } while (cursor);
    return tools;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.fail(new Error('MCP connection closed'));
      if (this.parentAbort) this.context.signal.removeEventListener('abort', this.parentAbort);
      await this.exited;
      await Promise.allSettled([...this.requests]);
      await Promise.allSettled([...this.cancellations]);
      if (this.config.url && this.sessionId) {
        await fetch(this.config.url, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(500),
          headers: { ...this.config.headers, 'MCP-Session-Id': this.sessionId, 'MCP-Protocol-Version': this.version },
        }).then(async response => { await response.body?.cancel(); }).catch(() => {});
      }
    })();
    return this.closing;
  }
}

export class McpManager {
  private connections = new Set<McpConnection>();
  private opening = new Set<Promise<McpConnection>>();
  private controller = new AbortController();
  constructor(private readonly servers: Record<string, McpConfig>, private readonly context: ToolContext,
    private readonly selection?: { only?: string[]; remove?: string[] }) {}
  private async connect(config: McpConfig, writable: boolean, signal = this.context.signal, initialization = signal) {
    const work = (async () => {
      const c = await McpConnection.start(config, { ...this.context, signal: AbortSignal.any([this.context.signal, signal, this.controller.signal]) }, writable);
      this.connections.add(c);
      try { await c.initialize(initialization); return c; } catch (error) { await c.close(); throw error; }
    })();
    this.opening.add(work);
    try { return await work; } finally { this.opening.delete(work); }
  }
  async tools(): Promise<AgentTool[]> {
    if (!object(this.servers) || Object.keys(this.servers).length > 8) throw new Error('Invalid MCP server configuration');
    const tools: AgentTool[] = [];
    const discovery = AbortSignal.any([this.context.signal, this.controller.signal, AbortSignal.timeout(30_000)]);
    for (const [name, config] of Object.entries(this.servers)) {
      if (!/^[\w-]{1,32}$/.test(name) || !object(config) || config.disabled !== undefined && typeof config.disabled !== 'boolean') throw new Error('Invalid MCP server name/configuration');
      if (config.disabled) continue;
      if (this.selection?.only && !this.selection.only.some(t => t.startsWith(name + '___'))) continue;
      const timeout = config.timeoutMs ?? 180_000;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647 ||
          config.readOnlyTools && (!Array.isArray(config.readOnlyTools) || config.readOnlyTools.some(t => typeof t !== 'string')) ||
          config.readPaths && (!Array.isArray(config.readPaths) || config.readPaths.some(p => typeof p !== 'string'))) throw new Error('Invalid MCP limits/policy');
      const connection = await this.connect(config, false, this.context.signal, discovery);
      for (const remote of await connection.listTools(discovery)) {
        const llmName = `${name}___${remote.name}`;
        if (this.selection?.remove?.includes(llmName) || this.selection?.only && !this.selection.only.includes(llmName)) continue;
        if (llmName.length > 64) throw new Error('MCP tool name exceeds model limit');
        const read = config.readOnlyTools?.includes(remote.name) === true;
        tools.push({ effect: read ? 'read' : 'execute', schema: { type: 'function', function: {
          name: llmName, description: remote.description ?? `Configured MCP tool ${remote.name}`, parameters: remote.inputSchema,
        } }, run: async (input, context) => {
          const temporary = !read && !!config.command;
          const target = temporary ? await this.connect(config, true, context.signal) : connection;
          try {
            const result = await target.call('tools/call', { name: remote.name, arguments: input }, context.signal, timeout);
            if (!object(result) || result.content !== undefined && !Array.isArray(result.content) ||
                !Array.isArray(result.content) && !object(result.structuredContent) || result.isError !== undefined && typeof result.isError !== 'boolean') throw new Error('Invalid MCP tool result');
            result.content ??= [];
            if (result.isError) throw new Error(result.content.filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n').slice(0, 8192) || 'MCP tool failed');
            return result;
          } finally { if (temporary) { await target.close(); this.connections.delete(target); } }
        } });
      }
    }
    if (tools.length > 256) throw new Error('MCP tool-count limit exceeded');
    return tools;
  }
  async close() {
    this.controller.abort(new Error('MCP manager closed'));
    await Promise.allSettled([...this.opening]);
    await Promise.allSettled([...this.connections].map(c => c.close()));
  }
}
