import { lstatSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { withinMount, writableMounts } from './sandbox/mounts.ts';

export const NOTE_ATTACHMENT_MAX = 64 * 1024;
export const NOTE_ATTACHMENT_HISTORY_MAX = 1024 * 1024;
export const NOTE_ATTACHMENT_EXTENSIONS = ['.txt', '.md', '.log', '.json', '.csv'] as const;

export interface NoteAttachment { name: string; bytes: Uint8Array }
export interface NoteAttachmentMeta { name: string; size: number }
export interface NoteAttachmentTarget { cwd: string; persistentMounts?: string[] }

export const NOTE_ATTACHMENT_WAIT = {
  remote: 'El runner asignado es remoto.',
  transport: 'El turno necesita confinamiento local y una entrada de prompt apta.',
  state: 'La base debe estar en estado privado, fuera de montajes escribibles.',
  size: 'El prompt con adjuntos supera 128 KiB.',
  invalid: 'El adjunto almacenado no supera la validación de texto.',
} as const;
export type NoteAttachmentWait = keyof typeof NOTE_ATTACHMENT_WAIT;

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function decodeNoteAttachment(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

export function validateNoteAttachment(file: NoteAttachment): string | undefined {
  if (!file || typeof file.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/.test(file.name)
    || file.name.includes('..') || !NOTE_ATTACHMENT_EXTENSIONS.some(ext => file.name.toLowerCase().endsWith(ext))) {
    return 'El nombre del adjunto debe tener hasta 120 caracteres ASCII permitidos y extensión .txt, .md, .log, .json o .csv.';
  }
  if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength < 1 || file.bytes.byteLength > NOTE_ATTACHMENT_MAX) {
    return 'El adjunto debe ocupar entre 1 y 65 536 bytes.';
  }
  try {
    if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(decodeNoteAttachment(file.bytes))) return;
  } catch { /* UTF-8 inválido */ }
  return 'El adjunto debe ser texto UTF-8 sin caracteres de control salvo TAB, LF y CR.';
}

const PRIVATE_STATE = 'Los adjuntos requieren una base y sidecars regulares en un estado privado, fuera de montajes escribibles.';

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** Comprueba la ruta antes de abrir SQLite, incluso los enlaces colgantes de sidecars opcionales. */
export function assertPrivateNoteDatabase(dbPath: string): void {
  if (dbPath === ':memory:') throw new Error(PRIVATE_STATE);
  const db = resolve(dbPath), state = dirname(db), uid = userInfo().uid;
  const root = parse(state).root;
  let path = root;
  try {
    for (const part of [null, ...state.slice(root.length).split(sep).filter(Boolean)]) {
      if (part !== null) path = join(path, part);
      const st = lstatSync(path);
      // /tmp es válido como ancestro si es de root y el sticky bit protege al directorio del dueño.
      const stickyRoot = path !== state && st.uid === 0 && (st.mode & 0o1000);
      if (!st.isDirectory() || (st.uid !== uid && st.uid !== 0) || ((st.mode & 0o022) && !stickyRoot)) throw new Error();
      if (path === state && (st.uid !== uid || (st.mode & 0o077))) throw new Error();
    }
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      let st;
      try { st = lstatSync(db + suffix); }
      catch (error) { if (suffix && missing(error)) continue; throw error; }
      if (!st.isFile() || st.uid !== uid || st.nlink !== 1 || (st.mode & 0o022)) throw new Error();
    }
  } catch { throw new Error(PRIVATE_STATE); }
}

/** Reutiliza el inventario de Git por checkout y cubre los directorios persistentes de fab. Solo lectura. */
export function assertNoteAttachmentMounts(dbPath: string, repos: string[], target?: NoteAttachmentTarget): void {
  const state = dirname(resolve(dbPath));
  const check = (path: string) => {
    if (withinMount(state, path)) throw new Error(PRIVATE_STATE);
  };
  try {
    for (const repo of new Set(repos)) {
      for (const path of writableMounts(repo)) check(path);
      const list = Bun.spawnSync(['git', '-C', repo, 'worktree', 'list', '--porcelain', '-z']);
      if (list.exitCode !== 0) throw new Error();
      for (const entry of list.stdout.toString().split('\0')) {
        if (!entry.startsWith('worktree ')) continue;
        const worktree = entry.slice('worktree '.length);
        // El registro de Git puede conservar worktrees eliminados; sus git dirs comunes ya se comprobaron.
        let real: string;
        try { real = realpathSync(worktree); }
        catch (error) { if (missing(error)) continue; throw error; }
        if (real !== realpathSync(repo)) for (const path of writableMounts(real)) check(path);
      }
    }
    if (target) for (const path of writableMounts(target.cwd)) check(path);
    for (const path of [join(state, 'worktrees'), join(state, 'live'), ...(target?.persistentMounts ?? [])]) {
      try { check(realpathSync(path)); }
      catch (error) { if (!missing(error)) throw error; }
    }
  } catch { throw new Error(PRIVATE_STATE); }
}
