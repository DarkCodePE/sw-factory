// Registro de servidores MCP: <stateDir>/mcp-servers.json, escrito a mano por el dueño.
// Solo referencias `${NOMBRE}`, nunca valores (D-K, T71 §4.3). `fab mcp list` lo valida y lo muestra.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { terminalText } from './chat/config.ts';
import { redact } from './evidence.ts';

export type McpServer =
  | { kind: 'url'; url: string; headers: Record<string, string>; required: string[] }
  | { kind: 'command'; command: string[]; env: Record<string, string>; required: string[] };
export type McpRegistry = Record<string, McpServer>;

const FILE = 'mcp-servers.json';
const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const REF = /^(?:Bearer )?\$\{([A-Z_][A-Z0-9_]{0,63})\}$/;
const FORBIDDEN_EXACT = new Set(['PATH', 'HOME', 'TMPDIR', 'NODE_OPTIONS']);
const FORBIDDEN_PREFIX = ['LD_', 'BUN_', 'GIT_CONFIG', 'FAB_', 'FABRICA_'];

/** Variables que cambian el cargador, git o la propia fab (T71 §4.2). Única lista: la usan el registro, el perfil y el Store. */
export const isForbiddenEnvName = (n: string): boolean => FORBIDDEN_EXACT.has(n) || FORBIDDEN_PREFIX.some(p => n.startsWith(p));

export class McpRegistryError extends Error {}
const bad = (field: string, why: string): never => { throw new McpRegistryError(`${FILE}: ${field}: ${why}`); };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function checkUrl(field: string, raw: unknown): string {
  if (typeof raw !== 'string') return bad(field, 'debe ser un texto');
  let u: URL;
  try { u = new URL(raw); } catch { return bad(field, 'URL inválida'); }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) bad(field, 'solo https:, o http: hacia 127.0.0.1 o localhost');
  if (u.username || u.password) bad(field, 'no admite usuario ni contraseña');
  if (raw.includes('?') || raw.includes('#')) bad(field, 'no admite cadena de consulta ni fragmento');
  // Los analizadores de URL difieren con `\`; se guarda la forma normalizada.
  if (raw.includes('\\')) bad(field, 'no admite barra invertida');
  // shortcut: un secreto sin forma conocida en la ruta no se detecta; la ruta no debe llevar credenciales.
  const path = (() => { try { return decodeURIComponent(u.pathname); } catch { return u.pathname; } })();
  if (redact(path) !== path) bad(field, 'la ruta parece contener una credencial; usa una cabecera con ${NOMBRE}');
  return u.href;
}

// Cada valor debe ser una referencia exacta; devuelve el nombre referenciado.
function refName(field: string, v: unknown, re: RegExp): string {
  const m = typeof v === 'string' ? re.exec(v) : null;
  if (!m) return bad(field, 'el valor debe ser una referencia ${NOMBRE}, no un valor literal');
  if (isForbiddenEnvName(m[1]!)) bad(field, `la variable ${m[1]} está prohibida`);
  return m[1]!;
}

function refMap(field: string, v: unknown, keyRe: RegExp, valRe: RegExp, required: Set<string>): Record<string, string> {
  if (!isObject(v)) return bad(field, 'debe ser un objeto');
  for (const [k, val] of Object.entries(v)) {
    if (!keyRe.test(k)) bad(`${field}.${k}`, 'nombre no válido');
    if (keyRe === ENV_NAME && isForbiddenEnvName(k)) bad(`${field}.${k}`, `la variable ${k} está prohibida`);
    required.add(refName(`${field}.${k}`, val, valRe));
  }
  return v as Record<string, string>;
}

