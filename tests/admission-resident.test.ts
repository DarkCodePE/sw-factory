import { afterEach, beforeAll, expect, test } from 'bun:test';
import { hostname } from 'node:os';
import type { CrashPoint } from '../src/admission/effects.ts';
import { residentMain } from '../src/admission/cli.ts';
import { Resident } from '../src/admission/resident.ts';
import { Store } from '../src/store.ts';
import { dbPath, fakeGh, FIXTURE, issue, open, POLICY, REPO, snapshot } from './helpers/admission.ts';

let deadPid = 0;
beforeAll(async () => { const child = Bun.spawn(['true']); await child.exited; deadPid = child.pid; });
const open_ = new Set<{ close(): void }>();
afterEach(() => { open_.forEach(s => s.close()); open_.clear(); });
const track = <T extends { store: { close(): void } }>(x: T): T => { open_.add(x.store); return x; };

test('--once de extremo a extremo: registra would_admit y no toca signals ni changes', async () => {
  const { store, resident } = track(open(dbPath()));
  const before = { signals: store.db.query('SELECT COUNT(*) n FROM signals').get(), changes: store.db.query('SELECT COUNT(*) n FROM changes').get(), acts: store.db.query('SELECT COUNT(*) n FROM activities').get() };
  await resident.run({ once: true });
  const snap = snapshot(store);
  expect(snap.triggers.length).toBe(4); // el PR (#5) no es un issue
  const decisions = snap.decisions.map((d: any) => [d.trigger_key.split('#')[1]!.split('@')[0], d.would_admit, d.strength, d.scope_max]);
  expect(decisions).toEqual([['1', 1, 'explicit', 'change'], ['2', 0, 'inferred', 'none'], ['3', 1, 'explicit', 'propose'], ['4', 0, 'inferred', 'none']]);
  expect(snap.effects.every((e: any) => e.status === 'done')).toBe(true);
  expect(snap.cursors).toEqual([{ source: `github:${REPO}`, value: '2026-01-04T10:00:00Z' }]);
  expect(store.db.query('SELECT COUNT(*) n FROM signals').get()).toEqual(before.signals);
  expect(store.db.query('SELECT COUNT(*) n FROM changes').get()).toEqual(before.changes);
  expect(store.db.query('SELECT COUNT(*) n FROM activities').get()).toEqual(before.acts);
  expect(store.db.query('SELECT COUNT(*) n FROM adm_lock').get()).toEqual({ n: 0 }); // lock liberado
});

test('el texto hostil del issue #2 no cambia su decisión (rechazado, scope none)', async () => {
  const { store, resident } = track(open(dbPath()));
  await resident.run({ once: true });
  expect(store.db.query("SELECT would_admit, scope_max FROM adm_decisions WHERE trigger_key LIKE '%#2@%'").get()).toEqual({ would_admit: 0, scope_max: 'none' });
  expect(JSON.stringify(snapshot(store))).not.toMatch(/IGNORA|OVERRIDE/); // el texto ni siquiera se guarda
});

test('repetir el poll no duplica nada, usa el cursor durable y el Thread agrupa los Triggers del issue', async () => {
  const issues = [...FIXTURE];
  const { store, run, resident } = track(open(dbPath(), {}, issues));
  await resident.run({ once: true });
  const once = snapshot(store);
  resident.lock.acquire(); await resident.cycle(); await resident.cycle();
  expect(snapshot(store)).toEqual(once);
  expect(run.calls.at(-1)).toContain('since=2026-01-04T10:00:00Z');
  // el issue 1 cambia (nueva etiqueta): nuevo Trigger, mismo Thread
  issues[0] = issue(1, '2026-01-06T10:00:00Z', { labels: ['fab', 'bug'] });
  await resident.cycle();
  const snap = snapshot(store);
  expect(snap.triggers.length).toBe(5);
  expect(snap.threads.length).toBe(4);
  expect(snap.triggers.filter((t: any) => t.thread_id === `github:${REPO}#1`).length).toBe(2);
});

test('el cursor no avanza si falla gh: el siguiente poll lo relee', async () => {
  const { store, resident } = track(open(dbPath(), { run: async () => ({ code: 1, stdout: '', stderr: 'boom' }) }));
  await expect(resident.run({ once: true })).rejects.toThrow(/gh api falló/);
  expect(snapshot(store).cursors).toEqual([]);
  expect(store.db.query('SELECT COUNT(*) n FROM adm_lock').get()).toEqual({ n: 0 });
});

const clean = async () => { const x = track(open(dbPath())); await x.resident.run({ once: true }); return snapshot(x.store); };

