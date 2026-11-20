import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { calculateMetrics, distribution } from '../src/metrics.ts';
import { startWeb } from '../src/web.ts';
import { metricsPage } from '../src/web-metrics.ts';
import { changePrLink } from '../src/web-changes.ts';
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
  const m = calculateMetrics(store, dir);
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

const H = 3600000, t0 = Date.parse('2026-11-18T00:00:00Z');
test('H1: un validador que agota reintentos no es estado terminal ni revisión pedida', () => {
  const c = store.createChange('uno', 'x', '');
  store.db.query("UPDATE activities SET status='completed',kind='implementation' WHERE change_id=?").run(c.id);
  store.db.query("UPDATE changes SET status='implemented' WHERE id=?").run(c.id);
  store.db.query("UPDATE workstreams SET state='active'").run();
  const [v] = store.requestValidation(c.id, ['code_review']);
  for (let i = 0; i < 4; i++) { const a = store.claimActivity('uno', 'w'); if (!a) break; store.failActivity(a.id, 'w', 'fallo'); }
  expect(store.getActivity(v!.id).status).toBe('failed');
  const m = calculateMetrics(store, dir);
  expect(m.cycles[1]?.samples).toBe(0); expect(m.cycles[3]?.samples).toBe(0);
  expect(m.kinds.some(([k]) => k === 'change_review')).toBe(false);
  expect(m.kinds).toContainEqual(['validador:code_review', 1]);
});
test('H2: p90 de 10 y 20 valores no es el máximo ni floor', () => {
  expect(distribution(Array.from({ length: 10 }, (_, i) => i + 1)).p90).toBe(9);
  expect(distribution(Array.from({ length: 20 }, (_, i) => 20 - i)).p90).toBe(18);
});
test('H3: la página de métricas redacta secretos del título', () => {
  const c = seed(1, 1); store.db.query('UPDATE changes SET title=? WHERE id=?').run('ghp_' + 'a'.repeat(36), c.id);
  const { body: html } = metricsPage(store, dir, new URL('http://x/metricas?range=all'));
  expect(html).toContain('[REDACTED]'); expect(html).not.toContain('ghp_aaaa');
});
test('H4: hitos y activities posteriores a now o anteriores a la creación no cuentan', () => {
  seed(1, 1);
  const early = calculateMetrics(store, dir, { now: t0 + 2.5 * H });
  expect(early.cycles.map(c => c.samples)).toEqual([1, 1, 0, 0]);
  const future = calculateMetrics(store, dir, { now: t0 + 0.5 * H });
  expect(future.cycles.map(c => c.samples)).toEqual([0, 0, 0, 0]);
  expect(future.kinds).toEqual([]); expect(future.cost.adapters).toEqual([]);
  store.db.query('UPDATE activities SET created_at=?').run(new Date(t0 - H).toISOString());
  expect(calculateMetrics(store, dir, { now }).cycles[0]?.samples).toBe(0);
});
test('H5: el tope conserva los changes más recientes', () => {
  store.db.transaction(() => { for (let i = 0; i < 1002; i++) seed(0, i < 2 ? 5 : 0, 'uno', new Date(t0 + i * 60000).toISOString()); })();
  expect(calculateMetrics(store, dir, { now }).cost.total).toBe(0);
});
test('H6: evidencia con ruta insegura deja el coste desconocido', () => {
  const c = seed(1, 3); const other = join(dir, 'otra'); mkdirSync(other);
  rmSync(join(dir, 'runs', c.id), { recursive: true, force: true }); symlinkSync(other, join(dir, 'runs', c.id));
  const m = calculateMetrics(store, dir, { now });
  expect(m.cost.unknownChanges).toBe(1); expect(m.cost.total).toBeNull();
});
test('H7: blocked: y quarantined: son estados terminales', () => {
  for (const prefix of ['blocked: x', 'quarantined: y']) {
    const c = store.createChange('uno', prefix, ''); store.db.query('DELETE FROM events WHERE change_id=?').run(c.id);
    store.event(c.workstreamId, 'info', prefix, c.id);
    expect(calculateMetrics(store, dir).cycles[3]?.samples).toBe(1);
    store.db.query('DELETE FROM changes WHERE id=?').run(c.id);
  }
});
test('H8: singleAttempt exige cero reintentos y a lo sumo un coste', () => {
  const write = (c: { id: string }, retry: number, costs: number[]) => {
    const a = store.listActivities({ changeId: c.id })[0]!;
    store.db.query('UPDATE activities SET retry_count=? WHERE id=?').run(retry, a.id);
    writeFileSync(join(dir, 'runs', c.id, `${a.id}.json`), JSON.stringify({ attemptCosts: costs, model: 'm', isolation: { adapter: 'a' } }));
    return calculateMetrics(store, dir, { now }).cost.models[0]?.name;
  };
  const one = seed(1, 1); expect(write(one, 0, [1, 2])).toBe('No medido');
  store.db.query('DELETE FROM changes WHERE id=?').run(one.id);
  const two = seed(1, 1); expect(write(two, 1, [1])).toBe('No medido');
});
function validatorChange() {
  const c = store.createChange('uno', 'x', '');
  store.db.query("UPDATE activities SET status='completed',kind='implementation' WHERE change_id=?").run(c.id);
  store.db.query("UPDATE changes SET status='implemented' WHERE id=?").run(c.id);
  store.db.query("UPDATE workstreams SET state='active'").run();
  store.requestValidation(c.id, ['code_review']);
  return { c, a: store.claimActivity('uno', 'w')! };
}
test('N1: la cuarentena de un validador sigue siendo estado terminal', () => {
  const { c, a } = validatorChange();
  store.quarantineActivity(a.id, 'w', 'razón');
  expect(store.getChange(c.id).status).toBe('quarantined');
  expect(calculateMetrics(store, dir).cycles[3]?.samples).toBe(1);
});
test('N1: el bloqueo de un validador sigue siendo estado terminal', () => {
  const { c, a } = validatorChange();
  store.blockActivity(a.id, 'w', 'razón');
  expect(store.getChange(c.id).status).toBe('blocked');
  expect(calculateMetrics(store, dir).cycles[3]?.samples).toBe(1);
});
test('N1: el reintento humano de un change bloqueado por validador cuenta como intervención', () => {
  const { c, a } = validatorChange();
  store.blockActivity(a.id, 'w', 'razón');
  store.retryChange(c.id);
  expect(calculateMetrics(store, dir).humans.find(h => h.id === c.id)?.retries).toBe(1);
});
test('N2: change completed y canceled sin activity siguen siendo terminales', () => {
  const c = store.createChange('uno', 'x', '');
  store.db.query("UPDATE changes SET status='implemented' WHERE id=?").run(c.id);
  store.closeChange(c.id, 'completed');
  expect(store.db.query("SELECT activity_id FROM events WHERE message='change completed'").get()).toEqual({ activity_id: null });
  expect(calculateMetrics(store, dir).cycles[3]?.samples).toBe(1);
});

