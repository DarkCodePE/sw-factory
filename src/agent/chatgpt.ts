// Model provider for a ChatGPT subscription, through the Codex Responses endpoint.
// Credentials are read from an existing Codex CLI login (~/.codex/auth.json). This client never
// refreshes or rewrites them: refresh tokens rotate, so refreshing here would sign the Codex CLI
// out. When the access token is near expiry the caller is told to refresh it with `codex`.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ProviderError, sseData, streamIdleFromEnv } from './provider.ts';
import { withIdleResponse } from './transport.ts';
import type { Message, ModelProvider, ModelRequest, ModelTurn, ToolCall } from './types.ts';

export const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex';

export interface ChatGPTOptions {
  model: string;
  /** Path to a Codex CLI auth file; defaults to $CODEX_HOME/auth.json or ~/.codex/auth.json. */
  authFile?: string;
  reasoningEffort?: string;
  maxResponseBytes?: number;
  baseUrl?: string;
  /** Fail a stream that sends nothing for this long (default 120 s; 0 disables). */
  streamIdleMs?: number;
}

interface Credentials { accessToken: string; accountId: string; residency?: string; expiresAt: number }

const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);

function jwtClaims(token: string): Record<string, any> {
  const part = token.split('.')[1];
  if (!part) throw new ProviderError('ChatGPT access token is malformed');
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); }
  catch { throw new ProviderError('ChatGPT access token is malformed'); }
}

export function defaultAuthFile() {
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
}

/** Read a Codex login. Only the access token and account ID are used; nothing is written back. */
export async function readCodexCredentials(path = defaultAuthFile()): Promise<Credentials> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new ProviderError(`No ChatGPT login found at ${path}; run \`codex login\` first`); }
  const tokens = object(raw) && object(raw.tokens) ? raw.tokens : undefined;
  const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : '';
  const accountId = typeof tokens?.account_id === 'string' ? tokens.account_id : '';
  if (!accessToken || !accountId) throw new ProviderError(`${path} is not a ChatGPT subscription login; run \`codex login\``);
  const claims = jwtClaims(accessToken);
  const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : 0;
  const auth = object(claims['https://api.openai.com/auth']) ? claims['https://api.openai.com/auth'] : {};
  const residency = typeof auth.chatgpt_compute_residency === 'string' && auth.chatgpt_compute_residency !== 'no_constraint'
    ? auth.chatgpt_compute_residency : undefined;
  return { accessToken, accountId, residency, expiresAt: exp };
}

const textOf = (content: Message['content']) =>
  typeof content === 'string' ? content : content?.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n') ?? '';

/** Translate our chat-style history into a Responses request body. */
export function responsesBody(model: string, request: ModelRequest, reasoningEffort?: string) {
  const instructions: string[] = [];
  const input: unknown[] = [];
  for (const m of request.messages) {
    if (m.role === 'system') { instructions.push(textOf(m.content)); continue; }
    if (m.role === 'tool') { input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: textOf(m.content) }); continue; }
    const type = m.role === 'assistant' ? 'output_text' : 'input_text';
    const content: unknown[] = [];
    if (typeof m.content === 'string') { if (m.content) content.push({ type, text: m.content }); }
    else for (const part of m.content ?? []) {
      if (part.type === 'text') content.push({ type, text: part.text });
      else if (m.role === 'user') content.push({ type: 'input_image', image_url: part.image_url.url });
    }
    if (content.length) input.push({ type: 'message', role: m.role, content });
    for (const call of m.tool_calls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
  }
  const body: Record<string, unknown> = {
    model, instructions: instructions.join('\n\n'), input, stream: true, store: false,
    tools: request.tools.map(t => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters, strict: false })),
  };
  if (reasoningEffort && reasoningEffort !== 'off') body.reasoning = { effort: reasoningEffort };
  return body;
}

