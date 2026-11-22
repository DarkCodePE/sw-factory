/**
 * CLI remota, lado cliente (T119c, diseño §3.1): `fab --remote <alias> <verbo>`. Habla con `/cli/v1/*` del servidor fijado por el alias,
 * sin seguir redirecciones, y manda campos tipados: nunca argv, comandos de shell, nombres de adaptador ni rutas del servidor.
 * La sesión se guarda en el almacén privado del cliente (`<estado>/remote/<alias>.json`, 0600) y no sale en argv, URL ni diagnósticos.
 * El cliente lee los ficheros locales (`--file`) y manda bytes y nombre base.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface RemoteDeps {
  stateDir: string;
  fetch?: typeof fetch;
  out?: (s: string) => void;
  err?: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Tope de espera de la aprobación del pareo. */
  pairTimeoutMs?: number;
}

interface Verb { op: string; /** Nombres de los argumentos posicionales tras el verbo; `id` va al campo id del comando. */ args?: string[]; read?: string; /** Lee `revision` del change antes de enviar. */ revision?: boolean; fixed?: Record<string, string> }

/** Verbo → operación. Los nombres siguen la CLI local; los «Nuevos» de §4.1 también. Un test de inventario cruza esta tabla con las capacidades. */
export const VERBS: Record<string, Verb> = {
  'ws list': { op: 'ops/read', read: '/workstreams' },
  'inbox': { op: 'ops/read', read: '/inbox' },
  'changes': { op: 'ops/read', read: '/changes' },
  'show': { op: 'ops/read', args: ['id'], read: '/changes/:id' },
  'activity': { op: 'ops/read', args: ['id'], read: '/activities/:id' },
  'review approve': { op: 'activities/review', args: ['id'], fixed: { decision: 'approve' } },
  'review comment': { op: 'activities/review', args: ['id', 'comment'], fixed: { decision: 'comment' } },
  'review decline': { op: 'activities/review', args: ['id', 'comment'], fixed: { decision: 'decline' } },
  'retry': { op: 'changes/retry', args: ['id'], revision: true },
  'note': { op: 'changes/note', args: ['id', 'body'] },
  'change rename': { op: 'changes/rename', args: ['id', 'title'] },
  'reject': { op: 'changes/cancel', args: ['id'] },
  'score add': { op: 'activities/score', args: ['id'] },
  'score backfill': { op: 'scorers/backfill' },
  'question answer': { op: 'questions/answer', args: ['id', 'answer'] },
  'signal add': { op: 'signals/create', args: ['workstream', 'title'] },
  'triage': { op: 'signals/triage', args: ['id'] },
  'signal ignore': { op: 'signals/ignore', args: ['id'] },
  'automation add': { op: 'automations/create' },
  'automation update': { op: 'automations/update', args: ['id'] },
  'automation rm': { op: 'automations/delete', args: ['id'] },
  'automation run-now': { op: 'automations/run', args: ['id'] },
  'automation enable': { op: 'automations/enable', args: ['id'] },
  'automation disable': { op: 'automations/disable', args: ['id'] },
  'ws create': { op: 'workstreams/create' },
  'ws settings': { op: 'workstreams/settings', args: ['id'] },
  'ws state': { op: 'workstreams/state', args: ['id', 'state'] },
  'ws agent': { op: 'workstreams/adaptador', args: ['id', 'agent'] },
  'ws archive': { op: 'workstreams/archive', args: ['id'] },
  'ws runner': { op: 'workstreams/runner', args: ['id', 'runner'] },
  'ws env': { op: 'workstreams/acceso', args: ['id'], fixed: { kind: 'env' } },
  'ws mcp': { op: 'workstreams/acceso', args: ['id'], fixed: { kind: 'mcp' } },
  'ws profile': { op: 'perfiles/asignar' },
  'profile save': { op: 'perfiles/guardar' },
  'profile import': { op: 'perfiles/importar' },
  'definition import': { op: 'definicion/importar' },
  'resident config': { op: 'resident/config' },
  'jira import': { op: 'jira/import', args: ['key'] },
  'runner add': { op: 'runners/create', args: ['name'] },
  'runner update': { op: 'runners/update', args: ['id'] },
  'runner rm': { op: 'runners/delete', args: ['id'] },
  'runner check': { op: 'runners/check', args: ['id'] },
  'improve save-profile': { op: 'automejora/save', args: ['id'] },
  'bench save-candidate': { op: 'changes/suite-task', args: ['id'] },
  'bench cancel': { op: 'benchmarks/cancel', args: ['id'] },
  'api-key create': { op: 'api-key/create' },
  'api-key list': { op: 'api-key/list' },
  'api-key revoke': { op: 'api-key/revoke', args: ['id'] },
  'session list': { op: 'session/list' },
  'session revoke': { op: 'session/revoke', args: ['id'] },
  'user list': { op: 'user/list' },
  'user invite': { op: 'user/invite' },
  'user revoke-invite': { op: 'user/revoke-invite', args: ['id'] },
  'user role': { op: 'user/role', args: ['id', 'role'] },
  'user disable': { op: 'user/disable', args: ['id'] },
  'user resolve-work': { op: 'user/resolve-work', args: ['id'] },
};

