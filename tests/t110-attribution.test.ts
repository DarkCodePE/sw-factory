import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { costRateAt } from '../src/attempt-cost.ts';
import { calculateMetrics } from '../src/metrics.ts';
import { Store } from '../src/store.ts';

test('T110: las cuatro dimensiones cuadran con el mismo conjunto y enlazan el PR publicado más tarde', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fab-attribution-'));
  let now = '2026-11-20T00:00:00.000Z';
  const store = new Store(join(dir, 'fab.db'), { clock: () => new Date(now) });
  try {
    const ws = store.createWorkstream({ slug: 'attrib', goal: 'g', repo: dir, requireChangeApproval: false });
    const s = store.addSignal(ws.id, 'fuente=api', 'usuario=intruso', { source: 'web', actorId: 'usuario-a' });
    const c = store.triageSignal(s.id);
    const none = store.triageSignal(store.addSignal(ws.id, 'sin PR', 'd', { source: 'cli', actorId: 'usuario-b' }).id);
    const old = store.createChange(ws.id, 'histórico', 'd');
    const oldActivity = store.listActivities({ changeId: old.id })[0]!;
    mkdirSync(join(dir, 'runs', old.id), { recursive: true });
    writeFileSync(join(dir, 'runs', old.id, `${oldActivity.id}.json`), JSON.stringify({ attemptCosts: [0.04] }));
    now = '2026-11-21T12:00:00.000Z';
    const push = (change: string, worker: 'investigate' | 'implement', costUsd?: number) => {
      const a = store.listActivities({ changeId: change })[0]!;
      const id = randomUUID();
      store.beginCostAttempt(a, { id, rate: costRateAt(dir, now, null), remote: false, runner: null, adapter: 'fake', legacyCount: 0, worker });
      store.finishCostAttempt(id, costUsd === undefined ? undefined : { costUsd }, 100);
    };
    push(c.id, 'investigate', 0.012);
    push(c.id, 'implement', 0.010);
    push(none.id, 'investigate', 0.003);
    push(none.id, 'implement');
    const pr = 'https://git.example.test/team/repo/pull/17';
    expect(store.listCostAttempts([c.id]).map(a => a.prUrl)).toEqual([null, null]);
    store.recordPrOpened(c.id, pr);
    expect(store.listCostAttempts([c.id]).map(a => [a.worker, a.originActorId, a.originSource, a.prUrl])).toEqual([
      ['investigate', 'usuario-a', 'web', pr],
      ['implement', 'usuario-a', 'web', pr],
    ]);
    const read = (from: string) => calculateMetrics(store, dir, { ws: ws.slug, from, to: '2026-11-21', now: Date.parse(now) }).spending;
    const spending = read('2026-11-21');
    expect(spending.total).toEqual({ measured: 25_000, unknown: 1, total: null });
    for (const groups of Object.values(spending.by)) {
      expect(groups.reduce((n, g) => n + (g.total.measured ?? 0), 0)).toBe(25_000);
      expect(groups.reduce((n, g) => n + g.total.unknown, 0)).toBe(1);
    }
    expect(spending.by.pr.map(g => g.name).sort()).toEqual(['Sin PR', pr]);
    const history = read('2026-11-20');
    for (const groups of Object.values(history.by)) {
      expect(groups.find(g => g.name === 'Sin dato')?.total.unknown).toBe(1);
    }
    expect(history.inference.measured).toBe(65_000);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('T110: origen desatendido, automatización normalizada y señales anteriores', () => {
  const store = new Store(':memory:');
  try {
    const ws = store.createWorkstream({ slug: 'sources', goal: 'g', repo: '/tmp', requireChangeApproval: false });
    store.setWorkstreamState(ws.id, 'active');
    const automation = store.createAutomation({ workstream: ws.id, name: 'diaria', cron: '0 0 * * *', title: 'a', body: 'b' });
    const automated = store.triageSignal(store.runAutomationNow(automation.id).signalId!);
    expect(store.getChangeOrigin(automated.id)).toEqual({ source: 'automation', actorId: null });
    for (const source of ['api', 'jira', 'resident'] as const) {
      const c = store.triageSignal(store.addSignal(ws.id, 'web', 'cli', { source }).id);
      expect(store.getChangeOrigin(c.id)).toEqual({ source, actorId: null });
    }
    const prior = store.triageSignal(store.addSignal(ws.id, 'fuente=web', 'usuario=a').id);
    expect(store.getChangeOrigin(prior.id)).toBeNull();
  } finally { store.close(); }
});
