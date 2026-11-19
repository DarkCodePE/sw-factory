import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { medir } from '../scripts/medir/t63-validadores.ts';

let dir: string;
let db: string;
let n = 0;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fab-t63-')); db = join(dir, 'fabrica.db'); n = 0; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = new Date('2026-11-19T12:00:00Z');
const old = '2026-11-01T00:00:00Z';

/** Un change con un validador por cada estado dado: [activity.status, review_status]. */
function add(s: Store, ws: string, status: string, validators: [string, string | null][], updated = old): void {
  const id = `c${++n}`;
  s.db.query('INSERT INTO changes (id, workstream_id, title, description, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, ws, 't', 'd', status, old, updated);
  validators.forEach(([st, rv], i) => {
    s.db.query('INSERT INTO activities (id, workstream_id, change_id, kind, status, review_status, validator, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(`${id}-v${i}`, ws, id, 'validation', st, rv, ['code_review', 'security_audit'][i] ?? 'qa', old);
  });
}

function seed(build: (s: Store, ws: string) => void): void {
  const s = new Store(db);
  const ws = s.createWorkstream({ slug: 'w', goal: 'g', repo: '/r' }).id;
  build(s, ws);
  s.close();
}
const ok: [string, string] = ['completed', 'approved'];

test('datos sintéticos: A=3, R=1, P=1, tasa 0,25, datos insuficientes y muestreo 0.1', () => {
  seed((s, ws) => {
    for (let i = 0; i < 3; i++) add(s, ws, 'completed', [ok]);
    add(s, ws, 'canceled', [ok]);
    add(s, ws, 'implemented', [ok]);
    add(s, ws, 'canceled', [ok, ['completed', 'declined']]); // un validador declinó: no cuenta
    add(s, ws, 'completed', []); // sin validadores: no entra
  });
  const r = medir([dir], NOW);
  expect(r).toMatchObject({ a: 3, r: 1, p: 1, pViejos: 1, tasa: 0.25, veredicto: 'datos insuficientes', muestreo: 0.1 });
  expect(r.fecha).toBe(NOW.toISOString());
});

test('solo cuenta el validador más reciente: un fallo antiguo reaprobado cuenta como aprobado', () => {
  seed((s, ws) => {
    add(s, ws, 'completed', [ok]);
    s.db.query('INSERT INTO activities (id, workstream_id, change_id, kind, status, review_status, validator, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('x1', ws, 'c1', 'validation', 'completed', 'declined', 'code_review', '2026-10-01T00:00:00Z');
  });
  expect(medir([dir], NOW)).toMatchObject({ a: 1, r: 0 });
});

test('30 changes con tasa 0,2: muestreo 0.5', () => {
  seed((s, ws) => {
    for (let i = 0; i < 24; i++) add(s, ws, 'completed', [ok]);
    for (let i = 0; i < 6; i++) add(s, ws, 'canceled', [ok]);
  });
  expect(medir([dir], NOW)).toMatchObject({ a: 24, r: 6, tasa: 0.2, veredicto: 'tasa alta', muestreo: 0.5 });
});

test('30 changes con tasa 0,15 (no supera el umbral): muestreo 0.1; sin datos: tasa null, no cero', () => {
  seed((s, ws) => {
    for (let i = 0; i < 34; i++) add(s, ws, 'completed', [ok]);
    for (let i = 0; i < 6; i++) add(s, ws, 'canceled', [ok]);
  });
  expect(medir([dir], NOW)).toMatchObject({ a: 34, r: 6, tasa: 0.15, veredicto: 'tasa baja', muestreo: 0.1 });
  const vacio = mkdtempSync(join(tmpdir(), 'fab-t63-v-'));
  try { new Store(join(vacio, 'fabrica.db')).close(); expect(medir([vacio], NOW)).toMatchObject({ tasa: null, muestreo: 0.1 }); }
  finally { rmSync(vacio, { recursive: true, force: true }); }
});

test('la base no cambia: mismo tamaño y mtime, ningún fichero nuevo', () => {
  seed((s, ws) => { add(s, ws, 'completed', [ok]); add(s, ws, 'canceled', [ok]); });
  const antes = { st: statSync(db), ls: readdirSync(dir).sort() };
  medir([dir], NOW);
  const st = statSync(db);
  expect(st.size).toBe(antes.st.size);
  expect(st.mtimeMs).toBe(antes.st.mtimeMs);
  expect(readdirSync(dir).sort()).toEqual(antes.ls);
});

test('fila rara: review_status approved pero la activity no está completed no cuenta como aprobado', () => {
  seed((s, ws) => { add(s, ws, 'completed', [['failed', 'approved']]); add(s, ws, 'canceled', [['pending', 'approved']]); });
  expect(medir([dir], NOW)).toMatchObject({ a: 0, r: 0, tasa: null });
});
