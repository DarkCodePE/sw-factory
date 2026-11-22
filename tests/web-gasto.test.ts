// Tests de la pestaña Gasto de la plataforma web de fab (T113).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { costRateAt } from '../src/attempt-cost.ts';
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
    expect(body).not.toContain('<strong>0.00 USD</strong>');
    expect(body).not.toContain('<strong>0 USD</strong>');
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
    seedItem({
      title: 'Tarifa con hash',
      attemptCosts: [0.10],
      inferenceAttempts: [{
        adapter: 'native',
        usage: { effectiveModel: 'modelo-nuevo', inputTokens: 50, outputTokens: 10, costUsd: 0.10, priceVersion: '2026-11-21-v1#0123456789ab' },
      }],
    });

    seedItem({
      title: 'Tarifa sin hash',
      attemptCosts: [0.20],
      inferenceAttempts: [{
        adapter: 'native',
        usage: { effectiveModel: 'modelo-antiguo', inputTokens: 50, outputTokens: 10, costUsd: 0.20, priceVersion: '2026-11-21-v1' },
      }],
    });

    const url = new URL('http://127.0.0.1:4310/metricas?tab=gasto&range=7');
    const { body } = metricsPage(store, dir, url);
    expect(body).toContain('modelo-nuevo');
    expect(body).toContain('modelo-antiguo');
  });

  test('tabla de los 20 PR más caros muestra URL de PR escapada, enlace a change y desglose', () => {
    const { change } = seedItem({
      title: 'Change con PR caro',
      prUrl: 'https://github.com/org/repo/pull/42',
      attemptCosts: [1.25],
      inferenceAttempts: [{
        adapter: 'native',
        usage: { effectiveModel: 'm1', inputTokens: 100, outputTokens: 50, costUsd: 1.25, priceVersion: 'v1' },
      }],
    });

    const url = new URL('http://127.0.0.1:4310/metricas?tab=gasto&range=7');
    const { body } = metricsPage(store, dir, url);

    expect(body).toContain('<a href="https://github.com/org/repo/pull/42">https://github.com/org/repo/pull/42</a>');
    expect(body).toContain(`<a href="/changes/${encodeURIComponent(change.id)}">Change con PR caro</a>`);
    expect(body).toContain('1.25 USD');
  });
});
