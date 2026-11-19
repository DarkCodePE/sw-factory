import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { applyQuery, parseQuery } from '../src/web-changes.ts';
import { startWeb } from '../src/web.ts';

let dir: string; let store: Store; let ws: string; let ws2: string;
const ids: Record<string, string> = {};
const q = (s: string) => parseQuery(new URLSearchParams(s));
const titles = (s: string, rows = store.changeIndex()) => applyQuery(rows, q(s)).map(c => c.title);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-web-changes-'));
  store = new Store(join(dir, 'fabrica.db'));
  ws = store.createWorkstream({ slug: 'uno', goal: 'g', repo: '/r' }).id;
  ws2 = store.createWorkstream({ slug: 'dos', goal: 'g', repo: '/r' }).id;
  store.db.exec(`CREATE TABLE change_links (change_id TEXT PRIMARY KEY, source_system TEXT, source_key TEXT, source_url TEXT, pr_json TEXT);
    CREATE TABLE adm_thread_changes (thread_id TEXT PRIMARY KEY, change_id TEXT NOT NULL, linked_at TEXT NOT NULL);`);
  const mk = (name: string, w = ws) => { ids[name] = store.createChange(w, name, 'd').id; return ids[name]!; };
  mk('Beta'); mk('Alfa'); mk('Gamma'); mk('Delta'); mk('Sin fuente', ws2);
  // Fuentes: Beta=jira, Alfa=canal (admisión), Gamma=canal (github en change_links), Delta=cli (signal triada), Sin fuente=ninguna.
  store.db.query("INSERT INTO change_links(change_id,source_system,source_key,source_url) VALUES (?,?,?,?)").run(ids.Beta!, 'jira', 'K-1', 'u');
  store.db.query("INSERT INTO adm_thread_changes VALUES ('github:o/r#1',?,'2026-01-01')").run(ids.Alfa!);
  store.db.query("INSERT INTO change_links(change_id,source_system,source_key,source_url) VALUES (?,?,?,?)").run(ids.Gamma!, 'github', 'o/r#2', 'u');
  store.db.query("INSERT INTO signals(id,workstream_id,title,body,status,change_id,created_at) VALUES ('s1',?,'t','b','triaged',?,'2026-01-01')").run(ws, ids.Delta!);
  // Fechas y actores deterministas.
  const dates: Record<string, [string, string]> = { Beta: ['2026-01-03T10:00:00Z', '2026-02-01T10:00:00Z'], Alfa: ['2026-01-01T10:00:00Z', '2026-03-01T10:00:00Z'], Gamma: ['2026-01-02T10:00:00Z', '2026-01-15T10:00:00Z'], Delta: ['2026-01-04T10:00:00Z', '2026-04-01T10:00:00Z'], 'Sin fuente': ['2026-01-05T10:00:00Z', '2026-05-01T10:00:00Z'] };
  for (const [n, [c, u]] of Object.entries(dates)) store.db.query('UPDATE changes SET created_at=?, updated_at=? WHERE id=?').run(c, u, ids[n]!!);
  store.db.exec('DELETE FROM events');
  const ev = (n: string, actor: string | null) => store.db.query("INSERT INTO events(workstream_id,change_id,severity,message,created_at,actor) VALUES (?,?,?,?,?,?)").run(store.getChange(ids[n]!).workstreamId, ids[n]!, 'info', 'm', '2026-01-01', actor);
  ev('Beta', 'ana'); ev('Beta', 'luis'); ev('Alfa', 'ana'); ev('Gamma', 'luis'); ev('Delta', 'luis');
  store.db.query("UPDATE changes SET status='failed' WHERE id=?").run(ids.Gamma!);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test('fuente: cada valor devuelve el conjunto exacto y lo desconocido es «No medido»', () => {
  expect(titles('source=jira')).toEqual(['Beta']);
  expect(titles('source=channel').sort()).toEqual(['Alfa', 'Gamma']);
  expect(titles('source=cli')).toEqual(['Delta']);
  expect(titles('source=unknown')).toEqual(['Sin fuente']);
});

test('creador: primer evento; sin eventos es «No medido»', () => {
  expect(titles('actor=ana').sort()).toEqual(['Alfa', 'Beta']);
  expect(titles('actor=luis').sort()).toEqual(['Delta', 'Gamma']);
  expect(titles('actor=unknown')).toEqual(['Sin fuente']);
});

test('fecha de actualización: rango inclusivo y fechas inválidas ignoradas', () => {
  expect(titles('from=2026-03-01').sort()).toEqual(['Alfa', 'Delta', 'Sin fuente']);
  expect(titles('to=2026-02-01').sort()).toEqual(['Beta', 'Gamma']);
  expect(titles('from=2026-02-01&to=2026-03-01&sort=title')).toEqual(['Alfa', 'Beta']);
  expect(titles('from=basura').length).toBe(5);
});

