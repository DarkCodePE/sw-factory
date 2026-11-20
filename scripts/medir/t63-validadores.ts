#!/usr/bin/env bun
// T63: ¿cuántos changes aprobados por los validadores acabaron rechazados por el dueño? Solo lectura, sin modelos.
// Definición, umbral y límites: docs/research/warp-platform/diseno/T64.md §2.
// R cuenta solo los `canceled` con el evento «reject solicitado» (`fab reject`, src/cli.ts). Desde D8 retirar la etiqueta de un issue
// también cancela el change (src/admission/resident.ts) y eso no juzga el trabajo: se informa aparte en `revocados` y no entra en la tasa.
// Límite: un rechazo anterior a ese evento no se ve y cuenta como revocado.
// Uso: bun scripts/medir/t63-validadores.ts <stateDir>...
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.ts';

export const MIN_CHANGES = 30;
export const UMBRAL_TASA = 0.15;
const DIA_MS = 86_400_000;

export interface Medicion {
  a: number; r: number; p: number;
  /** Aprobados `canceled` sin evento de `fab reject` (revocación de D8 u otra causa): fuera de la tasa. */
  revocados: number;
  /** Aprobados aún `implemented` desde hace más de 7 días. */
  pViejos: number;
  /** R / (A + R); `null` si A + R = 0 («No medido», nunca 0). */
  tasa: number | null;
  veredicto: 'tasa alta' | 'tasa baja' | 'datos insuficientes';
  muestreo: 0.5 | 0.1;
  fecha: string;
}

export function medir(stateDirs: string[], now: Date = new Date()): Medicion {
  let a = 0, r = 0, p = 0, pViejos = 0, revocados = 0;
  // El mismo stateDir dado dos veces contaría doble.
  for (const dir of new Set(stateDirs.map(d => realpathSync(d)))) {
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
        else if (c.status === 'canceled') {
          const rej = s.db.query(`SELECT 1 FROM events WHERE change_id = ? AND message = 'reject solicitado' LIMIT 1`).get(c.id);
          if (rej) r++; else revocados++;
        }
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
    a, r, p, revocados, pViejos, tasa,
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
