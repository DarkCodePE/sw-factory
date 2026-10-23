import type { McpConfig } from '../agent/mcp.ts';

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  [key: string]: unknown;
};

export interface SdkTool<I = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler(input: I): string | { content: unknown[] } | Promise<string | { content: unknown[] }>;
}

export interface SdkMcpServer {
  readonly name: string;
  start(): Promise<McpConfig>;
  close(): Promise<void>;
}

export interface NamedMcpConfig { name: string; config: McpConfig }
export type SessionMcpServer = SdkMcpServer | NamedMcpConfig;

export interface CreateSessionOptions {
  cwd?: string;
  modelId?: string;
  autonomy?: 'off' | 'low' | 'medium' | 'high';
  mcpServers?: SessionMcpServer[];
  hooks?: boolean;
  execPath?: string;
  settingsPath?: string;
  sessionDir?: string;
}

export interface RpcNotification {
  type: string;
  [key: string]: unknown;
}

export interface TurnResult {
  text: string;
  reason: string;
  notification: RpcNotification;
}

export interface Session {
  readonly sessionId: string;
  send(prompt: string): Promise<TurnResult>;
  stream(prompt: string): AsyncIterable<RpcNotification>;
  listMcpServers(): Promise<{ servers: Array<Record<string, unknown>>; summary: { connected: number; failed: number; needsAuth: number } }>;
  listMcpTools(): Promise<Array<{ server: string; name: string; description: string }>>;
  authenticateMcpServer(input: { serverName: string }): Promise<{ authorizeUrl: string }>;
  close(): Promise<void>;
}