test('T82: rango libre con from y to; rangos inválidos se rechazan', () => {
  seed(1, 1, 'uno', '2026-11-10T12:00:00Z');
  seed(1, 2, 'uno', '2026-11-15T12:00:00Z');
  seed(1, 4, 'uno', '2026-11-17T12:00:00Z');
  seed(1, 8, 'uno', '2026-11-20T12:00:00Z');

  const m = calculateMetrics(store, dir, { from: '2026-11-14', to: '2026-11-18', now });
  expect(m.count).toBe(2);
  expect(m.cost.total).toBe(6);

  expect(() => calculateMetrics(store, dir, { from: 'bad' })).toThrow(URIError);
  expect(() => calculateMetrics(store, dir, { to: '2026-99-99' })).toThrow(URIError);
  expect(() => calculateMetrics(store, dir, { to: '2026-02-31' })).toThrow(URIError);
  expect(() => calculateMetrics(store, dir, { from: '2026-11-20', to: '2026-11-10' })).toThrow(URIError);
  expect(() => calculateMetrics(store, dir, { range: 'invalido' as any })).toThrow(URIError);
});

test('T82: coste por fuente y por actor del primer evento', () => {
  const c1 = seed(1, 10, 'uno', '2026-11-18T00:00:00Z');
  const c2 = seed(1, 20, 'uno', '2026-11-18T01:00:00Z');
  const c3 = seed(1, null, 'uno', '2026-11-18T02:00:00Z');

  store.db.query("INSERT INTO signals (id, workstream_id, title, body, status, change_id, created_at) VALUES ('s1', ?, 't', 'b', 'triaged', ?, '2026-11-18T00:00:00Z')")
    .run(c1.workstreamId, c1.id);
  store.db.exec("CREATE TABLE IF NOT EXISTS change_links (change_id TEXT PRIMARY KEY, source_system TEXT, source_key TEXT, source_url TEXT, pr_json TEXT)");
  store.db.query("INSERT INTO change_links (change_id, source_system, source_key, source_url) VALUES (?, 'jira', 'PROJ-1', 'https://jira/PROJ-1')")
    .run(c2.id);

  store.db.query("UPDATE events SET actor='alice' WHERE change_id=? AND id IN (SELECT MIN(id) FROM events WHERE change_id=?)").run(c1.id, c1.id);
  store.db.query("UPDATE events SET actor='bob' WHERE change_id=? AND id IN (SELECT MIN(id) FROM events WHERE change_id=?)").run(c2.id, c2.id);

  const m = calculateMetrics(store, dir, { range: '7', now });
  expect(m.cost.sources.find(s => s.name === 'CLI')).toEqual({ name: 'CLI', measured: 10, unknown: 0, total: 10 });
  expect(m.cost.sources.find(s => s.name === 'Jira')).toEqual({ name: 'Jira', measured: 20, unknown: 0, total: 20 });
  expect(m.cost.sources.find(s => s.name === 'No medido')).toEqual({ name: 'No medido', measured: null, unknown: 1, total: null });

  expect(m.cost.actors.find(a => a.name === 'alice')).toEqual({ name: 'alice', measured: 10, unknown: 0, total: 10 });
  expect(m.cost.actors.find(a => a.name === 'bob')).toEqual({ name: 'bob', measured: 20, unknown: 0, total: 20 });
  expect(m.cost.actors.find(a => a.name === 'No medido')).toEqual({ name: 'No medido', measured: null, unknown: 1, total: null });
});

