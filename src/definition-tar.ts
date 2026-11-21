// Lector de tar en memoria para importar una definición empaquetada (T105). Nunca extrae a disco ni ejecuta nada:
// devuelve ruta relativa → texto, o rechaza el paquete entero. Solo ustar con ficheros y directorios.
import { StoreError } from './store.ts';

export const TAR_MAX_BYTES = 512 * 1024;
const MAX_ENTRIES = 64;
const MAX_FILE = 64 * 1024; // el tope de un SKILL.md; las plantillas del perfil son menores
const BLOCK = 512;
const bad = (m: string) => new StoreError('invalid_input', m);
/** Un nombre del paquete es dato hostil: en un mensaje va entre comillas y sin controles ni bidi (T105-H4). */
export const quoteName = (raw: string) => /[\p{Cc}\p{Cf}"\\]/u.test(raw) ? JSON.stringify(raw).replace(/[\p{Cc}\p{Cf}]/gu, c => `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}`) : raw;
const utf8 = new TextDecoder('utf-8', { fatal: true });

const cstr = (h: Uint8Array, from: number, len: number) => {
  const slice = h.subarray(from, from + len);
  const end = slice.indexOf(0);
  return Buffer.from(end < 0 ? slice : slice.subarray(0, end)).toString('latin1');
};
const octal = (h: Uint8Array, from: number, len: number, what: string) => {
  const s = cstr(h, from, len).trim();
  if (!/^[0-7]+$/.test(s)) throw bad(`tar: ${what} inválido`);
  return parseInt(s, 8);
};

/** Ruta relativa y limpia: sin absoluta, sin «..», sin segmentos vacíos ni caracteres de control. */
export function safeRelativePath(raw: string): string {
  const path = raw.replace(/^\.\//, '').replace(/\/$/, '');
  if (!path || path.startsWith('/') || path.includes('\\') || /[\p{Cc}\p{Cf}]/u.test(path)) throw bad(`ruta no admitida en el paquete: ${quoteName(raw)}`);
  if (path.split('/').some(s => s === '' || s === '.' || s === '..')) throw bad(`ruta no admitida en el paquete: ${quoteName(raw)}`);
  return path;
}

export function readTar(buf: Uint8Array): Map<string, string> {
  if (buf.length === 0 || buf.length > TAR_MAX_BYTES) throw bad(`el paquete debe ocupar entre 1 byte y ${TAR_MAX_BYTES} bytes`);
  if (buf.length % BLOCK !== 0) throw bad('el paquete no es un tar válido (usa tar --format=ustar)');
  const files = new Map<string, string>();
  let off = 0, entries = 0;
  for (; off + BLOCK <= buf.length;) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every(b => b === 0)) break;
    const sum = h.reduce((a, b, i) => a + (i >= 148 && i < 156 ? 32 : b), 0);
    if (sum !== octal(h, 148, 8, 'checksum')) throw bad('el paquete no es un tar válido (checksum)');
    if (++entries > MAX_ENTRIES) throw bad(`el paquete supera ${MAX_ENTRIES} entradas`);
    const name = cstr(h, 0, 100);
    if (cstr(h, 345, 155)) throw bad(`${quoteName(name)}: ruta con prefijo ustar no admitida`);
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]!);
    const size = octal(h, 124, 12, 'tamaño');
    off += BLOCK;
    if (type === '5') { safeRelativePath(name === './' ? 'x' : name); if (size) throw bad(`${quoteName(name)}: un directorio no lleva datos`); continue; }
    if (type !== '0') throw bad(`${quoteName(name)}: ${type === '2' ? 'enlace simbólico' : type === '1' ? 'enlace duro' : `entrada de tipo ${JSON.stringify(type)}`} no admitida; solo ficheros y directorios (tar --format=ustar)`);
    const path = safeRelativePath(name);
    if (files.has(path)) throw bad(`${quoteName(path)}: repetido en el paquete`);
    if (size > MAX_FILE) throw bad(`${quoteName(path)} supera ${MAX_FILE} bytes`);
    if (off + size > buf.length) throw bad('el paquete está truncado');
    try { files.set(path, utf8.decode(buf.subarray(off, off + size))); } catch { throw bad(`${quoteName(path)} no es texto UTF-8`); }
    if (files.get(path)!.includes('\0')) throw bad(`${quoteName(path)} no es texto`);
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  if (!buf.subarray(off).every(b => b === 0)) throw bad('el paquete trae datos tras el final del tar');
  return files;
}
