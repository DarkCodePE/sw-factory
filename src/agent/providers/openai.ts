import { decodeResponses, responsesBody } from '../chatgpt.ts';
import { ProviderError, streamIdleFromEnv } from '../provider.ts';
import { withIdleResponse, retryAfterMs } from '../transport.ts';
import type { ModelProvider } from '../types.ts';
import { resolveCredential, validateExtraHeaders, type CredentialOptions } from './auth.ts';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export interface OpenAIResponsesOptions extends CredentialOptions {
  model: string;
  baseUrl?: string;
  reasoningEffort?: string;
  maxOutputTokens?: number;
  maxResponseBytes?: number;
  streamIdleMs?: number;
  extraArgs?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
}

export function createOpenAIResponsesProvider(opts: OpenAIResponsesOptions): ModelProvider {
  if (!opts.model?.trim()) throw new Error('A model is required');
  const baseUrl = (opts.baseUrl ?? OPENAI_BASE_URL).replace(/\/$/, '');
  const maxBytes = opts.maxResponseBytes ?? 8 * 1024 * 1024;
  const idleMs = streamIdleFromEnv(opts.streamIdleMs);
  validateExtraHeaders(opts.extraHeaders);

  const getHeaders = async (forceRefresh = false): Promise<Record<string, string>> => {
    const credential = await resolveCredential(opts, forceRefresh);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    if (credential) {
      headers.authorization = `Bearer ${credential}`;
    }
    if (opts.extraHeaders) {
      Object.assign(headers, opts.extraHeaders);
    }
    return headers;
  };

  return {
    id: `openai#${opts.model}`,
    async complete(request, signal, delta) {
      let headers = await getHeaders(false);
      const body = JSON.stringify(
        responsesBody(opts.model, request, opts.reasoningEffort, {
          maxOutputTokens: opts.maxOutputTokens,
          extraArgs: opts.extraArgs,
        }),
      );

      const doRequest = async (currentHeaders: Record<string, string>): Promise<{ status: number; turn?: import('../types.ts').ModelTurn }> => {
        return withIdleResponse(
          `${baseUrl}/responses`,
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
                `OpenAI HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
                response.status === 429 || response.status >= 500,
                isLimit,
                retryAfterMs(response.headers.get('retry-after')),
              );
            }
            if (!response.body) {
              throw new ProviderError('Missing OpenAI response body');
            }
            const turn = await decodeResponses(response.body, maxBytes, delta);
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
            throw new ProviderError('OpenAI HTTP 401: Unauthorized');
          }
          return retried.turn!;
        }
        throw new ProviderError('OpenAI HTTP 401: Unauthorized');
      }

      return result.turn!;
    },
  };
}
