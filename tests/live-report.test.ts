import { expect, test } from 'bun:test';
import type { CrashPoint } from '../src/admission/effects.ts';
import { applyReport, ReportStore } from '../src/admission/reports.ts';
import { claudeLive } from '../src/live/claude.ts';
import { claimed } from './helpers/live.ts';

const ask = { state: 'awaiting' as const, summary: 's', human_action: '¿qué color?' };

test('el report se guarda por intento sin cambiar el estado de la activity (el latido sigue válido)', () => {
  const { store, adm, claim } = claimed();
  const a = claim();
  new ReportStore(adm).recorder(a.id, 'att-1')(ask);
  expect(store.getActivity(a.id).status).toBe('in_progress');
  expect(store.getActivity(a.id).workerId).toBe('w1');
  store.heartbeat(a.id, 'w1'); // no lanza
  expect(new ReportStore(adm).pending(a.id)).toMatchObject({ state: 'awaiting', attemptId: 'att-1', human_action: '¿qué color?' });
});

test('un report awaiting sin human_action no se acepta ni se guarda', () => {
  const { adm, claim } = claimed();
  const a = claim();
  expect(() => new ReportStore(adm).recorder(a.id, 'att')({ state: 'awaiting', summary: 's' })).toThrow(/human_action/);
  expect(new ReportStore(adm).pending(a.id)).toBeUndefined();
});

test('gana el último report; aplicar awaiting es atómico: pregunta, activity en espera y efecto reply', () => {
  const { store, adm, effects, claim } = claimed();
  const a = claim(), rec = new ReportStore(adm).recorder(a.id, 'att-1');
  rec({ state: 'done', summary: 'x' }); rec(ask);
  expect(applyReport(store, adm, effects, { activityId: a.id, workerId: 'w1' })).toEqual({ state: 'awaiting', questionId: 'q-att-1' });
  const after = store.getActivity(a.id);
  expect([after.status, after.questionId, after.workerId, after.retryCount]).toEqual(['waiting_reply', 'q-att-1', null, 0]);
  expect(adm.db.query('SELECT status, text FROM adm_questions').all()).toEqual([{ status: 'open', text: '¿qué color?' }]);
  expect(adm.db.query('SELECT kind, key, status FROM adm_effects').all()).toEqual([{ kind: 'reply', key: 'reply:q-att-1', status: 'pending' }]);
  expect(applyReport(store, adm, effects, { activityId: a.id, workerId: 'w1' })).toEqual({ state: 'none' });
});

test('caída tras registrar el report: sigue pendiente y se aplica en la recuperación, una sola vez', () => {
  const crash = (p: CrashPoint) => { if (p === 'report-recorded') throw new Error('crash'); };
  const { store, adm, effects, claim } = claimed();
  const a = claim();
  expect(() => new ReportStore(adm).recorder(a.id, 'att-1', crash)(ask)).toThrow('crash');
  // el pool murió: el huérfano vence, vuelve a pending y otro worker lo reclama
  store.requeueOrphans('ws', new Date(Date.now() + 3_600_000).toISOString());
  expect(store.getActivity(a.id).status).toBe('pending');
  const again = claim('w2');
  expect(applyReport(store, adm, effects, { activityId: again.id, workerId: 'w2' })).toEqual({ state: 'awaiting', questionId: 'q-att-1' });
  expect(adm.db.query('SELECT COUNT(*) n FROM adm_effects').get()).toEqual({ n: 1 });
});

test('caída justo después de aplicar: reaplicar no duplica pregunta ni efecto', () => {
  const crash = (p: CrashPoint) => { if (p === 'report-applied') throw new Error('crash'); };
  const { store, adm, effects, claim } = claimed();
  const a = claim();
  new ReportStore(adm).recorder(a.id, 'att-1')(ask);
  expect(() => applyReport(store, adm, effects, { activityId: a.id, workerId: 'w1', crash })).toThrow('crash');
  expect(store.getActivity(a.id).status).toBe('waiting_reply'); // la transacción ya se había confirmado
  expect(applyReport(store, adm, effects, { activityId: a.id, workerId: 'w1' })).toEqual({ state: 'none' });
  expect(adm.db.query('SELECT COUNT(*) n FROM adm_questions').get()).toEqual({ n: 1 });
});

test('un worker que ya no tiene la activity no puede aplicar el report (fencing)', () => {
  const { store, adm, effects, claim } = claimed();
  const a = claim();
  new ReportStore(adm).recorder(a.id, 'att-1')(ask);
  expect(() => applyReport(store, adm, effects, { activityId: a.id, workerId: 'otro' })).toThrow(/not held/);
  expect(store.getActivity(a.id).status).toBe('in_progress');
  expect(adm.db.query('SELECT COUNT(*) n FROM adm_questions').get()).toEqual({ n: 0 });
});

test('done y blocked solo se marcan aplicados: la activity la cierra el pool', () => {
  const { store, adm, effects, claim } = claimed();
  const a = claim();
  new ReportStore(adm).recorder(a.id, 'att-1')({ state: 'blocked', summary: 'sin permisos' });
  expect(applyReport(store, adm, effects, { activityId: a.id, workerId: 'w1' })).toMatchObject({ state: 'blocked' });
  expect(store.getActivity(a.id).status).toBe('in_progress');
});

test('el backend claude persiste cada report vía turn.onReport antes de contestar al agente', async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'live-rep-'));
  writeFileSync(join(dir, 'claude'), `#!/bin/sh
for a in "$@"; do [ "$p" = 1 ] && cfgf=$a; p=0; [ "$a" = --mcp-config ] && p=1; done
cfg=$(cat "$cfgf")
url=$(printf '%s' "$cfg" | sed 's/.*"url":"\\([^"]*\\)".*/\\1/')
auth=$(printf '%s' "$cfg" | sed 's/.*"Authorization":"\\([^"]*\\)".*/\\1/')
curl -s -H "Authorization: $auth" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"report","arguments":{"state":"awaiting","summary":"s","human_action":"¿color?"}}}' "$url" >/dev/null
echo '{"type":"result","result":"ok","session_id":"x"}'`);
  chmodSync(join(dir, 'claude'), 0o755);
  const saved = process.env.PATH; process.env.PATH = `${dir}:${saved}`;
  try {
    const { adm, claim } = claimed(), a = claim();
    const r = await claudeLive.run({ prompt: 'x', cwd: dir, attemptId: 'att-9', onReport: new ReportStore(adm).recorder(a.id, 'att-9') });
    expect(r.reports.length).toBe(1);
    expect(new ReportStore(adm).pending(a.id)).toMatchObject({ attemptId: 'att-9', state: 'awaiting' });
  } finally { process.env.PATH = saved; }
});

test('T26: manda el report, gana el último válido y la línea STATUS no decide; sin report no hay resultado (falla como hoy)', async () => {
  const { liveOutcome } = await import('../src/admission/reports.ts');
  expect(liveOutcome([])).toBeUndefined();
  expect(liveOutcome([{ state: 'awaiting', summary: 's', human_action: '¿?' }])?.kind).toBe('awaiting'); // sin STATUS en el texto: no es `missing`
  expect(liveOutcome([{ state: 'blocked', summary: 'a' }, { state: 'done', summary: 'b' }])?.report.summary).toBe('b');
  expect(liveOutcome([{ state: 'done', summary: 'ok' }, { state: 'awaiting', summary: 'x' }])?.kind).toBe('done'); // el último no es válido
  expect(liveOutcome([{ state: 'nope' as never, summary: 'x' }])).toBeUndefined();
});
