#!/usr/bin/env bun
// T63: ¿cuántos changes aprobados por los validadores acabaron rechazados por el dueño? Solo lectura, sin modelos.
// Definición, umbral y límites: docs/research/warp-platform/diseno/T64.md §2.
// Uso: bun scripts/medir/t63-validadores.ts <stateDir>...
import { join } from 'node:path';
import { Store } from '../../src/store.ts';

export const MIN_CHANGES = 30;
export const UMBRAL_TASA = 0.15;
const DIA_MS = 86_400_000;

export interface Medicion {
  a: number; r: number; p: number;
  /** Aprobados aún `implemented` desde hace más de 7 días. */
  pViejos: number;
  /** R / (A + R); `null` si A + R = 0 («No medido», nunca 0). */
  tasa: number | null;
  veredicto: 'tasa alta' | 'tasa baja' | 'datos insuficientes';
  muestreo: 0.5 | 0.1;
  fecha: string;
}

export function medir(stateDirs: string[], now: Date = new Date()): Medicion {
  let a = 0, r = 0, p = 0, pViejos = 0;
  for (const dir of stateDirs) {
    const s = new Store(join(dir, 'fabrica.db'), { readonly: true });
    try {
      // rowid desempata created_at iguales: la «más reciente» de cada validador.
      const ids = s.db.query(`SELECT c.id AS id, c.status AS status, c.updated_at AS updated_at FROM changes c
        WHERE EXISTS (SELECT 1 FROM activities v WHERE v.change_id = c.id AND v.validator IS NOT NULL)`).all() as
        { id: string; status: string; updated_at: string }[];
      for (const c of ids) {
        const ult = new Map<string, boolean>();
        const acts = s.db.query(`SELECT validator, status, review_status FROM activities
          WHERE change_id = ? AND validator IS NOT NULL ORDER BY created_at, rowid`).all(c.id) as
          { validator: string; status: string; review_status: string | null }[];
        for (const v of acts) ult.set(v.validator, v.status === 'completed' && v.review_status === 'approved');
        if (![...ult.values()].every(Boolean)) continue;
        if (c.status === 'completed') a++;
        else if (c.status === 'canceled') r++;
        else if (c.status === 'implemented') {
          p++;
          if (now.getTime() - Date.parse(c.updated_at) > 7 * DIA_MS) pViejos++;
        }
      }
    } finally { s.close(); }
  }
  const tasa = a + r > 0 ? r / (a + r) : null;
  const alta = a + r >= MIN_CHANGES && tasa !== null && tasa > UMBRAL_TASA;
  return {
    a, r, p, pViejos, tasa,
    veredicto: alta ? 'tasa alta' : a + r < MIN_CHANGES ? 'datos insuficientes' : 'tasa baja',
    muestreo: alta ? 0.5 : 0.1,
    fecha: now.toISOString(),
  };
}

if (import.meta.main) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) { console.error('Uso: bun scripts/medir/t63-validadores.ts <stateDir>...'); process.exit(2); }
  console.log(JSON.stringify(medir(dirs), null, 2));
}