test('estado, búsqueda y combinación', () => {
  expect(titles('status=failed')).toEqual(['Gamma']);
  expect(titles('q=ALF')).toEqual(['Alfa']);
  expect(titles('source=channel&status=failed')).toEqual(['Gamma']);
});

test('orden: actualizado (por defecto), creado y título', () => {
  expect(titles('')).toEqual(['Sin fuente', 'Delta', 'Alfa', 'Beta', 'Gamma']);
  expect(titles('sort=created')).toEqual(['Sin fuente', 'Delta', 'Beta', 'Gamma', 'Alfa']);
  expect(titles('sort=title')).toEqual(['Alfa', 'Beta', 'Delta', 'Gamma', 'Sin fuente']);
  expect(q('sort=nada').sort).toBe('updated');
});

test('changeIndex por workstream', () => {
  expect(store.changeIndex('dos').map(c => c.title)).toEqual(['Sin fuente']);
});

test('lectura: Store readonly sin tablas de fuente, sin crear ficheros', () => {
  const plain = mkdtempSync(join(tmpdir(), 'fab-web-changes-ro-'));
  try {
    const w = new Store(join(plain, 'fabrica.db')); const wid = w.createWorkstream({ slug: 'x', goal: 'g', repo: '/r' }).id; w.createChange(wid, 'C', 'd'); w.close();
    const before = readdirSync(plain).sort();
    const r = new Store(join(plain, 'fabrica.db'), { readonly: true });
    const rows = r.changeIndex(); r.close();
    expect(rows.length).toBe(1); expect(rows[0]!.source).toBeNull();
    expect(readdirSync(plain).sort()).toEqual(before);
  } finally { rmSync(plain, { recursive: true, force: true }); }
});

test('web: /changes muestra «No medido», escapa y mantiene los filtros rápidos', async () => {
  store.db.query("UPDATE changes SET title='<b>x</b>' WHERE id=?").run(ids['Sin fuente']!);
  const s = startWeb(dir, 0);
  try {
    const html = await (await fetch(`http://127.0.0.1:${s.port}/changes`)).text();
    expect(html).toContain('No medido'); expect(html).toContain('&lt;b&gt;x&lt;/b&gt;'); expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('class="quick"'); expect(html).toContain('status=failed');
    const only = await (await fetch(`http://127.0.0.1:${s.port}/changes?source=jira&sort=title`)).text();
    expect(only).toContain('Beta'); expect(only).not.toContain('Alfa');
  } finally { s.stop(true); }
});

test('bandeja: agrupa por día, busca y sirve el script de «visto»', async () => {
  const c = ids.Alfa!;
  const mk = (n: number, day: string) => store.db.query("INSERT INTO activities(id,workstream_id,change_id,kind,status,review_status,validator,created_at) VALUES (?,?,?,?,?,?,?,?)").run(`a${n}`, ws, c, 'validation', 'completed', 'awaiting', 'tests', `${day}T10:00:00Z`);
  mk(1, '2026-03-02'); mk(2, '2026-03-02'); mk(3, '2026-03-01');
  const s = startWeb(dir, 0);
  try {
    const html = await (await fetch(`http://127.0.0.1:${s.port}/`)).text();
    expect(html.match(/<h2><time>2026-03-0\d/g)).toEqual(['<h2><time>2026-03-02', '<h2><time>2026-03-01']);
    expect(html.indexOf('2026-03-02')).toBeLessThan(html.indexOf('2026-03-01'));
    expect(html).toContain('data-seen-id="a1"');
    expect(await (await fetch(`http://127.0.0.1:${s.port}/?q=zzz`)).text()).toContain('Nada coincide');
    const js = await fetch(`http://127.0.0.1:${s.port}/inbox.js`);
    expect(js.headers.get('content-type')).toContain('javascript'); expect(await js.text()).toContain('localStorage');
  } finally { s.stop(true); }
});

test('rendimiento: 1000 changes en menos de 300 ms', async () => {
  store.db.transaction(() => { for (let i = 0; i < 1000; i++) store.db.query("INSERT INTO changes(id,workstream_id,title,description,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(`p${i}`, ws, `Perf ${i}`, 'd', 'pending', '2026-01-01T00:00:00Z', `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`); })();
  const s = startWeb(dir, 0);
  try {
    await fetch(`http://127.0.0.1:${s.port}/changes`); // calienta
    const t = performance.now();
    const html = await (await fetch(`http://127.0.0.1:${s.port}/changes?sort=title`)).text();
    expect(performance.now() - t).toBeLessThan(300);
    expect(html).toContain('1005 changes');
  } finally { s.stop(true); }
});
