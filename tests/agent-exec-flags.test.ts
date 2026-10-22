import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SessionStore } from '../src/agent/session.ts';
import { prepareExecWorktree } from '../src/agent/exec-worktree.ts';

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) {
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
});

async function temp() {
  const path = await mkdtemp(join(tmpdir(), 'fab-exec-flags-'));
  roots.push(path);
  return path;
}

const entry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const mcpFixture = fileURLToPath(new URL('../scripts/mcp-fixture.ts', import.meta.url));

async function gitInit(cwd: string): Promise<string> {
  const run = async (args: string[]) => {
    const proc = Bun.spawn(['git', ...args], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`git ${args.join(' ')} failed with ${code}`);
  };
  await run(['init', '-b', 'main']);
  await run(['config', 'user.email', 'test@test.com']);
  await run(['config', 'user.name', 'Test']);
  await writeFile(join(cwd, 'README.md'), '# test repo\n');
  await run(['add', 'README.md']);
  await run(['commit', '-m', 'initial commit']);
  return cwd;
}

test('positivo: --add-tools suma una herramienta eliminada por defecto y un selector MCP:<server>/<tool>', async () => {
  const cwd = await temp();
  const settingsPath = join(cwd, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({
    mcpServers: {
      local: {
        command: process.execPath,
        args: ['--no-env-file', mcpFixture],
        env: { MCP_ALLOWED: 'explicit' },
        readOnlyTools: ['echo'],
      },
    },
  }));

  const child = Bun.spawn([
    process.execPath, '--no-env-file', entry, 'exec',
    '--settings', settingsPath,
    '--remove-tools', 'read-cli',
    '--add-tools', 'read-cli,MCP:local/echo',
    '--list-tools', '-o', 'json',
  ], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: cwd },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(0);
  expect(err).toBe('');
  const tools = JSON.parse(out);

  const readTool = tools.find((t: any) => t.id === 'read-cli');
  expect(readTool).toBeDefined();
  expect(readTool.currentlyAllowed).toBe(true);

  const mcpEcho = tools.find((t: any) => t.id === 'local___echo');
  expect(mcpEcho).toBeDefined();
  expect(mcpEcho.currentlyAllowed).toBe(true);
});

test('positivo: selector MCP:local en --only-tools y en --remove-tools', async () => {
  const cwd = await temp();
  const settingsPath = join(cwd, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({
    mcpServers: {
      local: {
        command: process.execPath,
        args: ['--no-env-file', mcpFixture],
        env: { MCP_ALLOWED: 'explicit' },
        readOnlyTools: ['echo'],
      },
    },
  }));

  // 1. Test --only-tools MCP:local
  const childOnly = Bun.spawn([
    process.execPath, '--no-env-file', entry, 'exec',
    '--settings', settingsPath,
    '--only-tools', 'MCP:local',
    '--list-tools', '-o', 'json',
  ], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: cwd },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [codeOnly, outOnly, errOnly] = await Promise.all([
    childOnly.exited,
    new Response(childOnly.stdout).text(),
    new Response(childOnly.stderr).text(),
  ]);
  expect(codeOnly).toBe(0);
  expect(errOnly).toBe('');
  const toolsOnly = JSON.parse(outOnly);
  const mcpEchoOnly = toolsOnly.find((t: any) => t.id === 'local___echo');
  expect(mcpEchoOnly).toBeDefined();
  expect(mcpEchoOnly.currentlyAllowed).toBe(true);
  expect(toolsOnly.some((t: any) => t.id === 'read-cli')).toBe(false);

  // 2. Test --remove-tools MCP:local
  const childRemove = Bun.spawn([
    process.execPath, '--no-env-file', entry, 'exec',
    '--settings', settingsPath,
    '--remove-tools', 'MCP:local',
    '--list-tools', '-o', 'json',
  ], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: cwd },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [codeRemove, outRemove, errRemove] = await Promise.all([
    childRemove.exited,
    new Response(childRemove.stdout).text(),
    new Response(childRemove.stderr).text(),
  ]);
  expect(codeRemove).toBe(0);
  expect(errRemove).toBe('');
  const toolsRemove = JSON.parse(outRemove);
  expect(toolsRemove.some((t: any) => t.id === 'local___echo')).toBe(false);
  const readToolRemove = toolsRemove.find((t: any) => t.id === 'read-cli');
  expect(readToolRemove).toBeDefined();
  expect(readToolRemove.currentlyAllowed).toBe(true);
});

