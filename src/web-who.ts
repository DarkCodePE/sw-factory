// Quién ejecuta una operación (T119c). En local es una cadena (`web`, `api:<nombre>`) y manda FAB_ACTOR, como antes de T119.
// En modo servidor es un `Principal` verificado: toda operación pasa por `runAs` (política + revalidación en la escritura)
// y el Store lleva el actor estable (`user:<id>`, con su rol) en cada evento, nota y `created_by`.
import { actorOf, runAs, type Principal } from './users.ts';
import type { PolicyContext } from './policy.ts';
import { join } from 'node:path';
import { Store } from './store.ts';

export interface ServerWho { principal: Principal; /** El servidor corre con `--write`. */ write: boolean }
export type Who = string | ServerWho;
export const isServer = (who: Who): who is ServerWho => typeof who !== 'string';

/** Ejecuta `fn` (síncrona) como `who`. En servidor: transacción inmediata, política `capability` y actor del Store. */
export function inActor<T>(store: Store, who: Who, capability: string, fn: () => T, ctx: Omit<PolicyContext, 'via' | 'write'> = {}): T {
  if (!isServer(who)) {
    // FAB_ACTOR es el patrón del Store. El tramo es síncrono: ningún await expone el actor a otra petición.
    const previous = process.env.FAB_ACTOR; process.env.FAB_ACTOR = who;
    try { return store.withRetry(fn); }
    finally { if (previous === undefined) delete process.env.FAB_ACTOR; else process.env.FAB_ACTOR = previous; }
  }
  return runAs(store, who.principal, capability, { ...ctx, write: who.write }, fresh => {
    store.asActor({ ...actorOf(fresh), role: fresh.role });
    try { return fn(); } finally { store.asActor(undefined); }
  });
}

/**
 * Política antes de resolver objetos, abrir vistas previas o salir a la red (§4.1). En servidor abre un escritor, ejecuta `runAs` sin efecto
 * y lanza `forbidden`/`unauthorized`; en local no hace nada. La escritura vuelve a comprobarlo en su transacción.
 */
export function preauthorize(stateDir: string, who: Who, capability: string, ctx: Omit<PolicyContext, 'via' | 'write'> = {}): void {
  if (!isServer(who)) return;
  const store = new Store(join(stateDir, 'fabrica.db'));
  try { inActor(store, who, capability, () => undefined, ctx); } finally { store.close(); }
}
