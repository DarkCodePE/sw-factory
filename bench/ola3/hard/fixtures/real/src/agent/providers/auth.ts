import { ProviderError } from '../provider.ts';

export interface CredentialOptions {
  apiKey?: string;
  apiKeyHelper?: string | string[];
}

const helperCache = new Map<string, string>();

export function clearCredentialCache(): void {
  helperCache.clear();
}

export function validateExtraHeaders(headers?: Record<string, string>): void {
  if (headers === undefined) return;
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    throw new Error('extraHeaders must be an object');
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string') throw new Error(`extraHeaders value for "${key}" must be a string`);
    const lower = key.toLowerCase().trim();
    if (lower === 'host' || lower === 'content-length') {
      throw new Error(`Forbidden header in extraHeaders: ${key}`);
    }
  }
}

export async function resolveCredential(
  options: CredentialOptions,
  forceRefresh = false,
): Promise<string> {
  const { apiKey, apiKeyHelper } = options;
  if (!apiKeyHelper) {
    return apiKey ?? '';
  }

  const argv = Array.isArray(apiKeyHelper)
    ? apiKeyHelper.map(String)
    : [String(apiKeyHelper)];

  if (argv.length === 0 || !argv[0]?.trim()) {
    throw new Error('Invalid apiKeyHelper: empty command');
  }

  const cacheKey = JSON.stringify(argv);
  if (!forceRefresh && helperCache.has(cacheKey)) {
    return helperCache.get(cacheKey)!;
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err: any) {
    throw new Error(`apiKeyHelper failed to start: ${err?.message ?? String(err)}`);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      reject(new Error('apiKeyHelper timed out after 10 s'));
    }, 10_000);
  });

  const readStdout = async (): Promise<string> => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    let bytes = 0;
    const parts: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes <= 4096) {
          parts.push(value);
        } else {
          const remaining = 4096 - (bytes - value.length);
          if (remaining > 0) parts.push(value.subarray(0, remaining));
        }
      }
    } finally {
      reader.releaseLock();
    }
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const errReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      let errText = '';
      try {
        const { value } = await errReader.read();
        if (value) errText = new TextDecoder().decode(value).slice(0, 500);
      } catch {} finally {
        errReader.releaseLock();
      }
      throw new Error(`apiKeyHelper exited with code ${exitCode}${errText ? `: ${errText}` : ''}`);
    }
    const full = Buffer.concat(parts).toString('utf8').slice(0, 4096).trim();
    return full;
  };

  try {
    const token = await Promise.race([readStdout(), timeoutPromise]);
    helperCache.set(cacheKey, token);
    return token;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