test('positivo: --spec-model usa el segundo modelo durante spec y el principal tras ExitSpecMode', async () => {
  const cwd = await temp();
  let mainCalls = 0;
  let specCalls = 0;

  const mainServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      mainCalls++;
      return Response.json({
        choices: [{ message: { role: 'assistant', content: 'STATUS: main model completed' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    },
  });

  const specServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      specCalls++;
      return Response.json({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_exit',
              type: 'function',
              function: { name: 'ExitSpecMode', arguments: '{}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 15, completion_tokens: 8 },
      });
    },
  });

  const settingsPath = join(cwd, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({
    modelId: 'custom:main',
    customModels: [
      { id: 'custom:main', model: 'main-model', provider: 'generic-chat-completion-api', baseUrl: mainServer.url.href + 'v1' },
      { id: 'custom:spec', model: 'spec-model', provider: 'generic-chat-completion-api', baseUrl: specServer.url.href + 'v1' },
    ],
  }));

  try {
    const child = Bun.spawn([
      process.execPath, '--no-env-file', entry, 'exec',
      '--settings', settingsPath,
      '--use-spec',
      '--spec-model', 'custom:spec',
      '--auto', 'high',
      '--cwd', cwd,
      '-o', 'json',
      'test spec model transition',
    ], {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: cwd },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(specCalls).toBeGreaterThanOrEqual(1);
    expect(mainCalls).toBeGreaterThanOrEqual(1);

    const result = JSON.parse(out);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('main model completed');
  } finally {
    mainServer.stop(true);
    specServer.stop(true);
  }
});

test('positivo: --worker-reasoning-effort llega al proveedor del worker (reasoning_effort en la petición)', async () => {
  let receivedEffort: string | undefined;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const body = await req.json() as any;
      if (body.reasoning_effort) {
        receivedEffort = body.reasoning_effort;
      }
      return Response.json({
        choices: [{ message: { role: 'assistant', content: 'STATUS: worker step complete' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      });
    },
  });

  try {
    const { buildProviders } = await import('../src/agent/exec-flags.ts');
    const { mission } = buildProviders({
      mission: true,
      'worker-reasoning-effort': 'high',
    } as any, {
      modelId: 'custom:worker',
      customModels: [
        { id: 'custom:worker', model: 'worker-model', provider: 'generic-chat-completion-api', baseUrl: server.url.href + 'v1' },
      ],
    });

    expect(mission?.workerProvider).toBeDefined();
    await mission!.workerProvider!.complete({
      messages: [{ role: 'user', content: 'test worker reasoning' }],
      tools: [],
      maxOutputTokens: 1024,
    }, new AbortController().signal);
    expect(receivedEffort).toBe('high');
  } finally {
    server.stop(true);
  }
});

test('positivo: --worktree crea rama <actual>-wt y la sesión guarda cwd del worktree', async () => {
  const repoDir = await temp();
  await gitInit(repoDir);

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch() {
      return Response.json({
        choices: [{ message: { role: 'assistant', content: 'STATUS: done in worktree' }, finish_reason: 'stop' }],
      });
    },
  });

  const sessionDir = await temp();
  const settingsPath = join(repoDir, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({
    modelId: 'custom:test',
    customModels: [{ id: 'custom:test', model: 'm', provider: 'generic-chat-completion-api', baseUrl: server.url.href + 'v1' }],
  }));

  try {
    const child = Bun.spawn([
      process.execPath, '--no-env-file', entry, 'exec',
      '--settings', settingsPath,
      '--worktree',
      '--session-dir', sessionDir,
      '-o', 'json',
      'run in worktree',
    ], {
      cwd: repoDir,
      env: { PATH: process.env.PATH ?? '', HOME: repoDir },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(err).toContain('Worktree: branch main-wt at');

    const result = JSON.parse(out);
    expect(result.ok).toBe(true);

    // Verify session snapshot has worktree cwd
    const store = await SessionStore.create(sessionDir);
    const session = await store.inspect(result.sessionId);
    expect(session.cwd).not.toBe(repoDir);
    const branchProc = Bun.spawn(['git', 'branch', '--show-current'], { cwd: session.cwd, stdout: 'pipe' });
    const currentBranch = (await new Response(branchProc.stdout).text()).trim();
    expect(currentBranch).toBe('main-wt');
  } finally {
    server.stop(true);
  }
});

test('positivo: --worktree nombre reutiliza rama existente libre', async () => {
  const repoDir = await temp();
  await gitInit(repoDir);

  // Create branch beforehand
  const branchProc = Bun.spawn(['git', 'branch', 'feat-free'], { cwd: repoDir });
  await branchProc.exited;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch() {
      return Response.json({
        choices: [{ message: { role: 'assistant', content: 'STATUS: done in reused branch' }, finish_reason: 'stop' }],
      });
    },
  });

  const sessionDir = await temp();
  const settingsPath = join(repoDir, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({
    modelId: 'custom:test',
    customModels: [{ id: 'custom:test', model: 'm', provider: 'generic-chat-completion-api', baseUrl: server.url.href + 'v1' }],
  }));

  try {
    const child = Bun.spawn([
      process.execPath, '--no-env-file', entry, 'exec',
      '--settings', settingsPath,
      '--worktree', 'feat-free',
      '--session-dir', sessionDir,
      '-o', 'json',
      'run in free branch worktree',
    ], {
      cwd: repoDir,
      env: { PATH: process.env.PATH ?? '', HOME: repoDir },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(err).toContain('Worktree: branch feat-free at');

    const result = JSON.parse(out);
    expect(result.ok).toBe(true);
  } finally {
    server.stop(true);
  }
});

test('positivo: --session-title persiste en el snapshot', async () => {
  const cwd = await temp();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch() {
      return Response.json({
        choices: [{ message: { role: 'assistant', content: 'STATUS: session done' }, finish_reason: 'stop' }],
      });
    },
  });

  const sessionDir = await temp();
  const settingsPath = join(cwd, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({
    modelId: 'custom:test',
    customModels: [{ id: 'custom:test', model: 'm', provider: 'generic-chat-completion-api', baseUrl: server.url.href + 'v1' }],
  }));

  try {
    const child = Bun.spawn([
      process.execPath, '--no-env-file', entry, 'exec',
      '--settings', settingsPath,
      '--session-title', 'Migración a Base de Datos de Prueba',
      '--session-dir', sessionDir,
      '-o', 'json',
      'prompt with title',
    ], {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: cwd },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(0);

    const result = JSON.parse(out);
    expect(result.ok).toBe(true);

    const store = await SessionStore.create(sessionDir);
    const session = await store.inspect(result.sessionId);
    expect(session.title).toBe('Migración a Base de Datos de Prueba');
  } finally {
    server.stop(true);
  }
});

