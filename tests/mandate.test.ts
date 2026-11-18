import { afterEach, expect, test } from 'bun:test';
import { AdmissionDb } from '../src/admission/db.ts';
import { buildReport } from '../src/admission/report.ts';
import { ThreadLinks } from '../src/admission/links.ts';
import { POLICY, REPO } from './helpers/admission.ts';
import { rig } from './helpers/auto.ts';

let t: ReturnType<typeof rig>;
afterEach(() => t?.close());
async function admitted() {
  t = rig();
  t.issues.push(t.issue(7, '2026-01-07T00:00:00Z', { labels: ['fab'] }));
  await t.cycle();
  return t.store.listChanges(t.ws.id)[0]!;
}
function update(labels: string[], state = 'open', day = '08') {
  Object.assign(t.issues[0]!, { labels, state, updated_at: `2026-01-${day}T00:00:00Z` });
}
const mandate = () => t.adm.db.query('SELECT trigger_key, revoked_at, revoked_reason FROM adm_thread_signals').get() as any;

test('D/E: solo retirar la etiqueta revoca; cerrar con etiqueta no revoca ni consulta rol', async () => {
  const c = await admitted();
  update(['FAB'], 'closed'); await t.cycle();
  expect(t.store.getChange(c.id).status).toBe(c.status);
  const calls = t.run.calls.length;
  update([], 'closed', '09'); await t.cycle();
  expect(t.store.getChange(c.id).status).toBe('canceled');
  expect(mandate().revoked_reason).toBe('trigger-label-removed');
  expect(mandate().trigger_key).toBe(`github:${REPO}#7@2026-01-07T00:00:00Z`);
  expect(t.run.calls.slice(calls).some(cmd => cmd.some(s => /permission|events/.test(s)))).toBe(false);
  expect(t.store.listActivities({ changeId: c.id }).every(a => a.status === 'canceled')).toBe(true);
});

test('G e idempotencia: repetir revocación o volver a etiquetar no readmite ni duplica el cierre', async () => {
  const c = await admitted();
  update([]); await t.cycle();
  const first = mandate();
  await t.cycle(); update([], 'open', '09'); await t.cycle();
  update(['fab'], 'open', '10'); await t.cycle();
  expect(mandate()).toEqual(first);
  expect(t.store.listChanges(t.ws.id)).toHaveLength(1);
  expect(t.store.listSignals(t.ws.id)).toHaveLength(1);
  expect(t.store.db.query("SELECT COUNT(*) n FROM events WHERE change_id=? AND message='change canceled'").get(c.id)).toEqual({ n: 1 });
  expect(JSON.stringify(buildReport(t.adm).decisions)).toContain('thread-revoked');
});

test('D: un change terminal no se cancela ni marca revocado al retirar la etiqueta', async () => {
  const c = await admitted();
  t.store.closeChange(c.id, 'canceled');
  update([]); await t.cycle();
  expect(mandate().revoked_at).toBeNull();
  expect(t.store.db.query("SELECT COUNT(*) n FROM events WHERE change_id=? AND message='change canceled'").get(c.id)).toEqual({ n: 1 });
});

test('observe registra would_revoke en stopsLost sin cambiar el change ni la autorización', async () => {
  const c = await admitted(); update([]);
  await t.cycle({ mode: 'observe' });
  expect(t.store.getChange(c.id).status).toBe(c.status);
  expect(mandate().revoked_at).toBeNull();
  const report = buildReport(t.adm);
  expect(report.decisions.some(d => d.reason === 'would_revoke')).toBe(true);
  expect(report.stopsLost).toHaveLength(1);
  expect(report.stopsLost[0]!.labelPresent).toBe(false);
});

test('la etiqueta de la admisión manda aunque cambie la política; un PR unido sin etiqueta no revoca', async () => {
  const c = await admitted();
  update(['fab']);
  await t.cycle({ policy: { ...POLICY, triggerLabel: 'otra' } });
  expect(t.store.getChange(c.id).status).toBe(c.status);
  t.adm.db.query('INSERT INTO adm_threads VALUES (?,?,?)').run(`github:${REPO}#8`, `github:${REPO}`, 'x');
  new ThreadLinks(t.adm).link(`github:${REPO}#8`, c.id);
  t.issues.push(t.issue(8, '2026-01-08T00:00:00Z'));
  await t.cycle();
  expect(t.store.getChange(c.id).status).toBe(c.status);
});

