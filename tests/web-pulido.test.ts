// T92–T97: pulido de la web (tema, barra lateral, bandeja, enlaces, filtros de changes).
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { applyQuery, INBOX_JS, linksBlock, parseQuery, roleField, roleLink, safeUrl } from '../src/web-changes.ts';
import { THEME_JS } from '../src/web-theme.ts';
import { SIDEBAR_JS, sidebarNav } from '../src/web-sidebar.ts';
import { DARK, WEB_STYLE } from '../src/web-style.ts';
import { startWeb } from '../src/web.ts';

let dir: string; let store: Store; let ws: string; let server: ReturnType<typeof startWeb> | undefined;
const q = (s: string) => parseQuery(new URLSearchParams(s));
const get = async (path: string) => (await fetch(`http://127.0.0.1:${server!.port}${path}`)).text();
const ui = { escape: (v: unknown) => String(v).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`), badge: (s: string) => s, labels: {} };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-web-pulido-'));
  store = new Store(join(dir, 'fabrica.db'));
  ws = store.createWorkstream({ slug: 'uno', goal: 'g', repo: '/r' }).id;
});
afterEach(() => { server?.stop(true); server = undefined; store.close(); rmSync(dir, { recursive: true, force: true }); });

// ---- T92 ---------------------------------------------------------------------------------------------------------
const lum = (hex: string) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x! + 0.05) / (y! + 0.05); };
const vars = (css: string) => Object.fromEntries([...css.matchAll(/--([\w-]+):(#[0-9a-f]{6})/g)].map(m => [m[1]!, m[2]!]));

test('T92: los contrastes de texto pasan 4.5:1 en el tema claro y en el oscuro', () => {
  const light = vars(WEB_STYLE.split('\n').find(l => l.startsWith(':root{'))!);
  for (const [name, v] of [['claro', light], ['oscuro', vars(DARK)]] as const) {
    for (const fg of ['text', 'muted', 'accent', 'good', 'bad', 'warn', 'focus']) for (const bg of ['bg', 'panel']) {
      if (fg === 'focus' && bg === 'panel') continue;
      expect(contrast(v[fg]!, v[bg]!), `${name}: ${fg} sobre ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test('T92: el atributo data-theme manda sobre el sistema y la hoja lo trae dos veces', () => {
  expect(WEB_STYLE).toContain(':root:not([data-theme=light])');
  expect(WEB_STYLE).toContain(':root[data-theme=dark]');
  expect(WEB_STYLE).toContain(':root[data-theme=light]');
});

test('T92: sin script en línea; theme.js sale del mismo origen y el control está oculto hasta que el script lo muestra', async () => {
  server = startWeb(dir, 0);
  const html = await get('/');
  expect(html).toContain('<script src="/theme.js"></script>');
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
  expect(html).toContain('class="theme" role="group" aria-label="Tema" hidden');
  expect(html).toContain('data-theme-set="dark"');
  expect(await get('/theme.js')).toBe(THEME_JS);
  expect(await get('/metricas')).toContain('/theme.js'); // también en las páginas sin sondeo
});

function runTheme(storage: Record<string, unknown>) {
  const attrs = new Map<string, string>(); const listeners: Record<string, (e: unknown) => void> = {};
  const root = { setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k), getAttribute: (k: string) => attrs.get(k) ?? null };
  const doc = { documentElement: root, addEventListener: (t: string, f: (e: unknown) => void) => { listeners[t] = f; }, querySelectorAll: () => [] };
  new Function('document', 'localStorage', THEME_JS)(doc, storage);
  return { attrs, click: (v: string) => listeners.click!({ target: { closest: () => ({ dataset: { themeSet: v } }) } }) };
}
test('T92: sin localStorage la página sigue el sistema; elegir oscuro fija el atributo y sobrevive a la recarga', () => {
  const broken = { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); } };
  const a = runTheme(broken); expect(a.attrs.has('data-theme')).toBe(false);
  expect(() => a.click('dark')).not.toThrow(); expect(a.attrs.get('data-theme')).toBe('dark');
  const data = new Map<string, string>(); const ok = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
  runTheme(ok).click('dark');
  expect(runTheme(ok).attrs.get('data-theme')).toBe('dark'); // «recarga»
  runTheme(ok).click('system'); expect(runTheme(ok).attrs.has('data-theme')).toBe(false);
  data.set('fab.theme', '<script>'); expect(runTheme(ok).attrs.has('data-theme')).toBe(false); // valor ajeno: se ignora
});

