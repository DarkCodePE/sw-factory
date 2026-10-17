import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_FILE = 1024 * 1024;
const fdPath = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;

/** Linux directory capabilities: never reopen a checked ancestor by its lexical path.
 * Symlinks in tool file paths are deliberately rejected. Atomic replacement avoids
 * mutating an inode also hardlinked outside the workspace. */
export async function withWorkspaceFile<T>(root: string, path: string, createParents: boolean,
  work: (parent: FileHandle, name: string, absolute: string) => Promise<T>): Promise<T> {
  if (process.platform !== 'linux') throw new Error('Anchored workspace file access requires Linux');
  const base = await realpath(root), absolute = resolve(base, path), rel = relative(base, absolute);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Path is outside the workspace');
  const parts = rel.split(sep), name = parts.pop()!;
  const handles: FileHandle[] = [];
  try {
    let parent = await open(base, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(parent);
    for (const part of parts) {
      const anchored = fdPath(parent.fd, part);
      if (createParents) await mkdir(anchored).catch((e: any) => { if (e.code !== 'EEXIST') throw e; });
      try { parent = await open(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
      catch (e: any) { if (['ELOOP', 'ENOTDIR'].includes(e.code)) throw new Error('Symlink directory is not allowed'); throw e; }
      handles.push(parent);
    }
    return await work(parent, name, absolute);
  } finally { await Promise.all(handles.reverse().map(h => h.close())); }
}

export async function readAnchored(parent: FileHandle, name: string): Promise<{ text: string; data: Buffer; mode: number }> {
  const file = await open(fdPath(parent.fd, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await file.stat();
    if (!st.isFile() || st.size > MAX_FILE) throw new Error('Expected a regular file of at most 1 MiB');
    // Bounded descriptor read also handles files growing after stat.
    const buffer = Buffer.alloc(MAX_FILE + 1);
    let size = 0;
    while (size < buffer.length) {
      const next = await file.read(buffer, size, buffer.length - size, null);
      if (!next.bytesRead) break; size += next.bytesRead;
    }
    if (size > MAX_FILE) throw new Error('Read file exceeds 1 MiB');
    const data = buffer.subarray(0, size);
    return { text: data.toString('utf8'), data, mode: st.mode & 0o777 };
  } finally { await file.close(); }
}

export async function atomicReplace(parent: FileHandle, name: string, text: string | Uint8Array, signal: AbortSignal, mode = 0o600) {
  if (Buffer.byteLength(text) > MAX_FILE) throw new Error('File result exceeds 1 MiB');
  const temporary = fdPath(parent.fd, `.fab-${crypto.randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await file.writeFile(text); await file.sync(); await file.close();
    signal.throwIfAborted();
    await rename(temporary, fdPath(parent.fd, name));
    await parent.sync();
  } finally {
    await file.close().catch(() => {});
    await unlink(temporary).catch((e: any) => { if (e.code !== 'ENOENT') throw e; });
  }
}

export const readWorkspaceFile = (root: string, path: string) =>
  withWorkspaceFile(root, path, false, (parent, name) => readAnchored(parent, name));