test('negativo: --spec-model sin --use-spec falla', async () => {
  const cwd = await temp();
  const child = Bun.spawn([
    process.execPath, '--no-env-file', entry, 'exec',
    '--spec-model', 'custom:spec',
    'prompt',
  ], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [code, , err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).not.toBe(0);
  expect(err).toContain('spec-model and spec-reasoning-effort require use-spec');
});

test('negativo: --worker-reasoning-effort sin --mission falla', async () => {
  const cwd = await temp();
  const child = Bun.spawn([
    process.execPath, '--no-env-file', entry, 'exec',
    '--worker-reasoning-effort', 'high',
    'prompt',
  ], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [code, , err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).not.toBe(0);
  expect(err).toContain('require mission');
});

test('negativo: selector desconocido falla con Unknown selected tool', async () => {
  const cwd = await temp();
  const child = Bun.spawn([
    process.execPath, '--no-env-file', entry, 'exec',
    '--only-tools', 'herramienta_totalmente_desconocida_xyz',
    '--list-tools',
  ], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [code, , err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).not.toBe(0);
  expect(err).toContain('Unknown selected tool: herramienta_totalmente_desconocida_xyz');
});

test('negativo: --worktree fuera de repo falla', async () => {
  const nonGitDir = await temp();
  const child = Bun.spawn([
    process.execPath, '--no-env-file', entry, 'exec',
    '--worktree',
    'prompt',
  ], {
    cwd: nonGitDir,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [code, , err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).not.toBe(0);
  expect(err).toContain('Working directory is not a git repository');
});

test('negativo: rama ya checkouteada en otro worktree falla', async () => {
  const repoDir = await temp();
  await gitInit(repoDir);

  // 'main' is already checked out at repoDir
  const child = Bun.spawn([
    process.execPath, '--no-env-file', entry, 'exec',
    '--worktree', 'main',
    'prompt',
  ], {
    cwd: repoDir,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [code, , err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).not.toBe(0);
  expect(err).toContain("Branch 'main' is already checked out at");
});

test('negativo: ruta de worktree ya ocupada por otra rama falla y preserva archivo sin commit', async () => {
  const repoDir = await temp();
  await gitInit(repoDir);
  const wtRoot = await temp();

  // Create another branch and check it out at the canonical targetPath
  const topProc = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], { cwd: repoDir, stdout: 'pipe' });
  const repoRoot = (await new Response(topProc.stdout).text()).trim();
  const repoHash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 8);
  const targetPath = join(wtRoot, repoHash, basename(repoRoot));

  await Bun.spawn(['git', 'branch', 'branch-ajena'], { cwd: repoDir }).exited;
  await Bun.spawn(['git', 'worktree', 'add', targetPath, 'branch-ajena'], { cwd: repoDir }).exited;

  // Write an uncommitted file in that existing worktree
  const uncommittedFile = join(targetPath, 'trabajo-sin-commit.txt');
  await writeFile(uncommittedFile, 'contenido critico sin commit');

  // Attempt prepareExecWorktree for the same repo with a different branch
  await expect(prepareExecWorktree({
    repo: repoDir,
    name: 'branch-nueva',
    root: wtRoot,
  })).rejects.toThrow(/la ruta ya pertenece al worktree de la rama branch-ajena/);

  // Verify the uncommitted file in the existing worktree is still intact!
  expect(await Bun.file(uncommittedFile).text()).toBe('contenido critico sin commit');
});

test('negativo: --add-tools con --only-tools que no la incluye falla (regla documentada)', async () => {
  const cwd = await temp();
  const child = Bun.spawn([
    process.execPath, '--no-env-file', entry, 'exec',
    '--only-tools', 'read-cli',
    '--add-tools', 'execute-cli',
    '--list-tools',
  ], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [code, , err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).not.toBe(0);
  expect(err).toContain("Cannot add tool 'Execute' not included in only-tools");
});

test('límite: título de 200+ caracteres falla', async () => {
  const cwd = await temp();
  const longTitle = 'a'.repeat(201);
  const child = Bun.spawn([
    process.execPath, '--no-env-file', entry, 'exec',
    '--session-title', longTitle,
    'prompt',
  ], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [code, , err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).not.toBe(0);
  expect(err).toContain('Session title cannot exceed 200 characters');
});

test('límite: nombre de rama inválido falla con git check-ref-format', async () => {
  const repoDir = await temp();
  await gitInit(repoDir);

  const child = Bun.spawn([
    process.execPath, '--no-env-file', entry, 'exec',
    '--worktree', 'invalid..branch',
    'prompt',
  ], {
    cwd: repoDir,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [code, , err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).not.toBe(0);
  expect(err).toContain('Invalid branch name: invalid..branch');
});

test('límite: raíz de worktrees inexistente se crea automáticamente', async () => {
  const repoDir = await temp();
  await gitInit(repoDir);
  const customRoot = join(repoDir, 'sub', 'nested', 'worktrees');

  const result = await prepareExecWorktree({
    repo: repoDir,
    root: customRoot,
  });

  expect(result.created).toBe(true);
  expect(result.branch).toBe('main-wt');
  expect(result.path.startsWith(customRoot)).toBe(true);
});

test('cancelación: señal abortada durante prepareExecWorktree deja el repo principal intacto', async () => {
  const repoDir = await temp();
  await gitInit(repoDir);

  const controller = new AbortController();
  controller.abort();

  await expect(prepareExecWorktree({
    repo: repoDir,
    signal: controller.signal,
  })).rejects.toThrow();

  // Verify main branch is still intact
  const proc = Bun.spawn(['git', 'status', '--porcelain'], { cwd: repoDir, stdout: 'pipe' });
  const status = await new Response(proc.stdout).text();
  expect(status.trim()).toBe('');
});

test('--disable-builtin-skills deja constancia en --list-tools -o json', async () => {
  const cwd = await temp();
  const child = Bun.spawn([
    process.execPath, '--no-env-file', entry, 'exec',
    '--disable-builtin-skills',
    '--list-tools', '-o', 'json',
  ], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(0);
  expect(err).toBe('');
  const tools = JSON.parse(out);
  expect(tools.length).toBeGreaterThan(0);
  for (const t of tools) {
    expect(t.builtinSkills).toBe(false);
  }
});

test('fab chat acepta --worktree y --add-tools con la misma semántica', async () => {
  const repoDir = await temp();
  await gitInit(repoDir);
  const home = await temp();
  const settingsPath = join(repoDir, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({
    modelId: 'custom:test',
    customModels: [{ id: 'custom:test', model: 'm', provider: 'generic-chat-completion-api', baseUrl: 'http://127.0.0.1:9/v1' }],
  }));

  const p = Bun.spawn([
    process.execPath, '--no-env-file', entry, 'chat',
    '--cwd', repoDir,
    '--settings', settingsPath,
    '--worktree',
    '--add-tools', 'read-cli',
  ], {
    cwd: repoDir,
    env: { PATH: process.env.PATH ?? '', HOME: home, FABRICA_HOME: home },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  p.stdin.write('/status\n/exit\n');
  p.stdin.end();

  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  expect(code).toBe(0);
  expect(err).toContain('Worktree: branch main-wt at');
});
