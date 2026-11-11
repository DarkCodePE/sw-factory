// Trabajo que entra por un canal (T32, H-17, ADR-0007): el texto es no confiable, así que solo corre en un adaptador
// confinable y SIEMPRE confinado. `native` lanza si se le pide confine; sigue disponible para changes creados a mano.
import type { LiveBackend, LiveTurn, LiveTurnResult } from '../live/contract.ts';
import type { AdmissionDb } from './db.ts';
import { ThreadLinks } from './links.ts';

export class ChannelBackendError extends Error {
  constructor(backend: string) { super(`el backend vivo «${backend}» no es confinable: no puede ejecutar trabajo que entra por un canal`); this.name = 'ChannelBackendError'; }
}

/** Un change es «de canal» si tiene algún hilo unido (T23). */
export const isChannelChange = (adm: AdmissionDb, changeId: string): boolean => new ThreadLinks(adm).threadsOf(changeId).length > 0;

/** Lanza un turno vivo; si el change es de canal, exige backend confinable y fuerza `confine: true` (un `confine: false` explícito no lo desactiva). */
export function runLiveTurn(adm: AdmissionDb, backend: LiveBackend, changeId: string, turn: LiveTurn): Promise<LiveTurnResult> {
  if (!isChannelChange(adm, changeId)) return backend.run(turn);
  if (!backend.confinable) throw new ChannelBackendError(backend.name);
  return backend.run({ ...turn, confine: true });
}