test('T82: gráficos SVG de series temporales, números coinciden con la tabla y días sin datos son huecos', () => {
  seed(1, 5, 'uno', '2026-11-17T10:00:00Z');
  seed(1, null, 'uno', '2026-11-18T10:00:00Z');

  const { body: html } = metricsPage(store, dir, new URL('http://127.0.0.1:4310/metricas?from=2026-11-17&to=2026-11-19'));
  expect(html).toContain('Series temporales');
  expect(html).toContain('Changes creados por día');
  expect(html).toContain('Coste por día');
  expect(html).toContain('Intervenciones humanas por día');
  expect(html).toContain('Coste por fuente del change');
  expect(html).toContain('Coste por actor del primer evento');

  // En el día sin datos (2026-11-19 para changes), la tabla tiene "Sin datos" y el SVG tiene hueco, nunca cero
  expect(html).toContain('<tr><th scope="row">2026-11-19</th><td>Sin datos</td></tr>');
  expect(html).not.toContain('<tr><th scope="row">2026-11-19</th><td>0</td></tr>');
  expect(html).toContain('>hueco<');
  const m = calculateMetrics(store, dir, { from: '2026-11-17', to: '2026-11-19' });
  expect(m.daily.changes).toEqual([1, 1, null]);
  expect(m.daily.costs).toEqual([5, null, null]);
  expect(m.daily.interventions).toEqual([3, 3, null]);

  // Tablas: valores por fila y día
  expect(html).toContain('<tr><th scope="row">2026-11-17</th><td>1</td></tr>');
  expect(html).toContain('<tr><th scope="row">2026-11-18</th><td>1</td></tr>');
  expect(html).toContain('<tr><th scope="row">2026-11-17</th><td>5.00 USD</td></tr>');
  expect(html).toContain('<tr><th scope="row">2026-11-18</th><td>No medido</td></tr>');
  expect(html).toContain('<tr><th scope="row">2026-11-17</th><td>3</td></tr>');
  expect(html).toContain('<tr><th scope="row">2026-11-18</th><td>3</td></tr>');

  // SVG: valores exactos y huecos por gráfico
  // Changes SVG
  expect(html).toContain('<text x="58" y="20" text-anchor="middle" font-size="11" fill="currentColor">1</text>');
  expect(html).toContain('<text x="114" y="20" text-anchor="middle" font-size="11" fill="currentColor">1</text>');
  // Coste SVG
  expect(html).toContain('<text x="58" y="20" text-anchor="middle" font-size="11" fill="currentColor">5.00</text>');
  // Intervenciones SVG
  expect(html).toContain('<text x="58" y="20" text-anchor="middle" font-size="11" fill="currentColor">3</text>');
  expect(html).toContain('<text x="114" y="20" text-anchor="middle" font-size="11" fill="currentColor">3</text>');
  // Hueco presente en día 19 (y día 18 en coste)
  expect(html).toContain('<text x="170" y="103" text-anchor="middle" font-size="11" fill="var(--muted, #888)">hueco</text>');
  expect(html).toContain('<text x="114" y="103" text-anchor="middle" font-size="11" fill="var(--muted, #888)">hueco</text>');

  expect(html).toContain('2026-11-17');
  expect(html).toContain('2026-11-18');
  expect(html).toContain('2026-11-19');
});

