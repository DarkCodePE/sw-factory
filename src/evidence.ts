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
        const textJson = JSON.stringify(JSON.parse(text), (key, v) => typeof v === 'string' ? (/api[_-]?key|token|secret|password|credential/i.test(key) ? '[REDACTED]' : redactForWeb(v)) : v, 2);
        return { text: textJson, truncated: false };
      } catch { /* Mostrar JSON roto como texto. */ }
    }
    text = text.replace(/("[\w-]*(?:api[_-]?key|token|secret|password|credential)[\w-]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[REDACTED]"');
    text = redactForWeb(text);
    return { text, truncated };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

// Regla de presentación; no amplía redact ni cambia la lectura histórica de improve.
function redactForWeb(text: string): string {
  return redact(text).replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*$/g, '[REDACTED]');
}

export function evidencePath(changeId: string, file: string): string {
  if (!/^[\w-]+$/.test(changeId) || !/^[\w.-]+$/.test(file) || file.includes('..')) throw new Error('Identificador de evidencia inválido');
  return `runs/${changeId}/${file}`;
}

export function redact(text: string): string {
  return text
    .replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[\w-]{35})\b/g, '[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, '[REDACTED]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b([\w-]*(?:api[_-]?key|token|secret|password|credential)[\w-]*\s*[:=]\s*)["']?[^\s"',}]+["']?/gi, '$1[REDACTED]');
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

