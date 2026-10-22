import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  authenticateMcpServer,
  getMcpAuthPath,
  McpRuntime,
  readTokenStore,
  startOAuthFlow,
  validateOAuthOptions,
  writeTokenStore,
} from '../src/agent/mcp-oauth.ts';
import { McpManager } from '../src/agent/mcp.ts';
import type { ToolContext } from '../src/agent/types.ts';

const fixturePath = fileURLToPath(new URL('../scripts/mcp-fixture.ts', import.meta.url));
const spawnedProcs: Array<ReturnType<typeof Bun.spawn>> = [];

function createContext(signal = new AbortController().signal): ToolContext {
  return {
    cwd: '/tmp',
    autonomy: 'medium',
    interactionMode: 'auto',
    sandbox: 'required',
    signal,
  };
}

beforeEach(() => {
  McpRuntime.clear();
  process.env.FABRICA_HOME = `/tmp/fab-test-home-${Date.now()}`;
});

afterEach(() => {
  McpRuntime.clear();
  for (const p of spawnedProcs.splice(0)) {
    try { p.kill(); } catch {}
  }
});

async function startOAuthFixture(): Promise<{ port: number; proc: ReturnType<typeof Bun.spawn> }> {
  const proc = Bun.spawn([process.execPath, fixturePath, '--oauth'], {
    stdout: 'pipe',
    stderr: 'inherit',
  });
  spawnedProcs.push(proc);

  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let port = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(buffer);
    if (match) {
      port = Number(match[1]);
      break;
    }
  }
  reader.releaseLock();
  if (!port) throw new Error('Failed to start OAuth fixture');
  return { port, proc };
}

describe('MCP OAuth Protocol', () => {
  test('positive: full OAuth flow, token persistence (0600), reuse in second session, and refresh after expiry', async () => {
    const { port } = await startOAuthFixture();
    const serverUrl = `http://127.0.0.1:${port}/mcp`;
    const serverName = 'fixture-auth';

    const mcpConfig = {
      url: serverUrl,
    };

    const ctx1 = createContext();
    const manager1 = new McpManager({ [serverName]: mcpConfig }, ctx1);

    // Initial attempt throws authentication required
    await expect(manager1.tools()).rejects.toThrow(/requires authentication/);
    const statuses1 = McpRuntime.status();
    const st1 = statuses1.find(s => s.server === serverName);
    expect(st1).toBeDefined();
    expect(st1!.state).toBe('needs authentication');
    expect(st1!.authorizeUrl).toContain(`http://127.0.0.1:${port}/authorize`);

    // Complete OAuth authentication using openUrl callback
    await authenticateMcpServer(serverName, {
      openUrl: async (authorizeUrl) => {
        // Fetch authorizeUrl following redirects so callback is hit
        const res = await fetch(authorizeUrl, { redirect: 'follow' });
        expect(res.ok).toBe(true);
      },
    });

    const statuses2 = McpRuntime.status();
    const st2 = statuses2.find(s => s.server === serverName);
    expect(st2!.state).toBe('connected');

    // Verify token was stored to disk with mode 0600
    const authFile = getMcpAuthPath();
    const fileStat = await stat(authFile);
    expect(fileStat.mode & 0o777).toBe(0o600);

    const store1 = await readTokenStore();
    const tokenRecord = store1[serverUrl];
    expect(tokenRecord).toBeDefined();
    expect(tokenRecord!.accessToken).toBe('fixture-valid-token');
    expect(tokenRecord!.refreshToken).toBe('fixture-refresh-token');

    await manager1.close();

    // Second session: reuses stored token without needing authenticateMcpServer
    const ctx2 = createContext();
    const manager2 = new McpManager({ [serverName]: mcpConfig }, ctx2);
    const tools2 = await manager2.tools();
    expect(tools2.length).toBeGreaterThan(0);
    expect(tools2.some(t => t.schema.function.name === `${serverName}___echo`)).toBe(true);
    await manager2.close();

    // Third session: token is expired, should refresh automatically
    const storeToUpdate = await readTokenStore();
    storeToUpdate[serverUrl]!.expiresAt = Date.now() - 10_000; // Expired 10s ago
    await writeTokenStore(storeToUpdate);

    const ctx3 = createContext();
    const manager3 = new McpManager({ [serverName]: mcpConfig }, ctx3);
    const tools3 = await manager3.tools();
    expect(tools3.length).toBeGreaterThan(0);

    const storeAfterRefresh = await readTokenStore();
    expect(storeAfterRefresh[serverUrl]!.accessToken).toBe('fixture-refreshed-token');
    await manager3.close();
  });

  test('negative: rejects clientId without authorizationServerIssuer', () => {
    expect(() => validateOAuthOptions({ clientId: 'my-id' })).toThrow(
      /clientId requires authorizationServerIssuer/,
    );
  });

  test('negative: rejects clientMetadataUrl with clientId', () => {
    expect(() =>
      validateOAuthOptions({
        clientId: 'my-id',
        authorizationServerIssuer: 'https://auth.example.com',
        clientMetadataUrl: 'https://client.example.com/meta',
      }),
    ).toThrow(/clientMetadataUrl and clientId are mutually exclusive/);
  });

  test('negative: corrupt token store file is ignored with warning without throwing', async () => {
    const authFile = getMcpAuthPath();
    await Bun.write(authFile, '{ corrupt json invalid: true');
    const store = await readTokenStore();
    expect(store).toEqual({});
  });

  test('negative: oauth false with 401 sets failed state without starting flow', async () => {
    const { port } = await startOAuthFixture();
    const serverUrl = `http://127.0.0.1:${port}/mcp`;
    const serverName = 'fixture-no-oauth';

    const ctx = createContext();
    const manager = new McpManager(
      {
        [serverName]: {
          url: serverUrl,
          oauth: false,
        },
      },
      ctx,
    );

    await expect(manager.tools()).rejects.toThrow(/401/);
    const statuses = McpRuntime.status();
    const st = statuses.find(s => s.server === serverName);
    expect(st).toBeDefined();
    expect(st!.state).toBe('failed');
    await manager.close();
  });

  test('cancellation: abort during OAuth handshake closes callback server and frees port (3 repetitions)', async () => {
    const testPort = 19875;

    for (let i = 0; i < 3; i++) {
      const abortCtrl = new AbortController();
      const session = await startOAuthFlow(
        `server-${i}`,
        {
          url: 'http://127.0.0.1:9999/mcp',
          oauth: { callbackPort: testPort },
        },
        abortCtrl.signal,
      );

      expect(session.callbackServer).toBeDefined();
      expect(session.callbackServer.port).toBe(testPort);

      // Abort the flow
      abortCtrl.abort(new Error('Handshake aborted'));
      await expect(session.promise).rejects.toThrow(/aborted/);

      // Give a tick for socket release
      await Bun.sleep(20);

      // Verify that another server can bind to testPort immediately without EADDRINUSE
      const probeServer = Bun.serve({
        port: testPort,
        hostname: '127.0.0.1',
        fetch() {
          return new Response('OK');
        },
      });
      expect(probeServer.port).toBe(testPort);
      probeServer.stop(true);
    }
  });
});
