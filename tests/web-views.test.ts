import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { authorize, READ_CAPABILITIES, ROLES, type Role } from '../src/policy.ts';
import type { Principal } from '../src/users.ts';
import { authorizeRead, configViewFor, readCapability, structuredActivityPage, structuredChangePage, structuredSignalsPage, structuredWorkstreamsPage, visiblePaths, PUBLIC_PATHS } from '../src/web-views.ts';
import type { Ui } from '../src/web-changes.ts';
import { workstreamsBody } from '../src/web-ws.ts';

const who = (role: Role, over: Partial<Principal> = {}): Principal =>
  ({ userId: `u-${role}`, role, issuer: 'github', subject: role, displayName: role, via: 'web', recovery: false, ...over });
const get = (path: string) => new URL(path, 'https://fab.test');
const status = (role: Role, path: string): number => { const d = authorizeRead(who(role), get(path)); return d.ok ? 200 : d.status; };

// Una fila por vista y rol (§4.2): O A M V.
const MATRIX: [string, [number, number, number, number]][] = [
  ['/', [200, 200, 200, 403]], ['/changes', [200, 200, 200, 403]], ['/signals', [200, 200, 200, 200]],
  ['/automations', [200, 200, 200, 403]], ['/workstreams', [200, 200, 200, 200]], ['/flujo', [200, 200, 200, 403]],
  ['/benchmarks', [200, 200, 200, 403]], ['/benchmarks/x', [200, 200, 200, 403]], ['/experimentos/x', [200, 200, 200, 403]],
  ['/changes/c1', [200, 200, 200, 200]], ['/activities/a1', [200, 200, 200, 200]],
  ['/metricas', [200, 200, 200, 403]],
  ['/changes/c1/turns/t1/log', [200, 200, 200, 403]], ['/changes/c1/turns/t1/transcript', [200, 200, 200, 403]],
  ['/config', [200, 200, 403, 403]], ['/config/runners', [200, 200, 403, 403]], ['/perfiles', [200, 200, 403, 403]],
  ['/definicion', [200, 200, 403, 403]], ['/automejora', [200, 200, 403, 403]], ['/webhooks', [200, 200, 403, 403]],
  ['/config/runners?editar=r1', [200, 403, 403, 403]], ['/workstreams/nuevo', [200, 403, 403, 403]],
  ['/automations/nueva', [200, 200, 403, 403]], ['/automations/a1/editar', [200, 200, 403, 403]],
  ['/config/claves-api', [200, 200, 200, 403]],
];
for (const [path, expected] of MATRIX) {
  test(`T119d matriz: ${path} para O A M V`, () => {
    expect(ROLES.map(r => status(r, path))).toEqual(expected);
  });
}

test('sin principal 401; ruta fuera del inventario 404 también para owner', () => {
  expect(authorizeRead(undefined, get('/'))).toMatchObject({ ok: false, status: 401 });
  expect(authorizeRead(who('owner'), get('/secreto'))).toMatchObject({ ok: false, status: 404 });
  expect(authorizeRead(who('owner'), get('/changes/c1/extra'))).toMatchObject({ ok: false, status: 404 });
});

test('una clave API o una sesión CLI no abren páginas; la recuperación restringida tampoco', () => {
  expect(authorizeRead(who('owner', { via: 'api', keyScope: 'decide' }), get('/'))).toMatchObject({ ok: false, status: 403, reason: 'surface' });
  expect(authorizeRead(who('owner', { via: 'cli' }), get('/'))).toMatchObject({ ok: false, status: 403 });
  expect(authorizeRead(who('owner', { recovery: true }), get('/'))).toMatchObject({ ok: false, status: 403, reason: 'recovery_restricted' });
});

test('la proyección es full para O A M y structured para V', () => {
  const proj = (r: Role) => { const d = authorizeRead(who(r), get('/changes/c1')); return d.ok ? d.projection : 'denegado'; };
  expect(ROLES.map(proj)).toEqual(['full', 'full', 'full', 'structured']);
});

