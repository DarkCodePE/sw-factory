import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { applyMigrations, MIGRATIONS } from '../src/migrations.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fab-mig-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ids = (db: Database) => (db.query('SELECT id FROM schema_migrations ORDER BY id').all() as { id: string }[]).map((r) => r.id);

// Base «de release»: api_keys con UNIQUE(name) y sin registro de migraciones.
function releaseDb(path: string): void {
  const s = new Store(path);
  s.db.exec(`DROP TABLE schema_migrations; DROP TABLE user_sessions; DROP TABLE user_invitations; DROP TABLE users; DROP TABLE team; DROP TABLE identity_audit;
    ALTER TABLE events DROP COLUMN actor_user_id; ALTER TABLE events DROP COLUMN actor_source;
    DROP TABLE api_keys;
    CREATE TABLE api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, scope TEXT NOT NULL CHECK (scope IN ('read','decide')),
      hash TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, revoked_at TEXT);
    INSERT INTO api_keys VALUES ('a1','uno','read','h1','2026-01-01','ana',NULL),('b2','dos','decide','h2','2026-01-02','ben','2026-02-01');`);
  s.close();
}

test('base limpia: aplica los IDs una vez y reabrir no repite', () => {
  const path = join(dir, 'a.db');
  const s = new Store(path);
  expect(ids(s.db)).toEqual(MIGRATIONS.map((m) => m.id).sort());
  s.close();
  const again = new Store(path);
  expect(ids(again.db)).toHaveLength(MIGRATIONS.length);
  again.close();
});

