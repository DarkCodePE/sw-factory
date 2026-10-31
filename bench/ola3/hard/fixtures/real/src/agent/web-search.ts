import type { AgentTool, ToolContext } from './types.ts';
import { inputObject, stringArg, tool } from './tools.ts';

const limitText = (s: string, max = 500) => Buffer.byteLength(s) <= max ? s : Buffer.from(s).subarray(0, max).toString('utf8') + '...';

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  external: true;
}

export interface WebSearchToolResult {
  provider: 'searxng' | 'brave';
  query: string;
  results: WebSearchResultItem[];
}

export interface SearchConfig {
  provider?: 'searxng' | 'brave' | 'none';
  url?: string;
  apiKey?: string;
}

export interface ResolvedSearchConfig {
  provider: 'searxng' | 'brave';
  url?: string;
  apiKey?: string;
}

function scrubApiKey(text: string, key?: string): string {
  if (!key || !key.trim()) return text;
  return text.split(key).join('[REDACTED]');
}

export function getSearchConfig(override?: SearchConfig): ResolvedSearchConfig | null {
  if (override) {
    const provider = override.provider?.trim().toLowerCase();
    if (!provider || provider === 'none') return null;
    if (provider === 'searxng') {
      const url = override.url?.trim() || process.env.FABRICA_SEARCH_URL?.trim();
      if (!url) return null;
      return { provider: 'searxng', url };
    }
    if (provider === 'brave') {
      const apiKey = override.apiKey?.trim() || process.env.FABRICA_SEARCH_API_KEY?.trim();
      if (!apiKey) return null;
      const url = override.url?.trim() || process.env.FABRICA_SEARCH_URL?.trim() || 'https://api.search.brave.com/res/v1/web/search';
      return { provider: 'brave', apiKey, url };
    }
    return null;
  }

  const envProvider = (process.env.FABRICA_SEARCH_PROVIDER ?? '').trim().toLowerCase();
  if (!envProvider || envProvider === 'none') return null;

  if (envProvider === 'searxng') {
    const url = (process.env.FABRICA_SEARCH_URL ?? '').trim();
    if (!url) return null;
    return { provider: 'searxng', url };
  }

  if (envProvider === 'brave') {
    const apiKey = (process.env.FABRICA_SEARCH_API_KEY ?? '').trim();
    if (!apiKey) return null;
    const url = (process.env.FABRICA_SEARCH_URL ?? '').trim() || 'https://api.search.brave.com/res/v1/web/search';
    return { provider: 'brave', apiKey, url };
  }

  return null;
}

