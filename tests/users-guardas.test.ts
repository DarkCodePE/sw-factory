import { afterEach, beforeEach, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, StoreError, API_KEY_ACTIVE_LIMIT } from '../src/store.ts';
import {
  acceptInvitation, audit, bootstrapOwner, changeUserRole, confirmRecovery, consoleActor, createUserKey, declareNoJournal, disableUser, enterRecovery,
  exportIdentityJournal, inviteUser, issueSession, resolvePrincipal, revalidatePrincipal, revokeUserKey, runAs, verifyIdentityJournal,
  type Principal, type Role,
} from '../src/users.ts';

// T119a-H21: guardas que funcionan pero ningún test afirmaba. Cada test nombra la mutación que mata.

let dir: string;
let store: Store;
let n = 0;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fab-guardas-')); store = new Store(join(dir, 'f.db')); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const login = (id: string) => resolvePrincipal(store, issueSession(store, id, 'web').token, 'web')!;
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as StoreError).code; } return 'no lanzó'; };
const boot = () => bootstrapOwner(store, { issuer: 'github', subject: 'root', displayName: 'A', operator: 'op' });
function add(by: Principal, role: Role): string {
  const sub = `s${++n}`;
  const inv = inviteUser(store, by, { expectedIssuer: 'github', expectedSubject: sub, role });
  return acceptInvitation(store, { code: inv.code, issuer: 'github', subject: sub, displayName: sub }).id;
}
const lineCount = (j: string) => readFileSync(j, 'utf8').split('\n').filter(Boolean).length;

test('U5b: una sesión de otro usuario no revalida a este principal', () => {
  const a = login(boot().id);
  const bId = add(a, 'member');
  const b = login(bId);
  expect(code(() => runAs(store, { ...a, sessionId: b.sessionId }, 'user/list', { write: false }, () => 1))).toBe('unauthorized');
});

test('U9b: revalidar refresca `recovery` aunque el principal traiga recovery:false', () => {
  const a = boot();
  enterRecovery(store, 'op', 'x', a.id);
  declareNoJournal(store, 'op', 'sin diario');
  const p = login(a.id);
  const forged = { ...p, recovery: false };
  expect(revalidatePrincipal(store, forged).recovery).toBe(true);
  expect(code(() => runAs(store, forged, 'user/list', { write: false }, () => 1))).toBe('forbidden');
});

test('U39b: una clave local (sin usuario) no se revoca por la vía de usuario, ni siquiera por su dueño', () => {
  const o = login(boot().id);
  const local = store.createApiKey('local', 'read');
  expect(code(() => revokeUserKey(store, o, local.id, true))).toBe('not_found');
  expect(store.verifyApiKey(local.key)).not.toBeNull();
});

test('S5: el tope de claves locales no cuenta las de usuario', () => {
  const o = login(boot().id);
  for (let i = 0; i < API_KEY_ACTIVE_LIMIT; i++) createUserKey(store, o, `k${i}`, 'read', { write: true });
  expect(() => store.createApiKey('local', 'read')).not.toThrow();
});

test('U51r: reexportar asientos ya escritos pero sin marcar no duplica líneas', () => {
  const j = join(dir, 'identity.jsonl');
  const a = login(boot().id);
  add(a, 'viewer');
  const { exported } = exportIdentityJournal(store, j);
  store.db.exec('UPDATE identity_audit SET exported_at = NULL'); // caída entre escribir y marcar
  expect(exportIdentityJournal(store, j).exported).toBe(0);
  expect(lineCount(j)).toBe(exported);
  expect(store.db.query('SELECT COUNT(*) n FROM identity_audit WHERE exported_at IS NULL').get()).toEqual({ n: 0 });
});

test('U51w: la línea cortada se trunca por bytes, no por caracteres (diario con UTF-8 multibyte)', () => {
  const j = join(dir, 'identity.jsonl');
  boot();
  audit(store, consoleActor('op'), 'nota', null, { reason: 'ñandú ✓ 日本語' });
  const first = exportIdentityJournal(store, j);
  const intact = readFileSync(j, 'utf8');
  appendFileSync(j, '{"seq":99,"opId":"a medias');
  audit(store, consoleActor('op'), 'otra', null, { reason: 'ç' });
  exportIdentityJournal(store, j);
  expect(verifyIdentityJournal(j)).toMatchObject({ ok: true, truncated: false, gaps: [], brokenAt: null, lastSeq: first.lastSeq + 1 });
  expect(readFileSync(j, 'utf8').startsWith(intact)).toBe(true);
});

test('U63: restringido sin asiento recovery.enter: nadie abre sesión ni resuelve', () => {
  const a = boot();
  const p = login(a.id);
  store.db.exec(`UPDATE team SET recovery = 'restricted'`);
  expect(resolvePrincipal(store, issueSessionRaw(a.id), 'web')).toBeNull();
  expect(code(() => issueSession(store, a.id, 'web'))).toBe('unauthorized');
  expect(code(() => runAs(store, p, 'user/list', { write: false }, () => 1))).toBe('forbidden');
});
// En restricción solo el designado resuelve; sin asiento no hay designado, así que se fuerza una sesión por SQL.
function issueSessionRaw(userId: string): string {
  const id = 'abcabcabcabc', secret = 'A'.repeat(43);
  const d = new Bun.CryptoHasher('sha256').update(secret).digest('hex');
  store.db.query(`INSERT INTO user_sessions (id, user_id, class, token_digest, created_at, expires_at) VALUES (?, ?, 'web', ?, ?, '2999-01-01T00:00:00.000Z')`).run(id, userId, d, store.now());
  return `fabs_${id}_${secret}`;
}

test('U64r: un «sin diario» anterior a la última entrada no cuenta para confirmar', () => {
  const a = boot();
  enterRecovery(store, 'op', 'primera', a.id);
  declareNoJournal(store, 'op', 'sin diario');
  enterRecovery(store, 'op', 'segunda', a.id); // nueva entrada: hay que declarar de nuevo
  const p = login(a.id);
  expect(code(() => confirmRecovery(store, p, [{ userId: a.id, role: 'owner' }]))).toBe('conflict');
  declareNoJournal(store, 'op', 'sin diario otra vez');
  expect(code(() => confirmRecovery(store, p, [{ userId: a.id, role: 'owner' }]))).toBe('no lanzó');
});

test('U66: el designado debe ser owner', () => {
  const a = login(boot().id);
  const m = add(a, 'member');
  expect(code(() => enterRecovery(store, 'op', 'x', m))).toBe('invalid_input');
  expect(store.db.query(`SELECT recovery FROM team`).get()).toEqual({ recovery: null });
});

test('U66b: el designado no puede estar de baja', () => {
  const a = login(boot().id);
  const b = add(a, 'member');
  changeUserRole(store, a, b, 'owner');
  disableUser(store, a, b);
  expect(code(() => enterRecovery(store, 'op', 'x', b))).toBe('invalid_input');
  expect(store.db.query(`SELECT recovery FROM team`).get()).toEqual({ recovery: null });
});

test('U67: «sin diario» solo vale dentro de una recuperación restringida', () => {
  boot();
  expect(code(() => declareNoJournal(store, 'op', 'sin diario'))).toBe('conflict');
  expect(store.db.query(`SELECT COUNT(*) n FROM identity_audit WHERE action = 'recovery.no-journal'`).get()).toEqual({ n: 0 });
});
