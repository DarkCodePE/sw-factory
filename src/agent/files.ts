import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { mkdirRelative, openRelative, renameRelative, unlinkRelative, type CapabilityHandle } from './file-capabilities.ts';

const MAX_FILE = 1024 * 1024;

/** Directory capabilities: never reopen a checked ancestor by its lexical path.
 * Symlinks in tool file paths are deliberately rejected. Atomic replacement avoids
 * mutating an inode also hardlinked outside the workspace. */
export async function withWorkspaceFile<T>(root: string, path: string, createParents: boolean,
  work: (parent: CapabilityHandle, name: string, absolute: string) => Promise<T>): Promise<T> {
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Anchored workspace file access requires Linux or macOS');
  const base = await realpath(root), absolute = resolve(base, path), rel = relative(base, absolute);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Path is outside the workspace');
  const parts = rel.split(sep), name = parts.pop()!;
  const handles: CapabilityHandle[] = [];
  try {
    let parent: CapabilityHandle = await open(base, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(parent);
    for (const part of parts) {
      if (createParents) await mkdirRelative(parent, part).catch((e: any) => { if (e.code !== 'EEXIST') throw e; });
      try { parent = await openRelative(parent, part, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
      catch (e: any) { if (['ELOOP', 'ENOTDIR'].includes(e.code)) throw new Error('Symlink directory is not allowed'); throw e; }
      handles.push(parent);
    }
    return await work(parent, name, absolute);
  } finally { await Promise.all(handles.reverse().map(h => h.close())); }
}

export async function readAnchored(parent: CapabilityHandle, name: string, maxBytes = MAX_FILE): Promise<{ text: string; data: Buffer; mode: number }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new Error('Invalid file byte limit');
  const file = await openRelative(parent, name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await file.stat();
    if (!st.isFile() || st.size > maxBytes) throw new Error(`Expected a regular file of at most ${maxBytes} bytes`);
    // Bounded descriptor read also handles files growing after stat.
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const next = await file.read(buffer, size, buffer.length - size, null);
      if (!next.bytesRead) break; size += next.bytesRead;
    }
    if (size > maxBytes) throw new Error('Read file exceeds byte limit');
    const data = buffer.subarray(0, size);
    return { text: data.toString('utf8'), data, mode: st.mode & 0o777 };
  } finally { await file.close(); }
}

export async function atomicReplace(parent: CapabilityHandle, name: string, text: string | Uint8Array, signal: AbortSignal, mode = 0o600, exactMode = false, maxBytes = MAX_FILE) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024 || Buffer.byteLength(text) > maxBytes) throw new Error('File result exceeds byte limit');
  const temporary = `.fab-${crypto.randomUUID()}.tmp`;
  const file = await openRelative(parent, temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await file.writeFile(text); if (exactMode) await file.chmod(mode); await file.sync(); await file.close();
    signal.throwIfAborted();
    await renameRelative(parent, temporary, name);
    await parent.sync();
  } finally {
    await file.close().catch(() => {});
    await unlinkRelative(parent, temporary).catch((e: any) => { if (e.code !== 'ENOENT') throw e; });
  }
}

export const readWorkspaceFile = (root: string, path: string) =>
  withWorkspaceFile(root, path, false, (parent, name) => readAnchored(parent, name));
export { unlinkRelative as unlinkAnchored } from './file-capabilities.ts';