test('T82 HTTP: rango libre vía HTTP y rechazo de rangos inválidos', async () => {
  seed(1, 2); store.close();
  const server = startWeb(dir, 0), base = `http://127.0.0.1:${server.port}/metricas`;
  try {
    const ok = await fetch(`${base}?from=2026-11-17&to=2026-11-19`);
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain('Series temporales');
    expect(ok.headers.get('content-security-policy')).toContain("default-src 'none'");

    // Rangos inválidos devuelven 400
    expect((await fetch(`${base}?from=invalido`)).status).toBe(400);
    expect((await fetch(`${base}?to=2026-13-40`)).status).toBe(400);
    expect((await fetch(`${base}?from=2026-11-20&to=2026-11-10`)).status).toBe(400);
    expect((await fetch(`${base}?range=otra_cosa`)).status).toBe(400);
  } finally {
    server.stop(true);
    store = new Store(join(dir, 'fabrica.db'));
  }
});

test('T82-H1: el rango libre rechaza más de 366 días con 400', async () => {
  expect(() => calculateMetrics(store, dir, { from: '2024-01-01', to: '2025-01-03' })).toThrow(URIError);
  expect(() => calculateMetrics(store, dir, { from: '1000-01-01', to: '9999-12-31' })).toThrow(URIError);
  const server = startWeb(dir, 0);
  try {
    const base = `http://127.0.0.1:${server.port}/metricas`;
    const res = await fetch(`${base}?from=2024-01-01&to=2025-01-03`);
    expect(res.status).toBe(400);
    const resOom = await fetch(`${base}?from=1000-01-01&to=9999-12-31`);
    expect(resOom.status).toBe(400);
  } finally {
    server.stop(true);
    store = new Store(join(dir, 'fabrica.db'));
  }
});

test('T82-H2: range=custom sin fechas y jueces con custom devuelven 400', async () => {
  expect(() => calculateMetrics(store, dir, { range: 'custom' })).toThrow(URIError);
  const server = startWeb(dir, 0);
  try {
    const base = `http://127.0.0.1:${server.port}/metricas`;
    const resCustomNoDates = await fetch(`${base}?ws=&range=custom&from=&to=`);
    expect(resCustomNoDates.status).toBe(400);

    const resJuecesCustom = await fetch(`${base}?tab=jueces&range=custom`);
    expect(resJuecesCustom.status).toBe(400);
  } finally {
    server.stop(true);
    store = new Store(join(dir, 'fabrica.db'));
  }
});

test('T82-H4: change creado en el límite de since entra en la serie diaria para range=7', () => {
  const changeTime = new Date(now - 7 * 86400000 + 3600000).toISOString(); // 6 días 23h atrás
  const c = store.createChange('uno', 'Change límite since', '');
  store.db.query("UPDATE changes SET created_at=? WHERE id=?").run(changeTime, c.id);

  const m = calculateMetrics(store, dir, { range: '7', now });
  expect(m.count).toBe(1);
  const changeDay = changeTime.slice(0, 10);
  expect(m.daily.days).toContain(changeDay);
  const dayIndex = m.daily.days.indexOf(changeDay);
  expect(m.daily.changes[dayIndex]).toBe(1);
});