test('base anterior: ALTER idempotente y revocación de una admisión sin trigger_key guardado', async () => {
  const c = await admitted();
  for (const col of ['trigger_key', 'revoked_at', 'revoked_reason']) t.adm.db.exec(`ALTER TABLE adm_thread_signals DROP COLUMN ${col}`);
  new AdmissionDb(t.store); new AdmissionDb(t.store);
  update([]); await t.cycle();
  expect(t.store.getChange(c.id).status).toBe('canceled');
  expect(mandate().revoked_at).not.toBeNull();
});

test('H1/E1: un efecto atrasado sin etiqueta no revoca una admisión posterior', async () => {
  const c = await admitted(), r = t.resident();
  const thread = `github:${REPO}#7`, key = `${thread}@2026-01-06T00:00:00Z`;
  r.adm.tx(() => {
    r.adm.db.query('INSERT INTO adm_triggers(key, thread_id, event, observed_at) VALUES (?,?,?,?)').run(key, thread,
      JSON.stringify({ repo: REPO, number: 7, author: 'alice', state: 'open', labels: [], updatedAt: '2026-01-06T00:00:00Z' }), r.adm.iso());
    r.effects.enqueue('admit', `admit:${key}`, { triggerKey: key });
  });
  await t.cycle();
  expect(t.store.getChange(c.id).status).toBe('pending');
  expect(mandate().revoked_at).toBeNull();
  update([]); await t.cycle();
  expect(t.store.getChange(c.id).status).toBe('canceled');
});

for (const status of ['blocked', 'failed', 'quarantined'] as const) test(`H2: retirar la etiqueta cancela ${status} e impide retryChange`, async () => {
  const c = await admitted();
  const a = t.store.claimActivity(t.ws.id, 'worker')!;
  if (status === 'blocked') t.store.blockActivity(a.id, 'worker', 'bloqueado');
  else if (status === 'quarantined') t.store.quarantineActivity(a.id, 'worker', 'cuarentena');
  else {
    t.store.failActivity(a.id, 'worker', 'fallo');
    for (let i = 0; i < 2; i++) {
      const retry = t.store.claimActivity(t.ws.id, 'worker')!;
      t.store.failActivity(retry.id, 'worker', 'fallo');
    }
  }
  expect(t.store.getChange(c.id).status).toBe(status);
  update([]); await t.cycle();
  expect(t.store.getChange(c.id).status).toBe('canceled');
  expect(mandate().revoked_at).not.toBeNull();
  expect(() => t.store.retryChange(c.id)).toThrow();
  expect(t.store.getChange(c.id).status).toBe('canceled');
});

test('H4: sin trigger_key usa la última admisión anterior a created_at, no observe antiguo ni una decisión futura', async () => {
  const c = await admitted(), db = t.adm.db, thread = `github:${REPO}#7`;
  db.query('UPDATE adm_thread_signals SET trigger_key=NULL, created_at=?').run('2026-01-10T12:00:00Z');
  db.query('UPDATE adm_decisions SET decided_at=?').run('2026-01-10T00:00:00Z');
  for (const [day, label] of [['09', 'antigua'], ['11', 'futura']]) {
    const key = `${thread}@2026-01-${day}T00:00:00Z`;
    db.query('INSERT INTO adm_triggers(key, thread_id, event, observed_at) VALUES (?,?,?,?)').run(key, thread, '{}', 'x');
    db.query('INSERT INTO adm_decisions VALUES (?,?,?,?,?,?,?)').run(key, 1, 'explicit', 'change', '["trigger-label"]',
      JSON.stringify({ ...POLICY, triggerLabel: label }), `2026-01-${day}T00:00:00Z`);
  }
  update(['fab'], 'open', '12'); await t.cycle();
  expect(t.store.getChange(c.id).status).toBe('pending');
  expect(mandate().revoked_at).toBeNull();
  update([], 'open', '13'); await t.cycle();
  expect(t.store.getChange(c.id).status).toBe('canceled');
  expect(mandate().trigger_key).toBe(`${thread}@2026-01-07T00:00:00Z`);
});
