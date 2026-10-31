import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import type { McpConfig } from '../agent/mcp.ts';
import type { CreateSessionOptions, NamedMcpConfig, RpcNotification, Session, SessionMcpServer, TurnResult } from './types.ts';

class Mailbox<T> {
  private values: T[] = [];
  private waiters: Array<(value: T) => void> = [];
  push(value: T) { const waiter = this.waiters.shift(); waiter ? waiter(value) : this.values.push(value); }
  next(): Promise<T> { const value = this.values.shift(); return value === undefined ? new Promise(resolve => this.waiters.push(resolve)) : Promise.resolve(value); }
  drain() { this.values.length = 0; }
}

export async function createSession(options: CreateSessionOptions = {}): Promise<Session> {
  const owned: Array<{ close(): Promise<void> }> = [];
  let child: ChildProcessWithoutNullStreams | undefined;
  let sessionId = '';
  let requestId = 0;
  let closed = false;
  let busy = false;
  const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
  const events = new Mailbox<RpcNotification>();
  const write = (frame: unknown) => {
    if (!child?.stdin.writable || closed) throw new Error('FAB SDK session is closed');
    child.stdin.write(JSON.stringify(frame) + '\n');
  };
  const rpcRequest = (method: string, params: Record<string, unknown> = {}) => {
    const id = String(++requestId);
    return new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { write({ jsonrpc: '2.0', type: 'request', factoryApiVersion: '1.0.0', id, method: `droid.${method}`, params }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  };
  try {
    const servers: Record<string, McpConfig> = {};
    for (const server of options.mcpServers ?? []) {
      let named: NamedMcpConfig;
      if (typeof (server as any).start === 'function') {
        const sdkServer = server as Extract<SessionMcpServer, { start(): Promise<McpConfig> }>;
        named = { name: sdkServer.name, config: await sdkServer.start() }; owned.push(sdkServer);
      } else named = server as NamedMcpConfig;
      if (Object.hasOwn(servers, named.name)) throw new Error(`Duplicate MCP server name: ${named.name}`);
      servers[named.name] = named.config;
    }
    const cli = options.execPath ? resolve(options.execPath) : resolve(import.meta.dir, '../cli.ts');
    const bun = options.execPath && !/\.(?:[cm]?js|ts)$/.test(options.execPath) ? undefined : process.execPath;
    const command = bun ?? options.execPath!;
    const args = bun ? (options.execPath ? [cli, 'exec'] : [cli, 'exec']) : ['exec'];
    args.push('--input-format', 'stream-jsonrpc', '-o', 'stream-jsonrpc');
    if (options.cwd) args.push('--cwd', resolve(options.cwd));
    if (options.settingsPath) args.push('--settings', resolve(options.settingsPath));
    if (options.sessionDir) args.push('--session-dir', resolve(options.sessionDir));
    const processChild = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
    child = processChild;
    processChild.stdout.setEncoding('utf8');
    const reader = createInterface({ input: processChild.stdout });
    void (async () => {
      for await (const line of reader) {
        let frame: any; try { frame = JSON.parse(line); } catch { events.push({ type: 'transport_error', message: 'Invalid JSON-RPC frame from FAB' }); continue; }
        if (frame?.type === 'response' && typeof frame.id === 'string') {
          const operation = pending.get(frame.id); if (!operation) continue;
          pending.delete(frame.id);
          frame.error ? operation.reject(new Error(frame.error.message ?? 'FAB RPC request failed')) : operation.resolve(frame.result);
        } else if (frame?.type === 'request' && typeof frame.id === 'string') {
          const result = frame.method === 'droid.request_permission' ? { selectedOption: 'cancel' }
            : frame.method === 'droid.ask_user' ? { cancelled: true, answers: [] } : {};
          write({ jsonrpc: '2.0', type: 'response', id: frame.id, result });
        } else if (frame?.type === 'notification' && frame.method === 'droid.session_notification' && frame.params?.notification) {
          events.push(frame.params.notification as RpcNotification);
        }
      }
    })().catch(error => events.push({ type: 'transport_error', message: error instanceof Error ? error.message : String(error) }));
    processChild.stderr.resume();
    processChild.once('close', code => {
      for (const operation of pending.values()) operation.reject(new Error(`FAB exec exited (${code ?? 'unknown'})`));
      pending.clear(); events.push({ type: 'transport_error', message: `FAB exec exited (${code ?? 'unknown'})` });
    });
    const initialized = await rpcRequest('initialize_session', { machineId: 'fab-sdk', ...(options.cwd ? { cwd: resolve(options.cwd) } : {}),
      ...(options.modelId ? { modelId: options.modelId } : {}), ...(options.autonomy ? { autonomyLevel: options.autonomy } : {}),
      hooks: options.hooks === true, mcpServers: servers });
    sessionId = initialized.sessionId;
  } catch (error) {
    closed = true; child?.kill('SIGKILL'); await Promise.allSettled(owned.map(server => server.close()));
    throw error;
  }

  async function* run(prompt: string): AsyncGenerator<RpcNotification> {
    if (closed) throw new Error('FAB SDK session is closed');
    if (busy) throw new Error('FAB SDK session already has an active turn');
    busy = true; events.drain();
    let completed = false;
    try {
      await rpcRequest('add_user_message', { text: prompt });
      for (;;) {
        const event = await events.next(); yield event;
        if (event.type === 'agent_turn_completed') { completed = true; return; }
        if (event.type === 'transport_error') throw new Error(String(event.message));
      }
    } finally {
      busy = false;
      if (!completed && !closed) void rpcRequest('interrupt_session').catch(() => {});
    }
  }

  const session: Session = {
    get sessionId() { return sessionId; },
    async send(prompt) {
      let delta = '', text = '', terminal: RpcNotification | undefined;
      for await (const event of run(prompt)) {
        if (event.type === 'assistant_text_delta' && typeof event.textDelta === 'string') delta += event.textDelta;
        if (event.type === 'create_message' && (event.message as any)?.role === 'assistant') {
          const content = (event.message as any).content;
          const complete = Array.isArray(content) ? content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('') : '';
          text = delta || complete; delta = '';
        }
        if (event.type === 'agent_turn_completed') terminal = event;
      }
      if (!terminal) throw new Error('FAB turn ended without completion notification');
      return { text: text || delta, reason: String(terminal.reason ?? 'unknown'), notification: terminal };
    },
    stream(prompt) { return run(prompt); },
    async listMcpServers() { return rpcRequest('list_mcp_servers'); },
    async listMcpTools() { return rpcRequest('list_mcp_tools'); },
    async authenticateMcpServer(input) { return rpcRequest('authenticate_mcp_server', input); },
    async close() {
      if (closed) return;
      if (busy) { try { await rpcRequest('interrupt_session'); } catch {} }
      try { await Promise.race([rpcRequest('close_session'), Bun.sleep(2000).then(() => { throw new Error('close timeout'); })]); } catch {}
      closed = true;
      child?.kill('SIGTERM');
      await Promise.allSettled(owned.map(server => server.close()));
      if (child?.exitCode === null) { await Bun.sleep(50); child.kill('SIGKILL'); }
    },
  };
  Object.defineProperties(session, {
    __rpcRequest: { value: rpcRequest },
    __setSessionId: { value: (value: string) => { sessionId = value; } },
  });
  return session;
}

export async function resumeSession(id: string, options: CreateSessionOptions = {}): Promise<Session> {
  if (!id.trim()) throw new Error('Session ID is required');
  const session = await createSession({ ...options, hooks: false });
  try {
    // `load_session` is the existing RPC resume operation; its result is reflected by sessionId below.
    const internal = session as Session & { __rpcRequest: (method: string, params: Record<string, unknown>) => Promise<any>; __setSessionId: (id: string) => void };
    const load = internal.__rpcRequest as ((method: string, params: Record<string, unknown>) => Promise<any>) | undefined;
    if (load) { const result = await load('load_session', { sessionId: id, hooks: options.hooks === true }); internal.__setSessionId(result.sessionId); }
    else throw new Error('Internal SDK resume channel is unavailable');
    return session;
  } catch (error) { await session.close(); throw error; }
}
