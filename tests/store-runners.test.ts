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
  store.createRunner({ name: 'torre', kind: 'ssh', target: 'torre' });
  store.createRunner({ name: 'loc', kind: 'local' });
  store.setWorkstreamRunner('w', 'torre');
  store.setWorkstreamRunner('w', 'loc');
  const msgs = (store.db.query('SELECT message FROM events WHERE workstream_id = ? ORDER BY id').all(w.id) as { message: string }[]).map(e => e.message);
  expect(msgs).toContain('runner: ninguno -> torre; el código de este workstream se enviará a torre');
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
