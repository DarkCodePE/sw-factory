import { lstatSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { withinMount, writableMounts } from './sandbox/mounts.ts';

export const NOTE_ATTACHMENT_MAX = 64 * 1024;
export const NOTE_ATTACHMENT_HISTORY_MAX = 1024 * 1024;
export const NOTE_ATTACHMENT_EXTENSIONS = ['.txt', '.md', '.log', '.json', '.csv'] as const;

export interface NoteAttachment { name: string; bytes: Uint8Array }
export interface NoteAttachmentMeta { name: string; size: number }
export interface NoteAttachmentTarget { cwd?: string; persistentMounts?: string[]; /** Inventario de escritura calculado fuera de la transacción. */ inventory?: string[] }

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
// Textos fijos, sin datos de la petición: la web los enseña tal cual para que el dueño sepa qué corregir.
export const NOTE_ATTACHMENT_STATE = {
  mode: 'Los adjuntos requieren un estado privado: el directorio de estado de fab debe ser 0700 (ejecuta chmod 700 sobre él; los estados nuevos ya se crean así).',
  ancestor: 'Un directorio superior al estado permite escribir a otros usuarios o es un enlace, y los adjuntos requieren un estado privado: quita ese permiso o mueve el estado con FABRICA_HOME.',
  files: 'La base de fab o sus sidecars no son ficheros regulares propios, sin enlaces y sin permiso de escritura para otros (una base 664 no vale: ejecuta chmod 600 sobre ella), y los adjuntos requieren un estado privado.',
  mounts: 'El estado de fab cae dentro de un repo, un git dir, un worktree o un montaje persistente, y los adjuntos requieren un estado privado fuera de montajes escribibles.',
  git: 'No se pudo inventariar los repos de los workstreams con Git: los adjuntos requieren un estado privado fuera de montajes escribibles.',
} as const;

export const ANCESTOR_PATH_PREFIX = ' Directorio: ';
export const NOTE_ATTACHMENT_REMOTE = 'Los adjuntos requieren un workstream local. El runner asignado es remoto.';

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** Comprueba la ruta antes de abrir SQLite, incluso los enlaces colgantes de sidecars opcionales. */
export function assertPrivateNoteDatabase(dbPath: string): void {
  if (dbPath === ':memory:') throw new Error(PRIVATE_STATE);
  const db = resolve(dbPath), state = dirname(db), uid = userInfo().uid;
  const root = parse(state).root;
  let path = root;
  let reason: keyof typeof NOTE_ATTACHMENT_STATE = 'ancestor';
  try {
    for (const part of [null, ...state.slice(root.length).split(sep).filter(Boolean)]) {
      if (part !== null) path = join(path, part);
      reason = path === state ? 'mode' : 'ancestor';
      const st = lstatSync(path);
      // /tmp es válido como ancestro si es de root y el sticky bit protege al directorio del dueño.
      const stickyRoot = path !== state && st.uid === 0 && (st.mode & 0o1000);
      if (!st.isDirectory() || (st.uid !== uid && st.uid !== 0) || ((st.mode & 0o022) && !stickyRoot)) throw new Error();
      if (path === state && (st.uid !== uid || (st.mode & 0o077))) throw new Error();
    }
    reason = 'files';
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      let st;
      try { st = lstatSync(db + suffix); }
      catch (error) { if (suffix && missing(error)) continue; throw error; }
      if (!st.isFile() || st.uid !== uid || st.nlink !== 1 || (st.mode & 0o022)) throw new Error();
    }
  } catch {
    // T96-H10: el aviso de ancestro nombra el directorio que falla (ruta local del dueño; la web la acepta solo si es ASCII sin marcado).
    throw new Error(reason === 'ancestor' ? `${NOTE_ATTACHMENT_STATE.ancestor}${ANCESTOR_PATH_PREFIX}${path}` : NOTE_ATTACHMENT_STATE[reason]);
  }
}

/**
 * Inventario de escritura: reutiliza el de Git por checkout. Lanza `git`, así que se calcula fuera de la
 * transacción. Un repo que ya no existe no puede montarse y no cuenta (otro workstream no bloquea el resto).
 */
export function noteAttachmentInventory(repos: string[], target?: NoteAttachmentTarget): string[] {
  const paths = new Set<string>();
  try {
    for (const repo of new Set(repos)) {
      let real: string;
      try { real = realpathSync(repo); }
      catch (error) { if (missing(error) || (error as NodeJS.ErrnoException)?.code === 'ENOTDIR') continue; throw error; }
      try { for (const path of writableMounts(repo)) paths.add(path); }
      catch {
        // T96-H9: un repo que ya no es repo Git no tiene git dirs ni worktrees que inventariar; su propia ruta sigue contando como montaje.
        const probe = Bun.spawnSync(['git', '-C', real, 'rev-parse', '--git-dir']);
        if (probe.exitCode !== 0 && /not a git repository|not a directory/i.test(probe.stderr.toString())) { paths.add(real); continue; }
        throw new Error();
      }
      const list = Bun.spawnSync(['git', '-C', repo, 'worktree', 'list', '--porcelain', '-z']);
      if (list.exitCode !== 0) throw new Error();
      for (const entry of list.stdout.toString().split('\0')) {
        if (!entry.startsWith('worktree ')) continue;
        // El registro de Git puede conservar worktrees eliminados; sus git dirs comunes ya se comprobaron.
        let worktree: string;
        try { worktree = realpathSync(entry.slice('worktree '.length)); }
        catch (error) { if (missing(error)) continue; throw error; }
        if (worktree !== real) for (const path of writableMounts(worktree)) paths.add(path);
      }
    }
    if (target?.cwd) for (const path of writableMounts(target.cwd)) paths.add(path);
  } catch { throw new Error(NOTE_ATTACHMENT_STATE.git); }
  return [...paths];
}

/** Solo lectura y sin procesos: compara el estado con el inventario y con los directorios persistentes de fab. */
export function assertNoteAttachmentMounts(dbPath: string, repos: string[], target?: NoteAttachmentTarget): void {
  const state = dirname(resolve(dbPath));
  const inventory = target?.inventory ?? noteAttachmentInventory(repos, target);
  try {
    for (const path of inventory) if (withinMount(state, path)) throw new Error();
    for (const path of [join(state, 'worktrees'), join(state, 'live'), ...(target?.persistentMounts ?? [])]) {
      try { if (withinMount(state, realpathSync(path))) throw new Error(); }
      catch (error) { if (!missing(error)) throw error; }
    }
  } catch { throw new Error(NOTE_ATTACHMENT_STATE.mounts); }
}
