import { Database } from 'bun:sqlite';
import { createHmac } from 'node:crypto';
import { afterEach, expect, test } from 'bun:test';
import { residentMain } from '../src/admission/cli.ts';
import { AdmissionDb } from '../src/admission/db.ts';
import { startHook } from '../src/admission/hook.ts';
import { buildReport } from '../src/admission/report.ts';
import { Resident } from '../src/admission/resident.ts';
import { Store } from '../src/store.ts';
import { dbPath, issue, open, POLICY, REPO, snapshot } from './helpers/admission.ts';

const SECRET = 'canario-secreto-del-webhook-0123456789';
const sign = (body: string | Uint8Array, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const payload = (repo = REPO) => JSON.stringify({ action: 'labeled', repository: { full_name: repo } });

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(f => f()); });

function setup(over: { repo?: string } = {}) {
  const store = new Store(dbPath());
  const adm = new AdmissionDb(store);
  let t = Math.floor(Date.now() / 1000) * 1000; // el informe usa el reloj del Store: el aviso debe caer en las últimas 24 h
  const clock = { advance: (ms: number) => { t += ms; }, at: () => new Date(t).toISOString() };
  const woke = { n: 0 }, logs: string[] = [];
  const hook = startHook({ port: 0, secret: SECRET, repo: over.repo ?? REPO, adm, wake: () => { woke.n++; }, now: () => t, log: l => logs.push(l) });
  cleanup.push(() => { hook.stop(); store.close(); });
  const post = (o: { event?: string; id?: string; body?: string | Uint8Array; sig?: string | null; path?: string; method?: string } = {}) => {
    const body = o.body ?? payload();
    const headers: Record<string, string> = { 'x-github-event': o.event ?? 'issues', 'x-github-delivery': o.id ?? uuid(1) };
    if (o.sig !== null) headers['x-hub-signature-256'] = o.sig ?? sign(body);
    return fetch(`http://127.0.0.1:${hook.port}${o.path ?? '/github'}`, { method: o.method ?? 'POST', headers, body: o.method === 'GET' ? undefined : body as BodyInit });
  };
  const rows = () => adm.db.query('SELECT * FROM adm_hook_deliveries ORDER BY rowid').all() as { delivery_id: string; event: string; result: string; bytes: number }[];
  return { store, adm, hook, post, rows, woke, logs, clock };
}

test('B2: sin firma, sha1, hex de otra longitud, otro secreto o cuerpo alterado: 401, sin fila y sin despertar', async () => {
  const { post, rows, woke, adm } = setup();
  const body = payload(), hex = sign(body).slice(7);
  for (const sig of [null, `sha1=${hex.slice(0, 40)}`, `sha256=${hex}00`, sign(body, 'otro-secreto-largo-1'), sign(body + ' ')]) {
    const res = await post({ body, sig });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
  }
  expect(rows()).toEqual([]);
  expect(woke.n).toBe(0);
  expect(adm.getRejectedHooks().count).toBe(5);

  // 404, 405 y entregas firmadas no incrementan el contador de rechazos
  await post({ path: '/otra-ruta' });
  await post({ method: 'GET' });
  expect(adm.getRejectedHooks().count).toBe(5);
  await post(); // entrega válida 202
  expect(adm.getRejectedHooks().count).toBe(5);
});

test('petición sin firma con base bloqueada por otro escritor responde 401 de inmediato sin dar 500', async () => {
  const { post, store } = setup();
  // Simular lock de escritura exclusivo sostenido por otro proceso / conexión
  const blocker = new Database(store.dbPath);
  blocker.exec('PRAGMA busy_timeout = 0;');
  blocker.exec('BEGIN EXCLUSIVE');
  try {
    const t0 = Date.now();
    const res = await post({ sig: null });
    const duration = Date.now() - t0;

    expect(res.status).toBe(401);
    expect(duration).toBeLessThan(2000);
  } finally {
    try { blocker.exec('ROLLBACK'); } catch {}
    blocker.close();
  }
});

test('entrega válida: 202 sin cuerpo, una fila con solo metadatos y un despertar', async () => {
  const { post, rows, woke, logs } = setup();
  const res = await post({ id: uuid(7) });
  expect([res.status, await res.text()]).toEqual([202, '']);
  expect(rows()).toEqual([expect.objectContaining({ delivery_id: uuid(7), event: 'issues', result: 'woke', bytes: payload().length })]);
  expect(woke.n).toBe(1);
  expect(logs).toEqual([`aviso ${uuid(7)} issues woke`]);
});

test('B3: la misma entrega dos veces deja una fila y un despertar', async () => {
  const { post, rows, woke, clock } = setup();
  expect((await post()).status).toBe(202);
  clock.advance(60_000);
  expect((await post()).status).toBe(202);
  expect(rows().length).toBe(1);
  expect(woke.n).toBe(1);
});

