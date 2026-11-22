// T112: productividad completa (cuatro tramos, interacciones por PR, runs por rol y raíz frente a subagentes) con datos sembrados de fecha conocida.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { calculateMetrics } from '../src/metrics.ts';
import { metricsPage } from '../src/web-metrics.ts';

let dir: string, store: Store;
const now = Date.parse('2026-11-19T12:00:00Z'), H = 3600000;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'prod-')); store = new Store(join(dir, 'fabrica.db')); store.createWorkstream({ slug: 'uno', goal: 'g', repo: '/synthetic', taskLimit: 2000 }); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const ev = (c: { id: string; workstreamId: string }, message: string, at: string) => {
  store.event(c.workstreamId, 'info', message, c.id);
  store.db.query('UPDATE events SET created_at=? WHERE id=(SELECT MAX(id) FROM events)').run(at);
};
/** Activities con fecha, rol y padre conocidos; sustituye a la que crea createChange. */
function acts(c: { id: string; workstreamId: string }, rows: Array<[id: string, kind: string, validator: string | null, parent: string | null, at: string]>) {
  store.db.query('DELETE FROM activities WHERE change_id=?').run(c.id);
  const q = store.db.query("INSERT INTO activities(id,workstream_id,change_id,parent_activity_id,kind,status,validator,retry_count,created_at) VALUES (?,?,?,?,?,'completed',?,0,?)");
  for (const [id, kind, validator, parent, at] of rows) q.run(id, c.workstreamId, c.id, parent, kind, validator, at);
}
const change = (title: string, at: string) => { const c = store.createChange('uno', title, ''); store.db.query('UPDATE changes SET created_at=? WHERE id=?').run(at, c.id); store.db.query('DELETE FROM events WHERE change_id=?').run(c.id); return c; };

function seed() {
  const a = change('A', '2026-11-17T00:00:00Z'), b = change('B', '2026-11-18T00:00:00Z'), c = change('C sin PR', '2026-11-18T00:00:00Z');
  ev(a, 'pr_opened: https://github.com/o/r/pull/1', '2026-11-17T02:00:00Z'); ev(a, 'merge_completed', '2026-11-17T10:00:00Z');
  ev(a, 'change_review approved', '2026-11-17T03:00:00Z'); ev(a, 'change_review approved', '2026-11-17T04:00:00Z'); // 2 interacciones
  ev(b, 'pr_opened: https://github.com/o/r/pull/2', '2026-11-18T04:00:00Z');
  for (const m of ['change_review approved', 'change_review commented', 'change retried (implementation)', 'human reply received (question q); re-queued']) ev(b, m, '2026-11-18T05:00:00Z'); // 4
  for (let i = 0; i < 7; i++) ev(c, 'change retried (implementation)', '2026-11-18T06:00:00Z'); // 7, pero sin PR: no cuenta
  acts(a, [['a1', 'implementation', null, null, '2026-11-17T01:00:00Z'], ['a2', 'change_review', 'code_review', 'a1', '2026-11-17T05:00:00Z']]);
  acts(b, [['b1', 'investigation', null, null, '2026-11-18T01:00:00Z'], ['b2', 'implementation', null, null, '2026-11-18T02:00:00Z'], ['b3', 'change_review', 'qa', 'b2', '2026-11-18T07:00:00Z'], ['b4', 'change_review', 'code_review', 'b2', '2026-11-19T01:00:00Z']]);
  acts(c, [['c1', 'investigation', null, null, '2026-11-18T03:00:00Z']]);
  return { a, b, c };
}

test('los cuatro tramos: mediana, p90 y muestras; los de revisión humana siguen sin medirse', () => {
  seed();
  const t = Object.fromEntries(calculateMetrics(store, dir, { range: '7', now }).prCycles.map(x => [x.name, x]));
  expect(Object.keys(t)).toEqual(['Kickoff → merge', 'Kickoff → PR', 'PR → primera revisión humana', 'Primera revisión humana → merge', 'PR → merge']);
  expect(t['Kickoff → merge']).toEqual({ name: 'Kickoff → merge', median: 10 * H, p90: 10 * H, samples: 1 });
  expect(t['Kickoff → PR']).toMatchObject({ median: 3 * H, p90: 4 * H, samples: 2 });
  expect(t['PR → merge']).toMatchObject({ median: 8 * H, samples: 1 });
  for (const n of ['PR → primera revisión humana', 'Primera revisión humana → merge']) expect(t[n]).toMatchObject({ median: null, p90: null, samples: 0 });
});

