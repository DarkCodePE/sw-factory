import type { AgentTool, ToolContext } from './types.ts';

const MAX_RESOURCE_BYTES = 1024 * 1024; // 1 MiB

const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);

export interface McpTarget {
  name: string;
  call(method: string, params: unknown, signal: AbortSignal, timeoutMs: number): Promise<any>;
}

export function createResourceTools(
  getServers: () => Map<string, McpTarget>,
  selection?: { only?: string[]; remove?: string[] },
): AgentTool[] {
  const tools: AgentTool[] = [];

  const listToolName = 'ListMcpResources';
  if (!selection?.remove?.includes(listToolName) && (!selection?.only || selection.only.includes(listToolName))) {
    tools.push({
      effect: 'read',
      schema: {
        type: 'function',
        function: {
          name: listToolName,
          description: 'List available MCP resources and resource templates',
          parameters: {
            type: 'object',
            properties: {
              server: { type: 'string', description: 'Optional server name to filter resources' },
            },
          },
        },
      },
      run: async (input: unknown, context: ToolContext) => {
        const inp = object(input) ? input : {};
        const targetServer = typeof inp.server === 'string' ? inp.server : undefined;
        const servers = getServers();
        const results: any[] = [];

        for (const [name, target] of servers.entries()) {
          if (targetServer && targetServer !== name) continue;
          let cursor: string | undefined;
          let pages = 0;
          do {
            if (++pages > 16) throw new Error('MCP resources pagination limit exceeded');
            const page = await target.call('resources/list', cursor ? { cursor } : {}, context.signal, 15_000);
            if (object(page) && Array.isArray(page.resources)) {
              for (const r of page.resources) {
                if (object(r) && typeof r.uri === 'string') {
                  results.push({
                    server: name,
                    uri: r.uri,
                    name: r.name ?? r.uri,
                    mimeType: r.mimeType,
                    description: r.description,
                  });
                }
              }
            }
            cursor = typeof page?.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
          } while (cursor);

          // Also fetch resource templates
          try {
            const tmplPage = await target.call('resources/templates/list', {}, context.signal, 15_000);
            if (object(tmplPage) && Array.isArray(tmplPage.resourceTemplates)) {
              for (const t of tmplPage.resourceTemplates) {
                if (object(t) && typeof t.uriTemplate === 'string') {
                  results.push({
                    server: name,
                    uriTemplate: t.uriTemplate,
                    name: t.name ?? t.uriTemplate,
                    mimeType: t.mimeType,
                    description: t.description,
                  });
                }
              }
            }
          } catch {}
        }
        return { resources: results };
      },
    });
  }

  const readToolName = 'ReadMcpResource';
  if (!selection?.remove?.includes(readToolName) && (!selection?.only || selection.only.includes(readToolName))) {
    tools.push({
      effect: 'read',
      schema: {
        type: 'function',
        function: {
          name: readToolName,
          description: 'Read the contents of an MCP resource',
          parameters: {
            type: 'object',
            properties: {
              server: { type: 'string', description: 'MCP server name' },
              uri: { type: 'string', description: 'Resource URI' },
            },
            required: ['server', 'uri'],
          },
        },
      },
      run: async (input: unknown, context: ToolContext) => {
        if (!object(input) || typeof input.server !== 'string' || typeof input.uri !== 'string' || !input.server || !input.uri) {
          throw new Error('ReadMcpResource requires server and uri');
        }
        const servers = getServers();
        const target = servers.get(input.server);
        if (!target) throw new Error(`MCP server "${input.server}" not found or has no resources capability`);

        const res = await target.call('resources/read', { uri: input.uri }, context.signal, 15_000);
        if (!object(res) || !Array.isArray(res.contents)) {
          throw new Error('Invalid MCP resources/read response');
        }

        let totalBytes = 0;
        for (const item of res.contents) {
          if (!object(item)) continue;
          if (typeof item.text === 'string') {
            totalBytes += Buffer.byteLength(item.text);
          } else if (typeof item.blob === 'string') {
            totalBytes += Math.ceil((item.blob.length * 3) / 4);
          }
          if (totalBytes > MAX_RESOURCE_BYTES) {
            throw new Error(`MCP resource exceeds 1 MiB limit (${totalBytes} bytes)`);
          }
        }

        return res;
      },
    });
  }

  return tools;
}

export function createPromptTools(
  getServers: () => Map<string, McpTarget>,
  selection?: { only?: string[]; remove?: string[] },
): AgentTool[] {
  const tools: AgentTool[] = [];

  const listToolName = 'ListMcpPrompts';
  if (!selection?.remove?.includes(listToolName) && (!selection?.only || selection.only.includes(listToolName))) {
    tools.push({
      effect: 'read',
      schema: {
        type: 'function',
        function: {
          name: listToolName,
          description: 'List available MCP prompts',
          parameters: {
            type: 'object',
            properties: {
              server: { type: 'string', description: 'Optional server name to filter prompts' },
            },
          },
        },
      },
      run: async (input: unknown, context: ToolContext) => {
        const inp = object(input) ? input : {};
        const targetServer = typeof inp.server === 'string' ? inp.server : undefined;
        const servers = getServers();
        const results: any[] = [];

        for (const [name, target] of servers.entries()) {
          if (targetServer && targetServer !== name) continue;
          let cursor: string | undefined;
          let pages = 0;
          do {
            if (++pages > 16) throw new Error('MCP prompts pagination limit exceeded');
            const page = await target.call('prompts/list', cursor ? { cursor } : {}, context.signal, 15_000);
            if (object(page) && Array.isArray(page.prompts)) {
              for (const p of page.prompts) {
                if (object(p) && typeof p.name === 'string') {
                  results.push({
                    server: name,
                    name: p.name,
                    description: p.description,
                    arguments: p.arguments,
                  });
                }
              }
            }
            cursor = typeof page?.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
          } while (cursor);
        }
        return { prompts: results };
      },
    });
  }

  const getToolName = 'GetMcpPrompt';
  if (!selection?.remove?.includes(getToolName) && (!selection?.only || selection.only.includes(getToolName))) {
    tools.push({
      effect: 'read',
      schema: {
        type: 'function',
        function: {
          name: getToolName,
          description: 'Get a prompt template from an MCP server',
          parameters: {
            type: 'object',
            properties: {
              server: { type: 'string', description: 'MCP server name' },
              name: { type: 'string', description: 'Prompt name' },
              arguments: { type: 'object', description: 'Optional prompt arguments' },
            },
            required: ['server', 'name'],
          },
        },
      },
      run: async (input: unknown, context: ToolContext) => {
        if (!object(input) || typeof input.server !== 'string' || typeof input.name !== 'string' || !input.server || !input.name) {
          throw new Error('GetMcpPrompt requires server and name');
        }
        const servers = getServers();
        const target = servers.get(input.server);
        if (!target) throw new Error(`MCP server "${input.server}" not found or has no prompts capability`);

        const params: Record<string, unknown> = { name: input.name };
        if (object(input.arguments)) params.arguments = input.arguments;

        const res = await target.call('prompts/get', params, context.signal, 15_000);
        if (!object(res) || !Array.isArray(res.messages)) {
          throw new Error('Invalid MCP prompts/get response');
        }
        return res;
      },
    });
  }

  return tools;
}