test('B4: 100 entregas distintas con reloj fijo, un woke y 99 coalesced; pasados 5 s vuelve a despertar', async () => {
  const { post, rows, woke, clock } = setup();
  for (let i = 1; i <= 100; i++) expect((await post({ id: uuid(i) })).status).toBe(202);
  expect(rows().filter(r => r.result === 'woke').length).toBe(1);
  expect(rows().filter(r => r.result === 'coalesced').length).toBe(99);
  expect(woke.n).toBe(1);
  clock.advance(4_999); await post({ id: uuid(101) }); expect(woke.n).toBe(1);
  clock.advance(1); await post({ id: uuid(102) }); expect(woke.n).toBe(2);
});

test('B5: 65 KiB (firmados o no) dan 413 sin cuerpo, sin fila y sin despertar; 64 KiB exactos pasan el límite', async () => {
  const { post, rows, woke } = setup();
  const big = new Uint8Array(65 * 1024).fill(97);
  for (const sig of [sign(big), null]) { const res = await post({ body: big, sig }); expect([res.status, await res.text()]).toEqual([413, '']); }
  const chunked = await fetch(`http://127.0.0.1:${setup().hook.port}/github`, { method: 'POST', headers: { 'x-github-event': 'issues', 'x-github-delivery': uuid(1) },
    body: new ReadableStream({ start(c) { c.enqueue(big); c.close(); } }), duplex: 'half' } as RequestInit);
  expect(chunked.status).toBe(413);
  expect(rows()).toEqual([]);
  expect(woke.n).toBe(0);
  const edge = JSON.stringify({ repository: { full_name: REPO }, pad: 'x'.repeat(64 * 1024 - 53) });
  expect(edge.length).toBe(64 * 1024);
  expect((await post({ body: edge })).status).toBe(202);
});

test('B7: solo existe POST /github; el resto da 404 o 405 sin cuerpo; escucha en 127.0.0.1', async () => {
  const { post, hook, rows, woke } = setup();
  expect(hook.hostname).toBe('127.0.0.1');
  const cases: [string, string, number][] = [['/', 'GET', 404], ['/github', 'GET', 405], ['/otra', 'POST', 404], ['/github', 'PUT', 405], ['/github/', 'POST', 404], ['/', 'POST', 404]];
  for (const [path, method, status] of cases) {
    const res = await post({ path, method });
    expect([path, method, res.status, await res.text()]).toEqual([path, method, status, '']);
  }
  expect(rows()).toEqual([]);
  expect(woke.n).toBe(0);
});

test('B8: delivery o evento con secuencias de terminal dan 400 y no llegan al log; los inválidos no dejan fila', async () => {
  const { post, rows, woke, logs } = setup();
  for (const o of [{ event: 'issues\x1b[2J' }, { id: 'x\x1b]0;pwn\x07' }, { id: 'no-uuid' }, { event: 'Issues' }, { event: '' }, { event: 'a'.repeat(41) }])
    expect((await post(o)).status).toBe(400);
  await post({ id: uuid(2), event: 'issues', body: payload('owner/\x1b[31mrojo') });
  expect(rows().length).toBe(1);
  expect(woke.n).toBe(0);
  expect(logs.join('\n')).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
});

test('B9 y eventos: ping y otros eventos se ignoran; otro repo no despierta; mayúsculas no importan; JSON roto es otro repo', async () => {
  const { post, rows, woke } = setup();
  await post({ id: uuid(1), event: 'ping' });
  await post({ id: uuid(2), event: 'push' });
  await post({ id: uuid(3), body: payload('owner/otro') });
  await post({ id: uuid(4), body: 'no es json' });
  await post({ id: uuid(5), body: JSON.stringify({ repository: { full_name: 42 } }) });
  expect(rows().map(r => r.result)).toEqual(['ignored_event', 'ignored_event', 'ignored_repo', 'ignored_repo', 'ignored_repo']);
  expect(woke.n).toBe(0);
  await post({ id: uuid(6), event: 'issue_comment', body: payload(REPO.toUpperCase()) });
  expect(rows().at(-1)!.result).toBe('woke');
  expect(woke.n).toBe(1);
});

