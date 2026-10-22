import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { McpManager } from '../src/agent/mcp.ts';
import type { ToolContext } from '../src/agent/types.ts';

const fixturePath = fileURLToPath(new URL('../scripts/mcp-fixture.ts', import.meta.url));
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
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

afterEach(() => {
  for (const p of spawnedProcs.splice(0)) {
    try { p.kill(); } catch {}
  }
});

async function startSseFixture(): Promise<{ port: number; proc: ReturnType<typeof Bun.spawn> }> {
  const proc = Bun.spawn([process.execPath, fixturePath, '--sse', '--all-capabilities'], {
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
  if (!port) throw new Error('Failed to start SSE fixture');
  return { port, proc };
}

describe('Legacy SSE Transport', () => {
  test('positive: connects to SSE transport, handles endpoint event, and calls tools', async () => {
    const { port } = await startSseFixture();
    const ctx = createContext();
    const manager = new McpManager(
      {
        sseServer: {
          url: `http://127.0.0.1:${port}/sse`,
          type: 'sse',
        },
      },
      ctx,
    );

    const tools = await manager.tools();
    expect(tools.length).toBeGreaterThan(0);
    const echoTool = tools.find(t => t.schema.function.name === 'sseServer___echo');
    expect(echoTool).toBeDefined();

    const result: any = await echoTool!.run({ msg: 'hello SSE' }, ctx);
    expect(result.structuredContent.input).toEqual({ msg: 'hello SSE' });
    await manager.close();
  });
});

describe('MCP Resources and Prompts Capabilities', () => {
  test('positive: registers and executes ListMcpResources, ReadMcpResource, ListMcpPrompts, GetMcpPrompt', async () => {
    const ctx = createContext();
    const manager = new McpManager(
      {
        local: {
          command: process.execPath,
          args: [fixturePath, '--all-capabilities'],
        },
      },
      ctx,
    );

    const tools = await manager.tools();
    const listResTool = tools.find(t => t.schema.function.name === 'ListMcpResources');
    const readResTool = tools.find(t => t.schema.function.name === 'ReadMcpResource');
    const listPrmTool = tools.find(t => t.schema.function.name === 'ListMcpPrompts');
    const getPrmTool = tools.find(t => t.schema.function.name === 'GetMcpPrompt');

    expect(listResTool).toBeDefined();
    expect(readResTool).toBeDefined();
    expect(listPrmTool).toBeDefined();
    expect(getPrmTool).toBeDefined();

    // Verify effects are 'read'
    expect(listResTool!.effect).toBe('read');
    expect(readResTool!.effect).toBe('read');
    expect(listPrmTool!.effect).toBe('read');
    expect(getPrmTool!.effect).toBe('read');

    // Test ListMcpResources
    const resListResult: any = await listResTool!.run({}, ctx);
    expect(resListResult.resources).toBeDefined();
    expect(resListResult.resources.length).toBeGreaterThan(0);
    expect(resListResult.resources.some((r: any) => r.uri === 'fixture://resource/1')).toBe(true);
    // Verifies resourceTemplates included
    expect(resListResult.resources.some((r: any) => r.uriTemplate === 'fixture://resource/{id}')).toBe(true);

    // Test ReadMcpResource
    const resReadResult: any = await readResTool!.run({ server: 'local', uri: 'fixture://resource/1' }, ctx);
    expect(resReadResult.contents).toBeDefined();
    expect(resReadResult.contents[0].text).toBe('Contents of fixture://resource/1');

    // Test ListMcpPrompts
    const prmListResult: any = await listPrmTool!.run({}, ctx);
    expect(prmListResult.prompts).toBeDefined();
    expect(prmListResult.prompts.some((p: any) => p.name === 'greeting')).toBe(true);

    // Test GetMcpPrompt
    const prmGetResult: any = await getPrmTool!.run({ server: 'local', name: 'greeting', arguments: { name: 'Alice' } }, ctx);
    expect(prmGetResult.messages).toBeDefined();
    expect(prmGetResult.messages[0].content.text).toBe('Hello, Alice!');

    await manager.close();
  });

  test('negative: server without resources capability does not register ListMcpResources or ReadMcpResource', async () => {
    const ctx = createContext();
    // No capabilities flags -> default fixture only declares tools: {}
    const manager = new McpManager(
      {
        plain: {
          command: process.execPath,
          args: [fixturePath],
        },
      },
      ctx,
    );

    const tools = await manager.tools();
    expect(tools.some(t => t.schema.function.name === 'ListMcpResources')).toBe(false);
    expect(tools.some(t => t.schema.function.name === 'ReadMcpResource')).toBe(false);
    expect(tools.some(t => t.schema.function.name === 'ListMcpPrompts')).toBe(false);
    expect(tools.some(t => t.schema.function.name === 'GetMcpPrompt')).toBe(false);
    await manager.close();
  });

  test('limit: resource exceeding 1 MiB is rejected', async () => {
    const ctx = createContext();
    const manager = new McpManager(
      {
        local: {
          command: process.execPath,
          args: [fixturePath, '--all-capabilities'],
        },
      },
      ctx,
    );

    const tools = await manager.tools();
    const readResTool = tools.find(t => t.schema.function.name === 'ReadMcpResource')!;
    await expect(
      readResTool.run({ server: 'local', uri: 'fixture://oversize' }, ctx),
    ).rejects.toThrow(/exceeds 1 MiB limit/);
    await manager.close();
  });

  test('limit: pagination handles 100 resources across cursor pages', async () => {
    const ctx = createContext();
    const manager = new McpManager(
      {
        local: {
          command: process.execPath,
          args: [fixturePath, '--resources', '--test-100-pages'],
        },
      },
      ctx,
    );

    const tools = await manager.tools();
    const listResTool = tools.find(t => t.schema.function.name === 'ListMcpResources')!;
    const res: any = await listResTool.run({ server: 'local' }, ctx);
    expect(res.resources.filter((r: any) => r.uri?.startsWith('fixture://paged/'))).toHaveLength(100);
    await manager.close();
  });

  test('CLI parity: fab exec --list-tools -o json displays the 4 tools when capabilities are declared', async () => {
    const settingsPath = `/tmp/fab-test-settings-tools-${Date.now()}.json`;
    await Bun.write(
      settingsPath,
      JSON.stringify({
        mcpServers: {
          caps: {
            command: process.execPath,
            args: [fixturePath, '--all-capabilities'],
          },
        },
      }),
    );

    const proc = Bun.spawn([
      process.execPath,
      cliPath,
      'exec',
      '--list-tools',
      '-o',
      'json',
      '--settings',
      settingsPath,
    ], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const outText = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    const json = JSON.parse(outText);
    expect(Array.isArray(json)).toBe(true);
    const toolNames = json.map((t: any) => t.llmId || t.displayName || t.id);
    expect(toolNames).toContain('ListMcpResources');
    expect(toolNames).toContain('ReadMcpResource');
    expect(toolNames).toContain('ListMcpPrompts');
    expect(toolNames).toContain('GetMcpPrompt');
  });
});
