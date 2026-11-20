import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, StoreError } from '../src/store.ts';

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-runners-'));
  store = new Store(join(dir, 'fabrica.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const code = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return e instanceof StoreError ? `${e.code}: ${e.message}` : String(e); }
};
const ws = () => store.createWorkstream({ slug: 'w', goal: 'g', repo: dir });

test('crea, lista, pausa y borra runners', () => {
  const r = store.createRunner({ name: 'torre', kind: 'ssh', target: 'torre.lan', options: { maxBundleMb: 100 } });
  expect(r).toMatchObject({ name: 'torre', kind: 'ssh', target: 'torre.lan', options: { maxBundleMb: 100 }, enabled: true });
  store.createRunner({ name: 'seguro', kind: 'local', options: { confine: true } });
  expect(store.listRunners().map(x => x.name)).toEqual(['seguro', 'torre']);
  expect(store.getRunner('seguro')).toMatchObject({ kind: 'local', target: null, options: { confine: true } });
  expect(store.setRunnerEnabled('torre', false).enabled).toBe(false);
  store.deleteRunner('torre');
  expect(code(() => store.getRunner('torre'))).toStartWith('not_found');
  expect(code(() => store.createRunner({ name: 'seguro', kind: 'local' }))).toStartWith('conflict');
});

test('valida nombre, alias y opciones nombrando el campo', () => {
  for (const name of ['', 'Torre', '-a', 'a_b', 'a'.repeat(42)])
    expect(code(() => store.createRunner({ name, kind: 'local' }))).toMatch(/^invalid_input: .*name/);
  for (const target of ['usuario@host', 'a b', '-oProxyCommand=x', '', 'a'.repeat(65), undefined])
    expect(code(() => store.createRunner({ name: 'x', kind: 'ssh', target }))).toMatch(/^invalid_input: .*target/);
  expect(code(() => store.createRunner({ name: 'x', kind: 'local', target: 'h' }))).toMatch(/^invalid_input: .*target/);
  expect(code(() => store.createRunner({ name: 'x', kind: 'ssh', target: 'h', options: { maxBundleMb: 0 } }))).toMatch(/^invalid_input: .*maxBundleMb/);
  expect(code(() => store.createRunner({ name: 'x', kind: 'ssh', target: 'h', options: { confine: true } }))).toMatch(/^invalid_input: .*confine/);
  expect(code(() => store.createRunner({ name: 'x', kind: 'local', options: { confine: 'si' } }))).toMatch(/^invalid_input: .*confine/);
  expect(code(() => store.createRunner({ name: 'x', kind: 'local', options: { env: { K: 'v' } } }))).toMatch(/^invalid_input: .*env/);
});

test('asigna runner a un workstream; inexistente es not_found; borrar en uso es conflict', () => {
  const w = ws();
  store.createRunner({ name: 'torre', kind: 'ssh', target: 'torre' });
  expect(w.runner).toBeNull();
  expect(code(() => store.setWorkstreamRunner('w', 'nada'))).toStartWith('not_found');
  expect(store.setWorkstreamRunner('w', 'torre').runner).toBe('torre');
  expect(code(() => store.deleteRunner('torre'))).toStartWith('conflict');
  expect(store.setWorkstreamRunner('w', null).runner).toBeNull();
  store.deleteRunner('torre');
});

test('el evento de un runner ssh avisa de que el código sale; el local no', () => {
  const w = ws();
  store.createRunner({ name: 'torre', kind: 'ssh', target: 'alias-privado' });
  store.createRunner({ name: 'loc', kind: 'local' });
  store.setWorkstreamRunner('w', 'torre');
  store.setWorkstreamRunner('w', 'loc');
  const msgs = (store.db.query('SELECT message FROM events WHERE workstream_id = ? ORDER BY id').all(w.id) as { message: string }[]).map(e => e.message);
  expect(msgs).toContain('runner: ninguno -> torre; el código de este workstream se enviará al runner remoto');
  expect(msgs).toContain('runner: torre -> loc');
  expect(msgs.join(' ')).not.toContain('alias-privado');
  expect(msgs.filter(m => m.includes('se enviará'))).toHaveLength(1);
});

test('la procedencia guarda el runner del intento', () => {
  const w = ws();
  const c = store.createChange(w.id, 't', 'd');
  const a = store.db.query('SELECT id FROM activities WHERE change_id = ?').get(c.id) as { id: string };
  expect(store.getActivity(a.id).runner).toBeNull();
  store.setActivityProvenance(a.id, 'd', null, { agent: 'claude', model: null, runner: 'torre' });
  expect(store.getActivity(a.id).runner).toBe('torre');
});

test('una base anterior se abre con runner nulo', () => {
  const path = join(dir, 'old.db');
  const old = new Database(path);
  old.exec(`CREATE TABLE workstreams (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, goal TEXT NOT NULL, repo TEXT NOT NULL,
    state TEXT NOT NULL, agent TEXT NOT NULL, worker_concurrency INTEGER NOT NULL, task_limit INTEGER NOT NULL,
    require_change_approval INTEGER NOT NULL, require_approval INTEGER NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO workstreams VALUES ('i','viejo','g','/r','active','claude',1,5,1,1,'2026-01-01T00:00:00.000Z');`);
  old.close();
  const s = new Store(path);
  try {
    expect(s.getWorkstream('viejo').runner).toBeNull();
    expect(s.listRunners()).toEqual([]);
  } finally { s.close(); }
});

test('CLI: add, list, ws runner con aviso, rm en uso falla', () => {
  const env = { ...process.env, FABRICA_HOME: dir };
  const fab = (...a: string[]) => Bun.spawnSync(['bun', 'src/cli.ts', ...a], { env, cwd: join(import.meta.dir, '..') });
  const out = (r: ReturnType<typeof fab>) => r.stdout.toString() + r.stderr.toString();
  store.close(); // la CLI abre su propia base en FABRICA_HOME
  expect(fab('ws', 'create', 'w', '--repo', dir, '--goal', 'g').exitCode).toBe(0);
  const add = fab('runner', 'add', 'torre', '--ssh', 'torre.lan', '--max-bundle-mb', '64');
  expect(add.exitCode).toBe(0);
  expect(out(add)).toContain('sale de tu máquina');
  expect(out(fab('runner', 'list'))).toContain('torre.lan');
  expect(JSON.parse(out(fab('runner', 'list', '--json')))[0]).toMatchObject({ name: 'torre', options: { maxBundleMb: 64 } });
  expect(out(fab('runner', 'add', 'x', '--ssh', 'u@h'))).toContain('invalid_input');
  const assign = fab('ws', 'runner', 'w', 'torre');
  expect(assign.exitCode).toBe(0);
  expect(out(assign)).toContain('sale de tu máquina');
  const rm = fab('runner', 'rm', 'torre');
  expect(rm.exitCode).toBe(1);
  expect(out(rm)).toContain('conflict');
  expect(fab('ws', 'runner', 'w', '--none').exitCode).toBe(0);
  expect(fab('runner', 'disable', 'torre').exitCode).toBe(0);
  expect(fab('runner', 'rm', 'torre').exitCode).toBe(0);
  store = new Store(join(dir, 'fabrica.db'));
});

test('H6: pausar y activar un runner deja un evento en cada workstream que lo usa, y solo en esos', () => {
  const a = ws(), b = store.createWorkstream({ slug: 'otro', goal: 'g', repo: dir });
  store.createRunner({ name: 'torre', kind: 'ssh', target: 'torre' });
  store.setWorkstreamRunner('w', 'torre');
  store.setRunnerEnabled('torre', false);
  store.setRunnerEnabled('torre', true);
  const msgs = (id: string) => (store.db.query('SELECT message FROM events WHERE workstream_id = ? ORDER BY id').all(id) as { message: string }[]).map(e => e.message);
  expect(msgs(a.id)).toEqual(expect.arrayContaining(['runner torre pausado', 'runner torre activado']));
  expect(msgs(b.id).filter(m => m.includes('torre'))).toEqual([]);
});

test('inventario público en lectura: proyecta campos y admite bases sin tabla sin migrar', () => {
  const path = join(dir, 'fabrica.db');
  store.createRunner({ name: 'torre', kind: 'ssh', target: 'alias-privado', options: { maxBundleMb: 99 } });
  store.setRunnerEnabled('torre', false);
  store.createRunner({ name: 'casa', kind: 'local' });
  const read = () => {
    const reader = new Store(path, { readonly: true });
    try { return reader.listRunnerSummaries(); } finally { reader.close(); }
  };
  expect(read()).toEqual([
    { name: 'casa', kind: 'local', enabled: true },
    { name: 'torre', kind: 'ssh', enabled: false },
  ]);
  store.db.exec('DROP TABLE runners');
  expect(read()).toEqual([]);
  expect(store.db.query("SELECT name FROM sqlite_schema WHERE name = 'runners'").get()).toBeNull();
});

test('asignación web por id compara la selección antes del no-op y comprueba estado y confirmación', () => {
  const w = ws();
  store.createRunner({ name: 'torre', kind: 'ssh', target: 'alias-privado' });
  store.createRunner({ name: 'casa', kind: 'local' });
  const other = new Store(join(dir, 'fabrica.db'));
  const select = (runner: string | null, expected: string | null, confirmSsh = false) =>
    store.setWorkstreamRunner(w.id, runner, { expected, confirmSsh });
  try {
    expect(code(() => store.setWorkstreamRunner(w.slug, 'casa', { expected: null, confirmSsh: false }))).toStartWith('not_found');
    expect(code(() => select('torre', null))).toStartWith('invalid_input');
    other.setWorkstreamRunner(w.slug, 'torre');
    expect(code(() => select('torre', null, true))).toStartWith('conflict');
    const count = store.listEvents(w.id).length;
    expect(select('torre', 'torre', true).runner).toBe('torre');
    expect(store.listEvents(w.id).length).toBe(count);
    other.setRunnerEnabled('casa', false);
    expect(code(() => select('casa', 'torre'))).toStartWith('conflict');
    expect(other.setWorkstreamRunner(w.slug, 'casa').runner).toBe('casa');
    expect(code(() => select('casa', 'casa'))).toStartWith('conflict');
    expect(select(null, 'casa').runner).toBeNull();
    other.deleteRunner('casa');
    expect(code(() => select('casa', null))).toStartWith('not_found');
    other.setWorkstreamState(w.id, 'archived');
    expect(code(() => select('torre', null, true))).toStartWith('conflict');
    expect(store.getWorkstream(w.id).runner).toBeNull();
  } finally { other.close(); }
});