test('con 600 entregas válidas la tabla conserva las 500 más recientes', async () => {
  const { adm, rows, hook } = setup();
  // se inserta por HTTP para ejercer la poda real; el reloj no importa (coalesced también cuenta)
  for (let i = 1; i <= 600; i++) await fetch(`http://127.0.0.1:${hook.port}/github`, { method: 'POST',
    headers: { 'x-github-event': 'issues', 'x-github-delivery': uuid(i), 'x-hub-signature-256': sign(payload()) }, body: payload() });
  expect(rows().length).toBe(500);
  expect(rows()[0]!.delivery_id).toBe(uuid(101));
  expect(rows().at(-1)!.delivery_id).toBe(uuid(600));
  expect((adm.db.query('SELECT COUNT(*) n FROM adm_hook_deliveries').get() as { n: number }).n).toBe(500);
});

test('B6: el secreto no aparece en respuestas, tablas ni log; sin variable o con secreto corto el residente no arranca', async () => {
  const { post, adm, logs } = setup();
  const texts: string[] = [];
  for (const o of [{}, { sig: null }, { id: 'malo' }, { path: '/x' }]) { const r = await post(o); texts.push(r.status + [...r.headers].join() + await r.text()); }
  for (const t of ['adm_hook_deliveries', 'adm_triggers', 'adm_effects', 'adm_polls']) texts.push(JSON.stringify(adm.db.query(`SELECT * FROM ${t}`).all()));
  expect(texts.join('\n') + logs.join('\n')).not.toContain(SECRET);
  const err = (await import('bun:test')).spyOn(console, 'error').mockImplementation(() => {});
  try {
    const store = new Store(dbPath());
    cleanup.push(() => store.close());
    const prev = process.env.FAB_GITHUB_WEBHOOK_SECRET;
    for (const env of [undefined, 'corto']) {
      if (env === undefined) delete process.env.FAB_GITHUB_WEBHOOK_SECRET; else process.env.FAB_GITHUB_WEBHOOK_SECRET = env;
      expect(await residentMain(['--repo', REPO, '--once', '--hook-port', '0'], store, { run: undefined })).toBe(1);
    }
    if (prev === undefined) delete process.env.FAB_GITHUB_WEBHOOK_SECRET; else process.env.FAB_GITHUB_WEBHOOK_SECRET = prev;
    expect(err.mock.calls.flat().join('\n')).toContain('FAB_GITHUB_WEBHOOK_SECRET');
    expect(await residentMain(['--repo', REPO, '--once', '--hook-port', '70000'], store)).toBe(1);
    expect(await residentMain(['--repo', REPO, '--once', '--hook-port', ''], store)).toBe(1);
  } finally { err.mockRestore(); }
});

test('el secreto nunca va en argv: --hook-port es la única opción y no hay --hook-secret', async () => {
  const store = new Store(dbPath());
  cleanup.push(() => store.close());
  const err = (await import('bun:test')).spyOn(console, 'error').mockImplementation(() => {});
  try { expect(await residentMain(['--repo', REPO, '--once', '--hook-secret', SECRET], store)).toBe(1); } finally { err.mockRestore(); }
});

test('T69b: una entrega woke hace que el residente empiece otro ciclo sin esperar el intervalo; sin --hook-port no abre puerto', async () => {
  const { store, resident } = open(dbPath(), { hookPort: 0, hookSecret: SECRET, intervalMs: 3_600_000 }, [issue(1, '2026-01-01T10:00:00Z')]);
  cleanup.push(() => store.close());
  const lines: string[] = [];
  let second!: () => void; const secondCycle = new Promise<void>(r => { second = r; });
  let first!: () => void; const firstCycle = new Promise<void>(r => { first = r; });
  const done = resident.run({ log: l => { lines.push(l); if (l.startsWith('ciclo:')) { if (lines.filter(x => x.startsWith('ciclo:')).length === 1) first(); else second(); } } });
  await firstCycle;
  const port = resident.hookPort!;
  expect(port).toBeGreaterThan(0);
  const body = payload();
  const res = await fetch(`http://127.0.0.1:${port}/github`, { method: 'POST', headers: { 'x-github-event': 'issues', 'x-github-delivery': uuid(1), 'x-hub-signature-256': sign(body) }, body });
  expect(res.status).toBe(202);
  await secondCycle;
  resident.stop(); await done;
  expect(lines.filter(l => l.startsWith('ciclo:')).length).toBe(2);
  expect(resident.hookPort).toBeUndefined();
  await expect(fetch(`http://127.0.0.1:${port}/github`, { method: 'POST' })).rejects.toThrow(); // el receptor se cierra con el residente

  const plain = open(dbPath());
  cleanup.push(() => plain.store.close());
  await plain.resident.run({ once: true });
  expect(plain.resident.hookPort).toBeUndefined();
});