test('interacciones por PR: media de los changes con PR (los sin PR no cuentan) y serie por día de apertura', () => {
  seed();
  const m = calculateMetrics(store, dir, { range: '7', now });
  expect(m.interactionsPerPr.mean).toBe(3); expect(m.interactionsPerPr.prs).toBe(2);
  const at = (d: string) => m.interactionsPerPr.daily[m.daily.days.indexOf(d)];
  expect(at('2026-11-17')).toBe(2); expect(at('2026-11-18')).toBe(4); expect(at('2026-11-19')).toBeNull();
});

test('sin ningún PR la media es null (No medido), no 0', () => {
  change('solo', '2026-11-18T00:00:00Z');
  const m = calculateMetrics(store, dir, { range: '7', now });
  expect(m.interactionsPerPr).toMatchObject({ mean: null, prs: 0 });
  expect(m.prCycles.every(c => c.median === null)).toBe(true);
});

test('runs por rol suman el total, día a día; la partición raíz/subagentes no se ofrece (T112-H1)', () => {
  seed();
  const r = calculateMetrics(store, dir, { range: '7', now }).runs, d = calculateMetrics(store, dir, { range: '7', now }).daily.days;
  expect(r.total).toBe(7); expect(r).not.toHaveProperty('root'); expect(r).not.toHaveProperty('sub');
  const idx = (day: string) => d.indexOf(day);
  expect(r.roles.map(x => [x.name, x.total])).toEqual([['implementation', 2], ['investigation', 2], ['validador:code_review', 2], ['validador:qa', 1]]);
  expect(r.roles.reduce((s, x) => s + x.total, 0)).toBe(r.total);
  expect(r.roles.find(x => x.name === 'validador:code_review')!.daily[idx('2026-11-19')]).toBe(1);
});

test('la página muestra los cuatro tramos, la media, y los runs por rol', () => {
  seed();
  const html = (q = '') => metricsPage(store, dir, new URL(`http://127.0.0.1:4310/metricas?from=2026-11-15&to=2026-11-21${q}`)).body;
  const h = html();
  for (const t of ['Kickoff → merge', 'Kickoff → PR', 'PR → primera revisión humana', 'Primera revisión humana → merge']) expect(h).toContain(t);
  expect(h).toContain('10 h'); expect(h).toContain('Interacciones humanas por PR'); expect(h).toContain('2 PRs');
  expect(h).toContain('Runs totales'); expect(h).not.toContain('subagentes');
  expect(h).toContain('name="runs"'); expect(h).toContain('Runs por día · rol');
  expect(h).toContain('validador:qa');
  expect(() => html('&runs=raiz')).toThrow(URIError); // sin partición hasta T110
  expect(() => html('&runs=otro')).toThrow(URIError);
});

test('más de cuatro roles: los tres mayores y «Otros»; el total se conserva', () => {
  const { c } = seed();
  store.db.query("INSERT INTO activities(id,workstream_id,change_id,kind,status,retry_count,created_at) VALUES ('c2',?,?,'steward','completed',0,'2026-11-18T09:00:00Z')").run(c.workstreamId, c.id);
  const h = metricsPage(store, dir, new URL('http://127.0.0.1:4310/metricas?from=2026-11-15&to=2026-11-21')).body;
  expect(h).toContain('Otros'); expect(h).toContain('8</');
});

test('sin actividad en el rango: No medido y sin gráfico', () => {
  const h = metricsPage(store, dir, new URL('http://127.0.0.1:4310/metricas?from=2026-11-15&to=2026-11-21')).body;
  expect(h).toContain('Runs totales'); expect(h).toContain('No medido');
});
