// Synthetic MCP server used only by local contract tests and CLI parity validation.
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const isOAuth = args.includes('--oauth');
const hasResources = args.includes('--resources') || args.includes('--all-capabilities') || isOAuth;
const hasPrompts = args.includes('--prompts') || args.includes('--all-capabilities') || isOAuth;

let calls = 0;

async function handleJsonRpc(frame: any): Promise<{ result?: unknown; error?: unknown }> {
  if (!frame.method || !Object.hasOwn(frame, 'id')) return {};
  const p = frame.params as any;

  if (frame.method === 'initialize') {
    const caps: Record<string, unknown> = { tools: {} };
    if (hasResources) caps.resources = {};
    if (hasPrompts) caps.prompts = {};
    return {
      result: {
        protocolVersion: '2025-11-25',
        capabilities: caps,
        serverInfo: { name: 'fixture', version: '1' },
      },
    };
  }

  if (frame.method === 'tools/list') {
    return {
      result: p?.cursor
        ? {
            tools: [
              { name: 'write', description: 'Synthetic write', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
              { name: 'hang', description: 'Synthetic timeout', inputSchema: { type: 'object' } },
            ],
          }
        : {
            tools: [{ name: 'echo', description: 'Synthetic echo', inputSchema: { type: 'object' } }],
            nextCursor: 'second',
          },
    };
  }

  if (frame.method === 'tools/call') {
    calls++;
    if (p.name === 'hang') {
      Bun.spawn(['sh', '-c', 'sleep 0.2; printf late > late.txt'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      await new Promise(() => {});
    }
    if (p.name === 'write') {
      await Bun.write('mcp-out.txt', String(p.arguments?.text ?? ''));
    }
    return {
      result: {
        content: [{ type: 'text', text: 'fixture result' }],
        structuredContent: {
          input: p.arguments,
          calls,
          allowed: process.env.MCP_ALLOWED,
          leaked: !!process.env.FAB_MCP_HOST_SECRET,
          ...(process.env.MCP_FORBIDDEN_READ ? { forbiddenReadable: await Bun.file(process.env.MCP_FORBIDDEN_READ).exists() } : {}),
        },
      },
    };
  }

  if (frame.method === 'resources/list') {
    if (p?.cursor === 'page2') {
      return {
        result: {
          resources: [
            { uri: 'fixture://resource/3', name: 'Resource Three', mimeType: 'text/plain', description: 'Third resource' },
          ],
        },
      };
    }
    if (p?.cursor === 'paginated-100') {
      const items = Array.from({ length: 50 }, (_, i) => ({
        uri: `fixture://paged/${i + 50}`,
        name: `Resource ${i + 50}`,
        mimeType: 'text/plain',
      }));
      return { result: { resources: items } };
    }
    if (p?.cursor === undefined && args.includes('--test-100-pages')) {
      const items = Array.from({ length: 50 }, (_, i) => ({
        uri: `fixture://paged/${i}`,
        name: `Resource ${i}`,
        mimeType: 'text/plain',
      }));
      return { result: { resources: items, nextCursor: 'paginated-100' } };
    }
    return {
      result: {
        resources: [
          { uri: 'fixture://resource/1', name: 'Resource One', mimeType: 'text/plain', description: 'First resource' },
          { uri: 'fixture://resource/2', name: 'Resource Two', mimeType: 'application/json', description: 'Second resource' },
        ],
        nextCursor: 'page2',
      },
    };
  }

  if (frame.method === 'resources/templates/list') {
    return {
      result: {
        resourceTemplates: [
          { uriTemplate: 'fixture://resource/{id}', name: 'Resource Template', mimeType: 'text/plain', description: 'Template' },
        ],
      },
    };
  }

  if (frame.method === 'resources/read') {
    if (p?.uri === 'fixture://oversize') {
      // 1 MiB + 100 bytes
      const bigText = 'X'.repeat(1024 * 1024 + 100);
      return { result: { contents: [{ uri: p.uri, mimeType: 'text/plain', text: bigText }] } };
    }
    return {
      result: {
        contents: [
          { uri: p?.uri, mimeType: 'text/plain', text: `Contents of ${p?.uri}` },
        ],
      },
    };
  }

  if (frame.method === 'prompts/list') {
    return {
      result: {
        prompts: [
          {
            name: 'greeting',
            description: 'Friendly greeting',
            arguments: [{ name: 'name', description: 'User name', required: true }],
          },
          {
            name: 'code-review',
            description: 'Code review assistant',
            arguments: [{ name: 'code', description: 'Code snippet' }],
          },
        ],
      },
    };
  }

  if (frame.method === 'prompts/get') {
    return {
      result: {
        description: `Prompt for ${p?.name}`,
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: `Hello, ${p?.arguments?.name ?? 'developer'}!` },
          },
        ],
      },
    };
  }

  return { error: { code: -32601, message: 'Unknown method' } };
}

