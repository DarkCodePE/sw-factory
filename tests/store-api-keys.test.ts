import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Store, StoreError } from '../src/store.ts';

const initial = '2026-11-19T07:00:00.000Z';
const revoked = '2026-11-19T07:30:00.000Z';
let now: string;
let store: Store;
let dir: string;

beforeEach(() => {
  now = initial;
  dir = mkdtempSync(join(tmpdir(), 'fab-api-keys-'));
  store = new Store(join(dir, 'fabrica.db'), { clock: () => new Date(now) });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('crea una clave de 32 bytes, autentica ambos ámbitos y lista solo metadatos', () => {
  const read = store.createApiKey('lector', 'read');
  const decide = store.createApiKey('dueno', 'decide');
  for (const { id, key } of [read, decide]) {
    const prefix = `fabk_${id}_`;
    expect(id).toMatch(/^[a-f0-9]{12}$/);
    expect(new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`).test(key)).toBe(true);
    const secret = key.slice(prefix.length);
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    expect(Buffer.from(secret, 'base64url').toString('base64url') === secret).toBe(true);
  }
  expect(read.id).not.toBe(decide.id);
  expect(store.verifyApiKey(read.key)).toEqual({ id: read.id, name: 'lector', scope: 'read' });
  expect(store.verifyApiKey(decide.key)).toEqual({ id: decide.id, name: 'dueno', scope: 'decide' });

  const listed = store.listApiKeys();
  expect(listed).toHaveLength(2);
  for (const [record, name, scope] of [[read, 'lector', 'read'], [decide, 'dueno', 'decide']] as const) {
    const entry = listed.find(key => key.id === record.id);
    expect(Object.keys(entry ?? {}).sort()).toEqual(['createdAt', 'createdBy', 'id', 'name', 'revokedAt', 'scope']);
    expect(entry).toEqual({
      id: record.id, name, scope, createdAt: initial,
      createdBy: process.env.FAB_ACTOR ?? userInfo().username, revokedAt: null,
    });
  }
});

test('H1: dos claves no comparten secreto ni hash', () => {
  const [a, b] = [store.createApiKey('uno', 'read'), store.createApiKey('dos', 'read')];
  const secret = (k: { id: string; key: string }) => k.key.slice(`fabk_${k.id}_`.length);
  expect(secret(a)).not.toBe(secret(b));
  const hashes = store.db.query<{ hash: string }, []>('SELECT hash FROM api_keys').all().map(r => r.hash);
  expect(new Set(hashes).size).toBe(2);
});

test('A1: solo persiste el SHA-256 del secreto y no crea eventos', () => {
  const { id, key } = store.createApiKey('canario', 'read');
  const secret = key.slice(`fabk_${id}_`.length);
  const hash = store.db.query<{ hash: string }, [string]>('SELECT hash FROM api_keys WHERE id = ?').get(id)?.hash;
  expect(hash === createHash('sha256').update(secret).digest('hex')).toBe(true);
  store.revokeApiKey(id);
  expect(store.db.query('SELECT id FROM events').all()).toEqual([]);
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  for (const file of readdirSync(dir)) {
    const bytes = readFileSync(join(dir, file));
    expect(bytes.includes(key)).toBe(false);
    expect(bytes.includes(secret)).toBe(false);
  }
});

test('rechaza nombres y ámbitos inválidos antes de escribir', () => {
  for (const name of ['', '-inicio', 'Mayuscula', 'dos palabras', 'a_b', 'a\n', 'a'.repeat(42)]) {
    expect(() => store.createApiKey(name, 'read')).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  }
  // @ts-expect-error Un llamador JavaScript puede pasar un ámbito arbitrario.
  expect(() => store.createApiKey('lector', 'write')).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  expect(store.listApiKeys()).toEqual([]);
  store.createApiKey('a'.repeat(41), 'read');
  store.createApiKey('1', 'decide');
  expect(store.listApiKeys()).toHaveLength(2);
});

test('el nombre es único y el cupo se aplica a las 20 claves activas', () => {
  for (let i = 0; i < 20; i++) store.createApiKey(`clave-${i}`, 'read');
  expect(() => store.createApiKey('clave-0', 'decide')).toThrow(expect.objectContaining({ code: 'conflict' }));
  expect(() => store.createApiKey('extra', 'read')).toThrow(expect.objectContaining({ code: 'limit_reached' }));
  store.revokeApiKey('clave-0');
  expect(() => store.createApiKey('clave-0', 'read')).toThrow(expect.objectContaining({ code: 'conflict' }));
  store.createApiKey('extra', 'read');
  expect(store.listApiKeys()).toHaveLength(21);
  expect(store.listApiKeys().filter(key => key.revokedAt === null)).toHaveLength(20);
});

test('A12: formato inválido, id ausente, secreto distinto y hash malformado devuelven null', () => {
  const { id, key } = store.createApiKey('lector', 'read');
  const different = (c: string) => c === 'a' ? 'b' : 'a';
  const unknownId = different(id[0]!) + id.slice(1);
  const prefix = `fabk_${id}_`;
  const secret = key.slice(prefix.length);
  const wrongSecret = prefix + different(secret[0]!) + secret.slice(1);
  for (const candidate of [
    '', key.slice(5), `\n${key}`, `${key}\n`, `${key}\r\n`, `${key}\u2028`, `${key} `,
    key.slice(0, -1), `${key}=`, 'a'.repeat(10_000), key.replace(id, unknownId), wrongSecret,
  ]) {
    expect(store.verifyApiKey(candidate)).toBeNull();
  }
  store.db.query("UPDATE api_keys SET hash = '00' WHERE id = ?").run(id);
  expect(store.verifyApiKey(key)).toBeNull();
});

test('revoca por nombre o id, conserva la fecha y comunica ausencias', () => {
  const first = store.createApiKey('primera', 'read');
  const second = store.createApiKey('segunda', 'decide');
  now = revoked;
  store.revokeApiKey('primera');
  store.revokeApiKey(second.id);
  now = '2026-11-20T00:00:00.000Z';
  store.revokeApiKey(first.id);
  expect(store.verifyApiKey(first.key)).toBeNull();
  expect(store.verifyApiKey(second.key)).toBeNull();
  expect(store.listApiKeys().map(key => key.revokedAt)).toEqual([revoked, revoked]);
  expect(() => store.revokeApiKey('ausente')).toThrow(expect.objectContaining({ code: 'not_found' }));
  try {
    store.revokeApiKey(first.key);
    throw new Error('se aceptó una clave en lugar de un id o nombre');
  } catch (error) {
    expect(error).toBeInstanceOf(StoreError);
    expect((error as Error).message.includes(first.key)).toBe(false);
  }
});

test('si un id coincide con el nombre de otra clave, revoca solo el id', () => {
  const first = store.createApiKey('primera', 'read');
  const second = store.createApiKey(first.id, 'decide');
  store.revokeApiKey(first.id);
  store.revokeApiKey(first.id);
  expect(store.verifyApiKey(first.key)).toBeNull();
  expect(store.verifyApiKey(second.key)).toEqual({ id: second.id, name: first.id, scope: 'decide' });
});

test('readonly verifica y lista sin modificar ficheros, también ante una base antigua', () => {
  const { id, key } = store.createApiKey('lector', 'read');
  const path = store.dbPath;
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const checkRead = (hasKeys: boolean) => {
    const bytes = readFileSync(path);
    const mtime = statSync(path, { bigint: true }).mtimeNs;
    const files = readdirSync(dir).sort();
    const reader = new Store(path, { readonly: true });
    try {
      for (let i = 0; i < 3; i++) {
        expect(reader.verifyApiKey(key)).toEqual(hasKeys ? { id, name: 'lector', scope: 'read' } : null);
      }
      expect(reader.listApiKeys()).toHaveLength(hasKeys ? 1 : 0);
      expect(reader.db.query("SELECT 1 FROM sqlite_schema WHERE name = 'api_keys'").get() !== null).toBe(hasKeys);
    } finally {
      reader.close();
    }
    expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(statSync(path, { bigint: true }).mtimeNs === mtime).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(files);
  };

  checkRead(true);
  store.db.exec('DROP TABLE api_keys; PRAGMA wal_checkpoint(TRUNCATE)');
  checkRead(false);
  const legacyPath = join(dir, 'anterior.db');
  const legacy = new Database(legacyPath);
  legacy.exec('CREATE TABLE marcador (valor TEXT); INSERT INTO marcador VALUES (\'anterior\')');
  legacy.close();
  const writer = new Store(legacyPath);
  try {
    expect(writer.listApiKeys()).toEqual([]);
    writer.createApiKey('nueva', 'read');
    expect(writer.db.query('SELECT valor FROM marcador').get()).toEqual({ valor: 'anterior' });
  } finally {
    writer.close();
  }
});
