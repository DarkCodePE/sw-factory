import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { McpConfig } from './mcp.ts';

export type McpServerState = 'connected' | 'connecting' | 'needs authentication' | 'failed';

export interface McpServerStatus {
  server: string;
  state: McpServerState;
  transport: 'stdio' | 'http' | 'sse';
  fingerprint: string;
  authorizeUrl?: string;
}

export interface McpOAuthOptions {
  scopes?: string | string[];
  resource?: string;
  authorizationServerIssuer?: string;
  clientId?: string;
  clientSecret?: string;
  clientMetadataUrl?: string;
  tokenEndpointAuthMethod?: string;
  callbackPort?: number;
}

export interface StoredToken {
  accessToken: string;
  tokenType?: string;
  expiresAt?: number;
  refreshToken?: string;
  scope?: string;
  clientId?: string;
  tokenEndpoint?: string;
}

interface ActiveOAuthSession {
  serverName: string;
  config: McpConfig;
  fingerprint: string;
  authorizeUrl: string;
  codeVerifier: string;
  state: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes?: string;
  resource?: string;
  callbackServer: ReturnType<typeof Bun.serve>;
  promise: Promise<StoredToken>;
  resolve: (token: StoredToken) => void;
  reject: (error: Error) => void;
}

const activeSessions = new Map<string, ActiveOAuthSession>();
const serverStatuses = new Map<string, McpServerStatus>();

export function getMcpAuthPath(): string {
  const base = process.env.FABRICA_HOME
    ? resolve(process.env.FABRICA_HOME)
    : resolve(process.env.HOME ?? homedir(), '.fabrica');
  return resolve(base, 'mcp-auth.json');
}

export function serverFingerprint(config: McpConfig): string {
  if (config.url) return config.url.trim().replace(/\/$/, '');
  if (config.command) return `${config.command} ${(config.args ?? []).join(' ')}`.trim();
  return 'unknown';
}

export function serverTransport(config: McpConfig): 'stdio' | 'http' | 'sse' {
  if (config.command) return 'stdio';
  if (config.type === 'sse') return 'sse';
  return 'http';
}

export async function readTokenStore(): Promise<Record<string, StoredToken>> {
  const file = getMcpAuthPath();
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, StoredToken>;
    }
    console.warn(`Warning: Corrupt token store at ${file}; ignoring.`);
    return {};
  } catch (err: any) {
    if (err?.code === 'ENOENT') return {};
    console.warn(`Warning: Could not read token store at ${file}: ${err?.message ?? String(err)}`);
    return {};
  }
}

export async function writeTokenStore(store: Record<string, StoredToken>): Promise<void> {
  const file = getMcpAuthPath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(store, null, 2), { mode: 0o600 });
}

export async function getStoredToken(fingerprint: string): Promise<StoredToken | undefined> {
  const store = await readTokenStore();
  return store[fingerprint];
}

export async function saveStoredToken(fingerprint: string, token: StoredToken): Promise<void> {
  const store = await readTokenStore();
  store[fingerprint] = token;
  await writeTokenStore(store);
}

export function validateOAuthOptions(oauth: unknown): McpOAuthOptions | undefined {
  if (oauth === false || oauth === undefined) return undefined;
  if (typeof oauth !== 'object' || oauth === null || Array.isArray(oauth)) {
    throw new Error('Invalid MCP OAuth configuration');
  }
  const o = oauth as McpOAuthOptions;
  if (o.clientId && !o.authorizationServerIssuer) {
    throw new Error('clientId requires authorizationServerIssuer');
  }
  if (o.clientMetadataUrl && o.clientId) {
    throw new Error('clientMetadataUrl and clientId are mutually exclusive');
  }
  if (o.callbackPort !== undefined && (!Number.isSafeInteger(o.callbackPort) || o.callbackPort < 0 || o.callbackPort > 65535)) {
    throw new Error('Invalid callbackPort');
  }
  return o;
}

