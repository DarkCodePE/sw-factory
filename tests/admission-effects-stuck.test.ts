import { expect, test } from 'bun:test';
import { AdmissionDb } from '../src/admission/db.ts';
import { Effects, type CrashPoint, type EffectAlert, type EffectHandler } from '../src/admission/effects.ts';
import { Outbox } from '../src/admission/outbox.ts';
import { applyReport, ReportStore } from '../src/admission/reports.ts';
import { ThreadLinks } from '../src/admission/links.ts';
import { REPO } from './helpers/admission.ts';
import { claimed } from './helpers/live.ts';

const status = (adm: AdmissionDb) => (adm.db.query('SELECT status, last_error FROM adm_effects').get() as { status: string; last_error: string | null });
function setup(handlers: Record<string, EffectHandler>, opts: ConstructorParameters<typeof Effects>[2] = {}) {
  const { adm } = claimed();
  const alerts: EffectAlert[] = [];
  return { adm, alerts, effects: new Effects(adm, handlers, { baseMs: 1, onAlert: a => alerts.push(a), ...opts }) };
}

test('un efecto no reejecutable interrumpido avisa (unknown) y con reconcile sale: ya hecho → done', async () => {
  let verdict: 'done' | 'retry' = 'done', runs = 0;
  const { adm, alerts, effects } = setup({ x: { rerunnable: false, run: () => { runs++; }, reconcile: async () => verdict } }, { crash: p => { if (p === 'effect-claimed') throw new Error('crash'); } });
  adm.tx(() => effects.enqueue('x', 'k', { n: 1 }));
  await expect(effects.dispatch()).rejects.toThrow('crash');
  expect(effects.recover()).toBe(1);
  expect(status(adm).status).toBe('unknown');
  expect(alerts).toMatchObject([{ kind: 'x', key: 'k', status: 'unknown', payload: { n: 1 } }]);
  expect(await effects.reconcile()).toBe(1);
  expect(status(adm)).toEqual({ status: 'done', last_error: null });
  expect(runs).toBe(0); // no se reejecutó
});

test('reconcile → retry vuelve a pending y se reintenta; si consultar falla, sigue unknown con el motivo', async () => {
  let verdict: 'done' | 'retry' | 'fail' = 'fail', runs = 0;
  const { adm, effects } = setup({ x: { rerunnable: false, run: () => { runs++; }, reconcile: async () => { if (verdict === 'fail') throw new Error('gh caído'); return verdict; } } }, { crash: p => { if (p === 'effect-claimed') throw new Error('crash'); } });
  adm.tx(() => effects.enqueue('x', 'k', {}));
  await expect(effects.dispatch()).rejects.toThrow('crash'); effects.recover();
  expect(await effects.reconcile()).toBe(0);
  expect(status(adm)).toEqual({ status: 'unknown', last_error: 'reconciliación fallida: gh caído' });
  verdict = 'retry';
  expect(await effects.reconcile()).toBe(1);
  expect(status(adm).status).toBe('pending');
});

test('sin reconcile, un unknown sigue ahí (no se reejecuta a ciegas)', async () => {
  const { adm, effects } = setup({ x: { rerunnable: false, run: () => {} } }, { crash: p => { if (p === 'effect-claimed') throw new Error('crash'); } });
  adm.tx(() => effects.enqueue('x', 'k', {}));
  await expect(effects.dispatch()).rejects.toThrow('crash'); effects.recover();
  expect(await effects.reconcile()).toBe(0);
  expect(status(adm).status).toBe('unknown');
});

test('un efecto que agota los intentos queda dead y avisa; también el que no tiene handler', async () => {
  const { adm, alerts, effects } = setup({ x: { rerunnable: true, run: () => { throw new Error('falla'); } } }, { maxAttempts: 1 });
  adm.tx(() => { effects.enqueue('x', 'k1', {}); effects.enqueue('sin-handler', 'k2', {}); });
  await effects.dispatch();
  expect(alerts.map(a => [a.key, a.status])).toEqual([['k1', 'dead'], ['k2', 'dead']]);
});

test('caída entre publicar la pregunta y cerrar el efecto reply: reconcile encuentra el marcador y no publica dos veces', async () => {
  const t = claimed(), a = t.claim(), T1 = `github:${REPO}#7`, comments: { body: string; user: { login: string } }[] = [];
  const posts: string[] = [];
  const run = (async (cmd: string[]) => {
    if (cmd.includes('POST')) { posts.push('x'); comments.push({ body: cmd.find(c => c.startsWith('body='))!.slice(5), user: { login: 'fab-bot' } }); return { code: 0, stdout: '{}', stderr: '' }; }
    return { code: 0, stdout: JSON.stringify([comments]), stderr: '' };
  }) as any;
  t.adm.db.query('INSERT INTO adm_threads(id, source, first_seen) VALUES (?,?,?)').run(T1, `github:${REPO}`, 'x');
  new ThreadLinks(t.adm).link(T1, t.change.id);
  const alerts: EffectAlert[] = [];
  const crash = (p: CrashPoint) => { if (p === 'effect-ran') throw new Error('crash'); }; // tras publicar, antes de cerrar
  const effects = new Effects(t.adm, { reply: new Outbox(t.adm, { selfLogin: 'fab-bot', run }).handler() }, { baseMs: 1, crash, onAlert: x => alerts.push(x) });
  new ReportStore(t.adm).recorder(a.id, 'att-1')({ state: 'awaiting', summary: 's', human_action: '¿color?' });
  applyReport(t.store, t.adm, effects, { activityId: a.id, workerId: 'w1' });
  await expect(effects.dispatch()).rejects.toThrow('crash');
  expect(posts.length).toBe(1);
  effects.recover(); // reinicio del residente
  expect(status(t.adm).status).toBe('unknown');
  expect(alerts[0]).toMatchObject({ kind: 'reply', status: 'unknown' });
  await effects.reconcile();
  expect(status(t.adm).status).toBe('done');
  await effects.dispatch();
  expect(posts.length).toBe(1);
});

test('el residente convierte el aviso de una pregunta en un evento visible de la activity y en una línea de log', async () => {
  const { Resident } = await import('../src/admission/resident.ts');
  const { POLICY } = await import('./helpers/admission.ts');
  const t = claimed(), a = t.claim();
  new ReportStore(t.adm).recorder(a.id, 'att-1')({ state: 'awaiting', summary: 's', human_action: '¿?' });
  applyReport(t.store, t.adm, t.effects, { activityId: a.id, workerId: 'w1' });
  const resident = new Resident(t.store, { repo: REPO, policy: POLICY, mode: 'observe' });
  (resident as any).alert({ kind: 'reply', key: 'reply:q-att-1', status: 'dead', error: 'sin red', payload: { questionId: 'q-att-1' } });
  expect(resident.alerts).toEqual(['efecto reply dead: sin red']);
  expect(t.store.listEvents('ws').some(e => e.severity === 'error' && e.message === 'efecto reply dead: sin red' && e.activity_id === a.id)).toBe(true);
});
