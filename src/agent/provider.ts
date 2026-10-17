import type { Message, ModelProvider, ModelRequest, ModelTurn, ToolCall } from './types.ts';

export class ProviderError extends Error {
  constructor(message: string, public readonly retryable = false, public readonly contextLimit = false) {
    super(message);
  }
}
export interface OpenAICompatibleOptions {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  reasoningEffort?: string;
  maxResponseBytes?: number;
  maxOutputTokens?: number;
}

function object(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Byte bounded SSE decoding; network chunk boundaries are not event boundaries. */
export async function* sseData(body: ReadableStream<Uint8Array>, maxBytes: number) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, buffered = '', data: string[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (!next.done) {
        bytes += next.value.length;
        if (bytes > maxBytes) throw new ProviderError('Model response exceeds byte budget');
        buffered += decoder.decode(next.value, { stream: true });
      } else buffered += decoder.decode();
      let newline: number;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline).replace(/\r$/, '');
        buffered = buffered.slice(newline + 1);
        if (line === '') {
          if (data.length) yield data.join('\n');
          data = [];
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (next.done) break;
    }
    if (buffered.trim() || data.length) throw new ProviderError('Truncated SSE event');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function validateTurn(turn: ModelTurn): ModelTurn {
  if (typeof turn.text !== 'string' || !Array.isArray(turn.toolCalls)) throw new ProviderError('Invalid model message');
  if (!['stop', 'tool_calls', 'length'].includes(turn.finishReason)) {
    throw new ProviderError(`Unsupported model finish reason: ${turn.finishReason || 'missing'}`);
  }
  if (turn.toolCalls.length && turn.finishReason !== 'tool_calls') {
    throw new ProviderError('Incomplete tool batch: tools without tool_calls finish reason');
  }
  if (!turn.toolCalls.length && turn.finishReason === 'tool_calls') throw new ProviderError('Empty tool call batch');
  const ids = new Set<string>();
  for (const call of turn.toolCalls) {
    if (!object(call) || typeof call.id !== 'string' || !call.id || ids.has(call.id) || call.type !== 'function' ||
        !object(call.function) || typeof call.function.name !== 'string' || !/^[\w.-]+$/.test(call.function.name) ||
        typeof call.function.arguments !== 'string' || !call.function.arguments) {
      throw new ProviderError('Invalid or duplicate model tool call');
    }
    ids.add(call.id);
  }
  return turn;
}

async function decodeStream(response: Response, maxBytes: number, delta?: (text: string) => void): Promise<ModelTurn> {
  if (!response.body) throw new ProviderError('Model response has no body');
  const calls = new Map<number, ToolCall>();
  let text = '', finishReason = '', done = false;
  let usage: ModelTurn['usage'];
  for await (const data of sseData(response.body, maxBytes)) {
    if (data === '[DONE]') { done = true; break; }
    let chunk: any;
    try { chunk = JSON.parse(data); } catch { throw new ProviderError('Malformed model SSE JSON'); }
    if (!object(chunk) || chunk.error) throw new ProviderError('Model returned an error in its stream');
    if (object(chunk.usage)) usage = {
      inputTokens: Number(chunk.usage.prompt_tokens ?? 0), outputTokens: Number(chunk.usage.completion_tokens ?? 0),
    };
    if (!Array.isArray(chunk.choices)) throw new ProviderError('Invalid model choice array');
    const choice = chunk.choices.find((c: any) => object(c) && c.index === 0);
    if (!choice) continue;
    if (!object(choice.delta) || (choice.delta.tool_calls !== undefined && !Array.isArray(choice.delta.tool_calls))) {
      throw new ProviderError('Invalid model delta');
    }
    if (finishReason && (choice.delta?.content || choice.delta?.tool_calls)) throw new ProviderError('Data after model finish');
    if (choice.delta?.content !== undefined && choice.delta.content !== null) {
      if (typeof choice.delta.content !== 'string') throw new ProviderError('Invalid model text delta');
      text += choice.delta.content;
      delta?.(choice.delta.content);
    }
    for (const part of choice.delta?.tool_calls ?? []) {
      if (!object(part) || !Number.isInteger(part.index) || part.index < 0 || part.index >= 64) throw new ProviderError('Invalid model tool index');
      let call = calls.get(part.index);
      if (!call) {
        call = { id: '', type: 'function', function: { name: '', arguments: '' } };
        calls.set(part.index, call);
      }
      if (part.type !== undefined && part.type !== 'function') throw new ProviderError('Unsupported tool type');
      if (part.id !== undefined) {
        if (typeof part.id !== 'string') throw new ProviderError('Invalid tool call id');
        call.id += part.id;
      }
      for (const key of ['name', 'arguments'] as const) {
        const value = part.function?.[key];
        if (value !== undefined) {
          if (typeof value !== 'string') throw new ProviderError('Invalid tool delta');
          call.function[key] += value;
        }
      }
    }
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      if (finishReason) throw new ProviderError('Multiple model finish signals');
      finishReason = choice.finish_reason;
    }
  }
  if (!done || !finishReason) throw new ProviderError('Model stream ended before completion');
  return validateTurn({ text, finishReason, toolCalls: [...calls].sort(([a], [b]) => a - b).map(([, c]) => c), usage });
}