const KNOWN = Object.keys(VERBS).sort((a, b) => b.split(' ').length - a.split(' ').length);
const remoteDir = (stateDir: string) => join(stateDir, 'remote');
const remotesFile = (stateDir: string) => join(remoteDir(stateDir), 'remotes.json');
const sessionFile = (stateDir: string, alias: string) => join(remoteDir(stateDir), `${alias}.session.json`);
const ALIAS = /^[a-z0-9][a-z0-9-]{0,30}$/;

function writePrivate(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
const readJson = <T>(path: string): T | null => { try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; } };

/** El alias fija el servidor: solo `https://<host>` canónico (sin ruta ni barra final). `http://127.0.0.1` solo para pruebas locales. */
function checkOrigin(origin: string): string {
  let u: URL;
  try { u = new URL(origin); } catch { throw new Error('origen inválido'); }
  const local = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  if ((u.protocol !== 'https:' && !local) || u.origin !== origin) throw new Error('el servidor debe ser https://<host> sin ruta ni barra final');
  return origin;
}

function addRemote(stateDir: string, alias: string, origin: string): void {
  if (!ALIAS.test(alias)) throw new Error('alias inválido');
  const all = readJson<Record<string, { origin: string }>>(remotesFile(stateDir)) ?? {};
  all[alias] = { origin: checkOrigin(origin) };
  mkdirSync(remoteDir(stateDir), { recursive: true, mode: 0o700 });
  writePrivate(remotesFile(stateDir), all);
}

export function remoteOrigin(stateDir: string, alias: string): string {
  const all = readJson<Record<string, { origin: string }>>(remotesFile(stateDir)) ?? {};
  const o = Object.hasOwn(all, alias) ? all[alias]?.origin : undefined;
  if (!o) throw new Error(`alias desconocido: ${alias} (fab remote add ${alias} https://<host>)`);
  return checkOrigin(o);
}

class RemoteError extends Error { constructor(readonly code: string, message: string, readonly status = 0, readonly retryAfter = 0) { super(message); } }