export async function discoverEndpoints(
  serverUrl: string,
  options: McpOAuthOptions = {},
): Promise<{ authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint?: string; resource?: string }> {
  let issuer = options.authorizationServerIssuer;
  let resource = options.resource;

  if (!issuer) {
    const origin = new URL(serverUrl).origin;
    try {
      const res = await fetch(`${origin}/.well-known/oauth-protected-resource`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const meta = await res.json() as any;
        if (typeof meta?.resource === 'string') resource ??= meta.resource;
        if (Array.isArray(meta?.authorization_servers) && typeof meta.authorization_servers[0] === 'string') issuer = meta.authorization_servers[0];
      }
    } catch {}
  }

  issuer = (issuer ?? new URL(serverUrl).origin).replace(/\/$/, '');
  let authEndpoint = '';
  let tokenEndpoint = '';
  let registrationEndpoint: string | undefined;

  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
    if (authEndpoint && tokenEndpoint) break;
    try {
      const res = await fetch(`${issuer}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const meta = await res.json() as any;
        if (!authEndpoint && typeof meta?.authorization_endpoint === 'string') authEndpoint = meta.authorization_endpoint;
        if (!tokenEndpoint && typeof meta?.token_endpoint === 'string') tokenEndpoint = meta.token_endpoint;
        if (!registrationEndpoint && typeof meta?.registration_endpoint === 'string') registrationEndpoint = meta.registration_endpoint;
      }
    } catch {}
  }

  return {
    authorizationEndpoint: authEndpoint || `${issuer}/authorize`,
    tokenEndpoint: tokenEndpoint || `${issuer}/token`,
    registrationEndpoint,
    resource,
  };
}

export async function registerDynamicClient(
  registrationEndpoint: string,
  redirectUri: string,
  authMethod = 'none',
): Promise<{ clientId: string; clientSecret?: string }> {
  const body = { client_name: 'fab', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: authMethod };
  const res = await fetch(registrationEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Dynamic Client Registration failed (HTTP ${res.status})`);
  const json = await res.json() as any;
  if (!json?.client_id || typeof json.client_id !== 'string') throw new Error('Dynamic Client Registration response missing client_id');
  return { clientId: json.client_id, clientSecret: typeof json.client_secret === 'string' ? json.client_secret : undefined };
}

export async function refreshAccessToken(
  tokenEndpoint: string,
  clientId: string,
  refreshToken: string,
  clientSecret?: string,
): Promise<StoredToken> {
  const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
  if (clientSecret) params.set('client_secret', clientSecret);
  const res = await fetch(tokenEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: params.toString(), signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Token refresh failed (HTTP ${res.status})`);
  const json = await res.json() as any;
  if (!json?.access_token || typeof json.access_token !== 'string') throw new Error('Refresh response missing access_token');
  const expiresAt = typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : undefined;
  return { accessToken: json.access_token, tokenType: json.token_type ?? 'Bearer', expiresAt, refreshToken: json.refresh_token ?? refreshToken, scope: json.scope, clientId, tokenEndpoint };
}

export async function startOAuthFlow(
  serverName: string,
  config: McpConfig,
  parentSignal?: AbortSignal,
): Promise<ActiveOAuthSession> {
  const existing = activeSessions.get(serverName);
  if (existing) return existing;

  const fp = serverFingerprint(config);
  const oauthOpts = validateOAuthOptions(config.oauth) ?? {};
  const endpoints = await discoverEndpoints(config.url!, oauthOpts);

  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(16).toString('hex');
  const requestedPort = oauthOpts.callbackPort ?? 0;

  let resolveToken!: (token: StoredToken) => void;
  let rejectToken!: (error: Error) => void;
  const tokenPromise = new Promise<StoredToken>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  let server: ReturnType<typeof Bun.serve>;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  const closeCallbackServer = () => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    try { server.stop(true); } catch {}
  };

  const onAbort = () => {
    closeCallbackServer();
    rejectToken(new Error('OAuth flow aborted'));
    activeSessions.delete(serverName);
    serverStatuses.set(serverName, {
      server: serverName,
      state: 'failed',
      transport: serverTransport(config),
      fingerprint: fp,
    });
  };

  if (parentSignal) {
    parentSignal.addEventListener('abort', onAbort, { once: true });
  }

  let clientId = oauthOpts.clientId ?? '';
  let clientSecret = oauthOpts.clientSecret;

  server = Bun.serve({
    hostname: '127.0.0.1',
    port: requestedPort,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/callback') {
        return new Response('Not found', { status: 404 });
      }
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      if (!code || returnedState !== state) {
        closeCallbackServer();
        const err = new Error('OAuth callback state mismatch or missing code');
        rejectToken(err);
        return new Response('Authentication failed', { status: 400 });
      }

      // Exchange authorization code for tokens
      try {
        const bodyParams = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: `http://127.0.0.1:${server.port}/callback`,
          client_id: clientId,
          code_verifier: codeVerifier,
        });
        if (clientSecret) bodyParams.set('client_secret', clientSecret);

        const tokenRes = await fetch(endpoints.tokenEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: bodyParams.toString(),
        });

        if (!tokenRes.ok) {
          throw new Error(`Token exchange failed (HTTP ${tokenRes.status})`);
        }
        const json = await tokenRes.json() as any;
        if (!json?.access_token || typeof json.access_token !== 'string') {
          throw new Error('Token exchange response missing access_token');
        }
        const expiresAt = typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : undefined;
        const record: StoredToken = {
          accessToken: json.access_token,
          tokenType: json.token_type ?? 'Bearer',
          expiresAt,
          refreshToken: json.refresh_token,
          scope: json.scope,
          clientId,
          tokenEndpoint: endpoints.tokenEndpoint,
        };
        await saveStoredToken(fp, record);
        resolveToken(record);
        serverStatuses.set(serverName, {
          server: serverName,
          state: 'connected',
          transport: serverTransport(config),
          fingerprint: fp,
        });
        return new Response('Authentication successful! You may close this window.', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      } catch (err: any) {
        rejectToken(err);
        return new Response(`Authentication error: ${err.message}`, { status: 500 });
      } finally {
        setTimeout(closeCallbackServer, 20);
        activeSessions.delete(serverName);
      }
    },
  });

  const redirectUri = `http://127.0.0.1:${server.port}/callback`;

  if (!clientId) {
    if (endpoints.registrationEndpoint) {
      try {
        const reg = await registerDynamicClient(endpoints.registrationEndpoint, redirectUri, oauthOpts.tokenEndpointAuthMethod);
        clientId = reg.clientId;
        clientSecret = reg.clientSecret;
      } catch {
        clientId = 'fab-client';
      }
    } else {
      clientId = 'fab-client';
    }
  }

  const authUrl = new URL(endpoints.authorizationEndpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const scopes = Array.isArray(oauthOpts.scopes) ? oauthOpts.scopes.join(' ') : oauthOpts.scopes;
  if (scopes) authUrl.searchParams.set('scope', scopes);
  if (endpoints.resource) authUrl.searchParams.set('resource', endpoints.resource);

  timeoutTimer = setTimeout(() => {
    closeCallbackServer();
    rejectToken(new Error('OAuth callback timed out after 5 minutes'));
    activeSessions.delete(serverName);
    serverStatuses.set(serverName, {
      server: serverName,
      state: 'failed',
      transport: serverTransport(config),
      fingerprint: fp,
    });
  }, 300_000);

  const session: ActiveOAuthSession = {
    serverName,
    config,
    fingerprint: fp,
    authorizeUrl: authUrl.toString(),
    codeVerifier,
    state,
    tokenEndpoint: endpoints.tokenEndpoint,
    clientId,
    clientSecret,
    redirectUri,
    scopes,
    resource: endpoints.resource,
    callbackServer: server,
    promise: tokenPromise,
    resolve: resolveToken,
    reject: rejectToken,
  };

  activeSessions.set(serverName, session);
  serverStatuses.set(serverName, {
    server: serverName,
    state: 'needs authentication',
    transport: serverTransport(config),
    fingerprint: fp,
    authorizeUrl: session.authorizeUrl,
  });

  return session;
}

export class McpRuntime {
  static status(): McpServerStatus[] {
    return Array.from(serverStatuses.values());
  }

  static setStatus(name: string, status: McpServerStatus): void {
    serverStatuses.set(name, status);
  }

  static clear(): void {
    for (const s of activeSessions.values()) {
      try { s.callbackServer.stop(true); } catch {}
    }
    activeSessions.clear();
    serverStatuses.clear();
  }
}

export async function authenticateMcpServer(
  serverName: string,
  options: {
    openUrl?: (url: string) => Promise<void> | void;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const session = activeSessions.get(serverName);
  if (!session) {
    const current = serverStatuses.get(serverName);
    if (current?.state === 'connected') return;
    throw new Error(`No active OAuth session for MCP server "${serverName}"`);
  }

  if (options.openUrl) {
    await options.openUrl(session.authorizeUrl);
  }

  if (options.signal) {
    options.signal.addEventListener('abort', () => {
      try { session.callbackServer.stop(true); } catch {}
      session.reject(new Error('OAuth authentication aborted'));
    }, { once: true });
  }

  await session.promise;
}
