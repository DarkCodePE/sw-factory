// Oráculo de regresión: funciones literales de src/improve.ts@ff52f0b.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runDirectory } from "../../src/manifest.ts";
import type { Store } from "../../src/store.ts";

/** Informe final de la última actividad worker; la evidencia se reinicia por intento antes de ejecutar el agente. */
export function armWorkerReport(store: Store, stateDir: string, changeId: string): string | null {
  const acts = store.listActivities({ changeId });
  const workerActs = acts.filter(a => a.kind === 'implementation' || a.kind === 'investigation');
  const act = workerActs.at(-1);
  if (!act) return null;
  const meta = join(runDirectory(stateDir, changeId), `${act.id}.json`);
  if (existsSync(meta)) {
    const evidence = JSON.parse(readFileSync(meta, 'utf8'));
    if ('workerReport' in evidence) return typeof evidence.workerReport === 'string' ? evidence.workerReport : null;
  }
  return act.result || null;
}

/**
 * Coste del brazo: suma de todos los intentos de todas las activities. null si falta algún coste.
 * Evidencia antigua sin reintentos conserva la lectura de `usage.costUsd`.
 */
export function armCost(store: Store, stateDir: string, changeId: string): number | null {
  const acts = store.listActivities({ changeId });
  if (!acts.length) return null;
  let total = 0;
  for (const a of acts) {
    const meta = join(runDirectory(stateDir, changeId), `${a.id}.json`);
    if (!existsSync(meta)) return null;
    const evidence = JSON.parse(readFileSync(meta, 'utf8'));
    const costs = evidence.attemptCosts ?? (a.retryCount === 0 ? [evidence.usage?.costUsd] : null);
    // A permanent failure increments retryCount without starting another attempt.
    const attempts = Math.max(1, a.retryCount + (a.status === 'failed' ? 0 : 1));
    if (!Array.isArray(costs) || costs.length < attempts) return null;
    for (const cost of costs) {
      if (typeof cost !== 'number' || !Number.isFinite(cost)) return null;
      total += cost;
    }
  }
  return total;
}