test('T82-H5: elegir rango preset con fechas en la URL vacía fechas y respeta el preset; día sin changes muestra Sin datos en coste', () => {
  seed(1, null, 'uno', '2026-11-18T10:00:00Z');
  const { body: html } = metricsPage(store, dir, new URL('http://127.0.0.1:4310/metricas?range=30&from=2026-11-17&to=2026-11-18'));
  expect(html).toContain('<option value="30" selected>Últimos 30 días</option>');
  expect(html).toContain('<input name="from" type="date" value="">');
  expect(html).toContain('<input name="to" type="date" value="">');

  const { body: htmlCustom } = metricsPage(store, dir, new URL('http://127.0.0.1:4310/metricas?from=2026-11-17&to=2026-11-19'));
  expect(htmlCustom).toContain('<tr><th scope="row">2026-11-18</th><td>No medido</td></tr>');
  expect(htmlCustom).toContain('<tr><th scope="row">2026-11-19</th><td>Sin datos</td></tr>');
});

test('T82-H6: change a las 23:00 del día to entra en la cohorte y Todo el historial avisa del tope de 90 días', () => {
  const c = store.createChange('uno', 'Change 23h', '');
  store.db.query("UPDATE changes SET created_at=? WHERE id=?").run('2026-11-18T23:00:00Z', c.id);

  const m = calculateMetrics(store, dir, { from: '2026-11-17', to: '2026-11-18', now });
  expect(m.count).toBe(1);
  const dayIndex = m.daily.days.indexOf('2026-11-18');
  expect(dayIndex).toBeGreaterThanOrEqual(0);
  expect(m.daily.changes[dayIndex]).toBe(1);

  const { body: htmlAll } = metricsPage(store, dir, new URL('http://127.0.0.1:4310/metricas?range=all'));
  expect(htmlAll).toContain('Las series temporales diarias de «Todo el historial» muestran como máximo los últimos 90 días');
});

test('T83-H3: guardas de ciclo PR/merge y selección del primer evento (MIN) sin alias no estándar', () => {
  const c1 = store.createChange('uno', 'Change fechas invertidas', '');
  store.db.query("UPDATE changes SET created_at=? WHERE id=?").run('2026-11-18T10:00:00Z', c1.id);
  store.event(c1.workstreamId, 'info', 'pr_opened: https://github.com/org/repo/pull/1', c1.id);
  store.db.query("UPDATE events SET created_at=? WHERE change_id=? AND message LIKE 'pr_opened%'").run('2026-11-18T09:00:00Z', c1.id);
  store.event(c1.workstreamId, 'info', 'merge_completed', c1.id);
  store.db.query("UPDATE events SET created_at=? WHERE change_id=? AND message='merge_completed'").run('2026-11-18T08:00:00Z', c1.id);

  const c2 = store.createChange('uno', 'Change múltiples eventos', '');
  store.db.query("UPDATE changes SET created_at=? WHERE id=?").run('2026-11-18T00:00:00Z', c2.id);
  store.db.query("INSERT INTO events (workstream_id, change_id, severity, message, created_at) VALUES (?, ?, 'info', 'pr_opened: https://github.com/org/repo/pull/2', '2026-11-18T02:00:00Z')").run(c2.workstreamId, c2.id);
  store.db.query("INSERT INTO events (workstream_id, change_id, severity, message, created_at) VALUES (?, ?, 'info', 'pr_opened: https://github.com/org/repo/pull/2', '2026-11-18T06:00:00Z')").run(c2.workstreamId, c2.id);
  store.db.query("INSERT INTO events (workstream_id, change_id, severity, message, created_at) VALUES (?, ?, 'info', 'merge_completed', '2026-11-18T04:00:00Z')").run(c2.workstreamId, c2.id);
  store.db.query("INSERT INTO events (workstream_id, change_id, severity, message, created_at) VALUES (?, ?, 'info', 'merge_completed', '2026-11-18T08:00:00Z')").run(c2.workstreamId, c2.id);

  const m = calculateMetrics(store, dir, { range: '7', now });
  const kickoff = m.prCycles.find(c => c.name === 'Kickoff → PR')!;
  const merge = m.prCycles.find(c => c.name === 'PR → merge')!;

  expect(kickoff.samples).toBe(1);
  expect(kickoff.median).toBe(2 * 3600000);
  expect(merge.samples).toBe(1);
  expect(merge.median).toBe(2 * 3600000);

  const c3 = store.createChange('uno', 'Change con alias raro', '');
  store.db.query("INSERT INTO events (workstream_id, change_id, severity, message, created_at) VALUES (?, ?, 'info', 'pr opened: https://github.com/org/repo/pull/3', '2026-11-18T01:00:00Z')").run(c3.workstreamId, c3.id);
  store.db.query("INSERT INTO events (workstream_id, change_id, severity, message, created_at) VALUES (?, ?, 'info', 'merged', '2026-11-18T02:00:00Z')").run(c3.workstreamId, c3.id);
  const evs = store.metricsEvents([c3.id], new Date().toISOString());
  expect(evs[0]?.prOpenedAt).toBeNull();
  expect(evs[0]?.mergedAt).toBeNull();
  expect(store.getChangePrUrl(c3.id)).toBeNull();
});

