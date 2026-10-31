import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { adfToText, markdownToAdf } from './adf.ts';
import type { TicketGateway } from './types.ts';

const REQUIRED = ['JIRA_HOSTNAME', 'JIRA_USERNAME', 'JIRA_API_TOKEN'] as const;
type Env = Record<string, string | undefined>;
export interface JiraConfig {
  host: string;
  user: string;
  token: string;
  origins: Record<string, string>;
  acceptanceField?: string;
}

function hostname(value: string): string {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    if (!url.hostname || !/^[a-z0-9.-]+$/i.test(url.hostname)) throw new Error();
    return url.host;
  } catch { throw new Error('JIRA_HOSTNAME debe ser un hostname HTTPS válido'); }
}

export function validateJiraKey(key: string): void {
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) throw new Error('Clave de HU inválida: usa el formato PROYECTO-123');
}

export function loadJiraEnv(env: Env = process.env, cwd = process.cwd()): JiraConfig {
  const values: Env = { ...env };
  const origins: Record<string, string> = {};
  for (const key of REQUIRED) if (env[key] !== undefined) origins[key] = 'entorno';
  const files: string[] = [];
  if (env.JIRA_ENV_FILE !== undefined) {
    const file = resolve(cwd, env.JIRA_ENV_FILE);
    if (!env.JIRA_ENV_FILE || !existsSync(file)) throw new Error('No se encontró el archivo indicado por JIRA_ENV_FILE');
    files.push(file);
  } else {
    let directory = resolve(cwd);
    while (true) {
      const file = join(directory, '.env');
      if (existsSync(file)) files.push(file);
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match || !['JIRA_HOSTNAME', 'JIRA_USERNAME', 'JIRA_API_TOKEN', 'JIRA_ACCEPTANCE_FIELD'].includes(match[1]!) || values[match[1]!] !== undefined) continue;
      let value = match[2]!.trim();
      if (/^(['"])[\s\S]*\1$/.test(value)) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, '').trim();
      values[match[1]!] = value;
      origins[match[1]!] = file;
    }
  }
  const missing = REQUIRED.filter(key => !values[key]?.trim());
  if (missing.length) throw new Error(`Faltan credenciales Jira: ${missing.join(', ')}`);
  return { host: hostname(values.JIRA_HOSTNAME!), user: values.JIRA_USERNAME!, token: values.JIRA_API_TOKEN!, origins,
    ...(values.JIRA_ACCEPTANCE_FIELD ? { acceptanceField: values.JIRA_ACCEPTANCE_FIELD } : {}) };
}

export function createJiraGateway(opts: {
  host: string; user: string; token: string; fetch?: typeof fetch;
  origins?: Record<string, string>; acceptanceField?: string;
}): TicketGateway {
  const host = hostname(opts.host);
  const acceptance = opts.acceptanceField ?? process.env.JIRA_ACCEPTANCE_FIELD;
  if (acceptance && !/^[A-Za-z][A-Za-z0-9_]*$/.test(acceptance)) throw new Error('JIRA_ACCEPTANCE_FIELD inválido');
  const requestFetch = opts.fetch ?? fetch;
  async function request(key: string, markdown?: string): Promise<unknown> {
    validateJiraKey(key);
    const url = new URL(`https://${host}/rest/api/3/issue/${key}${markdown === undefined ? '' : '/comment'}`);
    if (markdown === undefined) url.searchParams.set('fields', ['summary', 'description', 'status', 'issuetype', 'subtasks', ...(acceptance ? [acceptance] : [])].join(','));
    let response: Response;
    try {
      response = await requestFetch(url, { method: markdown === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: {
        Authorization: `Basic ${Buffer.from(`${opts.user}:${opts.token}`).toString('base64')}`,
        Accept: 'application/json', ...(markdown === undefined ? {} : { 'Content-Type': 'application/json' }),
      }, ...(markdown === undefined ? {} : { body: JSON.stringify({ body: markdownToAdf(markdown) }) }) });
    } catch { throw new Error(`Error de red al contactar Jira en ${host}`); }
    if (response.status === 401 || response.status === 403) {
      const origins = REQUIRED.map(key => opts.origins?.[key] ?? 'desconocido');
      const detail = REQUIRED.map((key, i) => `${key}: ${origins[i]}`).join('; ');
      const mixed = new Set(origins).size > 1 ? ' Orígenes mezclados: lo exportado gana sobre el .env; revisa valores antiguos del entorno.' : '';
      throw new Error(`Jira rechazó las credenciales (HTTP ${response.status}). Revisa usuario, token y permisos. Orígenes: ${detail}.${mixed}`);
    }
    if (response.status === 404) throw new Error(`HU ${key} no existe`);
    if (!response.ok) throw new Error(`Jira respondió HTTP ${response.status} en ${host}`);
    if (markdown !== undefined) return;
    try { return await response.json(); } catch { throw new Error(`Respuesta Jira inválida en ${host}`); }
  }
  const text = (value: unknown) => typeof value === 'string' ? value : adfToText(value);
  return {
    async getIssue(key) {
      const payload = await request(key) as { fields?: Record<string, any> };
      const fields = payload?.fields;
      if (!fields || typeof fields.summary !== 'string') throw new Error('Respuesta Jira inválida: falta el resumen de la HU');
      return { ref: { system: 'jira', key, url: `https://${host}/browse/${key}` }, summary: fields.summary,
        description: text(fields.description), status: typeof fields.status?.name === 'string' ? fields.status.name : '',
        issueType: typeof fields.issuetype?.name === 'string' ? fields.issuetype.name : '',
        ...(acceptance && fields[acceptance] != null ? { acceptance: text(fields[acceptance]) } : {}),
        subtasks: Array.isArray(fields.subtasks) ? fields.subtasks.flatMap((s: any) => typeof s?.fields?.summary === 'string' ? [s.fields.summary] : []) : [] };
    },
    async comment(key, markdown) { await request(key, markdown); },
  };
}