test('D-F: web y CLI deciden igual cada lectura y cada rol; toda capacidad de ruta existe en la política', () => {
  const caps = new Set(MATRIX.map(([p]) => readCapability(get(p))!));
  for (const cap of caps) {
    expect(cap).toBeTruthy();
    for (const r of ROLES) {
      const web = authorize({ role: r }, cap, { via: 'web', write: false });
      expect(web.ok || web.reason !== 'unknown_capability').toBe(true);
      const cli = authorize({ role: r }, cap, { via: 'cli', write: false });
      expect(web.ok).toBe(cli.ok); // la web nunca da más que la CLI
    }
  }
  // El viewer nunca recibe lo que la política reserva a la evidencia ni a la configuración.
  for (const cap of ['evidence/read', 'config/read', 'config/credentials']) expect(READ_CAPABILITIES[cap]!.roles.includes('V')).toBe(false);
});

test('inventario: todo GET literal de web.ts y su lista de activos tiene correspondencia o es un activo público', () => {
  const src = readFileSync(join(import.meta.dir, '../src/web.ts'), 'utf8');
  const literals = [...src.matchAll(/pathname === '(\/[^']*)'/g)].map(m => m[1]!);
  const publicOnes = new Set([...PUBLIC_PATHS, '/auth', '/healthz', '/_test/origin']); // fuera de la sesión o de la lectura
  expect(literals.length).toBeGreaterThan(8);
  for (const p of literals) if (!publicOnes.has(p)) expect(readCapability(get(p)), p).not.toBeNull();
});