export function createOpenAICompatibleProvider(opts: OpenAICompatibleOptions): ModelProvider {
  if (!opts.model?.trim()) throw new Error('A model is required');
  const baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
  const url = new URL(baseUrl + '/chat/completions');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid model base URL');
  const maxBytes = opts.maxResponseBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid model response byte limit');
  if (opts.maxOutputTokens !== undefined && (!Number.isSafeInteger(opts.maxOutputTokens) || opts.maxOutputTokens < 1)) throw new Error('Invalid model output token limit');
  return {
    id: `${baseUrl}#${opts.model}`,
    async complete(request, signal, delta) {
      const response = await fetch(url, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
        body: JSON.stringify({
          model: opts.model, messages: request.messages.map(({ contextKind, ...message }) =>
            message.role === 'assistant' && message.content === null && !message.tool_calls?.length ? { ...message, content: '' } : message), stream: true,
          stream_options: { include_usage: true }, max_tokens: Math.min(request.maxOutputTokens, opts.maxOutputTokens ?? Infinity),
          ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
          ...(request.tools.length ? { tools: request.tools } : {}),
        }),
      });
      if (!response.ok) {
        // Do not expose response bodies (which can echo keys, prompts, or provider internals).
        let contextLimit = response.status === 413;
        // Inspect at most 8 KiB locally; expose status only to callers/logs.
        if (response.status === 400 && response.body) {
          const reader = response.body.getReader();
          let text = '';
          try {
            while (text.length < 8192) {
              const part = await reader.read(); if (part.done) break;
              text += new TextDecoder().decode(part.value.subarray(0, 8192 - text.length));
            }
            contextLimit = /context_length_exceeded|maximum context length|context window.*exceed/i.test(text);
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        } else await response.body?.cancel();
        throw new ProviderError(`Model HTTP ${response.status}`, response.status === 429 || response.status >= 500, contextLimit);
      }
      if (response.headers.get('content-type')?.includes('text/event-stream')) return decodeStream(response, maxBytes, delta);
      if (!response.body) throw new ProviderError('Missing model response body');
      const reader = response.body.getReader();
      let bytes = 0;
      const parts: Uint8Array[] = [];
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          bytes += next.value.length;
          if (bytes > maxBytes) throw new ProviderError('Model response exceeds byte budget');
          parts.push(next.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      let json: any;
      try { json = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new ProviderError('Malformed model JSON'); }
      const choice = json.choices?.[0];
      if (!choice || !object(choice.message)) throw new ProviderError('Missing model choice');
      return validateTurn({ text: choice.message.content ?? '', toolCalls: choice.message.tool_calls ?? [], finishReason: choice.finish_reason,
        ...(object(json.usage) ? { usage: { inputTokens: Number(json.usage.prompt_tokens ?? 0), outputTokens: Number(json.usage.completion_tokens ?? 0) } } : {}) });
    },
  };
}

export const estimatedTokens = (messages: Message[], tools: ModelRequest['tools'] = []) =>
  Math.ceil(Buffer.byteLength(JSON.stringify({ messages, tools })) / 4);
