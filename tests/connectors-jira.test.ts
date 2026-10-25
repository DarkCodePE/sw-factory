import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adfToText, markdownToAdf } from '../src/connectors/adf.ts';
import { createJiraGateway, loadJiraEnv } from '../src/connectors/jira.ts';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function envFixture() {
  const root = mkdtempSync(join(tmpdir(), 'fab-jira-env-'));
  directories.push(root);
  const cwd = join(root, 'one', 'two');
  mkdirSync(cwd, { recursive: true });
  const file = join(root, '.env');
  writeFileSync(file, 'JIRA_HOSTNAME=example.atlassian.net\nJIRA_USERNAME="file-user"\nexport JIRA_API_TOKEN=fixture-file-token\nJIRA_ACCEPTANCE_FIELD=customfield_123\n');
  return { root, cwd, file };
}
const config = { host: 'example.atlassian.net', user: 'fixture-user', token: 'fixture-secret-not-real' };

test('environment wins over parent .env without mutating either source', () => {
  const { cwd, file } = envFixture();
  const env = { JIRA_API_TOKEN: 'exported-fixture-token' };
  const original = readFileSync(file, 'utf8');
  const loaded = loadJiraEnv(env, cwd);
  expect(loaded.user).toBe('file-user');
  expect(loaded.token).toBe('exported-fixture-token');
  expect(loaded.origins.JIRA_API_TOKEN).toBe('entorno');
  expect(loaded.origins.JIRA_USERNAME).toBe(file);
  expect(loaded.acceptanceField).toBe('customfield_123');
  expect(env).toEqual({ JIRA_API_TOKEN: 'exported-fixture-token' });
  expect(readFileSync(file, 'utf8')).toBe(original);
  expect(() => loadJiraEnv({ JIRA_API_TOKEN: '' }, cwd)).toThrow('JIRA_API_TOKEN');
});

test('explicit env file controls loading and missing variables only name keys', () => {
  const { root, cwd } = envFixture();
  const other = join(root, 'other.env');
  writeFileSync(other, 'JIRA_HOSTNAME=other.atlassian.net\nJIRA_USERNAME=other\nJIRA_API_TOKEN=other-fixture\n');
  expect(loadJiraEnv({ JIRA_ENV_FILE: other }, cwd).host).toBe('other.atlassian.net');
  expect(() => loadJiraEnv({ JIRA_ENV_FILE: join(root, 'absent.env') }, cwd)).toThrow('JIRA_ENV_FILE');
  writeFileSync(other, 'JIRA_API_TOKEN=not-for-output\n');
  let message = '';
  try { loadJiraEnv({ JIRA_ENV_FILE: other }, cwd); } catch (e) { message = (e as Error).message; }
  expect(message).toContain('JIRA_HOSTNAME, JIRA_USERNAME');
  expect(message).not.toContain('not-for-output');
});

test('partial nearer .env wins while missing keys are filled from ancestors', () => {
  const { cwd, file } = envFixture();
  const nearer = join(cwd, '.env');
  writeFileSync(nearer, 'JIRA_USERNAME=nearer-user\n');
  const loaded = loadJiraEnv({}, cwd);
  expect(loaded.user).toBe('nearer-user');
  expect(loaded.token).toBe('fixture-file-token');
  expect(loaded.origins.JIRA_USERNAME).toBe(nearer);
  expect(loaded.origins.JIRA_API_TOKEN).toBe(file);
});

test('GET selects fields, acceptance and subtasks; POST carries ADF', async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fakeFetch = (async (input: any, init: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    if (init.method === 'POST') return new Response('', { status: 201 });
    return Response.json({ fields: { summary: 'Una HU', description: markdownToAdf('Descripción con `código`'), status: { name: 'Abierta' },
      issuetype: { name: 'Historia' }, customfield_123: markdownToAdf('- Se verifica'), subtasks: [{ fields: { summary: 'Subtarea uno' } }, {}] } });
  }) as typeof fetch;
  const gateway = createJiraGateway({ ...config, acceptanceField: 'customfield_123', fetch: fakeFetch });
  const issue = await gateway.getIssue('KAN-12');
  expect(issue).toMatchObject({ summary: 'Una HU', status: 'Abierta', issueType: 'Historia', description: 'Descripción con `código`', subtasks: ['Subtarea uno'] });
  expect(issue.acceptance).toContain('Se verifica');
  expect(calls[0]!.url.pathname).toBe('/rest/api/3/issue/KAN-12');
  expect(calls[0]!.url.searchParams.get('fields')).toBe('summary,description,status,issuetype,subtasks,customfield_123');
  expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from(`${config.user}:${config.token}`).toString('base64')}`);
  const body = 'Comillas "x" y $(touch nada)\n\n[PR](https://github.com/a/b/pull/1)';
  await gateway.comment('KAN-12', body);
  expect(adfToText(JSON.parse(calls[1]!.init.body as string).body)).toBe(body);
});

for (const status of [401, 403]) test(`HTTP ${status} explains mixed origins without credential values`, async () => {
  const gateway = createJiraGateway({ ...config, origins: { JIRA_HOSTNAME: '/fixture/.env', JIRA_USERNAME: '/fixture/.env', JIRA_API_TOKEN: 'entorno' },
    fetch: (async () => Response.json({ errorMessages: [config.token] }, { status })) as unknown as typeof fetch });
  let message = '';
  try { await gateway.getIssue('KAN-12'); } catch (e) { message = (e as Error).message; }
  expect(message).toContain(`HTTP ${status}`);
  expect(message).toContain('Orígenes mezclados');
  expect(message).toContain('JIRA_API_TOKEN: entorno');
  expect(message).not.toContain(config.token);
  expect(message).not.toContain(config.user);
});

test('404 and network errors are safe; invalid keys never reach fetch', async () => {
  let requests = 0;
  const gateway = createJiraGateway({ ...config, fetch: (async () => { requests++; return new Response('', { status: 404 }); }) as unknown as typeof fetch });
  await expect(gateway.getIssue('KAN-404')).rejects.toThrow('HU KAN-404 no existe');
  for (const key of ['../KAN-1', 'kan-1', 'A-1', 'KAN-1?fields=token']) {
    await expect(gateway.getIssue(key)).rejects.toThrow('Clave de HU inválida');
    await expect(gateway.comment(key, 'x')).rejects.toThrow('Clave de HU inválida');
  }
  expect(requests).toBe(1);
  const offline = createJiraGateway({ ...config, fetch: (async () => { throw new Error(config.token); }) as unknown as typeof fetch });
  await expect(offline.getIssue('KAN-1')).rejects.toThrow('Error de red al contactar Jira en example.atlassian.net');
  expect(() => createJiraGateway({ ...config, host: 'https://user:secret@example.test' })).toThrow('JIRA_HOSTNAME');
});