/** Decode the Responses event stream into one model turn; tool calls are taken from completed items only. */
export async function decodeResponses(stream: ReadableStream<Uint8Array>, maxBytes: number, delta?: (t: string) => void): Promise<ModelTurn> {
  let text = '', finish = '', usage: ModelTurn['usage'];
  const calls = new Map<number, ToolCall>();
  for await (const data of sseData(stream, maxBytes)) {
    let event: any;
    try { event = JSON.parse(data); } catch { throw new ProviderError('Invalid Responses event'); }
    // Nothing may follow the terminal event: a turn is only usable if it ended exactly once.
    if (finish) throw new ProviderError('Data after model finish', true);
    switch (event?.type) {
      case 'response.output_text.delta':
        if (typeof event.delta === 'string') { text += event.delta; delta?.(event.delta); }
        break;
      case 'response.output_item.done':
        if (event.item?.type === 'function_call') {
          const { call_id, name, arguments: args } = event.item;
          if (typeof call_id !== 'string' || typeof name !== 'string' || typeof args !== 'string') throw new ProviderError('Invalid function call item');
          const index = Number.isSafeInteger(event.output_index) && event.output_index >= 0 ? event.output_index : 1_000_000 + calls.size;
          if (calls.has(index)) throw new ProviderError('Duplicate function call output index');
          calls.set(index, { id: call_id, type: 'function', function: { name, arguments: args } });
        }
        break;
      case 'response.completed': case 'response.incomplete': case 'response.failed': {
        const r = event.response ?? {};
        if (event.type === 'response.failed') throw new ProviderError(`ChatGPT response failed: ${r.error?.message ?? 'unknown error'}`, true);
        if (r.usage) usage = { inputTokens: Number(r.usage.input_tokens) || 0, outputTokens: Number(r.usage.output_tokens) || 0 };
        // Tools from an incomplete response are never dispatched; the call can be retried without effects.
        if (event.type === 'response.incomplete' && calls.size) throw new ProviderError('Incomplete response contained tool calls', true);
        finish = event.type === 'response.incomplete' ? 'length' : calls.size ? 'tool_calls' : 'stop';
        break;
      }
      case 'error':
        throw new ProviderError(`ChatGPT stream error: ${event.message ?? event.code ?? 'unknown'}`, true);
    }
  }
  if (!finish) throw new ProviderError('Model stream ended before completion', true);
  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  return { text, toolCalls, finishReason: finish, usage };
}

export function createChatGPTProvider(opts: ChatGPTOptions): ModelProvider {
  if (!opts.model?.trim()) throw new Error('A model is required');
  const baseUrl = (opts.baseUrl ?? CHATGPT_BASE_URL).replace(/\/$/, '');
  const maxBytes = opts.maxResponseBytes ?? 8 * 1024 * 1024;
  const idleMs = streamIdleFromEnv(opts.streamIdleMs);
  return {
    id: `chatgpt#${opts.model}`,
    async complete(request, signal, delta) {
      const creds = await readCodexCredentials(opts.authFile);
      if (creds.expiresAt && creds.expiresAt - Date.now() < 60_000) {
        throw new ProviderError('ChatGPT access token is expired; run any `codex` command to refresh the login, then retry');
      }
      const headers: Record<string, string> = {
        authorization: `Bearer ${creds.accessToken}`, 'chatgpt-account-id': creds.accountId,
        'content-type': 'application/json', accept: 'text/event-stream', originator: 'fab', 'user-agent': 'fab',
      };
      if (creds.residency) headers['x-openai-internal-codex-residency'] = creds.residency;
      return withIdleResponse(baseUrl + '/responses', {
        method: 'POST', signal, headers, redirect: 'error', body: JSON.stringify(responsesBody(opts.model, request, opts.reasoningEffort)),
      }, idleMs, async response => {
        if (response.status === 401) throw new ProviderError('ChatGPT rejected the login (401); run `codex login` again');
        if (!response.ok || !response.body) {
          const detail = (await response.text().catch(() => '')).slice(0, 300);
          throw new ProviderError(`ChatGPT request failed (HTTP ${response.status}) ${detail}`, response.status === 429 || response.status >= 500,
            /context|too long|maximum/i.test(detail));
        }
        return decodeResponses(response.body, maxBytes, delta);
      });
    },
  };
}