test('T83-H4: recordPrOpened exige URL https válida con host y rechaza https:// vacío', () => {
  const c = store.createChange('uno', 'Change url host', '');
  expect(() => store.recordPrOpened(c.id, 'https://')).toThrow();
  expect(() => store.recordPrOpened(c.id, 'https://?query')).toThrow();
  expect(() => store.recordPrOpened(c.id, 'https://#hash')).toThrow();
  expect(() => store.recordPrOpened(c.id, 'not-a-url')).toThrow();
  expect(() => store.recordPrOpened(c.id, 'http://github.com/org/repo/pull/1')).toThrow();
  expect(() => store.recordPrOpened(c.id, 'https://github.com/org/repo/pull/1')).not.toThrow();
});

test('T82-H7: resolveChangeAttribution reutiliza la resolución de fuente y creador acotada a la cohorte', () => {
  const c1 = seed(1, 10, 'uno', '2026-11-18T00:00:00Z');
  store.db.query("INSERT INTO signals (id, workstream_id, title, body, status, change_id, created_at) VALUES ('s10', ?, 't', 'b', 'triaged', ?, '2026-11-18T00:00:00Z')")
    .run(c1.workstreamId, c1.id);
  store.db.query("UPDATE events SET actor='carol' WHERE change_id=? AND id IN (SELECT MIN(id) FROM events WHERE change_id=?)").run(c1.id, c1.id);

  const empty = (store as any).resolveChangeAttribution([]);
  expect(empty.source.size).toBe(0);
  expect(empty.creator.size).toBe(0);

  const attr = (store as any).resolveChangeAttribution([c1.id]);
  expect(attr.source.get(c1.id)).toBe('cli');
  expect(attr.creator.get(c1.id)).toBe('carol');
});

test('T82-H8: changeIndex llama a resolveChangeAttribution sin argumentos para evitar límite de parámetros SQL', () => {
  const c = store.createChange('uno', 'Change de index', '');
  store.db.query("INSERT INTO signals (id, workstream_id, title, body, status, change_id, created_at) VALUES ('s20', ?, 't', 'b', 'triaged', ?, '2026-11-18T00:00:00Z')")
    .run(c.workstreamId, c.id);
  store.db.query("UPDATE events SET actor='dave' WHERE change_id=? AND id IN (SELECT MIN(id) FROM events WHERE change_id=?)").run(c.id, c.id);

  let calledWith: string[] | undefined = ['sentinel'];
  const orig = store.resolveChangeAttribution.bind(store);
  store.resolveChangeAttribution = (ids?: string[]) => {
    calledWith = ids;
    return orig(ids);
  };
  const list = store.changeIndex('uno');
  expect(calledWith).toBeUndefined();
  expect(list.find(x => x.id === c.id)?.source).toBe('cli');
  expect(list.find(x => x.id === c.id)?.creator).toBe('dave');
});

test('T83-H6: dos URLs distintas de PR registran sendos eventos y getChangePrUrl devuelve el último', () => {
  const c = store.createChange('uno', 'Change dos PRs', '');
  store.recordPrOpened(c.id, 'https://github.com/org/repo/pull/1');
  store.recordPrOpened(c.id, 'https://github.com/org/repo/pull/2');

  const evs = store.listEvents(c.workstreamId, 10, c.id).filter(e => typeof e.message === 'string' && e.message.startsWith('pr_opened:'));
  expect(evs).toHaveLength(2);
  expect(store.getChangePrUrl(c.id)).toBe('https://github.com/org/repo/pull/2');
});

