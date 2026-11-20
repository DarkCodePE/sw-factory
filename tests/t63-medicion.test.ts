import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
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

/** Un change con un validador por cada estado dado: [activity.status, review_status]. Un `canceled` lleva el evento de `fab reject` salvo `revocado`. */
function add(s: Store, ws: string, status: string, validators: [string, string | null][], updated = old, revocado = false): void {
  const id = `c${++n}`;
  s.db.query('INSERT INTO changes (id, workstream_id, title, description, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, ws, 't', 'd', status, old, updated);
  if (status === 'canceled' && !revocado)
    s.db.query('INSERT INTO events (workstream_id, change_id, severity, message, created_at) VALUES (?,?,?,?,?)').run(ws, id, 'warning', 'reject solicitado', old);
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

test('H1: un canceled sin evento de fab reject (revocación de D8) no es R: va a revocados y no sube la tasa', () => {
  seed((s, ws) => {
    add(s, ws, 'completed', [ok]);
    add(s, ws, 'canceled', [ok]);
    add(s, ws, 'canceled', [ok], old, true);
    add(s, ws, 'canceled', [ok], old, true);
  });
  expect(medir([dir], NOW)).toMatchObject({ a: 1, r: 1, revocados: 2, tasa: 0.5 });
});

test('H2: el mismo stateDir dos veces (o por un symlink) cuenta una sola vez', () => {
  seed((s, ws) => { add(s, ws, 'completed', [ok]); add(s, ws, 'canceled', [ok]); });
  const enlace = join(tmpdir(), `fab-t63-ln-${process.pid}`);
  symlinkSync(dir, enlace);
  try { expect(medir([dir, dir, enlace], NOW)).toMatchObject({ a: 1, r: 1 }); }
  finally { rmSync(enlace, { force: true }); }
});

test('H3: se abre en solo lectura: una base sin el índice de migración sigue sin él', () => {
  seed((s, ws) => { add(s, ws, 'completed', [ok]); s.db.exec('DROP INDEX idx_activities_lease'); });
  const indices = () => { const d = new Database(db, { readonly: true }); try { return d.query("SELECT name FROM sqlite_master WHERE type = 'index'").all(); } finally { d.close(); } };
  const antes = indices();
  medir([dir], NOW);
  expect(indices()).toEqual(antes);
  expect(JSON.stringify(antes)).not.toContain('idx_activities_lease');
});

test('H4: límites del umbral: 29 changes con tasa alta son insuficientes; 30 con tasa alta, alta; 30 con tasa baja, baja', () => {
  const con = (a: number, r: number) => { rmSync(db, { force: true }); n = 0; seed((s, ws) => { for (let i = 0; i < a; i++) add(s, ws, 'completed', [ok]); for (let i = 0; i < r; i++) add(s, ws, 'canceled', [ok]); }); return medir([dir], NOW); };
  expect(con(19, 10)).toMatchObject({ veredicto: 'datos insuficientes', muestreo: 0.1 });
  expect(con(20, 10)).toMatchObject({ veredicto: 'tasa alta', muestreo: 0.5 });
  expect(con(28, 2)).toMatchObject({ veredicto: 'tasa baja', muestreo: 0.1 });
});

test('H4: pViejos usa 7 días exactos (estricto) y un implemented reciente no cuenta', () => {
  seed((s, ws) => {
    add(s, ws, 'implemented', [ok], '2026-11-12T12:00:00Z'); // exactamente 7 días: no
    add(s, ws, 'implemented', [ok], '2026-11-12T11:59:59Z'); // pasa de 7 días
    add(s, ws, 'implemented', [ok], '2026-11-18T12:00:00Z'); // reciente
  });
  expect(medir([dir], NOW)).toMatchObject({ p: 3, pViejos: 1 });
});

test('H4: con dos activities del mismo validador y el mismo created_at gana la última insertada (rowid)', () => {
  seed((s, ws) => {
    add(s, ws, 'completed', [ok]);
    s.db.query('INSERT INTO activities (id, workstream_id, change_id, kind, status, review_status, validator, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('z1', ws, 'c1', 'validation', 'completed', 'declined', 'code_review', old);
  });
  expect(medir([dir], NOW)).toMatchObject({ a: 0, r: 0 });
});