test('un aviso que llega durante un ciclo no se pierde: el siguiente ciclo no espera', async () => {
  const { store, resident } = open(dbPath(), { hookPort: 0, hookSecret: SECRET, intervalMs: 3_600_000 }, [issue(1, '2026-01-01T10:00:00Z')]);
  cleanup.push(() => store.close());
  let n = 0; let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  let second!: () => void; const secondCycle = new Promise<void>(r => { second = r; });
  const origCycle = resident.cycle.bind(resident);
  resident.cycle = async () => { n++; if (n === 1) await gate; if (n === 2) second(); return origCycle(); };
  const done = resident.run({});
  while (!resident.hookPort) await Promise.resolve();
  const body = payload();
  await fetch(`http://127.0.0.1:${resident.hookPort}/github`, { method: 'POST', headers: { 'x-github-event': 'issues', 'x-github-delivery': uuid(1), 'x-hub-signature-256': sign(body) }, body });
  release();
  await secondCycle;
  resident.stop(); await done;
  expect(n).toBe(2);
});

test('B1: una entrega firmada que dice "etiqueta fab" no admite nada: el residente relee por la API y no hay efectos de la entrega', async () => {
  const issues = [issue(1, '2026-01-01T10:00:00Z')]; // gh devuelve el issue SIN etiqueta
  const base = open(dbPath(), {}, issues);
  cleanup.push(() => base.store.close());
  await base.resident.run({ once: true });

  const hooked = open(dbPath(), { hookPort: 0, hookSecret: SECRET, intervalMs: 3_600_000 }, issues);
  cleanup.push(() => hooked.store.close());
  let n = 0; let second!: () => void; const secondCycle = new Promise<void>(r => { second = r; });
  const done = hooked.resident.run({ log: l => { if (l.startsWith('ciclo:') && ++n === 2) second(); } });
  while (!hooked.resident.hookPort) await Promise.resolve();
  const lie = JSON.stringify({ action: 'labeled', label: { name: 'fab' }, sender: { login: 'maint' }, issue: { number: 1, labels: [{ name: 'fab' }], state: 'open' }, repository: { full_name: REPO } });
  const res = await fetch(`http://127.0.0.1:${hooked.resident.hookPort}/github`, { method: 'POST', headers: { 'x-github-event': 'issues', 'x-github-delivery': uuid(9), 'x-hub-signature-256': sign(lie) }, body: lie });
  expect(res.status).toBe(202);
  await secondCycle;
  hooked.resident.stop(); await done;

  expect(snapshot(hooked.store)).toEqual(snapshot(base.store)); // triggers, decisiones y efectos son los del sondeo
  expect(hooked.store.db.query('SELECT would_admit, reasons FROM adm_decisions').all()).toEqual([{ would_admit: 0, reasons: expect.stringContaining('no-trigger-label') }]);
  for (const t of ['adm_thread_signals', 'adm_thread_changes', 'adm_content', 'signals', 'changes']) expect(hooked.store.db.query(`SELECT COUNT(*) n FROM ${t}`).get()).toEqual({ n: 0 });
  expect(JSON.stringify(snapshot(hooked.store))).not.toContain('maint');
});

test('fab resident report --json incluye el recuento de avisos por resultado y la fecha del último', async () => {
  const { store, post, adm, clock } = setup();
  await post({ id: uuid(1) }); await post({ id: uuid(2) }); await post({ id: uuid(3), event: 'ping' });
  const r = buildReport(adm);
  expect(r.hooks.last24h).toEqual([{ result: 'coalesced', count: 1 }, { result: 'ignored_event', count: 1 }, { result: 'woke', count: 1 }]);
  expect(r.hooks.last).toBe(clock.at());
  const log = (await import('bun:test')).spyOn(console, 'log').mockImplementation(() => {});
  try { expect(await residentMain(['report', '--json'], store)).toBe(0); expect(JSON.parse(log.mock.calls[0]![0]).hooks.last24h.length).toBe(3); } finally { log.mockRestore(); }
  adm.db.exec("UPDATE adm_hook_deliveries SET received_at = '2026-01-01T00:00:00.000Z'"); // más viejas de 24 h respecto del reloj real
  expect(buildReport(adm).hooks.last24h).toEqual([]);
});

test('el constructor rechaza hookPort sin secreto de al menos 16 caracteres', () => {
  const store = new Store(dbPath());
  cleanup.push(() => store.close());
  for (const hookSecret of [undefined, '', 'corto-15-chars!']) expect(() => new Resident(store, { repo: REPO, policy: POLICY, mode: 'observe', hookPort: 0, hookSecret })).toThrow(/FAB_GITHUB_WEBHOOK_SECRET/);
});

test('modo off con --hook-port no abre el receptor', async () => {
  const { store, resident } = open(dbPath(), { mode: 'off', hookPort: 0, hookSecret: SECRET });
  cleanup.push(() => store.close());
  await resident.run({});
  expect(resident.hookPort).toBeUndefined();
});
