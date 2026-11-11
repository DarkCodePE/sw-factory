import { afterEach, expect, spyOn, test } from 'bun:test';
import { residentMain } from '../src/admission/cli.ts';
import { AdmissionDb } from '../src/admission/db.ts';
import { buildReport, formatReport } from '../src/admission/report.ts';
import { Store } from '../src/store.ts';
import { dbPath, fakeGh, FIXTURE, issue, open, REPO } from './helpers/admission.ts';

const stores = new Set<{ close(): void }>();
afterEach(() => { stores.forEach(s => s.close()); stores.clear(); });
const observed = async (over = {}, issues = FIXTURE) => {
  const o = open(dbPath(), over, issues); stores.add(o.store);
  await o.resident.run({ once: true });
  return o;
};
const mallory = { login: 'mallory', role: 'read' }, nobody = { login: 'ext', role: 403 as const };
const labeled = [
  issue(1, '2026-01-01T10:00:00Z', { labels: ['fab'] }),
  issue(2, '2026-01-02T10:00:00Z', { labels: ['fab'], labeled_by: mallory }),
  issue(3, '2026-01-03T10:00:00Z', { labels: ['fab'], labeled_by: nobody }),
  issue(4, '2026-01-04T10:00:00Z'),
];

test('agrupa decisiones por would_admit y primera razón, con cursor y último poll', async () => {
  const { store } = await observed({}, labeled);
  const r = buildReport(new AdmissionDb(store));
  expect(r.decisions).toEqual([
    { wouldAdmit: true, reason: 'trigger-label', count: 1 },
    { wouldAdmit: false, reason: 'label-not-verified', count: 2 },
    { wouldAdmit: false, reason: 'no-trigger-label', count: 1 }]);
  expect(r.sources).toHaveLength(1);
  expect(r.sources[0]).toMatchObject({ source: `github:${REPO}`, cursor: '2026-01-04T10:00:00Z', lastPollEvents: 4 });
  expect(r.sources[0]!.lastPoll).toMatch(/^\d{4}-/);
});

test('lista label-not-verified con labeler y rol (403 → unknown)', async () => {
  const { store } = await observed({}, labeled);
  const r = buildReport(new AdmissionDb(store));
  expect(r.labelNotVerified.map(l => [l.trigger.split('#')[1]!.split('@')[0], l.labelBy, l.role])).toEqual([['2', 'mallory', 'read'], ['3', 'ext', 'unknown']]);
});

test('lista efectos dead y reintentados, no los hechos a la primera', async () => {
  const run = fakeGh(labeled);
  let second = 0; // #1 siempre falla; #2 falla solo la primera vez
  const flaky = (async (cmd: string[], cwd: string) => {
    if (cmd.some(c => c.includes('issues/1/events')) || (cmd.some(c => c.includes('issues/2/events')) && !second++)) return { code: 1, stdout: '', stderr: 'boom (HTTP 500)' };
    return run(cmd, cwd);
  }) as typeof run;
  const { store, resident } = open(dbPath(), { run: flaky, maxAttempts: 2 }, labeled); stores.add(store);
  await resident.run({ once: true });
  await Bun.sleep(30); resident.lock.acquire(); await resident.effects.dispatch(); resident.lock.release(); // vence la espera de #2 y agota #1
  const r = buildReport(new AdmissionDb(store));
  expect(r.effects.map(e => [e.key.split('#')[1]!.split('@')[0], e.status, e.attempts])).toEqual([['1', 'dead', 2], ['2', 'done', 2]]);
  expect(r.effects[0]!.lastError).toContain('HTTP 500');
});

test('--json es JSON válido con los mismos datos y el texto los muestra', async () => {
  const { store } = await observed({}, labeled);
  const out: string[] = [], log = spyOn(console, 'log').mockImplementation((s: string) => { out.push(s); });
  try {
    expect(await residentMain(['report', '--json'], store)).toBe(0);
    expect(await residentMain(['report'], store)).toBe(0);
  } finally { log.mockRestore(); }
  expect(JSON.parse(out[0]!)).toEqual(buildReport(new AdmissionDb(store)));
  expect(out[1]).toBe(formatReport(buildReport(new AdmissionDb(store))));
  expect(out[1]).toContain('label-by=ext  rol=unknown');
});

test('report funciona con un residente activo (no toma el lock)', async () => {
  const path = dbPath();
  const { store, resident } = open(path, {}, labeled); stores.add(store);
  resident.lock.acquire();
  const other = new Store(path); stores.add(other);
  const out: string[] = [], log = spyOn(console, 'log').mockImplementation((s: string) => { out.push(s); });
  try { expect(await residentMain(['report'], other)).toBe(0); } finally { log.mockRestore(); }
  expect(out[0]).toContain('== Fuentes ==');
  expect(other.db.query('SELECT COUNT(*) n FROM adm_lock').get()).toEqual({ n: 1 }); // sigue siendo del residente
  resident.lock.release();
});
