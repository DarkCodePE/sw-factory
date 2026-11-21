// Configuración del residente que se edita desde la web y desde `fab resident config` (T107).
// Solo guarda lo que `fab resident` ya acepta como flag y nunca un secreto (el del webhook sigue en el entorno).
// El modo `auto` no se puede fijar aquí: exige --workstream y --self, y sigue siendo decisión de la línea de comandos.
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateRepo } from '../connectors/github.ts';
import { ensureStateDir } from '../state-dir.ts';
import type { Store } from '../store.ts';

export const RESIDENT_CONFIG = 'resident.json';
export const INTERVAL_MAX = 86_400;
/** Recibe el mensaje de auditoría; los eventos son por workstream, así que quien llama decide dónde van. */
export type Audit = (message: string) => void;
/** El gate de admisión es global: el cambio se anota en todos los workstreams. */
export const auditAll = (store: Pick<Store, 'listWorkstreams' | 'event'>): Audit => message => { for (const w of store.listWorkstreams()) store.event(w.id, 'info', message); };
export type ResidentConfig = { repo?: string; label?: string; intervalSec?: number; mode?: 'off' | 'observe'; updatedAt?: string; updatedBy?: string };
const KEYS = ['repo', 'label', 'intervalSec', 'mode', 'updatedAt', 'updatedBy'];
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,49}$/;

/** Valida los campos editables. Los mensajes son fijos: no repiten lo escrito, que podría ser un valor pegado por error. */
export function checkResidentConfig(i: { repo?: unknown; label?: unknown; intervalSec?: unknown; mode?: unknown }): ResidentConfig {
  const out: ResidentConfig = {};
  if (i.repo !== undefined) {
    if (typeof i.repo !== 'string') throw new Error('repo: usa owner/name');
    try { validateRepo(i.repo); } catch { throw new Error('repo: usa owner/name'); }
    out.repo = i.repo;
  }
  if (i.label !== undefined) {
    if (typeof i.label !== 'string' || !LABEL.test(i.label)) throw new Error('label: de 1 a 50 caracteres (letras, dígitos, espacio y ._:/-)');
    out.label = i.label;
  }
  if (i.intervalSec !== undefined) {
    if (typeof i.intervalSec !== 'number' || !Number.isInteger(i.intervalSec) || i.intervalSec < 1 || i.intervalSec > INTERVAL_MAX) throw new Error(`intervalo: un entero de 1 a ${INTERVAL_MAX} segundos`);
    out.intervalSec = i.intervalSec;
  }
  if (i.mode !== undefined) {
    if (i.mode !== 'off' && i.mode !== 'observe') throw new Error('modo: off u observe (auto solo se activa con fab resident --mode auto)');
    out.mode = i.mode;
  }
  return out;
}

export function loadResidentConfig(stateDir: string): ResidentConfig {
  const path = join(stateDir, RESIDENT_CONFIG);
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('resident.json no se puede leer'); }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('resident.json no es JSON válido'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !KEYS.includes(k))) throw new Error('resident.json tiene campos desconocidos');
  const r = raw as Record<string, unknown>;
  const meta = { ...(typeof r.updatedAt === 'string' ? { updatedAt: r.updatedAt } : {}), ...(typeof r.updatedBy === 'string' ? { updatedBy: r.updatedBy } : {}) };
  try { return { ...checkResidentConfig(r), ...meta }; } catch (e) { throw new Error(`resident.json inválido: ${(e as Error).message}`); }
}

/** Fusiona los campos dados con lo guardado y escribe de forma atómica (0600). Sin bloqueo: un único dueño y el último guardado gana. */
export function saveResidentConfig(stateDir: string, changes: ResidentConfig, actor: string, audit?: Audit, now = new Date()): ResidentConfig {
  const prev = loadResidentConfig(stateDir);
  const next: ResidentConfig = { ...prev, ...checkResidentConfig(changes), updatedAt: now.toISOString(), updatedBy: actor };
  ensureStateDir(stateDir);
  const path = join(stateDir, RESIDENT_CONFIG), tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try { if (lstatSync(path).isSymbolicLink()) throw new Error('resident.json es un enlace simbólico'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); // T107-H6: nombre aleatorio y wx: no sigue un enlace plantado
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  // T107-H5: la etiqueta y el repo son la entrada del gate de admisión; cada cambio queda con su actor (el del proceso, vía FAB_ACTOR).
  const diff = (['repo', 'label', 'intervalSec', 'mode'] as const).filter(k => prev[k] !== next[k])
    .map(k => `${k} ${prev[k] === undefined ? 'sin fijar' : JSON.stringify(prev[k])} -> ${JSON.stringify(next[k])}`);
  if (diff.length) audit?.(`resident.json: ${diff.join(', ')}`);
  return next;
}