test('H3: PUBLIC_PATHS cubre los activos de READ_ASSETS y los de web.ts, y ninguno tiene capacidad', () => {
  const src = readFileSync(join(import.meta.dir, '../src/web.ts'), 'utf8');
  const assets = [...src.slice(src.indexOf('const READ_ASSETS')).split('\n]);')[0]!.matchAll(/\['(\/[^']+)', \{/g)].map(m => m[1]!);
  expect(assets.length).toBe(6);
  for (const a of [...assets, '/style.css', '/poll.js', '/definition']) expect(PUBLIC_PATHS, a).toContain(a);
  for (const p of PUBLIC_PATHS) expect(readCapability(get(p)), p).toBeNull(); // se sirven antes de authorizeRead
  // Rutas por prefijo o regex: una nueva no puede quedar sin capacidad.
  for (const m of src.matchAll(/pathname\.startsWith\('(\/[^']*)'\)/g)) expect(readCapability(get(`${m[1]!.replace(/\/$/, '')}/x`)), m[1]).not.toBeNull();
  expect([...src.matchAll(/\.exec\(url\.pathname\)/g)].length).toBe(2); // si aparece otra, revisa ROUTES
});

test('visiblePaths: el menú del viewer omite configuración y claves; el del owner las lista', () => {
  const nav = ['/signals', '/workstreams', '/metricas', '/config', '/perfiles', '/config/claves-api', '/webhooks'];
  expect(visiblePaths(who('viewer'), nav)).toEqual(['/signals', '/workstreams']);
  expect(visiblePaths(who('owner'), nav)).toEqual(nav);
  expect(visiblePaths(undefined, nav)).toEqual([]);
});

// --- proyecciones estructuradas ---
let dir: string; let store: Store;
const ui: Ui = {
  escape: v => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`),
  badge: s => `<span class="status">${s}</span>`, labels: {},
};
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fab-views-')); store = new Store(join(dir, 'f.db')); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function seed() {
  const w = store.createWorkstream({ slug: 'uno', goal: 'g', repo: '/r' });
  const c = store.createChange(w.id, 'Cambio <b>', 'd');
  store.addChangeNote(c.id, 'NOTA-SECRETA-DEL-EQUIPO');
  const a = store.listActivities({ changeId: c.id })[0]!;
  store.db.query("UPDATE activities SET result = ?, review_status = 'declined', review_comment = ? WHERE id = ?").run('RESULTADO-DE-WORKER-ABC', 'COMENTARIO-DE-REVISION', a.id);
  return { c, a };
}

test('V: el change estructurado trae título y estado, sin notas ni resultado, y escapa el título', () => {
  const { c } = seed();
  const html = structuredChangePage(store, ui, c.id).body;
  expect(html).toContain('uno');
  expect(html).not.toContain('NOTA-SECRETA'); expect(html).not.toContain('RESULTADO-DE-WORKER'); expect(html).not.toContain('COMENTARIO');
  expect(structuredChangePage(store, ui, c.id).title).toBe('Cambio <b>'); // el título lo escapa quien pinta la plantilla
});

test('V: la activity estructurada no trae comentario, resultado, error, log ni diff', () => {
  const { a } = seed();
  const html = structuredActivityPage(store, ui, a.id).body;
  for (const t of ['RESULTADO-DE-WORKER', 'COMENTARIO-DE-REVISION', 'Veredicto y resultado', 'diff.patch', 'run.json']) expect(html).not.toContain(t);
  expect(html).toContain('declined');
});

test('V: un error de worker tampoco aparece', () => {
  const w = store.createWorkstream({ slug: 'dos', goal: 'g', repo: '/r' });
  const a = store.listActivities({ changeId: store.createChange(w.id, 'T', 'd').id })[0]!;
  store.db.query("UPDATE activities SET status = 'failed', error = ? WHERE id = ?").run('ERROR-DEL-WORKER-XYZ', a.id);
  expect(structuredActivityPage(store, ui, a.id).body).not.toContain('ERROR-DEL-WORKER-XYZ');
});

// T119d-H1: toda ruta que da `structured` a V tiene su vista estructurada; el resto da 403, nunca se sirve tal cual.
test('H1: para V solo hay 200 donde existe vista estructurada; el resto 403 no_structured_view', () => {
  const ok = ['/signals', '/workstreams', '/changes/c1', '/activities/a1'];
  for (const p of ok) expect(authorizeRead(who('viewer'), get(p)), p).toMatchObject({ ok: true, projection: 'structured' });
  for (const p of ['/', '/changes', '/automations', '/flujo', '/benchmarks', '/benchmarks/x', '/experimentos', '/experimentos/x', '/metricas'])
    expect(authorizeRead(who('viewer'), get(p)), p).toMatchObject({ ok: false, status: 403, reason: 'no_structured_view' });
  expect(authorizeRead(who('member'), get('/metricas'))).toMatchObject({ ok: true, projection: 'full' });
});

test('H1: señales para V: título, workstream y fecha; sin cuerpo', () => {
  store.createWorkstream({ slug: 'uno', goal: 'OBJETIVO-CANARIO', repo: '/CANARIO-RUTA-REPO' });
  store.addSignal('uno', 'Titulo <i>', 'CUERPO-CANARIO');
  const html = structuredSignalsPage(store, ui).body;
  expect(html).toContain('Titulo &#60;i&#62;'); expect(html).toContain('uno'); expect(html).not.toContain('CUERPO-CANARIO');
});

test('H1: workstreams para V: sin objetivo ni ruta del repo; para el resto, hideRepo oculta la ruta', () => {
  store.createWorkstream({ slug: 'uno', goal: 'OBJETIVO-CANARIO', repo: '/CANARIO-RUTA-REPO' });
  const html = structuredWorkstreamsPage(store, ui).body;
  expect(html).toContain('uno'); expect(html).not.toContain('CANARIO');
  expect(workstreamsBody(store, ui)).toContain('CANARIO-RUTA-REPO');
  expect(workstreamsBody(store, ui, undefined, true)).not.toContain('CANARIO-RUTA-REPO');
});

test('sesiones intercaladas: la decisión de cada principal no depende de la anterior', () => {
  const v = who('viewer'), m = who('member', { userId: 'u2' });
  const seq = [v, m, v, m].map(p => { const d = authorizeRead(p, get('/changes/c1/turns/t/log')); return d.ok; });
  expect(seq).toEqual([false, true, false, true]);
});

test('configViewFor: solo el owner ve los indicadores de credenciales del host', () => {
  expect(ROLES.map(r => configViewFor(who(r)).credentials)).toEqual([true, false, false, false]);
});
