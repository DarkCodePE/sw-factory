import { pathToFileURL } from 'node:url';
import { abortable } from './cancellation.ts';
import type { ToolContext } from './types.ts';

const VERSION = '2025-11-25';
const SUPPORTED = [VERSION, '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BYTES = 4 * 1024 * 1024;
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);

export interface RemoteTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpSseConfig {
  name?: string;
  url: string;
  headers?: Record<string, string>;
  connectTimeout?: number;
  timeoutMs?: number;
}

export class McpSseConnection {
  public readonly name: string;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private nextId = 1;
  private controller = new AbortController();
  private postUrl?: string;
  private version = VERSION;
  private closed = false;
  private messages = 0;
  private requests = new Set<Promise<void>>();
  private parentAbort?: () => void;
  public capabilities: Record<string, any> = {};

  constructor(
    private readonly config: McpSseConfig,
    private readonly context: ToolContext,
  ) {
    this.name = config.name ?? 'mcp';
  }

  static async start(config: McpSseConfig, context: ToolContext): Promise<McpSseConnection> {
    const conn = new McpSseConnection(config, context);
    conn.parentAbort = () => conn.fail(new Error('MCP SSE session aborted'));
    context.signal.addEventListener('abort', conn.parentAbort, { once: true });
    if (context.signal.aborted) conn.parentAbort();

    const connectTimeout = config.connectTimeout ?? 10_000;
    const timeoutSignal = AbortSignal.timeout(connectTimeout);
    const handshakeSignal = AbortSignal.any([context.signal, conn.controller.signal, timeoutSignal]);

    const endpointPromise = new Promise<string>((resolve, reject) => {
      const onAbort = () => reject(new Error('MCP SSE connection timed out or aborted'));
      handshakeSignal.addEventListener('abort', onAbort, { once: true });

      void (async () => {
        try {
          const res = await fetch(config.url, {
            method: 'GET',
            headers: {
              ...config.headers,
              accept: 'text/event-stream',
              'MCP-Protocol-Version': conn.version,
            },
            signal: conn.controller.signal,
          });

          if (!res.ok) {
            await res.body?.cancel().catch(() => {});
            throw new Error(`MCP SSE HTTP ${res.status}`);
          }
          if (!res.body) throw new Error('Missing MCP SSE response body');

          const reader = res.body.getReader();
          const decoder = new TextDecoder('utf-8', { fatal: true });
          let buffer = '';
          let currentEvent = '';
          let dataLines: string[] = [];
          let endpointFound = false;

          const dispatch = (event: string, data: string) => {
            if (!endpointFound && (event === 'endpoint' || data.startsWith('/') || data.startsWith('http'))) {
              endpointFound = true;
              handshakeSignal.removeEventListener('abort', onAbort);
              const resolved = new URL(data.trim(), config.url).href;
              conn.postUrl = resolved;
              resolve(resolved);
              return;
            }
            if (data.trim()) {
              try {
                conn.receive(JSON.parse(data));
              } catch (e: any) {
                conn.fail(new Error(`Invalid MCP SSE JSON: ${e.message}`));
              }
            }
          };

          for (;;) {
            const next = await reader.read();
            if (next.done) {
              buffer += decoder.decode();
              break;
            }
            if (next.value.length > MAX_BYTES) throw new Error('MCP SSE chunk exceeds limit');
            buffer += decoder.decode(next.value, { stream: true });

            let newline: number;
            while ((newline = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, newline).replace(/\r$/, '');
              buffer = buffer.slice(newline + 1);

              if (line === '') {
                if (dataLines.length) {
                  dispatch(currentEvent, dataLines.join('\n'));
                  dataLines = [];
                  currentEvent = '';
                }
              } else if (line.startsWith('event:')) {
                currentEvent = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).replace(/^ /, ''));
              }
            }
          }

          if (dataLines.length) dispatch(currentEvent, dataLines.join('\n'));
          if (!endpointFound) {
            reject(new Error('MCP SSE closed without endpoint event'));
          }
        } catch (err: any) {
          handshakeSignal.removeEventListener('abort', onAbort);
          reject(err);
          conn.fail(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });

    try {
      await endpointPromise;
    } catch (e: any) {
      await conn.close();
      throw e;
    }
    return conn;
  }

  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private receive(frame: unknown) {
    if (!object(frame) || frame.jsonrpc !== '2.0' || ++this.messages > 100_000) {
      throw new Error('Invalid MCP response');
    }
    if (typeof frame.method === 'string') {
      if (Object.hasOwn(frame, 'id')) {
        const result = frame.method === 'ping'
          ? {}
          : frame.method === 'roots/list'
            ? { roots: [{ uri: pathToFileURL(this.context.cwd).href, name: 'Workspace' }] }
            : undefined;
        this.queueSend({
          jsonrpc: '2.0',
          id: frame.id,
          ...(result ? { result } : { error: { code: -32601, message: 'Unsupported client capability' } }),
        });
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
    const deadline = setTimeout(
      () => this.fail(new Error('MCP transport acknowledgment timed out')),
      object(frame) && frame.method === 'tools/call' ? this.config.timeoutMs ?? 180_000 : 15_000,
    );
    const work = this.send(frame).finally(() => clearTimeout(deadline));
    this.requests.add(work);
    void work.catch(() => this.fail(new Error('MCP transport failed'))).finally(() => this.requests.delete(work));
    return work;
  }

  private async send(frame: any) {
    if (this.closed || !this.postUrl) throw new Error('MCP SSE connection is closed');
    const data = JSON.stringify(frame);
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('MCP request exceeds byte limit');

    const res = await fetch(this.postUrl, {
      method: 'POST',
      headers: {
        ...this.config.headers,
        'content-type': 'application/json',
        'MCP-Protocol-Version': this.version,
      },
      signal: this.controller.signal,
      body: data,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`MCP SSE POST HTTP ${res.status}`);
    }
    await res.body?.cancel().catch(() => {});
  }

  private cancelRequest(id: number) {
    if (!this.postUrl) return;
    const frame = { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Cancelled' } };
    const work = fetch(this.postUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(500),
      headers: {
        ...this.config.headers,
        'content-type': 'application/json',
        'MCP-Protocol-Version': this.version,
      },
      body: JSON.stringify(frame),
    }).then(async res => { await res.body?.cancel().catch(() => {}); }).catch(() => {});
    void work;
  }

  async call(method: string, params: unknown, signal: AbortSignal, timeoutMs: number) {
    if (this.closed) throw new Error('MCP connection is closed');
    signal.throwIfAborted();
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
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, timeoutMs);
        void this.queueSend({ jsonrpc: '2.0', id, method, params }).catch(() => {});
        if (signal.aborted) abort();
      });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('MCP failed'));
      await this.close();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      this.pending.delete(id);
    }
  }

  async initialize(signal = this.context.signal) {
    const result = await this.call('initialize', {
      protocolVersion: VERSION,
      capabilities: { roots: {} },
      clientInfo: { name: 'fab', version: '0.1.0' },
    }, signal, 15_000);
    if (!object(result) || !SUPPORTED.includes(result.protocolVersion) || !object(result.capabilities?.tools)) {
      throw new Error('MCP tools/version negotiation failed');
    }
    this.version = result.protocolVersion;
    if (object(result.capabilities)) {
      this.capabilities = result.capabilities;
    }
    try {
      await abortable(this.queueSend({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal);
    } catch (error) {
      this.fail(new Error('MCP initialization aborted'));
      await this.close();
      throw error;
    }
  }

  async listTools(signal = this.context.signal): Promise<RemoteTool[]> {
    const tools: RemoteTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let bytes = 0;
    do {
      if (++pages > 16) throw new Error('MCP catalog pagination limit exceeded');
      const page = await this.call('tools/list', cursor ? { cursor } : {}, signal, 15_000);
      bytes += Buffer.byteLength(JSON.stringify(page));
      if (bytes > 512 * 1024) throw new Error('MCP catalog exceeds 512 KiB');
      if (!object(page) || !Array.isArray(page.tools) || page.tools.some((t: any) =>
        !object(t) || typeof t.name !== 'string' || !/^[\w.-]{1,128}$/.test(t.name) ||
        !object(t.inputSchema) || t.inputSchema.type !== 'object' ||
        (t.description !== undefined && typeof t.description !== 'string'))) {
        throw new Error('Invalid MCP tool catalog');
      }
      tools.push(...page.tools);
      if (tools.length > 256 || new Set(tools.map(t => t.name)).size !== tools.length) {
        throw new Error('MCP tool catalog limit or duplicate');
      }
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (typeof cursor !== 'string' || !cursor || cursor.length > 1024 || cursors.has(cursor)) {
          throw new Error('Invalid MCP pagination cursor');
        }
        cursors.add(cursor);
      }
    } while (cursor);
    return tools;
  }

  async close(): Promise<void> {
    this.fail(new Error('MCP connection closed'));
    if (this.parentAbort) this.context.signal.removeEventListener('abort', this.parentAbort);
    await Promise.allSettled([...this.requests]);
  }
}