test('base de release: api_keys se reconstruye sin perder filas ni digests', () => {
  const path = join(dir, 'r.db');
  releaseDb(path);
  const s = new Store(path);
  const rows = s.db.query('SELECT id, name, scope, hash, created_by, revoked_at, user_id, expires_at FROM api_keys ORDER BY id').all();
  expect(rows).toEqual([
    { id: 'a1', name: 'uno', scope: 'read', hash: 'h1', created_by: 'ana', revoked_at: null, user_id: null, expires_at: null },
    { id: 'b2', name: 'dos', scope: 'decide', hash: 'h2', created_by: 'ben', revoked_at: '2026-02-01', user_id: null, expires_at: null },
  ]);
  expect(s.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  // UNIQUE(name) global cayó: el mismo nombre se admite por usuario, pero no entre claves locales.
  expect(() => s.db.query(`INSERT INTO api_keys (id,name,scope,hash,created_at,created_by) VALUES ('c3','uno','read','h','t','x')`).run()).toThrow();
  s.close();
});

test('un fallo a mitad hace rollback y no registra el ID', () => {
  const db = new Database(':memory:', { strict: true });
  const boom = [{ id: 'x-1', up: (d: Database) => { d.exec('CREATE TABLE t (a)'); throw new Error('boom'); } }];
  expect(() => applyMigrations(db, 'now', boom)).toThrow('boom');
  expect(db.query("SELECT 1 FROM sqlite_schema WHERE name = 't'").get()).toBeNull();
  expect(ids(db)).toEqual([]);
});

test('dos escritores: el segundo ve el registro bajo lock y no repite', () => {
  const path = join(dir, 'w.db');
  const a = new Store(path);
  const b = new Store(path);
  let runs = 0;
  const step = [{ id: 'x-2', up: () => { runs++; } }];
  applyMigrations(a.db, 'n', step);
  applyMigrations(b.db, 'n', step);
  expect(runs).toBe(1);
  a.close(); b.close();
});

test('el esquema de identidad impide segundo equipo y cambiar su UUID', () => {
  const s = new Store(join(dir, 't.db'));
  s.db.query(`INSERT INTO team (singleton,id,created_at) VALUES (1,'u1','t')`).run();
  expect(() => s.db.query(`INSERT INTO team (singleton,id,created_at) VALUES (2,'u2','t')`).run()).toThrow();
  expect(() => s.db.query(`UPDATE team SET id='u9'`).run()).toThrow(/inmutable/);
  expect(() => s.db.query(`DELETE FROM team`).run()).toThrow();
  s.close();
});

test('T119a-H6: un lector abre una base de release sin migrar y lista y verifica las claves locales', () => {
  const path = join(dir, 'ro.db');
  releaseDb(path);
  const ro = new Store(path, { readonly: true });
  try {
    expect(ro.listApiKeys().map((k) => k.id)).toEqual(['a1', 'b2']);
    expect(ro.verifyApiKey(`fabk_a1a1a1a1a1a1_${'A'.repeat(43)}`)).toBeNull(); // no lanza «no such column»
  } finally { ro.close(); }
});

test('T119a-H15: identity_audit solo admite añadir y marcar exported_at', () => {
  const s = new Store(join(dir, 'a.db'));
  s.db.query(`INSERT INTO identity_audit (op_id, at, actor, actor_source, action, result) VALUES ('o1','t','a','cli','x','ok')`).run();
  expect(() => s.db.query(`UPDATE identity_audit SET action = 'otra'`).run()).toThrow(/solo añadir/);
  expect(() => s.db.query(`UPDATE identity_audit SET result = 'fail'`).run()).toThrow(/solo añadir/);
  expect(() => s.db.query(`DELETE FROM identity_audit`).run()).toThrow(/solo añadir/);
  s.db.query(`UPDATE identity_audit SET exported_at = 't2'`).run();
  expect(s.db.query('SELECT exported_at FROM identity_audit').get()).toEqual({ exported_at: 't2' });
  s.close();
});

test('T119a-H18: INSERT OR REPLACE no reescribe un asiento, ni por seq ni por op_id', () => {
  const s = new Store(join(dir, 'r.db'));
  s.db.query(`INSERT INTO identity_audit (op_id, at, actor, actor_source, action, result) VALUES ('o1','t','a','cli','x','ok'), ('o2','t','a','cli','y','ok')`).run();
  expect(() => s.db.query(`INSERT OR REPLACE INTO identity_audit (seq, op_id, at, actor, actor_source, action, result) VALUES (1,'o9','t','forjado','cli','z','ok')`).run()).toThrow(/solo añadir/);
  expect(() => s.db.query(`INSERT OR REPLACE INTO identity_audit (op_id, at, actor, actor_source, action, result) VALUES ('o2','t','forjado','cli','z','ok')`).run()).toThrow(/solo añadir/);
  expect(s.db.query('SELECT seq, op_id, action FROM identity_audit ORDER BY seq').all()).toEqual([{ seq: 1, op_id: 'o1', action: 'x' }, { seq: 2, op_id: 'o2', action: 'y' }]);
  s.db.query(`INSERT INTO identity_audit (op_id, at, actor, actor_source, action, result) VALUES ('o3','t','a','cli','w','ok')`).run(); // añadir sigue valiendo
  s.close();
});

test('M14b: el trigger de solo añadir cubre también detail y object', () => {
  const s = new Store(join(dir, 'd.db'));
  s.db.query(`INSERT INTO identity_audit (op_id, at, actor, actor_source, action, object, detail, result) VALUES ('o1','t','a','cli','x','obj','{}','ok')`).run();
  expect(() => s.db.query(`UPDATE identity_audit SET detail = '{"a":1}'`).run()).toThrow(/solo añadir/);
  expect(() => s.db.query(`UPDATE identity_audit SET object = 'otro'`).run()).toThrow(/solo añadir/);
  s.close();
});

test('T119a-H16: bajo el lock se vuelve a comprobar el registro; si otro escritor aplicó el paso entre medias, no se repite', () => {
  const path = join(dir, 'lock.db');
  const a = new Database(path, { strict: true }), b = new Database(path, { strict: true });
  a.exec('PRAGMA busy_timeout = 5000');
  b.exec('PRAGMA busy_timeout = 5000');
  let runs = 0;
  const step = [{ id: 'x-lock', up: () => { runs++; } }];
  // `a` comprueba el registro (aún vacío) y, antes de abrir su transacción, `b` aplica el mismo paso.
  let fired = false;
  const racing = new Proxy(a, { get(target, prop) {
    if (prop !== 'query') { const v = Reflect.get(target, prop); return typeof v === 'function' ? v.bind(target) : v; }
    return (sql: string) => {
      const q = target.query(sql);
      if (!fired && sql.startsWith('SELECT 1 FROM schema_migrations')) {
        return { get: (...args: unknown[]) => { const r = (q.get as (...x: unknown[]) => unknown)(...args); fired = true; applyMigrations(b, 'n', step); return r; }, run: q.run.bind(q) };
      }
      return q;
    };
  } }) as Database;
  applyMigrations(racing, 'n', step);
  expect(runs).toBe(1);
  expect(ids(a)).toEqual(['x-lock']);
  a.close(); b.close();
});