function parseServer(name: string, s: unknown): McpServer {
  const f = `servers.${name}`;
  if (!SERVER_NAME.test(name) || name === 'fab') bad(f, 'nombre no válido o reservado');
  if (!isObject(s)) return bad(f, 'debe ser un objeto');
  const required = new Set<string>();
  const isUrl = 'url' in s, isCmd = 'command' in s;
  if (isUrl === isCmd) return bad(f, 'debe ser de tipo url o de tipo command, no ambos ni ninguno');
  const allowed = isUrl ? ['url', 'headers'] : ['command', 'env'];
  for (const k of Object.keys(s)) if (!allowed.includes(k)) bad(`${f}.${k}`, 'clave no admitida');
  const done = () => [...required].sort();
  if (isUrl) {
    const url = checkUrl(`${f}.url`, s.url);
    const headers = 'headers' in s ? refMap(`${f}.headers`, s.headers, HEADER_NAME, REF, required) : {};
    return { kind: 'url', url, headers, required: done() };
  }
  const c = s.command;
  if (!Array.isArray(c) || !c.length || !c.every(x => typeof x === 'string' && x !== '')) return bad(`${f}.command`, 'debe ser una lista de textos');
  if (!(c[0] as string).startsWith('/')) bad(`${f}.command`, 'el primer elemento debe ser una ruta absoluta');
  // Los argumentos acaban en argv (T34): nada que redact() reconozca como secreto; los secretos van por env.
  if (c.some(x => redact(x as string) !== x)) bad(`${f}.command`, 'los argumentos no pueden llevar secretos; pásalos por env con ${NOMBRE}');
  const env = 'env' in s ? refMap(`${f}.env`, s.env, ENV_NAME, /^\$\{([A-Z_][A-Z0-9_]{0,63})\}$/, required) : {};
  return { kind: 'command', command: c as string[], env, required: done() };
}

/** Sin fichero devuelve un registro vacío; cualquier defecto lanza McpRegistryError nombrando el campo. */
export function loadMcpRegistry(stateDir: string): McpRegistry {
  const path = join(stateDir, FILE);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return bad('JSON', 'JSON inválido'); }
  if (!isObject(raw)) return bad('raíz', 'debe ser un objeto');
  for (const k of Object.keys(raw)) if (k !== 'servers') bad(k, 'clave no admitida');
  if (!isObject(raw.servers)) return bad('servers', 'debe ser un objeto');
  return Object.fromEntries(Object.entries(raw.servers).map(([n, s]) => [n, parseServer(n, s)]));
}

/** Lo que se pinta en lugar de un nombre MCP por rol que no está en el registro: un valor pegado nunca se repite (T103-H11). */
export const MCP_OUTSIDE = '(nombre fuera del registro)';
/** Nombres del registro; un registro ausente o roto cuenta como vacío (todo queda «fuera»). */
export function registeredMcpNames(stateDir: string): Set<string> {
  try { return new Set(Object.keys(loadMcpRegistry(stateDir))); } catch { return new Set(); }
}

/** Nombres que no están en el registro (CLI y web comparten la comprobación). Lanza McpRegistryError si el registro es defectuoso. */
export function unregisteredMcp(stateDir: string, names: string[]): string[] {
  const reg = loadMcpRegistry(stateDir);
  return names.filter(n => !Object.hasOwn(reg, n));
}

/** fab mcp list (sin --settings): nombre, tipo y variables requeridas con «definida»/«no definida»; ningún valor. */
export function mcpListMain(stateDir: string, env: NodeJS.ProcessEnv = process.env): number {
  try {
    const entries = Object.entries(loadMcpRegistry(stateDir));
    if (!entries.length) { console.log('Sin servidores en el registro MCP'); return 0; }
    for (const [name, s] of entries) {
      const req = s.required.map(n => `${n} (${env[n] !== undefined ? 'definida' : 'no definida'})`).join(', ');
      console.log(`${name}  ${s.kind}  requiere: ${req || '—'}`);
    }
    return 0;
  } catch (e) {
    if (!(e instanceof McpRegistryError)) throw e;
    console.error(`error: ${terminalText(e.message)}`);
    return 1;
  }
}

/** Los servidores pedidos con el formato de `--mcp-config` de claude. Las referencias `${NOMBRE}` van sin resolver: las expande `claude` desde su entorno [I, T72g]. */
export function claudeMcpServers(registry: McpRegistry, names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.map(n => {
    const s = registry[n]!;
    // shortcut: el registro no declara el transporte; `/sse` al final de la ruta se trata como SSE, el resto como http (T72g lo comprueba).
    return [n, s.kind === 'url'
      ? { type: new URL(s.url).pathname.endsWith('/sse') ? 'sse' : 'http', url: s.url, headers: s.headers }
      : { command: s.command[0], args: s.command.slice(1), env: s.env }];
  }));
}
