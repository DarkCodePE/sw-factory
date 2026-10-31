import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { terminalText } from './config.ts';

export const workspaceKey = (cwd: string) => createHash('sha256').update(cwd).digest('hex');
export const MAX_HISTORY_BYTES = 256 * 1024;
/** Private local state, bounded descriptor reads and atomic replacement; never project config. */
export async function readLocalJSON(path: string, max: number): Promise<unknown> {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await f.stat(); if (!st.isFile() || st.size > max) throw new Error('Estado local excede el límite');
    const b = Buffer.alloc(max + 1); let size = 0;
    while (size < b.length) { const r = await f.read(b, size, b.length - size, null); if (!r.bytesRead) break; size += r.bytesRead; }
    if (size > max) throw new Error('Estado local excede el límite');
    return JSON.parse(b.subarray(0, size).toString());
  } finally { await f.close(); }
}
export async function writeLocalJSON(path: string, data: unknown) {
  const temporary = path + '.' + crypto.randomUUID() + '.tmp';
  const f = await open(temporary, 'wx', 0o600);
  try { await f.writeFile(JSON.stringify(data)); await f.sync(); await f.close(); await rename(temporary, path); }
  finally { await f.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
export class PromptHistory {
  entries: string[] = [];
  readonly path: string;
  constructor(readonly home: string, readonly cwd: string) { this.path = join(home, 'prompt-history', workspaceKey(cwd) + '.json'); }
  async load() {
    this.entries = [];
    try {
      const value = await readLocalJSON(this.path, MAX_HISTORY_BYTES);
      if (Array.isArray(value)) this.entries = value.filter((s): s is string => typeof s === 'string' && Buffer.byteLength(s) <= 32 * 1024).slice(-100).map(terminalText);
    } catch { this.entries = []; }
    return this.entries;
  }
  async add(prompt: string) {
    prompt = terminalText(prompt).trim();
    if (!prompt || prompt.startsWith('/') || Buffer.byteLength(prompt) > 32 * 1024) return;
    if (this.entries.at(-1) !== prompt) this.entries.push(prompt);
    this.entries = this.entries.slice(-100);
    while (Buffer.byteLength(JSON.stringify(this.entries)) > MAX_HISTORY_BYTES) this.entries.shift();
    await mkdir(join(this.home, 'prompt-history'), { recursive: true, mode: 0o700 });
    await writeLocalJSON(this.path, this.entries);
  }
}
