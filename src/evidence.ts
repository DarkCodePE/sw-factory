// Lectura de evidencia histórica: nunca crea directorios ni ejecuta git.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Activity, Store } from './store.ts';

export const EVIDENCE_LIMIT = 256 * 1024;
export type ClaudeFrame = Record<string, unknown>;
export interface EvidenceText { text: string; truncated: boolean; claudeFrames?: ClaudeFrame[]; claudeIncomplete?: boolean }
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
    if (path.endsWith('.log') && /^\s*\{\s*"type"\s*:\s*"(?:system|assistant|user|stream_event|rate_limit_event)"/.test(text)) {
      return readClaudeEvidence(text, truncated);
    }
    // JSON histórico puede contener PEM con saltos escapados; redactar los valores decodificados.
    if (!truncated && path.endsWith('.json')) {
      try {
        const textJson = JSON.stringify(JSON.parse(text), (key, v) => typeof v === 'string' ? (SECRET_KEY.test(key) ? '[REDACTED]' : redactForWeb(v)) : v, 2);
        return { text: textJson, truncated: false };
      } catch { /* Mostrar JSON roto como texto. */ }
    }
    return { text: redactEvidenceText(text), truncated };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

function redactEvidenceText(text: string): string {
  return redactForWeb(text.replace(new RegExp(`("[\\w-]*(?:${SECRET_WORDS})[\\w-]*"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'), '$1"[REDACTED]"'));
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
const SECRET_WORDS = 'api[_-]?key|token(?!izer)|secret|password|passwd|credential|private[_-]?key';
const SECRET_KEY = new RegExp(`${SECRET_WORDS}|^(?:pass|pwd|authorization|proxy-authorization|cookie|set-cookie)$|[_-]pwd$`, 'i');

// Redacta objetos y claves sensibles después de decodificar escapes JSON. Acota el anidamiento del log no confiable.
function redactLogValue(value: unknown, depth = 0): unknown {
  if (depth >= 64) return '[REDACTED]';
  if (typeof value === 'string') return redactForWeb(value);
  if (Array.isArray(value)) return value.map(item => redactLogValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    redactForWeb(key),
    typeof item === 'number' && /^(?:input|output|cache_creation_input|cache_read_input)_tokens$/.test(key) ? item
      : SECRET_KEY.test(key) ? '[REDACTED]' : redactLogValue(item, depth + 1),
  ]));
}

function readClaudeEvidence(text: string, truncated: boolean): EvidenceText {
  const lines = text.split('\n');
  const frames: ClaudeFrame[] = [];
  const rendered: string[] = [];
  let plain: string[] = [];
  let incomplete = truncated;
  let stderr = false;
  const flushPlain = () => {
    if (!plain.length) return;
    rendered.push(redactEvidenceText(plain.join('\n')));
    plain = [];
  };
  for (const [index, line] of lines.entries()) {
    if (line.trimEnd() === '[stderr]') {
      stderr = true;
    } else if (line.trim() && !(truncated && index === lines.length - 1)) {
      try {
        const value = JSON.parse(line) as ClaudeFrame | null;
        if (value && typeof value.type === 'string' && (!stderr || (value.type === 'system' && value.subtype === 'init'))) {
          stderr = false;
          const frame = redactLogValue(value) as ClaudeFrame;
          flushPlain();
          frames.push(frame);
          rendered.push(JSON.stringify(frame));
          continue;
        }
      } catch { /* Conserva la línea de diagnóstico aunque no se pueda interpretar. */ }
      if (!stderr) incomplete = true;
    }
    plain.push(line);
  }
  flushPlain();
  return { text: rendered.join('\n'), truncated, claudeFrames: frames, claudeIncomplete: incomplete };
}

// Valor: entre comillas con escapes, comilla sin cierre (corte de evidencia o valor enorme: hasta fin de línea), o hasta el siguiente separador.
const VALUE = String.raw`("(?:[^"\\\n]|\\.){0,4096}"|'(?:[^'\\\n]|\\.){0,4096}'|["'][^\r\n]*|[^\s"',}]+)`;
const quoted = (v: string) => /^["']/.test(v) ? `${v[0]}[REDACTED]${v[0]}` : '[REDACTED]';
// Con la clave entre comillas (JSON), solo se sustituye un valor de texto: los números y literales (`"input_tokens": 12`) se conservan.
const mask = (re: RegExp) => [re, (m: string, key: string, v: string) => /["']\s*[:=]\s*$/.test(key) && !/^["']/.test(v) ? m : key + quoted(v)] as const;

/** Saneador de un campo JSON: el nombre decide el valor completo; el resto pasa por `redact`. Lo comparten el manifiesto y el lector de evidencia. */
export function redactField(key: string, value: string): string {
  return SECRET_KEY.test(key) ? '[REDACTED]' : redact(value);
}

/** Una regla es una función de texto a texto; `source` (la regex que usa) deja que el test de linealidad derive sus entradas patológicas. */
type Rule = ((text: string) => string) & { source?: string };

/** Bloques de clave privada con cierre. Recorre con indexOf: si ya no queda ningún `-----END`, los BEGIN restantes no se vuelven a escanear (una regex lo haría una vez por BEGIN). */
function redactPrivateKeys(text: string): string {
  const begin = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/g, end = /-----END (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/g;
  let out = '', pos = 0, m: RegExpExecArray | null;
  while ((m = begin.exec(text))) {
    end.lastIndex = m.index + m[0].length;
    const e = end.exec(text);
    if (!e) break;
    out += text.slice(pos, m.index) + '[REDACTED]'; pos = e.index + e[0].length; begin.lastIndex = pos;
  }
  return out + text.slice(pos);
}
redactPrivateKeys.source = '-----BEGIN PRIVATE KEY----- -----END PRIVATE KEY-----';
const sub = (re: RegExp, to: string | ((m: string, key: string, v: string) => string)): Rule => Object.assign((t: string) => t.replace(re, to as string), { source: re.source });
const masked = (re: RegExp): Rule => { const [r, f] = mask(re); return sub(r, f); };

/** Reglas de redacción, en orden. Exportadas para el test de linealidad: cada regla debe costar O(n) con entradas patológicas. */
export const RULES: Rule[] = [
  redactPrivateKeys,
  sub(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'),
  sub(/\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[\w-]{35})\b/g, '[REDACTED]'),
  sub(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]'),
  sub(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, '[REDACTED]'),
  sub(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]'),
  // La cabecera acotada: con `-` en la clase y un `\b` delante, cada `eyJ` de `-eyJ-eyJ…` reinicia un recorrido hasta el final de la racha.
  sub(/\beyJ[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]'),
  sub(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@'),
  sub(/\bglpat-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'),
  sub(/\bnpm_[A-Za-z0-9]{20,}\b/g, '[REDACTED]'),
  masked(new RegExp(String.raw`\b((?:set-)?cookie["']\s*:\s*)${VALUE}`, 'gi')),
  // El valor se decide en la función, no con un lookahead: un lookahead que recorre la línea en cada retroceso es cuadrático.
  sub(/\b((?:Set-)?Cookie[ \t]*:[ \t]*)([^\r\n]+)/gi, (m, key, v) => /=|\S{16}/.test(v) ? `${key}[REDACTED]` : m),
  // Authorization: un esquema desconocido también oculta su valor (esquema opcional y un token); una palabra suelta como `required` no es credencial.
  masked(new RegExp(String.raw`\b((?:proxy-)?authorization["']?[ \t]*[:=](?![ \t]*[A-Za-z]{1,15}[ \t]*(?:[\r\n]|$))[ \t]*)${VALUE.replace('|[^\\s"\',}]+', '|(?:[A-Za-z][\\w-]*[ \\t]+)?[^\\s"\',}]+')}`, 'gi')),
  masked(new RegExp(String.raw`((?<![\w-])--[\w-]*?(?:token|secret|password|passwd|api-?key)[\w-]{0,256}(?:[ \t]+|=))(?![-<>|&]|\d+\b)${VALUE}`, 'gi')),
  masked(new RegExp(String.raw`(\bcurl\b(?:(?! (?:&&|\|\||;|\|) )[^\n]){0,500}?[ \t](?:-[a-zA-Z]{0,8}u|--user)(?:[ \t]+|=))(?!https?:\/\/)${VALUE}`, 'g')),
  // `pass` solo como asignación o clave JSON; `pwd` también con `:`, salvo que el valor sea una ruta o `$(…)`. `pass: 12` o `PASS: tests/x` no son secretos.
  masked(new RegExp(String.raw`\b(pass["']?[ \t]*=[ \t]*|pass["']\s*:\s*)${VALUE}`, 'gi')),
  masked(new RegExp(String.raw`(?<![A-Za-z0-9])(pwd["']?[ \t]*[:=][ \t]*|pwd["']\s*:\s*)(?![/~.$])${VALUE}`, 'gi')),
  // Sin prefijo capturado: el nombre de la clave que precede a la palabra queda en el texto, y no hay un recorrido por inicio.
  masked(new RegExp(String.raw`((?:${SECRET_WORDS})[\w-]{0,256}["']?\s*[:=]\s*)${VALUE}`, 'gi')),
];

export function redact(text: string): string {
  return RULES.reduce((t, rule) => rule(t), text);
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