test.each(['after-read', 'after-register', 'effect-claimed', 'effect-ran'] as CrashPoint[])('matar en «%s» y reiniciar deja el mismo resultado final', async point => {
  const golden = await clean();
  const path = dbPath();
  let armed = true;
  const first = track(open(path, { crash: p => { if (armed && p === point) { armed = false; throw new Error(`kill en ${p}`); } } }));
  first.resident.lock.acquire();
  await expect(first.resident.cycle()).rejects.toThrow(`kill en ${point}`);
  // kill -9: el lock queda con el pid de un proceso muerto
  first.store.db.query('UPDATE adm_lock SET pid = ?, host = ?').run(deadPid, hostname());
  const second = track(open(path));
  await second.resident.run({ once: true });
  expect(snapshot(second.store)).toEqual(golden);
  // y un reinicio más no cambia nada
  const third = track(open(path)); await third.resident.run({ once: true });
  expect(snapshot(third.store)).toEqual(golden);
});

test('mismos fixtures, mismos registros en bases distintas (reproducible)', async () => {
  expect(await clean()).toEqual(await clean());
});

test('CLI: auto sin --workstream se rechaza, y una segunda instancia sobre la misma base se niega', async () => {
  const { store, resident } = track(open(dbPath()));
  const errors: string[] = []; const orig = console.error; console.error = (m: string) => { errors.push(String(m)); };
  try {
    expect(await residentMain(['--repo', REPO, '--mode', 'auto', '--once'], store, { run: fakeGh([]) })).toBe(1);
    expect(errors.at(-1)).toMatch(/--workstream/);
    resident.lock.acquire(); // primera instancia activa
    expect(await residentMain(['--repo', REPO, '--once'], store, { run: fakeGh([]) })).toBe(1);
    expect(errors.at(-1)).toMatch(/Ya hay un residente activo/);
    resident.lock.release();
    expect(await residentMain(['--repo', REPO, '--once', '--since', 'ayer'], store, { run: fakeGh(FIXTURE) })).toBe(1);
    expect(errors.at(-1)).toMatch(/--since debe ser ISO/);
    expect(await residentMain(['--repo', REPO, '--once', '--since', '2026-01-01T00:00:00Z'], store, { run: fakeGh(FIXTURE) })).toBe(0);
  } finally { console.error = orig; }
  expect(store.db.query('SELECT COUNT(*) n FROM adm_decisions').get()).toEqual({ n: 4 });
});

test('modo off no consulta nada', async () => {
  const { store, run, resident } = track(open(dbPath(), { mode: 'off' }));
  await resident.run({ once: true });
  expect(run.calls).toEqual([]);
  expect(snapshot(store).triggers).toEqual([]);
});

test('la etiqueta solo cuenta si la puso alguien con triage o más (D2)', async () => {
  const issues = [
    issue(10, '2026-01-01T10:00:00Z', { labels: ['fab'] }), // MAINTAINER (write): verificada
    issue(11, '2026-01-01T11:00:00Z', { labels: ['fab'], author_association: 'NONE', user: { login: 'eve' }, labeled_by: { login: 'eve', role: 'read' } }), // issue form
    issue(12, '2026-01-01T12:00:00Z', { labels: ['fab'], labeled_by: { login: 'github-actions[bot]', type: 'Bot' } }),
    issue(13, '2026-01-01T13:00:00Z', { labels: ['fab'], labeled_by: { login: 'carol', role: 403 } }), // token sin acceso push
    issue(14, '2026-01-01T14:00:00Z', { labels: ['bug'] }), // sin etiqueta: no se consulta nada
  ];
  const { store, run, resident } = track(open(dbPath(), {}, issues));
  await resident.run({ once: true });
  const rows = store.db.query('SELECT trigger_key, would_admit, reasons FROM adm_decisions ORDER BY trigger_key').all() as any[];
  expect(rows.map(r => [r.trigger_key.split('#')[1]!.split('@')[0], r.would_admit, JSON.parse(r.reasons)])).toEqual([
    ['10', 1, ['trigger-label', 'label-by:maint(write)', 'author-trusted']],
    ['11', 0, ['label-not-verified', 'label-by:eve(read)']],
    ['12', 0, ['label-not-verified', 'label-by:github-actions[bot](bot)']],
    ['13', 0, ['label-not-verified', 'label-by:carol(unknown)']],
    ['14', 0, ['no-trigger-label']],
  ]);
  expect(run.calls.some(c => c.some(a => a.includes('issues/14/events')))).toBe(false);
  expect(run.calls.some(c => c.some(a => a.includes('github-actions')))).toBe(false); // a un bot no se le piden permisos
});

test('sin cursor ni --since, la primera lectura pide solo el último día (D3)', async () => {
  const store = new Store(dbPath(), { clock: () => new Date('2026-03-10T12:00:00.500Z') });
  open_.add(store);
  const run = fakeGh([issue(1, '2026-01-01T10:00:00Z'), issue(2, '2026-03-10T08:00:00Z')]);
  const resident = new Resident(store, { repo: REPO, policy: POLICY, mode: 'observe', run });
  await resident.run({ once: true });
  expect(run.calls[0]).toContain('since=2026-03-09T12:00:00Z');
  expect(snapshot(store).triggers.map((t: any) => t.thread_id)).toEqual([`github:${REPO}#2`]);
});
