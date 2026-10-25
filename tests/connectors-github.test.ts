import { expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createGhGateway, repoSlugFromRemote, type CommandRunner } from '../src/connectors/github.ts';

const input = { cwd: '/fixture/repo', repo: 'owner/project', branch: 'fab/12345678', base: 'main', title: 'Cambiar "x" $(touch no)',
  body: 'Primera línea "quotes"\n\n$(touch nunca)\n`código`', draft: true };
const pr = { number: 12, url: 'https://github.com/owner/project/pull/12', headRefName: input.branch, baseRefName: 'main', state: 'OPEN' };

test('push then reuse an existing open PR without create', async () => {
  const commands: string[][] = [];
  const run: CommandRunner = async (cmd, cwd) => {
    commands.push(cmd);
    expect(cwd).toBe(input.cwd);
    return { code: 0, stdout: cmd[0] === 'gh' ? JSON.stringify(pr) : '', stderr: '' };
  };
  expect(await createGhGateway({ run }).open(input)).toEqual({ repo: input.repo, number: 12, url: pr.url, branch: input.branch, base: 'main' });
  expect(commands[0]).toEqual(['git', 'push', '-u', 'origin', input.branch]);
  expect(commands.some(c => c.includes('create'))).toBe(false);
});

test('create and comment use intact private temporary bodies, never shell argv', async () => {
  const commands: string[][] = [];
  const paths: string[] = [];
  const run: CommandRunner = async cmd => {
    commands.push(cmd);
    if (cmd.includes('view')) return { code: 1, stdout: '', stderr: 'no pull requests found for branch' };
    if (cmd.includes('create') || cmd.includes('comment')) {
      const path = cmd[cmd.indexOf('--body-file') + 1]!;
      paths.push(path);
      expect(readFileSync(path, 'utf8')).toBe(input.body);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(cmd).not.toContain(input.body);
      if (cmd.includes('create')) expect(cmd[cmd.indexOf('--title') + 1]).toBe(input.title);
    }
    return { code: 0, stdout: cmd.includes('create') ? pr.url + '\n' : '', stderr: '' };
  };
  const gateway = createGhGateway({ run });
  const opened = await gateway.open(input);
  await gateway.comment(opened, input.body);
  expect(commands[2]).toContain('--draft');
  expect(commands.every(c => !['sh', '/bin/sh', 'bash'].includes(c[0]!))).toBe(true);
  expect(paths).toHaveLength(2);
  for (const path of paths) expect(existsSync(path)).toBe(false);
});

test('authentication failures never create PRs; failed writes clean body files', async () => {
  let created = false;
  const auth = createGhGateway({ run: async cmd => {
    if (cmd.includes('create')) created = true;
    return { code: cmd.includes('view') ? 1 : 0, stdout: '', stderr: 'authentication required fixture-secret' };
  } });
  await expect(auth.open(input)).rejects.toThrow('No se pudo consultar el PR');
  expect(created).toBe(false);
  let path = '';
  const failed = createGhGateway({ run: async cmd => {
    path = cmd[cmd.indexOf('--body-file') + 1]!;
    return { code: 1, stdout: '', stderr: 'fixture-secret' };
  } });
  await expect(failed.comment({ repo: input.repo, number: 12, url: pr.url, branch: input.branch, base: input.base }, input.body)).rejects.toThrow('gh pr falló');
  expect(existsSync(path)).toBe(false);
});

test('failed push stops before GitHub operations', async () => {
  const commands: string[][] = [];
  const gateway = createGhGateway({ run: async cmd => {
    commands.push(cmd);
    return { code: 128, stdout: '', stderr: 'fixture-auth-error' };
  } });
  await expect(gateway.open(input)).rejects.toThrow('git push falló');
  expect(commands).toHaveLength(1);
  expect(commands[0]?.[0]).toBe('git');
});

test('find handles absent and closed PRs, and rejects malformed GitHub metadata', async () => {
  expect(await createGhGateway({ run: async () => ({ code: 0, stdout: JSON.stringify({ ...pr, state: 'MERGED' }), stderr: '' }) }).find(input.repo, input.branch)).toBeUndefined();
  expect(await createGhGateway({ run: async () => ({ code: 1, stdout: '', stderr: 'no pull requests found' }) }).find(input.repo, input.branch)).toBeUndefined();
  await expect(createGhGateway({ run: async () => ({ code: 0, stdout: '{}', stderr: '' }) }).find(input.repo, input.branch)).rejects.toThrow('Respuesta de GitHub inválida');
  let calls = 0;
  const gateway = createGhGateway({ run: async () => { calls++; return { code: 0, stdout: '', stderr: '' }; } });
  await expect(gateway.open({ ...input, branch: '--delete' })).rejects.toThrow('Rama Git inválida');
  await expect(gateway.find('bad/repo/extra', input.branch)).rejects.toThrow('Repositorio GitHub inválido');
  expect(calls).toBe(0);
});

test('GitHub remote slugs support HTTPS, SCP and ssh URLs only for the exact host', () => {
  for (const remote of ['https://github.com/owner/project.git', 'git@github.com:owner/project.git', 'ssh://git@github.com/owner/project.git', 'ssh://git@github.com:22/owner/project.git', 'https://github.com/owner/project']) expect(repoSlugFromRemote(remote)).toBe('owner/project');
  for (const remote of ['https://gitlab.com/owner/project.git', 'https://github.com.evil/owner/project', 'git@github.com.evil:owner/project.git', '/local/repo', 'https://github.com/a/b/extra', 'https://github.com/a/b?token=x']) expect(repoSlugFromRemote(remote)).toBeUndefined();
});

test('GitHub canonical URL casing may differ from the configured repo slug', async () => {
  const gateway = createGhGateway({ run: async cmd => ({ code: 0, stdout: cmd.includes('view') ? JSON.stringify(pr) : '', stderr: '' }) });
  const result = await gateway.open({ ...input, repo: 'Owner/Project' });
  expect(result.url).toBe(pr.url);
  expect(result.repo).toBe('Owner/Project');
});
