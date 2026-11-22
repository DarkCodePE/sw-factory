// Tests de la pestaña Gasto de la plataforma web de fab (T113).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { costRateAt } from '../src/attempt-cost.ts';
import { calculateMetrics } from '../src/metrics.ts';
import { metricsPage } from '../src/web-metrics.ts';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-gasto-test-'));
  mkdirSync(join(dir, 'runs'), { recursive: true });
  store = new Store(join(dir, 'fabrica.db'));
  store.createWorkstream({ slug: 'ws-test', goal: 'Pruebas de gasto', repo: '/tmp/repo' });
});

afterEach(() => {
  try { store.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function seedItem(opts: {
  title: string;
  date?: string;
  attemptCosts?: (number | null)[];
  inferenceAttempts?: any[];
  prUrl?: string;
  actor?: string;
}) {
  const date = opts.date ?? new Date(Date.now() - 2 * 86400000).toISOString();
  if (opts.actor) process.env.FAB_ACTOR = opts.actor;
  const c = store.createChange('ws-test', opts.title, 'descripción');
  if (opts.actor) {
    store.db.query("UPDATE events SET actor=? WHERE change_id=?").run(opts.actor, c.id);
    delete process.env.FAB_ACTOR;
  }

  store.db.query("UPDATE changes SET created_at=?, status='completed' WHERE id=?").run(date, c.id);
  const act = store.listActivities({ changeId: c.id })[0]!;
  store.db.query("UPDATE activities SET created_at=?, started_at=?, completed_at=?, kind='investigation', status='completed' WHERE id=?")
    .run(date, date, date, act.id);

  if (opts.prUrl) {
    store.recordPrOpened(c.id, opts.prUrl);
  }

  const runDir = join(dir, 'runs', c.id);
  mkdirSync(runDir, { recursive: true });
  const meta: Record<string, unknown> = {
    durationMs: 60000,
    isolation: { adapter: 'native' },
  };
  if (opts.attemptCosts !== undefined) {
    meta.attemptCosts = opts.attemptCosts;
  }
  if (opts.inferenceAttempts !== undefined) {
    meta.inferenceAttempts = opts.inferenceAttempts;
  }
  writeFileSync(join(runDir, `${act.id}.json`), JSON.stringify(meta));
  return { change: c, activity: act };
}

describe('Pestaña Gasto en la web (T113)', () => {
  test('las cinco tarjetas de gasto están presentes con su estructura, ayuda y tablas plegadas', () => {
    seedItem({
      title: 'Change con gasto',
      attemptCosts: [0.05],
      inferenceAttempts: [
        {
          adapter: 'native',
          requestedModel: 'claude-sonnet',
          workerRole: 'investigate',
          usage: {
            effectiveModel: 'claude-3-7-sonnet-20250219',
            inputTokens: 1000,
            outputTokens: 200,
            cacheReadTokens: 50,
            costUsd: 0.05,
            priceVersion: '2026-11-21-v1#a1b2c3d4e5f6',
          },
        },
      ],
    });

    const url = new URL('http://127.0.0.1:4310/metricas?tab=gasto&range=7');
    const { body } = metricsPage(store, dir, url);

    // Cinco tarjetas de métricas
    expect(body).toContain('<section class="card" aria-labelledby="t-cost">');
    expect(body).toContain('<section class="card" aria-labelledby="t-spending-worker">');
    expect(body).toContain('<section class="card" aria-labelledby="t-spending-model">');
    expect(body).toContain('<section class="card" aria-labelledby="t-spending-user">');
    expect(body).toContain('<section class="card" aria-labelledby="t-spending-source">');

    // Títulos de las 5 tarjetas
    expect(body).toContain('<h2 id="t-cost">Coste por día</h2>');
    expect(body).toContain('<h2 id="t-spending-worker">Gasto por worker</h2>');
    expect(body).toContain('<h2 id="t-spending-model">Gasto por modelo</h2>');
    expect(body).toContain('<h2 id="t-spending-user">Gasto por usuario</h2>');
    expect(body).toContain('<h2 id="t-spending-source">Gasto por fuente</h2>');

    // Tablas de datos plegadas bajo cada tarjeta
    expect(body).toContain('<summary>Tabla de datos · Coste por día</summary>');
    expect(body).toContain('<summary>Tabla de datos · Gasto por worker</summary>');
    expect(body).toContain('<summary>Tabla de datos · Gasto por modelo registrado</summary>');
    expect(body).toContain('<summary>Tabla de datos · Gasto por usuario</summary>');
    expect(body).toContain('<summary>Tabla de datos · Gasto por fuente</summary>');

    // Modelo efectivo presente, sin modelo pedido inventado
    expect(body).toContain('claude-3-7-sonnet-20250219');
    expect(body).not.toContain('claude-sonnet</td>');

    // Tabla de los 20 PR más caros
    expect(body).toContain('<caption>Los 20 PR más caros</caption>');
  });

  test('T109-H6: null se muestra como «No medido» y nunca como 0 o 0.00 USD', () => {
    seedItem({
      title: 'Change sin mediciones',
      attemptCosts: [null],
    });

    const url = new URL('http://127.0.0.1:4310/metricas?tab=gasto&range=7');
    const { body } = metricsPage(store, dir, url);

    // En total y en cards debe salir «No medido»
    expect(body).toContain('Total: <strong>No medido</strong>');
    expect(body).not.toContain('0.00 USD');
    expect(body).not.toContain('0 USD');
  });

  test('T109-H6: FAB_ACTOR se escapa para prevenir XSS en Gasto por usuario', () => {
    const ws = store.getWorkstream('ws-test');
    const s = store.addSignal(ws.id, 'con actor malicioso', 'b', { source: 'cli', actorId: '<script>alert("xss")</script>' });
    const c = store.triageSignal(s.id);
    const date = new Date(Date.now() - 86400000).toISOString();
    store.db.query("UPDATE changes SET created_at=?, status='completed' WHERE id=?").run(date, c.id);
    const a = store.listActivities({ changeId: c.id })[0]!;
    store.db.query("UPDATE activities SET created_at=?, status='completed', kind='investigation' WHERE id=?").run(date, a.id);
    const runDir = join(dir, 'runs', c.id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, `${a.id}.json`), JSON.stringify({ attemptCosts: [0.15], isolation: { adapter: 'native' } }));

    store.beginCostAttempt(a, {
      id: 'att-xss',
      rate: costRateAt(dir, date, null),
      remote: false,
      runner: null,
      adapter: 'native',
      legacyCount: 0,
    });
    store.finishCostAttempt('att-xss', { costUsd: 0.15 }, 100);

    const url = new URL('http://127.0.0.1:4310/metricas?tab=gasto&range=7');
    const { body } = metricsPage(store, dir, url);

    // El script malicioso debe estar escapado como entidad HTML
    expect(body).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(body).not.toContain('<script>alert("xss")</script>');
  });

  test('tarifa versión#hash12 y versión antigua sin hash se procesan correctamente', () => {
    const today = new Date().toISOString().slice(0, 10);
    const date = `${today}T10:00:00.000Z`;
    const item1 = seedItem({
      title: 'Tarifa con hash',
      date,
      attemptCosts: [0.10],
      inferenceAttempts: [{
        adapter: 'native',
        usage: { effectiveModel: 'modelo-nuevo', inputTokens: 50, outputTokens: 10, costUsd: 0.10, priceVersion: '2026-11-21-v1#0123456789ab' },
      }],
    });
    store.beginCostAttempt(item1.activity, {
      id: 'att-hash',
      rate: { ...costRateAt(dir, date, null), version: '2026-11-21-v1#0123456789ab' },
      remote: false,
      runner: null,
      adapter: 'native',
      legacyCount: 0,
    });
    store.finishCostAttempt('att-hash', { costUsd: 0.10, effectiveModel: 'modelo-nuevo' }, 100);

    const item2 = seedItem({
      title: 'Tarifa sin hash',
      date,
      attemptCosts: [0.20],
      inferenceAttempts: [{
        adapter: 'native',
        usage: { effectiveModel: 'modelo-antiguo', inputTokens: 50, outputTokens: 10, costUsd: 0.20, priceVersion: '2026-11-21-v1' },
      }],
    });
    store.beginCostAttempt(item2.activity, {
      id: 'att-sin-hash',
      rate: { ...costRateAt(dir, date, null), version: '2026-11-21-v1' },
      remote: false,
      runner: null,
      adapter: 'native',
      legacyCount: 0,
    });
    store.finishCostAttempt('att-sin-hash', { costUsd: 0.20, effectiveModel: 'modelo-antiguo' }, 100);

    const m = calculateMetrics(store, dir, { ws: 'ws-test', from: today, to: today });
    expect(m.spending.attempts.map(a => a.rateVersion).sort()).toEqual(['2026-11-21-v1', '2026-11-21-v1#0123456789ab']);

    const url = new URL(`http://127.0.0.1:4310/metricas?tab=gasto&range=7`);
    const { body } = metricsPage(store, dir, url);
    expect(body).toContain('modelo-nuevo');
    expect(body).toContain('modelo-antiguo');
  });

  test('tabla de los 20 PR más caros muestra orden por coste, tope de 20, URL de PR y desglose', () => {
    const today = new Date().toISOString().slice(0, 10);
    const date = `${today}T12:00:00.000Z`;
    // Crear 22 PRs con costes crecientes
    for (let i = 1; i <= 22; i++) {
      const cost = i * 1.0;
      const { activity } = seedItem({
        title: `PR caro ${String(i).padStart(2, '0')}`,
        prUrl: `https://github.com/org/repo/pull/${i}`,
        date,
        attemptCosts: [cost],
        inferenceAttempts: [{
          adapter: 'native',
          usage: { effectiveModel: 'm1', inputTokens: 100, outputTokens: 50, costUsd: cost, priceVersion: 'v1' },
        }],
      });
      store.beginCostAttempt(activity, {
        id: `att-pr-${i}`,
        rate: costRateAt(dir, date, null),
        remote: false,
        runner: null,
        adapter: 'native',
        legacyCount: 0,
      });
      store.finishCostAttempt(`att-pr-${i}`, { costUsd: cost, effectiveModel: 'm1' }, 100);
    }

    const url = new URL(`http://127.0.0.1:4310/metricas?tab=gasto&range=7`);
    const { body } = metricsPage(store, dir, url);

    // Tope de 20 PR: los 2 de menor coste (1 y 2) no deben estar en la tabla
    const tablePart = body.slice(body.indexOf('<caption>Los 20 PR más caros</caption>'));
    const tableSection = tablePart.slice(0, tablePart.indexOf('</table>'));

    expect(tableSection).toContain('PR caro 22');
    expect(tableSection).toContain('PR caro 03');
    expect(tableSection).not.toContain('PR caro 02');
    expect(tableSection).not.toContain('PR caro 01');

    // Orden decreciente por coste: PR caro 22 antes que PR caro 21
    const idx22 = tableSection.indexOf('PR caro 22');
    const idx21 = tableSection.indexOf('PR caro 21');
    expect(idx22).toBeLessThan(idx21);

    // Enlace de PR escapado y enlace a change
    expect(tableSection).toContain('<a href="https://github.com/org/repo/pull/22">https://github.com/org/repo/pull/22</a>');

    // Desglose (Inferencia · Cómputo · Plataforma)
    expect(tableSection).toContain('22.00 USD · 0.00 USD · 0.00 USD');
  });

  test('T113-H1: sin reserva a m.cost, total y Coste por día provienen de spending.daily', () => {
    const today = new Date().toISOString().slice(0, 10);
    // Intento con gasto desconocido en spending
    const itemA = seedItem({
      title: 'Change con gasto no medido en spending',
      date: `${today}T10:00:00.000Z`,
      attemptCosts: [0.50],
      inferenceAttempts: [{
        adapter: 'claude',
        remoteDeclared: true,
        usage: { effectiveModel: 'm-remoto', costUsd: 0.50 },
      }],
    });
    store.beginCostAttempt(itemA.activity, {
      id: 'att-remoto',
      rate: costRateAt(dir, `${today}T10:00:00.000Z`, 'torre'),
      remote: true,
      runner: 'torre',
      adapter: 'claude',
      legacyCount: 0,
    });
    store.finishCostAttempt('att-remoto', { costUsd: 0.50 }, 100);

    const url = new URL(`http://127.0.0.1:4310/metricas?tab=gasto&range=7`);
    const { body } = metricsPage(store, dir, url);

    // Sin reserva a m.cost: el total debe ser «No medido» y no caer a ninguna cifra parcial
    expect(body).toContain('Total: <strong>No medido</strong>');
    expect(body).not.toContain('Total: <strong>0.50 USD</strong>');

    // Coste por día debe marcar «No medido» en la fecha con intentos no medidos, no 0.50 USD
    expect(body).toContain(`<th scope="row">${today}</th><td>No medido</td>`);
    expect(body).not.toContain(`<th scope="row">${today}</th><td>0.50 USD</td>`);
  });

  test('T113-H2: nada no medido sale como 0.00 en desglose ni en ranking de PRs', () => {
    // Change histórico sin intentos de cómputo ni plataforma
    seedItem({
      title: 'Change histórico sin cómputo',
      attemptCosts: [0.30],
    });

    const url = new URL(`http://127.0.0.1:4310/metricas?tab=gasto&range=7`);
    const { body } = metricsPage(store, dir, url);

    // En la tabla de los 20 PR debe salir «No medido» para cómputo y plataforma, nunca 0.00 USD
    expect(body).toContain('0.30 USD · No medido · No medido');
    expect(body).not.toContain('0.30 USD · 0.00 USD · 0.00 USD');
    expect(body).not.toContain('· 0.00 USD ·');
  });

  test('T113-H3: la serie Otros en tarjeta por dimensión es null si algún grupo del resto es desconocido ese día', () => {
    const today = new Date().toISOString().slice(0, 10);
    const ws = store.getWorkstream('ws-test');
    const users = ['usr-1', 'usr-2', 'usr-3', 'usr-4', 'usr-5'];
    for (const [i, u] of users.entries()) {
      const s = store.addSignal(ws.id, `signal-${u}`, 'b', { source: 'cli', actorId: u });
      const c = store.triageSignal(s.id);
      const a = store.listActivities({ changeId: c.id })[0]!;
      const isUnknown = u === 'usr-5';
      const date = `${today}T11:00:00.000Z`;
      store.db.query("UPDATE changes SET created_at=?, status='completed' WHERE id=?").run(date, c.id);
      store.db.query("UPDATE activities SET created_at=?, started_at=?, completed_at=?, kind='investigation', status='completed' WHERE id=?").run(date, date, date, a.id);
      const runDir = join(dir, 'runs', c.id);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, `${a.id}.json`), JSON.stringify({
        attemptCosts: [5 - i],
        durationMs: 60000,
        isolation: { adapter: 'native' },
        inferenceAttempts: isUnknown ? undefined : [{
          adapter: 'native',
          usage: { effectiveModel: 'm1', costUsd: 5 - i },
        }],
      }));

      store.beginCostAttempt(a, {
        id: `att-${u}`,
        rate: costRateAt(dir, date, isUnknown ? 'torre' : null),
        remote: isUnknown,
        runner: isUnknown ? 'torre' : null,
        adapter: 'native',
        legacyCount: 0,
      });
      store.finishCostAttempt(`att-${u}`, { costUsd: 5 - i }, 100);
    }

    const url = new URL(`http://127.0.0.1:4310/metricas?tab=gasto&range=7`);
    const { body } = metricsPage(store, dir, url);

    // En la tarjeta de usuarios, usr-4 y usr-5 quedan en «Otros».
    // Como usr-5 no está medido, Otros para today no debe sumar parcialmente (p. ej. 2.00 USD), sino «No medido»
    const userCard = body.slice(body.indexOf('aria-labelledby="t-spending-user"'));
    const userCardSection = userCard.slice(0, userCard.indexOf('</section>'));

    expect(userCardSection).toContain('Otros');
    expect(userCardSection).toContain(`<th scope="row">${today}</th><td>5.00 USD</td><td>4.00 USD</td><td>3.00 USD</td><td>No medido</td>`);
    expect(userCardSection).not.toContain(`<th scope="row">${today}</th><td>5.00 USD</td><td>4.00 USD</td><td>3.00 USD</td><td>2.00 USD</td>`);
  });

  test('T113-H4: escenario x1-mezcla en la suite (mata M01 en changeCost y M02 en adapters/models)', () => {
    const today = new Date().toISOString().slice(0, 10);
    const date = `${today}T12:00:00.000Z`;

    // A: intento remoto actual con remoteDeclared
    const itemA = seedItem({
      title: 'remoto-declarado',
      date,
      attemptCosts: [0.50],
      inferenceAttempts: [{
        adapter: 'claude',
        remoteDeclared: true,
        usage: { effectiveModel: 'm-remoto', costUsd: 0.50 },
      }],
    });
    store.beginCostAttempt(itemA.activity, {
      id: 'r1',
      rate: costRateAt(dir, date, 'torre'),
      remote: true,
      runner: 'torre',
      adapter: 'claude',
      legacyCount: 0,
    });
    store.finishCostAttempt('r1', { costUsd: 0.50, effectiveModel: 'm-remoto' }, 100);

    // B: intento local medido
    const itemB = seedItem({
      title: 'local-medido',
      date,
      attemptCosts: [0.25],
      inferenceAttempts: [{
        adapter: 'claude',
        usage: { effectiveModel: 'm-local', costUsd: 0.25 },
      }],
    });
    store.beginCostAttempt(itemB.activity, {
      id: 'l1',
      rate: costRateAt(dir, date, null),
      remote: false,
      runner: null,
      adapter: 'claude',
      legacyCount: 0,
    });
    store.finishCostAttempt('l1', { costUsd: 0.25 }, 100);

    const m = calculateMetrics(store, dir, { ws: 'ws-test', from: today, to: today });
    // M01: guarda de changeCost — el intento remoto con remoteDeclared no debe sumarse como medido
    expect(m.cost.total).toBeNull();

    // M02: coste remoto no debe imputarse a m.cost.models ni a spending.models como medido
    const remoteModelCost = m.cost.models.find(g => g.name === 'm-remoto');
    expect(remoteModelCost?.measured).toBeNull();
    expect(remoteModelCost?.total).toBeNull();

    const remoteModelSpending = m.spending.models.find(g => g.name === 'm-remoto');
    expect(remoteModelSpending?.inference.measured).toBeNull();
    expect(remoteModelSpending?.inference.total).toBeNull();

    // Afirmaciones sobre el HTML de la pestaña Gasto
    const url = new URL(`http://127.0.0.1:4310/metricas?tab=gasto&range=custom&from=${today}&to=${today}&ws=ws-test`);
    const { body } = metricsPage(store, dir, url);

    expect(body).toContain('Total: <strong>No medido</strong>');
    expect(body).toContain('Subtotal medido: <strong>0.25 USD</strong>');
    expect(body).not.toContain('0.75 USD');
    expect(body).not.toContain('0,75 USD');
  });

  test('T113-H6: referencia de tarifa versión#hash12 visible en tabla plegada de Coste por día', () => {
    const today = new Date().toISOString().slice(0, 10);
    const date = `${today}T10:00:00.000Z`;
    const item1 = seedItem({
      title: 'Tarifa con hash',
      date,
      attemptCosts: [0.10],
      inferenceAttempts: [{
        adapter: 'native',
        usage: { effectiveModel: 'modelo-nuevo', costUsd: 0.10 },
      }],
    });
    store.beginCostAttempt(item1.activity, {
      id: 'att-h6-1',
      rate: { ...costRateAt(dir, date, null), version: 'v2#0123456789ab' },
      remote: false,
      runner: null,
      adapter: 'native',
      legacyCount: 0,
    });
    store.finishCostAttempt('att-h6-1', { costUsd: 0.10, effectiveModel: 'modelo-nuevo' }, 100);

    const item2 = seedItem({
      title: 'Tarifa sin hash',
      date,
      attemptCosts: [0.20],
      inferenceAttempts: [{
        adapter: 'native',
        usage: { effectiveModel: 'modelo-antiguo', costUsd: 0.20 },
      }],
    });
    store.beginCostAttempt(item2.activity, {
      id: 'att-h6-2',
      rate: { ...costRateAt(dir, date, null), version: 'v1' },
      remote: false,
      runner: null,
      adapter: 'native',
      legacyCount: 0,
    });
    store.finishCostAttempt('att-h6-2', { costUsd: 0.20, effectiveModel: 'modelo-antiguo' }, 100);

    const url = new URL(`http://127.0.0.1:4310/metricas?tab=gasto&range=7`);
    const { body } = metricsPage(store, dir, url);

    const costCard = body.slice(body.indexOf('aria-labelledby="t-cost"'));
    const costCardSection = costCard.slice(0, costCard.indexOf('</section>'));

    // Opción A mínima: una línea en la tabla plegada de Coste por día con las referencias distintas del rango
    expect(costCardSection).toContain('Tarifas aplicadas: v1, v2#0123456789ab');
  });

  test('T113-H8: textos coherentes con los datos: columna de intentos, singular en conteo y modelo No medido', () => {
    const today = new Date().toISOString().slice(0, 10);
    const date = `${today}T10:00:00.000Z`;
    // Intento único sin modelo efectivo (evidencia anterior a T108)
    const item = seedItem({
      title: 'Change anterior a T108 sin modelo efectivo',
      date,
      attemptCosts: [0.10],
      inferenceAttempts: [{
        adapter: 'native',
        usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.10 },
      }],
    });
    store.beginCostAttempt(item.activity, {
      id: 'att-h8',
      rate: costRateAt(dir, date, null),
      remote: false,
      runner: null,
      adapter: 'native',
      legacyCount: 0,
    });
    store.finishCostAttempt('att-h8', { costUsd: 0.10 }, 100);

    const url = new URL(`http://127.0.0.1:4310/metricas?tab=gasto&range=7`);
    const { body } = metricsPage(store, dir, url);

    // 1. Columnas de agrupaciones dicen «Intentos sin coste medido» (no Activities ni Changes)
    expect(body).toContain('<th scope="col">Intentos sin coste medido</th>');
    expect(body).not.toContain('<th scope="col">Activities sin coste medido</th>');
    expect(body).not.toContain('<th scope="col">Changes sin coste medido</th>');

    // 2. Con 0 o 1 intentos sin coste completo medido: singular «1 intento sin coste completo medido» o «0 intentos»
    // En este caso, el intento tiene coste completo medido, así que unknownCount es 0
    expect(body).toContain('0 intentos sin coste completo medido');
    expect(body).not.toContain('0 intentos sin coste medido');

    // 3. En la tabla de modelos, el modelo no efectivo anterior a T108 se llama «No medido», concordando con el pie
    const modelTable = body.slice(body.indexOf('<caption>Coste por modelo registrado</caption>'));
    const modelTableSection = modelTable.slice(0, modelTable.indexOf('</table>'));
    expect(modelTableSection).toContain('No medido');
    expect(modelTableSection).not.toContain('Sin dato');
  });
});