async function request(deps: RemoteDeps, origin: string, path: string, body: unknown, token?: string): Promise<unknown> {
  const f = deps.fetch ?? fetch;
  const res = await f(`${origin}${path}`, {
    method: 'POST', redirect: 'manual', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  // Un redirect con credenciales no se sigue: acabaría en otro origen.
  if (res.status >= 300 && res.status < 400) throw new RemoteError('redirect', 'el servidor respondió con una redirección; no se sigue', res.status);
  let parsed: { ok?: boolean; data?: unknown; error?: { code: string; message: string } } = {};
  try { parsed = await res.json() as typeof parsed; } catch { /* cuerpo no JSON */ }
  if (!res.ok || parsed.ok === false) throw new RemoteError(parsed.error?.code ?? 'error', parsed.error?.message ?? `HTTP ${res.status}`, res.status, Number(res.headers.get('retry-after')) || 0);
  return parsed.data;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function login(deps: RemoteDeps, alias: string, origin: string): Promise<void> {
  const verifier = randomBytes(32).toString('base64url');
  const start = await request(deps, origin, '/cli/v1/pair/start', { challenge: sha(verifier) }) as { code: string; url: string; expiresIn: number };
  (deps.out ?? console.log)(`Abre ${start.url}, teclea el código ${start.code} y confirma que es tu terminal. Esperando la aprobación…`);
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const deadline = Date.now() + (deps.pairTimeoutMs ?? start.expiresIn * 1000);
  for (;;) {
    try {
      const s = await request(deps, origin, '/cli/v1/pair/exchange', { code: start.code, verifier }) as { token: string; expiresAt: string };
      writePrivate(sessionFile(deps.stateDir, alias), { origin, token: s.token, expiresAt: s.expiresAt });
      (deps.out ?? console.log)(`Sesión guardada (caduca ${s.expiresAt}).`);
      return;
    } catch (e) {
      // 409 = aún sin aprobar; 429 = esperar lo que pide el servidor; cualquier otra cosa corta.
      const wait = e instanceof RemoteError && (e.status === 409 || e.status === 429);
      if (!wait || Date.now() > deadline) throw wait ? new RemoteError('timeout', 'el pareo no se aprobó a tiempo') : e;
      await sleep(Math.max(2000, (e as RemoteError).retryAfter * 1000));
    }
  }
}

interface Parsed { verb: Verb; id: string; fields: Record<string, string>; confirm?: string; opId?: string; file?: string }

/** `--k v` y `--k=v` pasan a campos; `--yes` marca la confirmación del formulario; `--confirm <rev>` y `--op-id` son del comando; `--file` va aparte. */
export function parseVerb(argv: string[]): Parsed {
  const word = KNOWN.find(k => { const w = k.split(' '); return w.every((x, i) => argv[i] === x); });
  if (!word) throw new Error(`verbo remoto desconocido: ${argv.slice(0, 2).join(' ') || '(vacío)'}`);
  const verb = VERBS[word]!, rest = argv.slice(word.split(' ').length);
  const pos: string[] = [], fields: Record<string, string> = { ...verb.fixed };
  let confirm: string | undefined, opId: string | undefined, file: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    // `--yes` y `--cancel` son booleanos: no consumen el valor siguiente.
    if (k === 'yes') { fields.confirm = 'yes'; continue; }
    if (k === 'cancel') { fields.cancel = 'yes'; continue; }
    const value = inline ?? rest[++i];
    if (value === undefined) throw new Error(`falta el valor de --${k}`);
    if (k === 'confirm') confirm = value;
    else if (k === 'op-id') opId = value;
    else if (k === 'file' || k === 'package') file = value;
    else if (k === 'reassign-to') fields.reassignTo = value;
    else if (/^[A-Za-z][\w.]{0,60}$/.test(k)) fields[k] = value;
    else throw new Error(`flag desconocido: --${k}`);
  }
  const names = verb.args ?? [];
  if (pos.length > names.length) throw new Error(`sobran argumentos para «${word}»`);
  let id = '';
  names.forEach((n, i) => { if (pos[i] === undefined) return; if (n === 'id') id = pos[i]!; else fields[n] = pos[i]!; });
  return { verb, id, fields, confirm, opId, file };
}

function print(deps: RemoteDeps, data: unknown): void {
  (deps.out ?? console.log)(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

/** Punto de entrada de `fab --remote <alias> <verbo…>` y `fab remote add|list|rm`. Devuelve el código de salida. */
export async function remoteMain(argv: string[], deps: RemoteDeps): Promise<number> {
  const err = deps.err ?? console.error;
  try {
    if (argv[0] === 'remote') {
      if (argv[1] === 'add' && argv[2] && argv[3]) { addRemote(deps.stateDir, argv[2], argv[3]); return 0; }
      if (argv[1] === 'list') { print(deps, readJson(remotesFile(deps.stateDir)) ?? {}); return 0; }
      if (argv[1] === 'rm' && argv[2]) {
        const all = readJson<Record<string, unknown>>(remotesFile(deps.stateDir)) ?? {};
        delete all[argv[2]]; writePrivate(remotesFile(deps.stateDir), all);
        rmSync(sessionFile(deps.stateDir, argv[2]), { force: true });
        return 0;
      }
      throw new Error('fab remote add <alias> <https://host> | list | rm <alias>');
    }
    const [alias, ...verbArgv] = argv;
    if (!alias || !ALIAS.test(alias)) throw new Error('uso: fab --remote <alias> <verbo> …');
    const origin = remoteOrigin(deps.stateDir, alias);
    if (verbArgv[0] === 'login') { await login(deps, alias, origin); return 0; }
    const saved = readJson<{ origin: string; token: string; expiresAt: string }>(sessionFile(deps.stateDir, alias));
    // La sesión solo vale para el origen con el que se pareó.
    if (!saved || saved.origin !== origin || Date.parse(saved.expiresAt) <= Date.now()) throw new RemoteError('unauthorized', `sin sesión: ejecuta fab --remote ${alias} login`, 401);
    if (verbArgv[0] === 'logout') {
      try { await request(deps, origin, '/cli/v1/commands', { op: 'session/logout' }, saved.token); } catch (e) { if (!(e instanceof RemoteError && e.status === 401)) throw e; }
      rmSync(sessionFile(deps.stateDir, alias), { force: true });
      return 0;
    }
    const p = parseVerb(verbArgv);
    const fields = { ...p.fields };
    let id = p.id;
    if (p.verb.read) {
      const q = new URLSearchParams(Object.entries(fields)).toString();
      fields.path = p.verb.read.replace(':id', encodeURIComponent(id)) + (q ? `?${q}` : '');
      for (const k of Object.keys(fields)) if (k !== 'path') delete fields[k];
      id = '';
    }
    const send = (body: Record<string, unknown>) => request(deps, origin, '/cli/v1/commands', body, saved.token);
    if (p.verb.revision) fields.revision = ((await send({ op: 'ops/read', fields: { path: `/changes/${encodeURIComponent(id)}` } })) as { revision: string }).revision;
    const body: Record<string, unknown> = { op: p.verb.op, ...(id ? { id } : {}), fields, ...(p.confirm ? { confirm: p.confirm } : {}), ...(p.opId ? { opId: p.opId } : {}) };
    if (p.file) {
      // El cliente lee el fichero local y manda bytes y nombre base; el servidor no recibe rutas.
      if (!existsSync(p.file) || !statSync(p.file).isFile()) throw new Error('el fichero no existe');
      body.file = { name: basename(p.file), base64: readFileSync(p.file).toString('base64') };
    }
    print(deps, await send(body));
    return 0;
  } catch (e) {
    // Sin la sesión ni el cuerpo de la petición: solo código y mensaje del servidor o del cliente.
    err(e instanceof RemoteError ? `error (${e.code}): ${e.message}` : `error: ${(e as Error).message}`);
    return 1;
  }
}
