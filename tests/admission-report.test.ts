import { afterEach, expect, spyOn, test } from 'bun:test';
import { residentMain } from '../src/admission/cli.ts';
import { AdmissionDb, hasAdmission } from '../src/admission/db.ts';
import { buildReport, formatReport } from '../src/admission/report.ts';
import { Store, type ChangeStatus } from '../src/store.ts';
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

// Estas mediciones son una función de las tablas: no necesitan un canal GitHub.
const seeded = () => {
  const store = new Store(dbPath()); stores.add(store);
  const adm = new AdmissionDb(store), at = '2026-01-01T10:00:00Z';
  const trigger = (key: string, thread: string, event = {}) => {
    adm.db.query('INSERT OR IGNORE INTO adm_threads VALUES (?,?,?)').run(thread, 'github:test/repo', at);
    adm.db.query('INSERT INTO adm_triggers VALUES (?,?,?,?)').run(key, thread, JSON.stringify({
      url: `https://github.com/test/repo/issues/${key}`, author: 'ana', authorAssociation: 'MEMBER', state: 'open', labels: [], ...event,
    }), at);
  };
  const decision = (key: string, thread: string, reason: string, time = at, event = {}, label = 'fab', admit = false) => {
    trigger(key, thread, event);
    adm.db.query('INSERT INTO adm_decisions VALUES (?,?,?,?,?,?,?)')
      .run(key, Number(admit), 'explicit', admit ? 'change' : 'none', JSON.stringify([reason]), JSON.stringify({ triggerLabel: label }), time);
  };
  const comment = (key: string, thread: string, association = 'MEMBER', time = at, reason = 'no-open-question') => {
    trigger(key, thread, { authorAssociation: association });
    adm.db.query('INSERT INTO adm_comment_decisions VALUES (?,?,?,?,?)').run(key, 0, reason, null, time);
  };
  let workstream: string | undefined;
  const link = (thread: string, status: ChangeStatus = 'in_progress') => {
    workstream ??= store.createWorkstream({ slug: 'report', goal: 'medir', repo: '/tmp/report', agent: 'fake' }).id;
    adm.db.query('INSERT INTO changes(id, workstream_id, title, description, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(`change-${thread}`, workstream, thread, '', status, at, at);
    adm.db.query('INSERT INTO adm_thread_changes VALUES (?,?,?)').run(thread, `change-${thread}`, at);
  };
  return { store, adm, at, trigger, decision, comment, link };
};

test('un seguimiento de confianza sin pregunta abierta en un hilo admitido sale en followupsLost, con su URL', () => {
  const { adm, at, trigger, comment } = seeded();
  trigger('issue', 'linked');
  adm.db.query('INSERT INTO adm_thread_changes VALUES (?,?,?)').run('linked', 'change-1', at);
  comment('member', 'linked'); comment('outsider', 'linked', 'NONE'); comment('unadmitted', 'other');
  comment('answered', 'linked', 'MEMBER', at, 'before-question');
  trigger('signal', 'signaled');
  adm.db.query('INSERT INTO adm_thread_signals VALUES (?,?,?,?)').run('signaled', 'signal-1', 'change', at);
  comment('owner', 'signaled', 'OWNER');
  expect(buildReport(adm).followupsLost).toEqual(['member', 'owner'].map(trigger => ({
    trigger, url: `https://github.com/test/repo/issues/${trigger}`, author: 'ana', association: trigger === 'owner' ? 'OWNER' : 'MEMBER', decidedAt: at,
  })));
});

test('en observe cuenta como admitido el hilo con una decisión would_admit', () => {
  const { adm, at, decision, comment } = seeded();
  decision('admission', 'observe', 'trigger-label', at, {}, 'fab', true);
  comment('z', 'observe'); comment('a', 'observe'); comment('early', 'observe', 'COLLABORATOR', '2026-01-01T09:00:00Z');
  expect(buildReport(adm).followupsLost.map(f => f.trigger)).toEqual(['early', 'a', 'z']);
  expect(adm.db.query('SELECT * FROM adm_thread_changes').all()).toEqual([]);
  expect(adm.db.query('SELECT * FROM adm_thread_signals').all()).toEqual([]);
});

test('la etiqueta retirada o el cierre sobre un hilo ya admitido sale en stopsLost, una vez por hilo', () => {
  const { adm, at, decision, link } = seeded();
  decision('later', 'removed', 'thread-already-admitted', '2026-01-02T10:00:00Z');
  decision('first', 'removed', 'thread-already-admitted');
  decision('closed', 'closed', 'thread-already-admitted', at, { state: 'closed', labels: ['SPECIAL'] }, 'special');
  decision('open', 'open', 'thread-already-admitted', at, { labels: ['SPECIAL'] }, 'special');
  decision('other', 'other', 'issue-not-open', at, { state: 'closed' });
  link('closed'); link('removed'); link('open');
  expect(buildReport(adm).stopsLost).toEqual([
    { thread: 'closed', url: 'https://github.com/test/repo/issues/closed', state: 'closed', labelPresent: true, decidedAt: at, changeStatus: 'in_progress' },
    { thread: 'removed', url: 'https://github.com/test/repo/issues/first', state: 'open', labelPresent: false, decidedAt: at, changeStatus: 'in_progress' },
  ]);
});

test('un issue de confianza sin etiqueta sale en unlabeledTrusted, con admittedAt si se etiquetó después', () => {
  const { adm, at, decision } = seeded();
  decision('later', 'trusted', 'no-trigger-label', '2026-01-02T10:00:00Z');
  decision('first', 'trusted', 'no-trigger-label');
  decision('admit-later', 'trusted', 'trigger-label', '2026-01-04T10:00:00Z', {}, 'fab', true);
  decision('admit-first', 'trusted', 'trigger-label', '2026-01-03T10:00:00Z', {}, 'fab', true);
  decision('pending', 'pending', 'no-trigger-label');
  decision('outsider', 'outsider', 'no-trigger-label', at, { authorAssociation: 'NONE' });
  decision('closed', 'closed', 'no-trigger-label', at, { state: 'closed' });
  decision('other', 'other', 'repo-not-allowed');
  expect(buildReport(adm).unlabeledTrusted).toEqual([
    { thread: 'trusted', url: 'https://github.com/test/repo/issues/first', firstSeen: at, admittedAt: '2026-01-03T10:00:00Z' },
    { thread: 'pending', url: 'https://github.com/test/repo/issues/pending', firstSeen: at, admittedAt: null },
  ]);
});

test('formatReport no imprime el cuerpo del comentario', () => {
  const { adm, at, decision, comment, link } = seeded();
  const empty = formatReport(buildReport(adm));
  decision('admit', 'trusted', 'trigger-label', at, {}, 'fab', true);
  comment('comment', 'trusted');
  const body = '\x1b[2JNO IMPRIMIR TEXTO NO CONFIABLE';
  adm.db.query('INSERT INTO adm_comments VALUES (?,?,?)').run('comment', body, 'hash');
  decision('stop', 'trusted', 'thread-already-admitted');
  link('trusted');
  decision('unlabeled', 'pending', 'no-trigger-label');
  const output = formatReport(buildReport(adm));
  expect(output).toContain('https://github.com/test/repo/issues/comment');
  expect(output).toContain('https://github.com/test/repo/issues/stop');
  expect(output).toContain('https://github.com/test/repo/issues/unlabeled');
  expect(output).not.toContain(body);
  expect(JSON.stringify(buildReport(adm))).not.toContain('NO IMPRIMIR');
  expect(empty.match(/\(ninguno\)/g)).toHaveLength(4);
});


test('report sobre una base sin admisión no crea tablas adm_*', async () => {
  const out: string[] = [], log = spyOn(console, 'log').mockImplementation((s: string) => { out.push(s); });
  try {
    for (const args of [['report'], ['report', '--json']]) {
      const store = new Store(dbPath()); stores.add(store);
      expect(hasAdmission(store)).toBe(false);
      expect(await residentMain(args, store)).toBe(0);
      expect(hasAdmission(store)).toBe(false);
      expect(store.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'adm_*'").all()).toEqual([]);
    }
  } finally { log.mockRestore(); }
  expect(out).toEqual(['(el residente nunca se ha ejecutado en esta base)', '{}']);
});


test('stopsLost excluye changes terminados y exige un change vinculado existente', () => {
  const { adm, at, decision, link } = seeded();
  for (const status of ['completed', 'failed', 'canceled', 'declined', 'blocked', 'quarantined'] as const) {
    decision(status, status, 'thread-already-admitted', at, { state: 'closed' });
    link(status, status);
  }
  decision('unlinked', 'unlinked', 'thread-already-admitted');
  decision('signaled', 'signaled', 'thread-already-admitted', at, {}, 'fab', true);
  adm.db.query('INSERT INTO adm_thread_signals VALUES (?,?,?,?)').run('signaled', 'signal', 'change', at);
  decision('missing', 'missing', 'thread-already-admitted');
  adm.db.query('INSERT INTO adm_thread_changes VALUES (?,?,?)').run('missing', 'nonexistent', at);
  expect(buildReport(adm).stopsLost).toEqual([]);
});

test('stopsLost conserva la segunda fila si la primera no cumple', () => {
  const { adm, at, decision, link } = seeded();
  decision('innocent', 'thread', 'thread-already-admitted', at, { labels: ['FAB'] });
  decision('removed', 'thread', 'thread-already-admitted', '2026-01-02T10:00:00Z');
  link('thread', 'in_review');
  expect(buildReport(adm).stopsLost).toEqual([{
    thread: 'thread', url: 'https://github.com/test/repo/issues/removed', state: 'open', labelPresent: false,
    decidedAt: '2026-01-02T10:00:00Z', changeStatus: 'in_review',
  }]);
});

test('report reconoce tablas adm_* antiguas sin adm_thread_changes y conserva sus decisiones', async () => {
  for (const args of [['report'], ['report', '--json']]) {
    const { store, adm, decision } = seeded();
    decision('saved', 'thread', 'no-trigger-label');
    adm.db.exec('DROP TABLE adm_thread_changes');
    expect(hasAdmission(store)).toBe(false);
    const out: string[] = [], log = spyOn(console, 'log').mockImplementation((s: string) => { out.push(s); });
    try { expect(await residentMain(args, store)).toBe(0); } finally { log.mockRestore(); }
    if (args.includes('--json')) expect(JSON.parse(out[0]!).decisions).toEqual([{ wouldAdmit: false, reason: 'no-trigger-label', count: 1 }]);
    else expect(out[0]).toContain('no-trigger-label: 1');
  }
});

for (const missing of ['labels', 'triggerLabel'] as const) test(`stopsLost tolera la ausencia de ${missing}`, () => {
  const { adm, at, decision, link } = seeded();
  decision('stop', 'thread', 'thread-already-admitted', at, { labels: ['fab'] });
  link('thread');
  if (missing === 'labels') adm.db.query("UPDATE adm_triggers SET event = json_remove(event, '$.labels') WHERE key = 'stop'").run();
  else adm.db.query("UPDATE adm_decisions SET policy = '{}' WHERE trigger_key = 'stop'").run();
  expect(buildReport(adm).stopsLost).toMatchObject([{ thread: 'thread', labelPresent: false }]);
});

test('formatReport quita controles de cada línea sin permitir líneas falsas', () => {
  const { adm, at, decision, comment, link } = seeded();
  decision('admit', 'thread', 'trigger-label', at, {}, 'fab', true);
  comment('comment', 'thread');
  decision('stop', 'thread', 'thread-already-admitted'); link('thread');
  decision('unlabeled', 'pending', 'no-trigger-label');
  const report = buildReport(adm);
  const dirty = 'valor\x00\x1b[2J\nFALSA\r\t\x7f\x85';
  report.sources.push({ source: dirty, cursor: dirty, lastPoll: dirty, lastPollEvents: 1 });
  report.decisions[0]!.reason = dirty;
  report.labelNotVerified.push({ trigger: dirty, labelBy: dirty, role: dirty, decidedAt: dirty });
  report.effects.push({ key: dirty, status: dirty, attempts: 2, lastError: dirty });
  Object.assign(report.followupsLost[0]!, { url: dirty, author: dirty, trigger: dirty, association: dirty, decidedAt: dirty });
  Object.assign(report.stopsLost[0]!, { url: dirty, thread: dirty, decidedAt: dirty });
  Object.assign(report.unlabeledTrusted[0]!, { url: dirty, thread: dirty, firstSeen: dirty, admittedAt: dirty });
  const output = formatReport(report);
  expect(output).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  expect(output.split('\n')).toHaveLength(22); // 7 cabeceras, 6 separadores y 9 filas, sin saltos procedentes de datos
  expect(output).toContain('valor[2JFALSA');
  expect(output).not.toContain('\nFALSA');
});