test('T83-H7: recordPrOpened guarda URL canónica normalizada y rechaza barras invertidas o triple barra', () => {
  const c = store.createChange('uno', 'Change canonical url', '');
  store.recordPrOpened(c.id, 'HTTPS://GitHub.com/org/repo/pull/1');
  expect(store.getChangePrUrl(c.id)).toBe('https://github.com/org/repo/pull/1');

  const c2 = store.createChange('uno', 'Change bad urls', '');
  expect(() => store.recordPrOpened(c2.id, 'https:///x')).toThrow();
  expect(() => store.recordPrOpened(c2.id, 'https:\\\\h\\\\x')).toThrow();
});

test('T83-H1: repetir recordPrOpened no duplica el evento ni altera el conteo en metricsDailyPrs', () => {
  const c = store.createChange('uno', 'Change con PR repetido', '');
  store.recordPrOpened(c.id, 'https://github.com/org/repo/pull/1');
  store.recordPrOpened(c.id, 'https://github.com/org/repo/pull/1');
  const evs = store.listEvents(c.workstreamId, 10, c.id).filter(e => typeof e.message === 'string' && e.message.startsWith('pr_opened:'));
  expect(evs).toHaveLength(1);

  const daily = store.metricsDailyPrs([c.id], new Date().toISOString());
  const today = new Date().toISOString().slice(0, 10);
  expect(daily.opened.get(today)).toBe(1);
});

test('T83: ciclo con PR (kickoff→PR, PR→primera revisión humana, PR→merge); tramos exactos con eventos sintéticos', () => {
  const c1 = store.createChange('uno', 'Change con PR', '');
  store.db.query("UPDATE changes SET created_at=?, status='completed' WHERE id=?").run('2026-11-18T00:00:00Z', c1.id);
  store.event(c1.workstreamId, 'info', 'pr_opened: https://github.com/org/repo/pull/42', c1.id);
  store.db.query("UPDATE events SET created_at=? WHERE change_id=? AND message LIKE 'pr_opened%'").run('2026-11-18T02:00:00Z', c1.id);
  store.event(c1.workstreamId, 'info', 'merge_completed', c1.id);
  store.db.query("UPDATE events SET created_at=? WHERE change_id=? AND message='merge_completed'").run('2026-11-18T05:00:00Z', c1.id);

  const c2 = store.createChange('uno', 'Change sin PR', '');
  store.db.query("UPDATE changes SET created_at=? WHERE id=?").run('2026-11-18T00:00:00Z', c2.id);

  const m = calculateMetrics(store, dir, { range: '7', now });
  const kickoffPr = m.prCycles.find(c => c.name === 'Kickoff → PR')!;
  expect(kickoffPr.median).toBe(2 * 3600000);
  expect(kickoffPr.samples).toBe(1);

  const prReview = m.prCycles.find(c => c.name === 'PR → primera revisión humana')!;
  expect(prReview.median).toBeNull();
  expect(prReview.samples).toBe(0);

  const prMerge = m.prCycles.find(c => c.name === 'PR → merge')!;
  expect(prMerge.median).toBe(3 * 3600000);
  expect(prMerge.samples).toBe(1);

  expect(m.count).toBe(2);
  expect(m.count - kickoffPr.samples).toBe(1);
  expect(m.count - prMerge.samples).toBe(1);
});