// ---- T93 ---------------------------------------------------------------------------------------------------------
test('T93: los archivados van al final, tras un separador, y sin archivados no hay separador', () => {
  const mk = (slug: string) => store.createWorkstream({ slug, goal: 'g', repo: '/r' });
  const old = mk('viejo'); mk('nuevo');
  store.db.query("UPDATE workstreams SET state='archived' WHERE id=?").run(old.id);
  const html = sidebarNav(store.listWorkstreams(), ui.escape);
  const order = [...html.matchAll(/data-ws="([^"]+)"/g)].map(m => m[1]);
  expect(order).toEqual(['uno', 'nuevo', 'viejo']);
  expect(html.indexOf('data-sep')).toBeLessThan(html.indexOf('data-ws="viejo"'));
  expect(html.indexOf('data-sep')).toBeGreaterThan(html.indexOf('data-ws="nuevo"'));
  expect(sidebarNav(store.listWorkstreams().filter(w => w.state !== 'archived'), ui.escape)).not.toContain('data-sep');
});

test('T93: el slug se escapa y los controles están ocultos sin script', () => {
  const html = sidebarNav([{ slug: 'a"><b>', state: 'active' } as never], ui.escape);
  expect(html).not.toContain('<b>'); expect(html).toContain('data-ws-search aria-label="Buscar workstream" placeholder="Buscar" hidden'); expect(html).toContain('data-ws-pin aria-pressed="false"');
});

test('T93: con 30 workstreams el script filtra y fija en el cliente (no pide nada al servidor)', () => {
  const items = Array.from({ length: 30 }, (_, i) => { const slug = `ws${i}`; const el = { dataset: { ws: slug, i: String(i) }, hidden: false, has: new Set<string>(), hasAttribute(a: string) { return this.has.has(a); }, appendChild() {}, querySelector: () => ({ hidden: true, setAttribute() {}, textContent: '' }) }; return el; });
  const ul = { children: items as unknown[], appendChild(x: unknown) { this.children = this.children.filter(c => c !== x).concat(x); }, querySelector: () => null };
  const search = { value: '', hidden: true, addEventListener(_: string, f: () => void) { (search as unknown as { f: () => void }).f = f; } };
  const nav = { querySelector: (s: string) => s === 'ul' ? ul : s === '[data-ws-search]' ? search : null, addEventListener() {} };
  const fetchCalls: unknown[] = [];
  new Function('document', 'localStorage', 'fetch', SIDEBAR_JS)({ querySelector: () => nav }, { getItem: () => '["ws7"]', setItem() {} }, (...a: unknown[]) => fetchCalls.push(a));
  expect((ul.children[0] as typeof items[0]).dataset.ws).toBe('ws7'); // fijado arriba
  search.value = 'ws2'; (search as unknown as { f: () => void }).f();
  expect(items.filter(i => !i.hidden).map(i => i.dataset.ws).sort()).toEqual(['ws2', 'ws20', 'ws21', 'ws22', 'ws23', 'ws24', 'ws25', 'ws26', 'ws27', 'ws28', 'ws29']);
  expect(fetchCalls).toHaveLength(0);
  // sin localStorage la lista sale en el orden de creación
  items.sort((a, b) => Number(a.dataset.i) - Number(b.dataset.i)); ul.children = items;
  expect(() => new Function('document', 'localStorage', SIDEBAR_JS)({ querySelector: () => nav }, { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } })).not.toThrow();
  expect((ul.children[0] as typeof items[0]).dataset.ws).toBe('ws0');
});

