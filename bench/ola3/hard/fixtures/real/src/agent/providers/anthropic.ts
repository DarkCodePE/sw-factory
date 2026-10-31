import { ProviderError, sseData, streamIdleFromEnv, validateTurn } from '../provider.ts';
import { withIdleResponse, retryAfterMs } from '../transport.ts';
import type { Message, ModelProvider, ModelRequest, ModelTurn, ToolCall } from '../types.ts';
import { resolveCredential, validateExtraHeaders, type CredentialOptions } from './auth.ts';

export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

export interface AnthropicOptions extends CredentialOptions {
  model: string;
  baseUrl?: string;
  authMode?: 'provider-default' | 'bearer';
  reasoningEffort?: string;
  maxOutputTokens?: number;
  maxResponseBytes?: number;
  streamIdleMs?: number;
  extraArgs?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
}

const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);

const textOf = (content: Message['content']): string => {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content
    .filter(p => p.type === 'text')
    .map(p => (p as { text: string }).text)
    .join('\n');
};

const thinkingBudget = (effort?: string): number | undefined => {
  if (!effort || effort === 'off') return undefined;
  switch (effort) {
    case 'low': return 2048;
    case 'medium': return 8192;
    case 'high': return 16384;
    case 'extra-high': return 32768;
    default: {
      const n = Number(effort);
      return Number.isSafeInteger(n) && n > 0 ? n : 2048;
    }
  }
};

export function anthropicRequestBody(
  model: string,
  request: ModelRequest,
  options: {
    reasoningEffort?: string;
    maxOutputTokens?: number;
    extraArgs?: Record<string, unknown>;
  } = {},
) {
  const systemTexts: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = [];

  for (const m of request.messages) {
    if (m.role === 'system') {
      const text = textOf(m.content);
      if (text) systemTexts.push(text);
      continue;
    }

    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id ?? '',
        content: textOf(m.content),
      };
      const last = messages[messages.length - 1];
      if (last && last.role === 'user') {
        last.content.push(block);
      } else {
        messages.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (m.role === 'user') {
      const blocks: unknown[] = [];
      if (typeof m.content === 'string') {
        if (m.content) blocks.push({ type: 'text', text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === 'text') blocks.push({ type: 'text', text: part.text });
          else if (part.type === 'image_url') {
            const url = part.image_url.url;
            const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(url);
            if (match) {
              blocks.push({
                type: 'image',
                source: { type: 'base64', media_type: match[1], data: match[2] },
              });
            }
          }
        }
      }
      const last = messages[messages.length - 1];
      if (last && last.role === 'user') {
        last.content.push(...blocks);
      } else {
        messages.push({ role: 'user', content: blocks });
      }
      continue;
    }

    if (m.role === 'assistant') {
      const blocks: unknown[] = [];
      const text = textOf(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.function.arguments);
        } catch {
          input = {};
        }
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input,
        });
      }
      messages.push({ role: 'assistant', content: blocks });
    }
  }

  const budget = thinkingBudget(options.reasoningEffort);
  const requestedMax = Math.min(request.maxOutputTokens, options.maxOutputTokens ?? 4096);
  const maxTokens = budget ? Math.max(requestedMax, budget + 1024) : requestedMax;

  const promptCache = options.extraArgs?.promptCache === true;
  let systemField: unknown;
  if (systemTexts.length > 0) {
    const combinedSystem = systemTexts.join('\n\n');
    if (promptCache) {
      systemField = [
        {
          type: 'text',
          text: combinedSystem,
          cache_control: { type: 'ephemeral' },
        },
      ];
    } else {
      systemField = combinedSystem;
    }
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages,
    stream: true,
  };

  if (systemField !== undefined) body.system = systemField;

  if (request.tools.length > 0) {
    body.tools = request.tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }

  if (budget) {
    body.thinking = { type: 'enabled', budget_tokens: budget };
  }

  if (options.extraArgs) {
    for (const [k, v] of Object.entries(options.extraArgs)) {
      if (k !== 'promptCache' && !Object.hasOwn(body, k)) {
        body[k] = v;
      }
    }
  }

  return body;
}