test('T83: serie de PRs abiertos y fusionados en el tiempo', () => {
  const c = store.createChange('uno', 'Change serie PRs', '');
  store.db.query("UPDATE changes SET created_at=? WHERE id=?").run('2026-11-17T00:00:00Z', c.id);

  store.event(c.workstreamId, 'info', 'pr_opened: https://github.com/org/repo/pull/10', c.id);
  store.db.query("UPDATE events SET created_at=? WHERE change_id=? AND message LIKE 'pr_opened%'").run('2026-11-17T12:00:00Z', c.id);
  store.event(c.workstreamId, 'info', 'merge_completed', c.id);
  store.db.query("UPDATE events SET created_at=? WHERE change_id=? AND message='merge_completed'").run('2026-11-18T12:00:00Z', c.id);

  const m = calculateMetrics(store, dir, { from: '2026-11-17', to: '2026-11-19' });
  expect(m.daily.prs).toEqual([
    { opened: 1, merged: null },
    { opened: null, merged: 1 },
    { opened: null, merged: null },
  ]);

  const { body: html } = metricsPage(store, dir, new URL('http://127.0.0.1:4310/metricas?from=2026-11-17&to=2026-11-19'));
  expect(html).toContain('PRs abiertos y fusionados por día');
  expect(html).toContain('Tramos del ciclo con PR');
  expect(html).toContain('Kickoff → PR');
  expect(html).toContain('PR → merge');
  expect(html).toContain('PR → primera revisión humana');

  // Afirma celdas de tabla día a día (abiertos, fusionados y sin datos)
  expect(html).toContain('<tr><th scope="row">2026-11-17</th><td>1</td><td>Sin datos</td></tr>');
  expect(html).toContain('<tr><th scope="row">2026-11-18</th><td>Sin datos</td><td>1</td></tr>');
  expect(html).toContain('<tr><th scope="row">2026-11-19</th><td>Sin datos</td><td>Sin datos</td></tr>');
  expect(html).not.toContain('<tr><th scope="row">2026-11-19</th><td>0</td>');

  // Afirma SVG: barras, valores y hueco
  expect(html).toContain('<text x="46" y="20" text-anchor="middle" font-size="10" fill="currentColor">1</text>');
  expect(html).toContain('<text x="126" y="20" text-anchor="middle" font-size="10" fill="currentColor">1</text>');
  expect(html).toContain('<text x="170" y="103" text-anchor="middle" font-size="11" fill="var(--muted, #888)">hueco</text>');
});

test('T83: detalle del change muestra enlace al PR, escapa URL, solo admite https, y sin PR es No medido', async () => {
  const c1 = store.createChange('uno', 'Change con PR https', '');
  store.recordPrOpened(c1.id, 'https://github.com/org/repo/pull/99?param=1&other=<script>');

  const c2 = store.createChange('uno', 'Change sin PR', '');

  const c3 = store.createChange('uno', 'Change con PR http no seguro', '');
  store.db.exec("CREATE TABLE IF NOT EXISTS change_links (change_id TEXT PRIMARY KEY, source_system TEXT, source_key TEXT, source_url TEXT, pr_json TEXT)");
  store.db.query("INSERT INTO change_links (change_id, pr_json) VALUES (?, ?)").run(c3.id, JSON.stringify({ url: 'http://insecure.test/pr/1' }));

  store.close();
  const server = startWeb(dir, 0);
  try {
    const r1 = await fetch(`http://127.0.0.1:${server.port}/changes/${c1.id}`);
    expect(r1.status).toBe(200);
    const html1 = await r1.text();
    expect(html1).toContain('https://github.com/org/repo/pull/99?param=1&amp;other=&lt;script&gt;');
    expect(html1).not.toContain('<script>');
    expect(html1).toContain('<a href="https://github.com/org/repo/pull/99?param=1&amp;other=&lt;script&gt;"');

    const r2 = await fetch(`http://127.0.0.1:${server.port}/changes/${c2.id}`);
    expect(r2.status).toBe(200);
    const html2 = await r2.text();
    expect(html2).toContain('PR: No medido');

    const r3 = await fetch(`http://127.0.0.1:${server.port}/changes/${c3.id}`);
    expect(r3.status).toBe(200);
    const html3 = await r3.text();
    expect(html3).toContain('PR: No medido');
    expect(html3).not.toContain('http://insecure.test');
  } finally {
    server.stop(true);
    store = new Store(join(dir, 'fabrica.db'));
  }
});

test('T83: recordPrOpened solo admite https', () => {
  const c = store.createChange('uno', 'c', '');
  expect(() => store.recordPrOpened(c.id, 'http://inseguro.test')).toThrow();
  expect(() => store.recordPrOpened(c.id, 'javascript:alert(1)')).toThrow();
  store.recordPrOpened(c.id, 'https://github.com/owner/repo/pull/1');
  expect(store.getChangePrUrl(c.id)).toBe('https://github.com/owner/repo/pull/1');
  expect(changePrLink({ getChangePrUrl: () => 'http://insecure.test' } as any, c.id)).toBe('No medido');
  expect(changePrLink({ getChangePrUrl: () => 'javascript:alert(1)' } as any, c.id)).toBe('No medido');
});