if (isOAuth || args.includes('--http') || args.includes('--sse')) {
  // HTTP / SSE server mode
  const portIndex = args.indexOf('--port');
  const port = portIndex !== -1 && args[portIndex + 1] ? Number(args[portIndex + 1]) : 0;
  let activeSseController: ReadableStreamDefaultController<Uint8Array> | undefined;

  const validTokens = new Set(['fixture-valid-token', 'fixture-refreshed-token', 'synthetic-token']);

  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const host = `http://127.0.0.1:${server.port}`;

      if (url.pathname === '/.well-known/oauth-protected-resource') {
        return Response.json({
          resource: host,
          authorization_servers: [host],
        });
      }

      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return Response.json({
          issuer: host,
          authorization_endpoint: `${host}/authorize`,
          token_endpoint: `${host}/token`,
          registration_endpoint: `${host}/register`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        });
      }

      if (url.pathname === '/register' && req.method === 'POST') {
        return Response.json({
          client_id: 'fixture-client-id',
          client_secret: 'fixture-client-secret',
        }, { status: 201 });
      }

      if (url.pathname === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri');
        const state = url.searchParams.get('state');
        if (!redirectUri) return new Response('Missing redirect_uri', { status: 400 });
        const target = new URL(redirectUri);
        target.searchParams.set('code', 'synthetic-auth-code');
        if (state) target.searchParams.set('state', state);
        return Response.redirect(target.toString(), 302);
      }

      if (url.pathname === '/token' && req.method === 'POST') {
        const bodyText = await req.text();
        const params = new URLSearchParams(bodyText);
        const grantType = params.get('grant_type');

        if (grantType === 'authorization_code') {
          const code = params.get('code');
          if (code !== 'synthetic-auth-code') {
            return Response.json({ error: 'invalid_grant' }, { status: 400 });
          }
          return Response.json({
            access_token: 'fixture-valid-token',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'fixture-refresh-token',
          });
        }

        if (grantType === 'refresh_token') {
          const refreshToken = params.get('refresh_token');
          if (refreshToken !== 'fixture-refresh-token') {
            return Response.json({ error: 'invalid_grant' }, { status: 400 });
          }
          return Response.json({
            access_token: 'fixture-refreshed-token',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'fixture-refresh-token',
          });
        }

        return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
      }

      // Check Bearer auth in OAuth mode
      if (isOAuth) {
        const auth = req.headers.get('authorization') ?? '';
        const match = /^Bearer\s+(.+)$/i.exec(auth);
        const token = match?.[1];
        if (!token || !validTokens.has(token)) {
          return new Response('Unauthorized', {
            status: 401,
            headers: {
              'WWW-Authenticate': `Bearer resource_metadata="${host}/.well-known/oauth-protected-resource"`,
            },
          });
        }
      }

      // SSE transport endpoint
      if (url.pathname === '/sse') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            activeSseController = controller;
            const endpointEvent = `event: endpoint\ndata: ${host}/mcp-messages\n\n`;
            controller.enqueue(new TextEncoder().encode(endpointEvent));
          },
          cancel() {
            activeSseController = undefined;
          },
        });
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        });
      }

      // POST message endpoint for SSE transport
      if (url.pathname === '/mcp-messages' && req.method === 'POST') {
        const frame = await req.json();
        const outcome = await handleJsonRpc(frame);
        if (activeSseController) {
          const resp = { jsonrpc: '2.0', id: frame.id, ...outcome };
          const sseMsg = `event: message\ndata: ${JSON.stringify(resp)}\n\n`;
          activeSseController.enqueue(new TextEncoder().encode(sseMsg));
        }
        return new Response(null, { status: 202 });
      }

      // Standard HTTP POST JSON-RPC endpoint
      if (req.method === 'POST') {
        const frame = await req.json();
        if (!Object.hasOwn(frame, 'id')) {
          await handleJsonRpc(frame);
          return new Response(null, { status: 202 });
        }
        const outcome = await handleJsonRpc(frame);
        return Response.json({ jsonrpc: '2.0', id: frame.id, ...outcome });
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  console.log(`MCP fixture listening on http://127.0.0.1:${server.port}`);
} else {
  // Stdio transport mode
  const send = (frame: unknown) => process.stdout.write(JSON.stringify(frame) + '\n');
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (!frame.method || !Object.hasOwn(frame, 'id')) continue;
    const outcome = await handleJsonRpc(frame);
    send({ jsonrpc: '2.0', id: frame.id, ...outcome });
  }
}
