// Guardas del modo servidor para las acciones que tocan la máquina (§3.1, §4.3): repos y destinos salen de un inventario del operador
// (`server-inventory.json` en el directorio de estado), nunca de lo que escribe el usuario. Sin inventario, falla cerrado.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { StoreError, type Store } from './store.ts';

export interface ServerInventory {
  /** alias → ruta absoluta de un repositorio git que el equipo puede usar. */
  repos?: Record<string, string>;
  /** Alias SSH de runners que el dueño autoriza. */
  runnerTargets?: string[];
  /** Repos `owner/name` que el residente puede vigilar. */
  residentRepos?: string[];
  /** Techo de los ajustes de un workstream. */
  ceiling?: { concurrency?: number; taskLimit?: number };
}

const bad = (m: string) => new StoreError('invalid_input', m);
export const INVENTORY_FILE = 'server-inventory.json';

export function loadInventory(stateDir: string): ServerInventory {
  try { const v = JSON.parse(readFileSync(join(stateDir, INVENTORY_FILE), 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
}

/** Alias → ruta real, comprobada ahora: debe ser un directorio git y su ruta real no puede cambiar de sitio por un enlace. */
export function repoByAlias(stateDir: string, alias: string): string {
  const configured = Object.hasOwn(loadInventory(stateDir).repos ?? {}, alias) ? loadInventory(stateDir).repos![alias] : undefined;
  if (typeof configured !== 'string') throw bad('El repositorio no está en el inventario del servidor.');
  let real: string;
  try { real = realpathSync(configured); } catch { throw bad('El repositorio del inventario no está disponible.'); }
  if (!statSync(real).isDirectory() || !existsSync(join(real, '.git'))) throw bad('El repositorio del inventario no es un repositorio git.');
  return real;
}

type Raw = Record<string, string>;
const GUARDS: Record<string, (input: Raw, store: Store, stateDir: string, id: string) => Raw> = {
  // El `repo` del formulario es un alias; la ruta sale del inventario. Los comandos de verificación quedan en consola.
  'workstreams/create': (input, _store, stateDir) => {
    if (input.verify) throw bad('El comando de verificación se fija desde la consola del operador.');
    return { ...input, repo: repoByAlias(stateDir, input.repo ?? '') };
  },
  'workstreams/settings': (input, _store, stateDir) => {
    const c = loadInventory(stateDir).ceiling ?? {};
    const over = (v: string | undefined, max: number | undefined) => v !== undefined && max !== undefined && !(Number(v) <= max);
    if (over(input.concurrency, c.concurrency) || over(input.task_limit, c.taskLimit)) throw bad('El ajuste supera el techo operativo del servidor.');
    return input;
  },
  // Un workstream de nube no se activa con acceso en modo anterior (sin tope declarado).
  'workstreams/state': (input, store, _stateDir, id) => {
    const ws = store.getWorkstream(id);
    if (input.state === 'active' && (ws.envAllow === null || ws.mcpAllow === null)) throw bad('El workstream usa el modo anterior de acceso: declara sus nombres antes de activarlo en el servidor.');
    return input;
  },
  'runners/create': (input, _store, stateDir) => runnerGuard(input, stateDir),
  'runners/update': (input, _store, stateDir) => runnerGuard(input, stateDir),
  'resident/config': (input, _store, stateDir) => {
    if (input.repo && !(loadInventory(stateDir).residentRepos ?? []).includes(input.repo)) throw bad('El repositorio no está preaprobado para el residente.');
    return input;
  },
};

function runnerGuard(input: Raw, stateDir: string): Raw {
  const targets = loadInventory(stateDir).runnerTargets ?? [];
  if (input.target && !targets.includes(input.target)) throw bad('El destino SSH no está en el inventario del servidor.');
  // Un runner local desde la red exige confinamiento.
  if (!input.target && input.confine !== 'yes') throw bad('Un runner local en modo servidor exige confinamiento.');
  return input;
}

export function serverGuard(name: string, input: Raw, store: Store, stateDir: string, id: string): Raw {
  const guard = Object.hasOwn(GUARDS, name) ? GUARDS[name] : undefined;
  return guard ? guard(input, store, stateDir, id) : input;
}
