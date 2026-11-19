import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { calculateMetrics, distribution } from '../src/metrics.ts';
import { startWeb } from '../src/web.ts';
let dir: string, store: Store;
const now = Date.parse('2026-11-19T12:00:00Z');
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'webf3-')); store = new Store(join(dir, 'fabrica.db')); store.createWorkstream({ slug: 'uno', goal: 'g', repo: '/synthetic', taskLimit: 2000 }); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
function seed(hours: number, cost: number | null, slug = 'uno', date = '2026-11-18T00:00:00Z') {
  const c = store.createChange(slug, '<script>synthetic</script>', '');
  const a = store.listActivities({ changeId: c.id })[0]!;
  const start = Date.parse(date), at = (h: number) => new Date(start + h * 3600000).toISOString();
  store.db.query('UPDATE changes SET created_at=?,status=\'completed\' WHERE id=?').run(date, c.id);
  store.db.query("UPDATE activities SET created_at=?,kind='investigation' WHERE id=?").run(at(hours), a.id);
  store.db.query('DELETE FROM events WHERE change_id=?').run(c.id);
  const insert = store.db.query('INSERT INTO events(workstream_id,change_id,activity_id,severity,message,created_at) VALUES (?,?,?,?,?,?)');
  for (const [message, h] of [['investigation awaiting spec review', hours * 2], ['change_review approved', hours * 3], ['human reply received (question q); re-queued', hours * 3], ['change retried (investigation)', hours * 3], ['change completed', hours * 4]] as const) insert.run(c.workstreamId, c.id, a.id, 'info', message, at(h));
  const path = join(dir, 'runs', c.id); mkdirSync(path, { recursive: true });
  writeFileSync(join(path, `${a.id}.json`), JSON.stringify({ attemptCosts: [cost], isolation: { adapter: 'synthetic' }, model: 'modelo-demo' }));
  return c;
}
test('mediana par/impar y p90 por rango más próximo', () => {
  expect(distribution([1, 9, 3, 7])).toEqual({ median: 5, p90: 9, samples: 4 });
  expect(distribution([9, 1, 3])).toEqual({ median: 3, p90: 9, samples: 3 });
  expect(distribution([])).toEqual({ median: null, p90: null, samples: 0 });
});
test('tramos exactos, intervenciones, estados, tipos y coste; null no es cero', () => {
  seed(1, 2); seed(3, 0); seed(5, null);
  const m = calculateMetrics(store, dir, { range: '7', now });
  expect(m.cycles.map(c => c.median)).toEqual([3, 6, 9, 12].map(n => n * 3600000));
  expect(m.cycles.map(c => c.p90)).toEqual([5, 10, 15, 20].map(n => n * 3600000));
  expect(m.humans.map(h => [h.reviews, h.answers, h.retries, h.total])).toEqual([[1,1,1,3],[1,1,1,3],[1,1,1,3]]);
  expect(m.states).toEqual([['completed', 3]]); expect(m.kinds).toEqual([['investigation', 3]]);
  expect(m.cost.total).toBeNull(); expect(m.cost.measured).toBe(2); expect(m.cost.unknownChanges).toBe(1);
  expect(m.cost.top.map(c => c.cost)).toEqual([2, 0]);
  expect(m.cost.adapters).toEqual([{ name: 'synthetic', measured: 2, unknown: 1, total: null }]);
  expect(m.cost.models).toEqual([{ name: 'modelo-demo', measured: 2, unknown: 1, total: null }]);
});
test('filtros de cohorte por fecha y workstream, incluyendo límites y futuro', () => {
  store.createWorkstream({ slug: 'dos', goal: 'g', repo: '/synthetic' });
  seed(1, 1); seed(1, 4, 'dos'); seed(1, 16, 'uno', '2026-10-01T00:00:00Z'); seed(1, 32, 'uno', '2026-11-20T00:00:00Z');
  seed(0, 8, 'uno', '2026-11-12T12:00:00Z');
  expect(calculateMetrics(store, dir, { ws: 'uno', range: '7', now }).cost.total).toBe(9);
  expect(calculateMetrics(store, dir, { ws: 'dos', range: '30', now }).cost.total).toBe(4);
  expect(calculateMetrics(store, dir, { ws: 'uno', range: 'all', now }).cost.total).toBe(25);
});
test('vacío y evidencia ausente, rota o incompleta no inventan datos', () => {
  expect(calculateMetrics(store, dir, { now }).cost.total).toBeNull();
  const c = seed(1, 0); const a = store.listActivities({ changeId: c.id })[0]!;
  rmSync(join(dir, 'runs'), { recursive: true });
  expect(calculateMetrics(store, dir, { now }).cost.unknownChanges).toBe(1);
  store.db.query('DELETE FROM events').run();
  const m = calculateMetrics(store, dir, { now });
  expect(m.cycles.slice(1).map(c => c.samples)).toEqual([0,0,0]); // no se inventa una fecha sin evento
  expect(m.cost.adapters[0]?.name).toBe('No medido');
  mkdirSync(join(dir, 'runs', c.id), { recursive: true });
  for (const content of ['{broken', '{"attemptCosts":[null]}', '{"attemptCosts":[]}']) {
    writeFileSync(join(dir, 'runs', c.id, `${a.id}.json`), content);
    expect(calculateMetrics(store, dir, { now }).cost.total).toBeNull();
  }
});
test('tope de 1000 changes, selección determinista y aviso', () => {
  store.db.transaction(() => { for (let i=0;i<1002;i++) seed(0, 0); })();
  const m = calculateMetrics(store, dir, { now });
  expect(m.count).toBe(1000); expect(m.omitted).toBe(2); expect(m.cost.total).toBe(0);
});
test('HTTP: escapado, CSP, sin sondeo, HEAD, Host, 405 y disco inalterado', async () => {
  seed(1, 2); store.close();
  const tree = () => readdirSync(dir, { recursive: true }).map(p => String(p)).sort();
  const before = tree(), bytes = readFileSync(join(dir, 'fabrica.db'));
  const server = startWeb(dir, 0), url = `http://127.0.0.1:${server.port}/metricas`;
  try {
    const r = await fetch(url); const html = await r.text();
    expect(r.status).toBe(200); expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(html).toContain('&lt;script&gt;synthetic'); expect(html).not.toContain('<script>'); expect(html).not.toContain('/poll.js');
    expect(html).toContain('<svg'); expect(html).toContain('<table'); expect(html).toContain('Actualizar');
    expect(await (await fetch(url, { method: 'HEAD' })).text()).toBe('');
    expect((await fetch(url, { headers: { Host: 'evil.test' } })).status).toBe(403);
    for (const method of ['POST','PUT','PATCH','DELETE','OPTIONS']) expect((await fetch(url, { method })).status).toBe(405);
    expect((await fetch(url+'?range=bad')).status).toBe(400);
    expect(tree()).toEqual(before); expect(readFileSync(join(dir, 'fabrica.db'))).toEqual(bytes);
  } finally { server.stop(true); store = new Store(join(dir, 'fabrica.db')); }
});
test('eventos reales del Store y comentarios no simulan hitos ni reintentos', () => {
  const c = store.createChange('uno', 'Flujo sintético', '');
  const a = store.listActivities({ changeId: c.id })[0]!;
  store.resolveReview(a.id, 'comment', 'investigation failed permanently: dato no confiable');
  let m = calculateMetrics(store, dir);
  expect(m.humans[0]?.reviews).toBe(1); expect(m.humans[0]?.retries).toBe(0);
  expect(m.cycles[3]?.samples).toBe(0);
  const next = store.listActivities({ changeId: c.id }).find(a => a.parentActivityId)!;
  store.resolveReview(next.id, 'decline', 'Motivo sintético');
  m = calculateMetrics(store, dir);
  expect(m.humans[0]?.reviews).toBe(2); expect(m.cycles[3]?.samples).toBe(1);
});
test('validadores y reintentos automáticos no cuentan como humanos; fechas ausentes no usan updatedAt', () => {
  const c = seed(1, 2), a = store.listActivities({ changeId: c.id })[0]!;
  store.db.query('DELETE FROM events').run();
  for (const message of ['validator code_review completed: approved', 'investigation failed (retry 1/3): fallo', 'change created: change_review approved']) store.event(c.workstreamId, 'info', message, c.id, a.id);
  const m = calculateMetrics(store, dir, { now });
  expect(m.humans[0]?.total).toBe(0); expect(m.cycles[2]?.samples).toBe(0); expect(m.cycles[3]?.samples).toBe(0);
});
test('atribución histórica desconocida, multiintentos y change sin activities', () => {
  const c = seed(1, 2), a = store.listActivities({ changeId: c.id })[0]!;
  store.db.query("UPDATE activities SET retry_count=1 WHERE id=?").run(a.id);
  writeFileSync(join(dir, 'runs', c.id, `${a.id}.json`), JSON.stringify({ attemptCosts: [1, 2], model: 'ultimo', isolation: { adapter: 'ultimo' } }));
  const m = calculateMetrics(store, dir, { now });
  expect(m.cost.total).toBe(3);
  expect(m.cost.models[0]?.name).toBe('No medido'); expect(m.cost.adapters[0]?.name).toBe('No medido');
  store.db.query('DELETE FROM activities WHERE change_id=?').run(c.id);
  expect(calculateMetrics(store, dir, { now }).cost.total).toBeNull();
});