export function isSearchConfigured(override?: SearchConfig): boolean {
  return getSearchConfig(override) !== null;
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const SEARCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

export async function executeWebSearch(input: unknown, context: ToolContext): Promise<WebSearchToolResult> {
  const config = getSearchConfig(context.searchConfig);
  if (!config) {
    throw new Error('WebSearch: No search provider configured. Set FABRICA_SEARCH_PROVIDER to "searxng" (with FABRICA_SEARCH_URL) or "brave" (with FABRICA_SEARCH_API_KEY).');
  }

  if (!context.networkAccess) {
    throw new Error('WebSearch network access requires a runtime grant');
  }

  const p = inputObject(input);
  const query = stringArg(p, 'query');
  if (!query.trim()) {
    throw new Error('WebSearch query must be a non-empty string');
  }
  if (query.length > 512) {
    throw new Error('WebSearch query exceeds 512 characters');
  }

  const rawMax = p.maxResults !== undefined ? p.maxResults : 5;
  if (typeof rawMax !== 'number' || !Number.isSafeInteger(rawMax) || rawMax < 1 || rawMax > 20) {
    throw new Error('WebSearch maxResults must be an integer between 1 and 20');
  }
  const maxResults = rawMax;

  let currentUrl: URL;
  try {
    currentUrl = new URL(config.url!);
  } catch {
    throw new Error('WebSearch provider URL is invalid');
  }

  if (currentUrl.protocol !== 'http:' && currentUrl.protocol !== 'https:') {
    throw new Error(`WebSearch disallowed URL scheme: ${currentUrl.protocol}`);
  }

  if (config.provider === 'searxng') {
    currentUrl.searchParams.set('q', query);
    currentUrl.searchParams.set('format', 'json');
  } else if (config.provider === 'brave') {
    currentUrl.searchParams.set('q', query);
    currentUrl.searchParams.set('count', String(maxResults));
  }

  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'User-Agent': 'fab-agent/1.0',
  };
  if (config.provider === 'brave' && config.apiKey) {
    headers['X-Subscription-Token'] = config.apiKey;
  }

  const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const signal = context.signal ? AbortSignal.any([context.signal, timeoutSignal]) : timeoutSignal;
  signal.throwIfAborted();

  let response: Response;
  let redirects = 0;

  while (true) {
    signal.throwIfAborted();
    try {
      response = await fetch(currentUrl.toString(), {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal,
      });
    } catch (err: any) {
      signal.throwIfAborted();
      throw new Error(`WebSearch network error: ${scrubApiKey(err?.message ?? String(err), config.apiKey)}`);
    }

    if (response.status >= 300 && response.status < 400) {
      redirects++;
      if (redirects > MAX_REDIRECTS) {
        throw new Error('WebSearch exceeded maximum redirects (5)');
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`WebSearch redirect (${response.status}) without Location header`);
      }
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        throw new Error(`WebSearch invalid redirect URL: ${scrubApiKey(location, config.apiKey)}`);
      }
      if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
        throw new Error(`WebSearch disallowed redirect scheme: ${nextUrl.protocol}`);
      }
      currentUrl = nextUrl;
      continue;
    }
    break;
  }

  const cl = response.headers.get('content-length');
  if (cl && parseInt(cl, 10) > MAX_RESPONSE_BYTES) {
    throw new Error(`WebSearch response exceeds 64 KiB limit (${cl} bytes)`);
  }

  if (!response.body) {
    throw new Error('WebSearch received empty response body');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('WebSearch response exceeded 64 KiB limit');
      }
      chunks.push(value);
    }
  } catch (err: any) {
    signal.throwIfAborted();
    throw err;
  }

  const rawText = Buffer.concat(chunks).toString('utf-8');

  if (!response.ok) {
    const errorBody = limitText(scrubApiKey(rawText, config.apiKey), 500);
    throw new Error(`WebSearch provider returned HTTP ${response.status}: ${errorBody}`);
  }

  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error('WebSearch provider returned invalid JSON');
  }

  if (!data || typeof data !== 'object') {
    throw new Error('WebSearch provider returned invalid JSON object');
  }

  let rawItems: any[] = [];
  if (config.provider === 'searxng') {
    rawItems = Array.isArray(data.results) ? data.results : [];
  } else if (config.provider === 'brave') {
    rawItems = Array.isArray(data.web?.results) ? data.web.results : [];
  }

  const results: WebSearchResultItem[] = rawItems.slice(0, maxResults).map((item: any) => ({
    title: typeof item?.title === 'string' ? item.title.trim() : '',
    url: typeof item?.url === 'string' ? item.url.trim() : '',
    snippet: typeof (item?.snippet ?? item?.content ?? item?.description) === 'string'
      ? String(item.snippet ?? item.content ?? item.description).trim()
      : '',
    external: true as const,
  }));

  return {
    provider: config.provider,
    query,
    results,
  };
}

export function webSearchTool(): AgentTool {
  return tool('WebSearch', 'read', {
    query: { type: 'string', description: 'Search query string (maximum 512 characters).' },
    maxResults: { type: 'integer', description: 'Maximum number of results to return (1 to 20, default 5).' },
  }, ['query'], executeWebSearch, 'Search the web using a configured search engine provider (SearXNG or Brave Search). Returns search results with title, URL and snippet.');
}