export async function decodeAnthropicStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  delta?: (t: string) => void,
): Promise<ModelTurn> {
  let text = '';
  let finishReason = '';
  const toolCallsByIndex = new Map<number, { id: string; name: string; args: string }>();
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const data of sseData(stream, maxBytes)) {
    let event: any;
    try {
      event = JSON.parse(data);
    } catch {
      throw new ProviderError('Invalid Anthropic event');
    }
    if (!object(event)) continue;

    switch (event.type) {
      case 'message_start': {
        if (object(event.message?.usage)) {
          inputTokens += Number(event.message.usage.input_tokens) || 0;
          outputTokens += Number(event.message.usage.output_tokens) || 0;
        }
        break;
      }
      case 'content_block_start': {
        const idx = Number(event.index);
        const block = event.content_block;
        if (block?.type === 'tool_use') {
          toolCallsByIndex.set(idx, {
            id: String(block.id ?? ''),
            name: String(block.name ?? ''),
            args: '',
          });
        }
        break;
      }
      case 'content_block_delta': {
        const idx = Number(event.index);
        const d = event.delta;
        if (!object(d)) break;
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          text += d.text;
          delta?.(d.text);
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          const call = toolCallsByIndex.get(idx);
          if (call) call.args += d.partial_json;
        }
        break;
      }
      case 'message_delta': {
        if (object(event.delta)) {
          const stop = event.delta.stop_reason;
          if (typeof stop === 'string') {
            if (stop === 'tool_use') finishReason = 'tool_calls';
            else if (stop === 'max_tokens') finishReason = 'length';
            else finishReason = 'stop';
          }
        }
        if (object(event.usage)) {
          outputTokens += Number(event.usage.output_tokens) || 0;
        }
        break;
      }
      case 'message_stop': {
        if (!finishReason) {
          finishReason = toolCallsByIndex.size > 0 ? 'tool_calls' : 'stop';
        }
        break;
      }
      case 'error': {
        const msg = event.error?.message ?? 'Anthropic stream error';
        throw new ProviderError(`Anthropic stream error: ${msg}`, true);
      }
    }
  }

  if (!finishReason) {
    throw new ProviderError('Model stream ended before completion', true);
  }

  const toolCalls: ToolCall[] = [...toolCallsByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => ({
      id: c.id,
      type: 'function',
      function: {
        name: c.name,
        arguments: c.args || '{}',
      },
    }));

  return validateTurn({
    text,
    toolCalls,
    finishReason,
    usage: { inputTokens, outputTokens },
  });
}

export function createAnthropicProvider(opts: AnthropicOptions): ModelProvider {
  if (!opts.model?.trim()) throw new Error('A model is required');
  const baseUrl = (opts.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/$/, '');
  const maxBytes = opts.maxResponseBytes ?? 8 * 1024 * 1024;
  const idleMs = streamIdleFromEnv(opts.streamIdleMs);
  validateExtraHeaders(opts.extraHeaders);

  const getHeaders = async (forceRefresh = false): Promise<Record<string, string>> => {
    const credential = await resolveCredential(opts, forceRefresh);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': ANTHROPIC_VERSION,
    };
    if (opts.authMode === 'bearer') {
      if (credential) headers.authorization = `Bearer ${credential}`;
    } else {
      if (credential) headers['x-api-key'] = credential;
    }
    if (opts.extraHeaders) {
      Object.assign(headers, opts.extraHeaders);
    }
    return headers;
  };

  return {
    id: `anthropic#${opts.model}`,
    async complete(request, signal, delta) {
      let headers = await getHeaders(false);
      const body = JSON.stringify(
        anthropicRequestBody(opts.model, request, {
          reasoningEffort: opts.reasoningEffort,
          maxOutputTokens: opts.maxOutputTokens,
          extraArgs: opts.extraArgs,
        }),
      );

      const doRequest = async (currentHeaders: Record<string, string>): Promise<{ status: number; turn?: ModelTurn }> => {
        return withIdleResponse(
          `${baseUrl}/v1/messages`,
          {
            method: 'POST',
            signal,
            headers: currentHeaders,
            redirect: 'error',
            body,
          },
          idleMs,
          async response => {
            if (response.status === 401) {
              return { status: 401 };
            }
            if (!response.ok) {
              let detail = '';
              try {
                detail = (await response.text().catch(() => '')).slice(0, 300);
              } catch {}
              const isLimit = /context|maximum|too long/i.test(detail);
              throw new ProviderError(
                `Anthropic HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
                response.status === 429 || response.status >= 500,
                isLimit,
                retryAfterMs(response.headers.get('retry-after')),
              );
            }
            if (!response.body) {
              throw new ProviderError('Missing Anthropic response body');
            }
            const turn = await decodeAnthropicStream(response.body, maxBytes, delta);
            return { status: response.status, turn };
          },
        );
      };

      const result = await doRequest(headers);
      if (result.status === 401) {
        if (opts.apiKeyHelper) {
          headers = await getHeaders(true);
          const retried = await doRequest(headers);
          if (retried.status === 401) {
            throw new ProviderError('Anthropic HTTP 401: Unauthorized');
          }
          return retried.turn!;
        }
        throw new ProviderError('Anthropic HTTP 401: Unauthorized');
      }

      return result.turn!;
    },
  };
}
