// Lectura de evidencia histórica: nunca crea directorios ni ejecuta git.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Activity, Store } from './store.ts';

export const EVIDENCE_LIMIT = 256 * 1024;
export interface EvidenceText { text: string; truncated: boolean }
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

/** Las rutas son relativas a stateDir. Se rechazan todos los symlinks, incluidos los internos. */
export function readEvidence(stateDir: string, path: string): EvidenceText | null {
  if (isAbsolute(path) || path.split(/[\\/]/).some(p => p === '..' || p === '.' || !p)) throw new Error('Ruta de evidencia inválida');
  const root = realpathSync(stateDir);
  const target = resolve(root, path);
  if (!inside(root, target)) throw new Error('Evidencia fuera de stateDir');
  let fd: number | undefined;
  try {
    let cursor = root;
    for (const part of path.split('/')) {
      cursor = join(cursor, part);
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('Symlink de evidencia rechazado');
    }
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    // Comprueba el fichero realmente abierto: cubre sustituciones de directorios entre lstat y open.
    const opened = process.platform === 'linux' ? realpathSync(`/proc/self/fd/${fd}`) : realpathSync(target);
    if (!inside(root, opened)) throw new Error('Evidencia fuera de stateDir');
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('La evidencia no es un fichero regular');
    const buffer = Buffer.alloc(EVIDENCE_LIMIT + 1);
    let count = 0;
    while (count < buffer.length) {
      const n = readSync(fd, buffer, count, buffer.length - count, null);
      if (!n) break;
      count += n;
    }
    const truncated = count > EVIDENCE_LIMIT;
    let text = buffer.subarray(0, Math.min(count, EVIDENCE_LIMIT)).toString('utf8');
    // No presentar un token cortado: podría no encajar ya en su patrón de redacción.
    if (truncated) {
      const floor = Math.max(0, text.length - 4096);
      let i = text.length;
      while (i > floor && text[i - 1]!.trim() !== '') i--;
      text = text.slice(0, i);
    }
    // JSON histórico puede contener PEM con saltos escapados; redactar los valores decodificados.
    if (!truncated && path.endsWith('.json')) {
      try {
        const textJson = JSON.stringify(JSON.parse(text), (key, v) => typeof v === 'string' ? (SECRET_KEY.test(key) ? '[REDACTED]' : redactForWeb(v)) : v, 2);
        return { text: textJson, truncated: false };
      } catch { /* Mostrar JSON roto como texto. */ }
    }
    text = text.replace(new RegExp(`("[\\w-]*(?:${SECRET_WORDS})[\\w-]*"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'), '$1"[REDACTED]"');
    text = redactForWeb(text);
    return { text, truncated };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

// Regla de presentación; no amplía redact ni cambia la lectura histórica de improve.
function redactForWeb(text: string): string {
  return redact(text).replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*$/g, '[REDACTED]');
}

export function evidencePath(changeId: string, file: string): string {
  if (!/^[\w-]+$/.test(changeId) || !/^[\w.-]+$/.test(file) || file.includes('..')) throw new Error('Identificador de evidencia inválido');
  return `runs/${changeId}/${file}`;
}

// Palabras que delatan un valor secreto en una clave; `pass` y las cabeceras van aparte y exactas, para no atrapar «bypass» o «Cookie banner».
const SECRET_WORDS = 'api[_-]?key|token(?!iz)|secret|password|passwd|credential|private[_-]?key';
const SECRET_KEY = new RegExp(`${SECRET_WORDS}|^(?:pass|authorization|proxy-authorization|cookie|set-cookie)$`, 'i');
// Valor: entre comillas con escapes, comilla sin cierre (corte de evidencia o valor enorme: hasta fin de línea), o hasta el siguiente separador.
const VALUE = String.raw`("(?:[^"\\\n]|\\.){0,4096}"|'(?:[^'\\\n]|\\.){0,4096}'|["'][^\r\n]*|[^\s"',}]+)`;
const quoted = (v: string) => /^["']/.test(v) ? `${v[0]}[REDACTED]${v[0]}` : '[REDACTED]';
// Con la clave entre comillas (JSON), solo se sustituye un valor de texto: los números y literales (`"input_tokens": 12`) se conservan.
const mask = (re: RegExp) => [re, (m: string, key: string, v: string) => /["']\s*[:=]\s*$/.test(key) && !/^["']/.test(v) ? m : key + quoted(v)] as const;

/** Saneador de un campo JSON: el nombre decide el valor completo; el resto pasa por `redact`. Lo comparten el manifiesto y el lector de evidencia. */
export function redactField(key: string, value: string): string {
  return SECRET_KEY.test(key) ? '[REDACTED]' : redact(value);
}

const RULES: (readonly [RegExp, string | ((m: string, key: string, v: string) => string)])[] = [
  [/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/g, '[REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[\w-]{35})\b/g, '[REDACTED]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, '[REDACTED]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]'],
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/\bnpm_[A-Za-z0-9]{20,}\b/g, '[REDACTED]'],
  mask(new RegExp(String.raw`\b((?:set-)?cookie["']\s*:\s*)${VALUE}`, 'gi')),
  [/\b((?:Set-)?Cookie[ \t]*:[ \t]*)(?=[^\r\n]*=|\S{16})[^\r\n]+/gi, '$1[REDACTED]'],
  // Authorization: un esquema desconocido también oculta su valor (hasta fin de línea); una palabra suelta como `required` no es credencial.
  mask(new RegExp(String.raw`\b((?:proxy-)?authorization["']?[ \t]*[:=](?![ \t]*[A-Za-z]{1,15}[ \t]*(?:[\r\n]|$))[ \t]*)${VALUE.replace('|[^\\s"\',}]+', '|[^\\r\\n]+')}`, 'gi')),
  mask(new RegExp(String.raw`((?<![\w-])--[\w-]{0,64}?(?:token|secret|password|passwd|api-?key)[\w-]{0,64}(?:[ \t]+|=))(?![-<>|&]|\d+\b)${VALUE}`, 'gi')),
  mask(new RegExp(String.raw`(\bcurl\b[^\n&|;]{0,500}?[ \t](?:-[a-zA-Z]{0,8}u|--user)(?:[ \t]+|=))${VALUE}`, 'g')),
  // `pass` y `pwd` solo como asignación o clave JSON; `pwd:` no cuenta si el valor es una ruta o `$(…)`; `pass: 12` o `PASS: tests/x` no son secretos.
  mask(new RegExp(String.raw`\b((?:pass["']?[ \t]*=|pass["']\s*:|pwd["']?[ \t]*[:=]|pwd["']\s*:)[ \t]*)(?![/~.$])${VALUE}`, 'gi')),
  mask(new RegExp(String.raw`\b([\w-]{0,64}?(?:${SECRET_WORDS})[\w-]{0,64}["']?\s*[:=]\s*)${VALUE}`, 'gi')),
];

export function redact(text: string): string {
  return RULES.reduce((t, [re, to]) => t.replace(re, to as string), text);
}



export function activityMetadata(stateDir: string, a: Activity): Record<string, unknown> | null {
  const file = readEvidence(stateDir, evidencePath(a.changeId, `${a.id}.json`));
  if (!file || file.truncated) return null;
  try {
    const value = JSON.parse(file.text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/** Conserva la semántica del coste de improve: falta un intento => total desconocido. */
export function activityCosts(a: Activity, meta: Record<string, unknown> | null): (number | null)[] | null {
  if (!meta) return null;
  const costs = meta.attemptCosts ?? (a.retryCount === 0 ? [(meta.usage as { costUsd?: unknown } | undefined)?.costUsd] : null);
  const attempts = Math.max(1, a.retryCount + (a.status === 'failed' ? 0 : 1));
  if (!Array.isArray(costs) || costs.length < attempts) return null;
  return costs.map(c => typeof c === 'number' && Number.isFinite(c) ? c : null);
}

export function changeCost(store: Store, stateDir: string, changeId: string): number | null {
  const acts = store.listActivities({ changeId });
  if (!acts.length) return null;
  let total = 0;
  for (const a of acts) {
    const costs = activityCosts(a, activityMetadata(stateDir, a));
    if (!costs || costs.some(c => c === null)) return null;
    total += (costs as number[]).reduce((sum, c) => sum + c, 0);
  }
  return total;
}

// Sonda de egress escrita por el hijo native; ausente si la activity no usó red.
export function readEgressProbe(path: string) {
  try {
    const { reachable, decided, positiveControl, probedAt } = JSON.parse(readFileSync(path, 'utf8'));
    return { reachable, decided, positiveControl, probedAt };
  } catch { return null; }
}

