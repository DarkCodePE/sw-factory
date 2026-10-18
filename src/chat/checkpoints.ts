import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomicReplace, readAnchored, unlinkAnchored, withWorkspaceFile } from '../agent/files.ts';
import { openRelative, type CapabilityHandle } from '../agent/file-capabilities.ts';
import type { FileMutation, FileSnapshot, ToolContext } from '../agent/types.ts';
import { workspaceKey } from './history.ts';

const MAX_BYTES = 16 * 1024 * 1024;
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
interface Entry { path: string; before?: { data: string; mode: number }; after: string; mode: number; uncertain: boolean }
interface Turn { id: string; label: string; generation: number; entries: Entry[]; restored?: boolean; restoring?: boolean }
interface Journal { version: 1; cwd: string; generation: number; turns: Turn[] }
const inside = (root: string, path: string) => { const rel = relative(root, path); return !rel || rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
const safePath = (path: string) => !!path && !isAbsolute(path) && path.split(sep).every(p => p && !['.', '..', '.git', '.fab', '.fabrica'].includes(p));

/** Conservative file undo. Unknown mutators fence every earlier checkpoint before they run. */
export class Checkpoints {
  private state!: Journal;
  private turn?: Turn;
  private lock?: CapabilityHandle;
  private anchor?: Awaited<ReturnType<typeof open>>;
  private stateName = '';
  readonly directory: string;
  readonly path: string;
  constructor(readonly cwd: string, readonly home: string) {
    this.directory = join(home, 'file-checkpoints'); this.path = join(this.directory, workspaceKey(cwd) + '.json');
  }
  private async acquire() {
    if (this.lock) throw new Error('Journal ya activo');
    if (await realpath(this.cwd) !== this.cwd || inside(this.cwd, resolve(this.home))) throw new Error('Los checkpoints requieren un home privado fuera del workspace');
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    if (inside(this.cwd, await realpath(this.home))) throw new Error('El home real está dentro del workspace');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const actual = await realpath(this.directory);
    if (inside(this.cwd, actual)) throw new Error('El journal real está dentro del workspace');
    try {
      this.anchor = await open(actual, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const directoryStat = await this.anchor.stat();
      if (directoryStat.uid !== process.getuid?.() || directoryStat.mode & 0o022) throw new Error('El journal debe ser privado y no escribible por otros usuarios');
      this.stateName = `${workspaceKey(this.cwd)}.json`;
      this.lock = await openRelative(this.anchor, this.stateName + '.lock', constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let raw: unknown;
      try { raw = JSON.parse((await readAnchored(this.anchor, this.stateName, MAX_BYTES)).text); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      if (raw === undefined) this.state = { version: 1, cwd: this.cwd, generation: 0, turns: [] };
      else { this.validate(raw); this.state = raw; }
    } catch (e) { await this.finish(); throw e; }
  }
  private validate(value: unknown): asserts value is Journal {
    const j = value as Journal;
    if (!j || j.version !== 1 || j.cwd !== this.cwd || !Number.isSafeInteger(j.generation) || j.generation < 0 || !Array.isArray(j.turns) || j.turns.length > 20) throw new Error('Journal inválido');
    for (const t of j.turns) {
      if (!t || typeof t.id !== 'string' || !/^[\w-]+$/.test(t.id) || typeof t.label !== 'string' || !Number.isSafeInteger(t.generation) || t.generation < 0 || t.generation > j.generation || !Array.isArray(t.entries) || t.entries.length > 100) throw new Error('Checkpoint inválido');
      const paths = new Set<string>();
      for (const e of t.entries) {
        if (!e || !safePath(e.path) || paths.has(e.path) || !/^[a-f0-9]{64}$/.test(e.after) || !Number.isInteger(e.mode) || e.mode < 0 || e.mode > 0o777 || typeof e.uncertain !== 'boolean') throw new Error('Entrada de checkpoint inválida');
        paths.add(e.path);
        if (e.before && (typeof e.before.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.before.data) || Buffer.from(e.before.data, 'base64').length > 1024 * 1024 || !Number.isInteger(e.before.mode) || e.before.mode < 0 || e.before.mode > 0o777)) throw new Error('Snapshot inválido');
      }
    }
  }
  private async save() {
    const text = JSON.stringify(this.state) + '\n';
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Checkpoints exceden 16 MiB; escritura cancelada');
    if (!this.anchor) throw new Error('Journal sin directorio anclado');
    await atomicReplace(this.anchor, this.stateName, text, new AbortController().signal, 0o600, true, MAX_BYTES);
  }
  async begin(label: string) {
    await this.acquire();
    this.turn = { id: crypto.randomUUID(), label: label.slice(0, 100), generation: this.state.generation, entries: [] };
    this.state.turns = [...this.state.turns.slice(-19), this.turn];
    try { await this.save(); } catch (e) { await this.finish(); throw e; }
  }
  async prepare(change: FileMutation, context: ToolContext) {
    if (context.cwd !== this.cwd) throw new Error('Checkpoint de otro workspace rechazado');
    if (!this.turn || !this.lock) throw new Error('No hay turno de checkpoints activo');
    const path = relative(this.cwd, resolve(this.cwd, change.path));
    if (!safePath(path)) throw new Error('Ruta protegida o fuera del workspace');
    let entry = this.turn.entries.find(e => e.path === path);
    if (entry) {
      if (entry.uncertain || !change.before || hash(change.before.data) !== entry.after || change.before.mode !== entry.mode) throw new Error('Archivo cambiado fuera del journal');
    } else {
      if (this.turn.entries.length >= 100) throw new Error('Máximo 100 archivos por turno');
      entry = { path, before: change.before ? { data: Buffer.from(change.before.data).toString('base64'), mode: change.before.mode } : undefined,
        after: hash(change.after), mode: change.mode, uncertain: true };
      this.turn.entries.push(entry);
    }
    entry.after = hash(change.after); entry.uncertain = true;
    await this.save(); // durable intent precedes the write, including cancellation/crash windows
    const saved = entry;
    return async (applied: FileSnapshot) => { saved.after = hash(applied.data); saved.mode = applied.mode; saved.uncertain = false; await this.save(); };
  }
  async barrier(_name: string, _context: ToolContext) {
    if (!this.lock) throw new Error('No hay journal activo');
    this.state.generation++; await this.save();
  }
  async finish() {
    this.turn = undefined;
    try { if (this.lock) { await this.lock.close(); this.lock = undefined; await unlinkAnchored(this.anchor!, this.stateName + '.lock'); } }
    finally { await this.anchor?.close(); this.anchor = undefined; this.stateName = ''; }
  }
  async list() {
    await this.acquire();
    try { return this.state.turns.filter(t => t.entries.length && !t.restored).map(t => ({ id: t.id, label: t.label, files: t.entries.length, blocked: t.generation !== this.state.generation || t.restoring || t.entries.some(e => e.uncertain) })); }
    finally { await this.finish(); }
  }
  async rewind(id?: string, signal = new AbortController().signal) {
    await this.acquire();
    try {
      const turn = id ? this.state.turns.find(t => t.id === id) : [...this.state.turns].reverse().find(t => t.entries.length && !t.restored);
      if (!turn || turn.restored || !turn.entries.length) throw new Error('No hay checkpoint de archivos para ese turno');
      if (turn.generation !== this.state.generation) throw new Error('Rewind bloqueado por Execute u otra mutación sin registro. Nunca se revierten sus efectos.');
      if (turn.restoring || turn.entries.some(e => e.uncertain)) throw new Error('Checkpoint incierto o restauración parcial; requiere inspección manual');
      const verify = async (parent: Parameters<typeof readAnchored>[0], name: string, entry: Entry) => {
        const current = await readAnchored(parent, name);
        if (hash(current.data) !== entry.after || current.mode !== entry.mode) throw new Error(`Cambio posterior en ${entry.path}; no se sobrescribe`);
      };
      // Preflight every path before the first effect; recheck each anchored path immediately before writing.
      for (const entry of turn.entries) await withWorkspaceFile(this.cwd, entry.path, false, (parent, name) => verify(parent, name, entry));
      signal.throwIfAborted(); turn.restoring = true; await this.save();
      for (const entry of [...turn.entries].reverse()) {
        signal.throwIfAborted();
        await withWorkspaceFile(this.cwd, entry.path, false, async (parent, name) => {
          await verify(parent, name, entry);
          if (entry.before) await atomicReplace(parent, name, Buffer.from(entry.before.data, 'base64'), signal, entry.before.mode, true);
          else { signal.throwIfAborted(); await unlinkAnchored(parent, name); await parent.sync(); }
        });
      }
      turn.restored = true; turn.restoring = false; await this.save();
      return { id: turn.id, files: turn.entries.length };
    } finally { await this.finish(); }
  }
}