// ---- T94 ---------------------------------------------------------------------------------------------------------
function blocked(n: number) {
  for (let i = 0; i < n; i++) {
    const c = store.createChange(ws, `C${i}`, 'd'); const a = store.listActivities({ changeId: c.id })[0]!;
    store.db.query("UPDATE activities SET review_status='awaiting' WHERE id=?").run(a.id);
  }
}
test('T94: el contador del menú coincide con la bandeja y está en la lista', async () => {
  blocked(3); server = startWeb(dir, 0);
  const html = await get('/');
  expect(html).toContain('<strong class="count" aria-label="3 en la bandeja">3</strong>');
  expect(html.match(/data-seen-id=/g)).toHaveLength(3);
  expect(html.match(/data-sel="/g)).toHaveLength(3);
  expect(html).toContain('data-sel-all'); expect(html).toContain('data-seen-sel="1"'); expect(html).toContain('data-seen-sel="0"');
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
});
test('T94: sin nada en la bandeja no hay contador', async () => { server = startWeb(dir, 0); expect(await get('/')).not.toContain('class="count"'); });

test('T94: copiar id (sin script en línea) y el enlace de la activity a su rol en Perfiles', async () => {
  const c = store.createChange(ws, 'X', 'd'); const a = store.listActivities({ changeId: c.id })[0]!;
  store.db.query("UPDATE activities SET kind='implementation' WHERE id=?").run(a.id);
  server = startWeb(dir, 0);
  const change = await get(`/changes/${c.id}`);
  expect(change).toContain(`data-copy="${c.id}"`); expect(change).toContain('href="/perfiles?ws=uno#f-worker.implement"');
  const act = await get(`/activities/${a.id}`);
  expect(act).toContain(`data-copy="${a.id}"`); expect(act).toContain('Ver el rol en Perfiles');
  expect(await get('/inbox.js')).toContain('navigator.clipboard.writeText');
});
test('T94: roleField cubre validadores y tipos; revisión de change y gates no tienen rol', () => {
  expect(roleField({ kind: 'implementation', validator: 'qa' })).toBe('validators.qa');
  expect(roleField({ kind: 'investigation', validator: null })).toBe('worker.investigate');
  expect(roleField({ kind: 'change_review', validator: null })).toBeNull();
});

// ---- T95 ---------------------------------------------------------------------------------------------------------
test('T95: solo https a hosts conocidos se vuelve enlace', () => {
  expect(safeUrl('https://github.com/o/r/pull/3', {})).toBe('https://github.com/o/r/pull/3');
  expect(safeUrl('https://acme.atlassian.net/browse/K-1', {})).not.toBeNull();
  expect(safeUrl('https://jira.interna.example/browse/K-1', { JIRA_HOSTNAME: 'jira.interna.example' })).not.toBeNull();
  for (const bad of ['javascript:alert(1)', 'http://github.com/o/r', 'https://evil.example/o', 'https://github.com.evil.example/', 'https://u:p@github.com/o', 'data:text/html,x', 'no es url', 'https://atlassian.net.evil.example/'])
    expect(safeUrl(bad, {}), bad).toBeNull();
});
test('T95: el bloque escapa el texto, no enlaza lo inseguro y no aparece sin datos', () => {
  expect(linksBlock(ui, {})).toBe('');
  const html = linksBlock(ui, { source: { system: 'jira', key: '<b>K-1</b>', url: 'javascript:alert(1)' }, pr: { repo: 'o/r', number: 3, url: 'https://github.com/o/r/pull/3' } });
  expect(html).not.toContain('<b>'); expect(html).not.toContain('javascript:'); expect(html.match(/<a /g)).toHaveLength(1); // solo el del PR
  expect(html).toContain('<a href="https://github.com/o/r/pull/3" rel="noopener noreferrer">o/r#3</a>');
});
test('T95: el detalle del change muestra PR e issue desde change_links y un change sin PR no muestra el bloque', async () => {
  store.db.exec('CREATE TABLE change_links (change_id TEXT PRIMARY KEY, source_system TEXT, source_key TEXT, source_url TEXT, pr_json TEXT)');
  const c = store.createChange(ws, 'Con PR', 'd'); const d = store.createChange(ws, 'Sin PR', 'd'); const e = store.createChange(ws, 'Roto', 'd');
  store.db.query('INSERT INTO change_links VALUES (?,?,?,?,?)').run(c.id, 'github', 'o/r#9', 'https://github.com/o/r/issues/9', JSON.stringify({ repo: 'o/r', number: 4, url: 'https://github.com/o/r/pull/4', branch: 'b', base: 'main' }));
  store.db.query('INSERT INTO change_links VALUES (?,?,?,?,?)').run(e.id, null, null, null, '{no json');
  server = startWeb(dir, 0);
  const html = await get(`/changes/${c.id}`);
  expect(html).toContain('href="https://github.com/o/r/pull/4"'); expect(html).toContain('href="https://github.com/o/r/issues/9"');
  expect(await get(`/changes/${d.id}`)).not.toContain('class="links"');
  const broken = await get(`/changes/${e.id}`); // pr_json corrupto: sin bloque y sin 500
  expect(broken).toContain('Roto'); expect(broken).not.toContain('class="links"');
});

// ---- T97 ---------------------------------------------------------------------------------------------------------
function seed() {
  store.db.exec(`CREATE TABLE change_links (change_id TEXT PRIMARY KEY, source_system TEXT, source_key TEXT, source_url TEXT, pr_json TEXT)`);
  const mk = (t: string, created: string) => { const c = store.createChange(ws, t, 'd'); store.db.query('UPDATE changes SET created_at=?, updated_at=? WHERE id=?').run(created, created, c.id); return c.id; };
  const auto = mk('Auto', '2026-03-01T10:00:00Z'), cli = mk('Cli', '2026-02-01T10:00:00Z'), plain = mk('Sin datos', '2026-01-01T10:00:00Z');
  store.db.query("INSERT INTO signals(id,workstream_id,title,body,status,change_id,created_at,source) VALUES ('s1',?,'t','b','triaged',?,'2026-01-01','automation:abc')").run(ws, auto);
  store.db.query("INSERT INTO signals(id,workstream_id,title,body,status,change_id,created_at,source) VALUES ('s2',?,'t','b','triaged',?,'2026-01-01',NULL)").run(ws, cli);
  const acts = (id: string) => store.listActivities({ changeId: id });
  store.db.query("UPDATE activities SET agent='claude', kind='investigation' WHERE id=?").run(acts(auto)[0]!.id);
  store.db.query("UPDATE activities SET agent='codex', kind='implementation' WHERE id=?").run(acts(cli)[0]!.id);
  store.db.query("INSERT INTO activities(id,workstream_id,change_id,kind,status,validator,created_at,agent) VALUES ('v1',?,?,'implementation','pending','qa','2026-03-02','claude')").run(ws, auto);
  return { auto, cli, plain };
}
const titles = (s: string) => applyQuery(store.changeIndex(), q(s)).map(c => c.title);

test('T97: source=automation, adaptador, rol y fechas de creación dan el conjunto exacto', () => {
  seed();
  expect(titles('source=automation')).toEqual(['Auto']);
  expect(titles('source=cli')).toEqual(['Cli']);
  expect(titles('agent=claude')).toEqual(['Auto']);
  expect(titles('agent=codex')).toEqual(['Cli']);
  expect(titles('agent=unknown')).toEqual(['Sin datos']);
  expect(titles('role=qa')).toEqual(['Auto']);
  expect(titles('role=implementation')).toEqual(['Cli']);
  expect(titles('role=unknown')).toEqual([]);
  expect(titles('cfrom=2026-02-01&cto=2026-02-28')).toEqual(['Cli']);
  expect(titles('cfrom=2026-02-02')).toEqual(['Auto']);
  expect(titles('cto=2026-01-31')).toEqual(['Sin datos']);
  expect(titles('cfrom=basura')).toHaveLength(3);
});
test('T97: dir=asc|desc invierte el orden y el natural se conserva', () => {
  seed();
  expect(titles('sort=created')).toEqual(['Auto', 'Cli', 'Sin datos']);
  expect(titles('sort=created&dir=asc')).toEqual(['Sin datos', 'Cli', 'Auto']);
  expect(titles('sort=title')).toEqual(['Auto', 'Cli', 'Sin datos']);
  expect(titles('sort=title&dir=desc')).toEqual(['Sin datos', 'Cli', 'Auto']);
  expect(titles('sort=created&dir=raro')).toEqual(['Auto', 'Cli', 'Sin datos']);
});
test('T97: la lista cuenta activities y muestra «No medido» donde falta el dato; el Store sigue siendo de solo lectura', async () => {
  const { auto } = seed();
  const row = store.changeIndex().find(c => c.id === auto)!;
  expect(row.activityCount).toBe(2); expect(row.agents).toEqual(['claude']); expect(row.roles).toEqual(['investigation', 'qa']);
  server = startWeb(dir, 0);
  const html = await get('/changes?agent=unknown');
  expect(html).toContain('Sin datos'); expect(html).toContain('<th>Activities</th>'); expect(html).toContain('Automation (segundo plano)');
  expect(html).toContain('name="agent"'); expect(html).toContain('name="role"'); expect(html).toContain('name="cfrom"'); expect(html).toContain('name="dir"');
  const ro = new Store(join(dir, 'fabrica.db'), { readonly: true });
  expect(() => ro.changeIndex()).not.toThrow(); expect(() => ro.changeLinks(auto)).not.toThrow(); ro.close();
});
test('T97: una base anterior (sin signals.source ni activities.agent) sigue listando', () => {
  const c = store.createChange(ws, 'Vieja', 'd');
  // Una sentencia por exec y sin el índice: un DROP COLUMN que falla no se puede tragar en silencio.
  store.db.exec('DROP INDEX idx_signals_source'); store.db.exec('ALTER TABLE signals DROP COLUMN source'); store.db.exec('ALTER TABLE activities DROP COLUMN agent');
  expect((store.db.query('PRAGMA table_info(signals)').all() as { name: string }[]).some(x => x.name === 'source')).toBe(false);
  const ro = new Store(join(dir, 'fabrica.db'), { readonly: true });
  const row = ro.changeIndex().find(x => x.id === c.id)!; ro.close();
  expect(row.source).toBeNull(); expect(row.agents).toEqual([]); expect(row.activityCount).toBe(1);
});
test('T97: 1000 changes se consultan y filtran en menos de 300 ms', () => {
  store.db.transaction(() => { for (let i = 0; i < 1000; i++) {
    store.db.query("INSERT INTO changes(id,workstream_id,title,description,status,created_at,updated_at) VALUES (?,?,?,'d','pending',?,?)").run(`c${i}`, ws, `C${i}`, `2026-01-${String(1 + i % 28).padStart(2, '0')}`, `2026-02-01`);
    store.db.query("INSERT INTO activities(id,workstream_id,change_id,kind,status,created_at,agent) VALUES (?,?,?,'investigation','pending','2026-01-01',?)").run(`a${i}`, ws, `c${i}`, i % 2 ? 'claude' : null);
  } })();
  const t0 = performance.now();
  const rows = applyQuery(store.changeIndex(), q('sort=created&dir=asc&agent=unknown&q=c'));
  expect(rows).toHaveLength(500); expect(performance.now() - t0).toBeLessThan(300);
});

// ---- T94: el guion de la bandeja ---------------------------------------------------------------------------------
test('T94: seleccionar todo, marcar y quitar «visto», copiar; el sondeo conserva la selección', async () => {
  const mkLi = (id: string, checked = false) => ({ dataset: { seenId: id }, classList: { toggle() {} }, checked, c: { dataset: { sel: id }, checked }, querySelector(s: string) { return s === '[data-sel]' ? this.c : { textContent: '', setAttribute() {} }; } });
  const lis = [mkLi('a'), mkLi('b'), mkLi('c')];
  const boxes = lis.map(l => l.c);
  const store_ = new Map<string, string>(); const clicks: ((e: unknown) => void)[] = [];
  const copied: string[] = [];
  const doc = { querySelectorAll: (s: string) => s === '[data-sel]' ? boxes : s === '[data-sel]:checked' ? boxes.filter(b => b.checked) : lis, addEventListener: (_: string, f: (e: unknown) => void) => { clicks.push(f); }, body: {}, querySelector: () => null };
  const win: Record<string, unknown> = {};
  new Function('window', 'document', 'localStorage', 'MutationObserver', 'navigator', INBOX_JS)(win, doc, { getItem: (k: string) => store_.get(k) ?? null, setItem: (k: string, v: string) => store_.set(k, v) }, class { observe() {} }, { clipboard: { writeText: async (v: string) => { copied.push(v); } } });
  const click = (attrs: Record<string, string>) => { const t = { dataset: attrs, textContent: '', matches: (s: string) => Object.keys(attrs).some(k => s.split(',').includes(`[data-${k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}]`)) }; for (const f of clicks) f({ target: { closest: (sel: string) => t.matches(sel) ? t : null } }); return t; };
  click({ selAll: '' }); expect(boxes.every(b => b.checked)).toBe(true);
  click({ selAll: '' }); expect(boxes.some(b => b.checked)).toBe(false); // segunda vez deselecciona
  boxes[0]!.checked = boxes[2]!.checked = true;
  click({ seenSel: '1' }); expect(JSON.parse(store_.get('fab.inbox.seen')!).sort()).toEqual(['a', 'c']);
  boxes[2]!.checked = false; click({ seenSel: '0' }); expect(JSON.parse(store_.get('fab.inbox.seen')!)).toEqual(['c']);
  const t = click({ copy: 'abc-123' }); await Promise.resolve(); await Promise.resolve(); await new Promise(r => setTimeout(r, 0));
  expect(copied).toEqual(['abc-123']); expect(t.textContent).toBe('Copiado');
  // el sondeo recibe un <main> nuevo: la selección actual se copia a él
  boxes[1]!.checked = true; const next = [mkLi('a'), mkLi('b'), mkLi('c')];
  (win.fabPrepare as (r: unknown) => void)({ querySelectorAll: () => next });
  expect(next.map(l => l.c.checked)).toEqual([true, true, false]);
});

// ---- Arreglos tras verificación ----------------------------------------------------------------------------------
test('T95-H1: jira_imports sin source_url no rompe el detalle del change', async () => {
  store.db.exec('CREATE TABLE jira_imports (issue_key TEXT PRIMARY KEY, signal_id TEXT NOT NULL UNIQUE)');
  const c = store.createChange(ws, 'Vieja base', 'd');
  const ro = new Store(join(dir, 'fabrica.db'), { readonly: true });
  expect(ro.changeLinks(c.id)).toEqual({}); ro.close();
  server = startWeb(dir, 0);
  const res = await fetch(`http://127.0.0.1:${server.port}/changes/${c.id}`);
  expect(res.status).toBe(200); expect(await res.text()).toContain('Vieja base');
});

function runPoll(body: string, before: string, after: string, extra: { active?: string } = {}) {
  let tick: () => Promise<void> = async () => {};
  const mkLink = (html: string) => ({ innerHTML: html });
  const live = mkLink(before), next = mkLink(after);
  const main = { innerHTML: 'a', replaceWith() { replaced++; } }; let replaced = 0;
  const parsed = { querySelector: (s: string) => s === 'main' ? { innerHTML: 'a' } : s === 'nav a[href="/"]' ? next : null };
  const doc = { addEventListener() {}, hidden: false, activeElement: extra.active ? { matches: (s: string) => s.includes(extra.active!) && !s.includes(`:not([${extra.active}])`) } : null,
    querySelector: (s: string) => s === 'nav a[href="/"]' ? live : s === 'main' ? main : null };
  const g = { fabNotify: undefined, getSelection: () => ({ toString: () => '' }) };
  new Function('document', 'window', 'fetch', 'DOMParser', 'location', 'setInterval', 'Response', body)(doc, g, async () => ({ ok: true, text: async () => '' }), class { parseFromString() { return parsed; } }, { href: '/' }, (f: () => Promise<void>) => { tick = f; });
  return { live, tick: () => tick(), replaced: () => replaced };
}
test('T94-H2: el sondeo actualiza el contador del menú aunque <main> no cambie', async () => {
  server = startWeb(dir, 0);
  const r = runPoll(await get('/poll.js'), 'Bandeja <strong>4</strong>', 'Bandeja <strong>5</strong>');
  await r.tick(); expect(r.live.innerHTML).toBe('Bandeja <strong>5</strong>');
});

test('T94-H1: un validador hostil no inyecta marcado por el href del rol', async () => {
  const html = roleLink(ui, { kind: 'implementation', validator: 'q"><img src=x id=INY>' as never }, 'uno', 'Rol');
  expect(html).not.toContain('<img');
  const c = store.createChange(ws, 'H', 'd'); const a = store.listActivities({ changeId: c.id })[0]!;
  store.db.query("UPDATE activities SET validator=? WHERE id=?").run('q"><img src=x id=INY>', a.id);
  server = startWeb(dir, 0);
  expect(await get(`/changes/${c.id}`)).not.toContain('<img src=x id=INY>');
  expect(await get(`/activities/${a.id}`)).not.toContain('<img src=x id=INY>');
});

test('T94-H3: en solo lectura Perfiles trae (sin plantillas) el ancla a la que apunta el enlace al rol', async () => {
  const c = store.createChange(ws, 'R', 'd'); const a = store.listActivities({ changeId: c.id })[0]!;
  store.db.query("UPDATE activities SET kind='implementation' WHERE id=?").run(a.id);
  server = startWeb(dir, 0);
  const link = /href="(\/perfiles\?ws=uno)#(f-worker\.implement)"/.exec(await get(`/changes/${c.id}`))!;
  const page = await get(link[1]!);
  expect(page).toContain(`id="${link[2]}"`);
  expect(page).not.toContain('<form action="/perfiles/guardar"'); expect(page).not.toContain('<textarea'); // T58: sin plantillas en solo lectura
});

test('T94-H4: una casilla con foco no frena el sondeo y el texto de «Copiar id» no lo desmonta', async () => {
  const poll = await (server = startWeb(dir, 0), get('/poll.js'));
  expect(poll).toContain("input:not([data-sel]),select,textarea"); // las casillas no cuentan como «escribiendo»
  const mk = (text: string, id = 'abc') => ({ dataset: { copy: id }, textContent: text });
  const live = mk('Copiado'), received = mk('Copiar id');
  const win: Record<string, unknown> = {}; const doc = { querySelectorAll: () => [], addEventListener() {}, body: {}, querySelector: (s: string) => s === '[data-copy="abc"]' ? live : null };
  new Function('window', 'document', 'localStorage', 'MutationObserver', 'navigator', INBOX_JS)(win, doc, { getItem: () => null, setItem() {} }, class { observe() {} }, {});
  (win.fabPrepare as (r: unknown) => void)({ querySelectorAll: (s: string) => s === '[data-copy]' ? [received] : [] });
  expect(received.textContent).toBe('Copiado'); // igual al vivo: el <main> no cambia y no se sustituye
});

test('T97-H1: un adaptador con coma no se parte y un filtro ausente se ve en el selector', async () => {
  const c = store.createChange(ws, 'Coma', 'd'); const a = store.listActivities({ changeId: c.id })[0]!;
  store.db.query("UPDATE activities SET agent='uno,dos' WHERE id=?").run(a.id);
  expect(store.changeIndex().find(x => x.id === c.id)!.agents).toEqual(['uno,dos']);
  expect(applyQuery(store.changeIndex(), q('agent=dos'))).toHaveLength(0);
  server = startWeb(dir, 0);
  expect(await get('/changes')).toContain('<option value="uno,dos">');
  const html = await get('/changes?agent=nadie');
  expect(html).toContain('<option value="nadie" selected>'); expect(html).toContain('No hay changes para estos filtros');
});

test('T95-H2: JIRA_HOSTNAME con puerto o con esquema enlaza el mismo host y nada más', () => {
  const env = { JIRA_HOSTNAME: 'jira.x.example:8443' };
  expect(safeUrl('https://jira.x.example:8443/browse/K-1', env)).not.toBeNull();
  expect(safeUrl('https://jira.x.example/browse/K-1', env)).toBeNull(); // otro puerto = otro host
  expect(safeUrl('https://jira.x.example:9999/browse/K-1', env)).toBeNull();
  expect(safeUrl('https://jira.y.example/b', { JIRA_HOSTNAME: 'https://jira.y.example' })).not.toBeNull();
  expect(safeUrl('https://jira.y.example/b', { JIRA_HOSTNAME: 'https://jira.y.example/ruta' })).toBeNull(); // host mal formado: se ignora
});

// ---- G3-H1: huecos de test de la verificación -------------------------------------------------------------------
test('G3-H1: hosts parecidos, cto inclusivo, dir inválido con título, columna de activities y paleta oscura explícita', async () => {
  for (const bad of ['https://evilgithub.com/o', 'https://evilatlassian.net/b', 'https://github.com.atlassian.com/x']) expect(safeUrl(bad, {}), bad).toBeNull();
  expect(safeUrl('https://gist.github.com/o', {})).toBeNull();
  seed();
  expect(titles('cto=2026-03-01')).toContain('Auto'); // el día `cto` entra (inclusivo)
  expect(titles('sort=title&dir=raro')).toEqual(['Auto', 'Cli', 'Sin datos']); // inválido = natural (título ascendente)
  server = startWeb(dir, 0);
  const rows = (await get('/changes')).match(/<tr><td><a href="\/changes\/[^"]+">Auto<\/a>.*?<\/tr>/)![0]!;
  expect(rows).toContain('<td>2</td>'); // dos activities: el número sale de los datos
  expect(WEB_STYLE).toMatch(/:root\[data-theme=dark\]\{color-scheme:dark;--bg:#191e1b/); // el selector trae la paleta, no solo existe
});
test('G3-H1: dos adaptadores en un change, fijar con el almacenamiento roto y pr.number no numérico', async () => {
  const c = store.createChange(ws, 'Dos', 'd'); const a = store.listActivities({ changeId: c.id })[0]!;
  store.db.query("UPDATE activities SET agent='a1' WHERE id=?").run(a.id);
  store.db.query("INSERT INTO activities(id,workstream_id,change_id,kind,status,created_at,agent) VALUES ('x2',?,?,'implementation','pending','2026-01-01','a2')").run(ws, c.id);
  expect(store.changeIndex().find(x => x.id === c.id)!.agents).toEqual(['a1', 'a2']);
  expect(titles('agent=a2')).toEqual(['Dos']);
  store.db.exec('CREATE TABLE change_links (change_id TEXT PRIMARY KEY, source_system TEXT, source_key TEXT, source_url TEXT, pr_json TEXT)');
  store.db.query('INSERT INTO change_links(change_id,pr_json) VALUES (?,?)').run(c.id, JSON.stringify({ repo: 'o/r', number: '4', url: 'https://github.com/o/r/pull/4' }));
  expect(store.changeLinks(c.id).pr).toBeUndefined(); // un número que no es número no se muestra como «#undefined»
  // fijar con localStorage que lanza: no rompe y la lista sigue
  const mkLi = (slug: string, i: number) => ({ dataset: { ws: slug, i: String(i) }, hidden: false, hasAttribute: () => false, querySelector: () => ({ hidden: true, setAttribute() {}, textContent: '' }), closest() { return this; } });
  const lis = [mkLi('x', 0), mkLi('y', 1)]; let onClick: (e: unknown) => void = () => {};
  const ul = { children: lis as unknown[], appendChild() {}, querySelector: () => null };
  const nav = { querySelector: (s: string) => s === 'ul' ? ul : null, addEventListener: (_: string, f: (e: unknown) => void) => { onClick = f; } };
  const broken = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
  new Function('document', 'localStorage', SIDEBAR_JS)({ querySelector: () => nav }, broken);
  expect(() => onClick({ target: { closest: (sel: string) => sel === '[data-ws-pin]' ? lis[1] : lis[1] } })).not.toThrow();
});
