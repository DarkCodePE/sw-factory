import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, StoreError } from '../src/store.ts';
import {
  acceptInvitation, bootstrapOwner, changeUserRole, createUserKey, disableUser, findUserByIdentity, inviteUser, issueSession,
  listInvitations, listSessions, listUserKeys, listUsers, resolvePrincipal, revokeInvitation, revokeSession, revokeUserKey, runAs,
  teamId, verifyUserKey, actorOf, serviceActor, audit, consoleActor, enterRecovery, type Principal, type Role,
} from '../src/users.ts';

let now: number;
let dir: string;
let path: string;
let store: Store;
const clock = () => new Date(now);
const open = () => new Store(path, { clock });

beforeEach(() => {
  now = Date.parse('2026-11-22T10:00:00.000Z');
  dir = mkdtempSync(join(tmpdir(), 'fab-users-'));
  path = join(dir, 'f.db');
  store = open();
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const code = (e: unknown) => (e as StoreError).code;
const throwsCode = (fn: () => unknown, c: StoreError['code']) => { try { fn(); } catch (e) { expect(code(e)).toBe(c); return; } throw new Error('no lanzó'); };

function owner(): Principal {
  const u = bootstrapOwner(store, { issuer: 'github', subject: '1', displayName: 'Dueña', operator: 'op' });
  return login(u.id);
}
function login(userId: string, cls: 'web' | 'cli' = 'web', s: Store = store): Principal {
  return resolvePrincipal(s, issueSession(s, userId, cls).token, cls)!;
}
/** Alta por invitación completa; devuelve el principal del nuevo usuario. */
function member(by: Principal, subject: string, role: Role = 'member'): Principal {
  const inv = inviteUser(store, by, { expectedIssuer: 'github', expectedSubject: subject, role });
  const u = acceptInvitation(store, { code: inv.code, issuer: 'github', subject, displayName: `u${subject}` });
  return login(u.id);
}

test('bootstrap: equipo singleton con UUID estable, una sola vez, y se preserva al reabrir', () => {
  expect(teamId(store)).toBeNull();
  const u = bootstrapOwner(store, { issuer: 'github', subject: '1', displayName: 'A', operator: 'op' });
  const id = teamId(store)!;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(u.teamId).toBe(id);
  throwsCode(() => bootstrapOwner(store, { issuer: 'github', subject: '2', displayName: 'B', operator: 'op' }), 'conflict');
  store.close(); store = open();
  expect(teamId(store)).toBe(id);
});

test('invitación: solo el sujeto verificado esperado, una vez, sin caducar ni revocar', () => {
  const o = owner();
  const inv = inviteUser(store, o, { expectedIssuer: 'github', expectedSubject: '10', role: 'member' });
  const accept = (extra: object = {}) => () => acceptInvitation(store, { code: inv.code, issuer: 'github', subject: '10', displayName: 'X', ...extra });
  throwsCode(accept({ subject: '11' }), 'forbidden');
  throwsCode(accept({ issuer: 'google' }), 'forbidden');
  throwsCode(() => acceptInvitation(store, { code: 'x', issuer: 'github', subject: '10', displayName: 'X' }), 'forbidden');
  const u = accept()();
  expect(u.role).toBe('member');
  throwsCode(accept(), 'forbidden');

  const inv2 = inviteUser(store, o, { expectedIssuer: 'github', expectedSubject: '12', role: 'viewer' });
  revokeInvitation(store, o, inv2.id);
  throwsCode(() => acceptInvitation(store, { code: inv2.code, issuer: 'github', subject: '12', displayName: 'Y' }), 'forbidden');

  const inv3 = inviteUser(store, o, { expectedIssuer: 'github', expectedSubject: '13', role: 'viewer' });
  now += 24 * 3600_000 + 1;
  throwsCode(() => acceptInvitation(store, { code: inv3.code, issuer: 'github', subject: '13', displayName: 'Z' }), 'forbidden');
});

test('dos redenciones desde conexiones distintas crean una sola cuenta', () => {
  const o = owner();
  const inv = inviteUser(store, o, { expectedIssuer: 'github', expectedSubject: '20', role: 'member' });
  const other = open();
  try {
    const args = { code: inv.code, issuer: 'github', subject: '20', displayName: 'N' };
    acceptInvitation(store, args);
    throwsCode(() => acceptInvitation(other, args), 'forbidden');
    expect((store.db.query(`SELECT COUNT(*) n FROM users WHERE subject='20'`).get() as { n: number }).n).toBe(1);
  } finally { other.close(); }
});

test('el código de invitación no queda en claro y owner no se invita', () => {
  const o = owner();
  const inv = inviteUser(store, o, { expectedIssuer: 'github', expectedSubject: '30', role: 'member' });
  const rows = JSON.stringify(store.db.query('SELECT * FROM user_invitations').all()) + JSON.stringify(store.db.query('SELECT * FROM identity_audit').all());
  expect(rows).not.toContain(inv.code);
  throwsCode(() => inviteUser(store, o, { expectedIssuer: 'github', expectedSubject: '31', role: 'owner' }), 'invalid_input');
});

test('admin solo invita member/viewer y solo revoca las suyas; member no invita', () => {
  const o = owner();
  const a = member(o, '40', 'admin');
  const m = member(o, '41', 'member');
  throwsCode(() => inviteUser(store, a, { expectedIssuer: 'github', expectedSubject: '42', role: 'admin' }), 'forbidden');
  throwsCode(() => inviteUser(store, m, { expectedIssuer: 'github', expectedSubject: '42', role: 'viewer' }), 'forbidden');
  const ownersInv = inviteUser(store, o, { expectedIssuer: 'github', expectedSubject: '43', role: 'member' });
  throwsCode(() => revokeInvitation(store, a, ownersInv.id), 'not_found');
  const mine = inviteUser(store, a, { expectedIssuer: 'github', expectedSubject: '44', role: 'viewer' });
  revokeInvitation(store, a, mine.id);
  expect(listInvitations(store, a).map((i) => [i.id, !!i.revokedAt])).toEqual([[mine.id, true]]);
  expect(listInvitations(store, o)).toHaveLength(4);
});

test('un cambio del nombre visible no cambia la identidad; el nombre es dato', () => {
  const o = owner();
  const p = member(o, '50');
  expect(findUserByIdentity(store, 'github', '50')!.id).toBe(p.userId);
  expect(() => store.db.query(`UPDATE users SET subject = 'otro' WHERE id = ?`).run(p.userId)).toThrow(/inmutable/);
  const inv = inviteUser(store, o, { expectedIssuer: 'github', expectedSubject: '51', role: 'viewer' });
  const u = acceptInvitation(store, { code: inv.code, issuer: 'github', subject: '51', displayName: 'owner (admin)' });
  expect(u.role).toBe('viewer');
  expect(actorOf(login(u.id)).actor).toBe(`user:${u.id}`);
});

test('sesiones: caducidad web 12 h y CLI 1 h, token de otra superficie y revocación persistente', () => {
  const o = owner();
  const web = issueSession(store, o.userId, 'web'), cli = issueSession(store, o.userId, 'cli');
  expect(resolvePrincipal(store, web.token, 'web')!.via).toBe('web');
  expect(resolvePrincipal(store, cli.token, 'cli')!.via).toBe('cli');
  // T119a-H13a: el token CLI presentado como cookie web (y al revés) no resuelve.
  expect(resolvePrincipal(store, cli.token, 'web')).toBeNull();
  expect(resolvePrincipal(store, web.token, 'cli')).toBeNull();
  expect(resolvePrincipal(store, `fabk_${web.id}_${web.token.slice(-43)}`, 'web')).toBeNull();
  expect(verifyUserKey(store, web.token)).toBeNull();
  expect(resolvePrincipal(store, web.token.slice(0, -1) + (web.token.endsWith('A') ? 'B' : 'A'), 'web')).toBeNull();
  now += 3600_000 + 1;
  expect(resolvePrincipal(store, cli.token, 'cli')).toBeNull();
  expect(resolvePrincipal(store, web.token, 'web')).not.toBeNull();
  now += 11 * 3600_000;
  expect(resolvePrincipal(store, web.token, 'web')).toBeNull();
  const fresh = issueSession(store, o.userId, 'web');
  const p = resolvePrincipal(store, fresh.token, 'web')!;
  expect(listSessions(store, p).map((s) => s.current)).toEqual([true]);
  revokeSession(store, p, fresh.id);
  store.close(); store = open();
  expect(resolvePrincipal(store, fresh.token, 'web')).toBeNull();
});

test('un usuario no revoca la sesión de otro', () => {
  const o = owner();
  const m = member(o, '60');
  throwsCode(() => revokeSession(store, m, o.sessionId!), 'not_found');
  expect(resolvePrincipal(store, issueSession(store, o.userId, 'web').token, 'web')).not.toBeNull();
});

test('cambio de rol y baja invalidan sesiones y claves del afectado en la misma transacción', () => {
  const o = owner();
  const m = member(o, '70');
  const key = createUserKey(store, m, 'k1', 'read', { write: true });
  const sess = login(m.userId);
  expect(verifyUserKey(store, key.key)).not.toBeNull();
  changeUserRole(store, o, m.userId, 'admin');
  expect(resolvePrincipal(store, issueSession(store, m.userId, 'web').token, 'web')!.role).toBe('admin');
  expect(verifyUserKey(store, key.key)).toBeNull();
  expect(sess.sessionId && store.db.query('SELECT revoked_at FROM user_sessions WHERE id = ?').get(sess.sessionId)).toEqual({ revoked_at: expect.any(String) });
  const live = login(m.userId);
  disableUser(store, o, m.userId);
  expect(runAsOk(live)).toBe(false);
  throwsCode(() => issueSession(store, m.userId, 'web'), 'unauthorized');
  expect(resolvePrincipal(store, 'fabs_000000000000_' + 'A'.repeat(43), 'web')).toBeNull();
});
const runAsOk = (p: Principal) => { try { runAs(store, p, 'session/list', { write: false }, () => 1); return true; } catch { return false; } };

test('último owner: dos bajas cruzadas desde conexiones distintas dejan un owner', () => {
  const a = owner();
  const b = member(a, '80', 'member');
  changeUserRole(store, a, b.userId, 'owner');
  const ob = login(b.userId);
  const other = open();
  try {
    const bOnOther = resolvePrincipal(other, issueSession(other, b.userId, 'web').token, 'web')!;
    disableUser(store, a, b.userId);
    // b ya no es owner activo: su baja de a falla por credencial, y a sigue siendo el único.
    throwsCode(() => disableUser(other, bOnOther, a.userId), 'unauthorized');
    expect(runAsOk(ob)).toBe(false);
    throwsCode(() => disableUser(store, a, a.userId), 'conflict');
    throwsCode(() => changeUserRole(store, a, a.userId, 'admin'), 'conflict');
    expect(listUsers(store, a).filter((u) => u.role === 'owner' && !u.disabledAt)).toHaveLength(1);
  } finally { other.close(); }
});

test('último owner: con dos owners, degradaciones cruzadas conservan uno', () => {
  const a = owner();
  const b = member(a, '81');
  changeUserRole(store, a, b.userId, 'owner');
  const b2 = login(b.userId);
  changeUserRole(store, a, b.userId, 'admin');
  throwsCode(() => changeUserRole(store, b2, a.userId, 'viewer'), 'unauthorized');
  throwsCode(() => changeUserRole(store, a, a.userId, 'viewer'), 'conflict');
});

test('revocación que gana la escritura impide la mutación (conexión distinta)', () => {
  const o = owner();
  const m = member(o, '90');
  const other = open();
  try {
    let ran = 0;
    revokeSession(other, resolvePrincipal(other, issueSession(other, m.userId, 'web').token, 'web')!, m.sessionId!); // mismo usuario, otra sesión: no afecta
    expect(() => runAs(store, m, 'session/list', { write: false }, () => ran++)).toThrow();
    ran = 0;
    const live = login(m.userId);
    disableUser(other, resolvePrincipal(other, issueSession(other, o.userId, 'web').token, 'web')!, m.userId);
    throwsCode(() => runAs(store, live, 'session/list', { write: false }, () => ran++), 'unauthorized');
    expect(ran).toBe(0);
  } finally { other.close(); }
});

test('rol cambiado tras resolver: el principal viejo no opera con el rol antiguo', () => {
  const o = owner();
  const a = member(o, '91', 'admin');
  const stale = resolvePrincipal(store, issueSession(store, a.userId, 'web').token, 'web')!;
  changeUserRole(store, o, a.userId, 'viewer');
  throwsCode(() => inviteUser(store, stale, { expectedIssuer: 'github', expectedSubject: '92', role: 'member' }), 'unauthorized');
});

test('claves: viewer rechazado (D-2 A), mismo nombre por usuario, valor solo al crear', () => {
  const o = owner();
  const v = member(o, '100', 'viewer');
  throwsCode(() => createUserKey(store, v, 'v1', 'read', { write: true }), 'forbidden');
  const m1 = member(o, '101'), m2 = member(o, '102');
  const k1 = createUserKey(store, m1, 'ci', 'read', { write: true }), k2 = createUserKey(store, m2, 'ci', 'decide', { write: true });
  throwsCode(() => createUserKey(store, m1, 'ci', 'read', { write: true }), 'conflict');
  expect(JSON.stringify(listUserKeys(store, m1))).not.toContain(k1.key.slice(-43));
  expect(listUserKeys(store, m1).map((k) => k.id)).toEqual([k1.id]);
  throwsCode(() => listUserKeys(store, m1, { all: true }), 'forbidden');
  expect(listUserKeys(store, o, { all: true }).map((k) => k.id).sort()).toEqual([k1.id, k2.id].sort());
  const p = verifyUserKey(store, k2.key)!;
  expect(p).toMatchObject({ userId: m2.userId, role: 'member', via: 'api', keyScope: 'decide', keyId: k2.id });
  // Se revalida en la escritura.
  expect(runAs(store, p, 'changes/note', { write: true }, () => 'ok')).toBe('ok');
  // El digest de una clave de usuario no autentica como clave local, ni al revés.
  expect(store.verifyApiKey(k1.key)).toBeNull();
  const local = store.createApiKey('ci', 'read');
  expect(verifyUserKey(store, local.key)).toBeNull();
});

test('un viewer con clave previa (fila forzada) tampoco autentica', () => {
  const o = owner();
  const m = member(o, '110');
  const k = createUserKey(store, m, 'x', 'read', { write: true });
  store.db.query(`UPDATE users SET role = 'viewer' WHERE id = ?`).run(m.userId);
  expect(verifyUserKey(store, k.key)).toBeNull();
});

test('revocar clave: por ID, la propia o cualquiera si es owner; ajena sin ser owner no', () => {
  const o = owner();
  const a = member(o, '120', 'admin'), m = member(o, '121');
  const km = createUserKey(store, m, 'k', 'read', { write: true }), ka = createUserKey(store, a, 'k', 'read', { write: true });
  throwsCode(() => revokeUserKey(store, a, km.id, true), 'forbidden');
  throwsCode(() => revokeUserKey(store, m, 'ffffffffffff', true), 'not_found');
  revokeUserKey(store, m, km.id, true);
  expect(verifyUserKey(store, km.key)).toBeNull();
  revokeUserKey(store, o, ka.id, true);
  expect(verifyUserKey(store, ka.key)).toBeNull();
  const audit = store.db.query(`SELECT detail FROM identity_audit WHERE action = 'key.revoke' ORDER BY seq DESC LIMIT 1`).get() as { detail: string };
  expect(JSON.parse(audit.detail)).toEqual({ ownerId: a.userId });
});

test('clave caducada no autentica', () => {
  const o = owner();
  const k = createUserKey(store, o, 'temp', 'read', { write: true, expiresAt: new Date(now + 1000).toISOString() });
  expect(verifyUserKey(store, k.key)).not.toBeNull();
  now += 2000;
  expect(verifyUserKey(store, k.key)).toBeNull();
});

test('actor estable: el evento guarda ID, origen y no el nombre visible; sin actor explícito conserva el comportamiento anterior', () => {
  const o = owner();
  const ws = store.createWorkstream({ slug: 'w', goal: 'g', repo: dir });
  store.event(ws.id, 'info', 'a', undefined, undefined, actorOf(o));
  store.event(ws.id, 'info', 'b', undefined, undefined, serviceActor('pool', 'vm'));
  store.event(ws.id, 'info', 'c');
  const rows = store.db.query('SELECT actor, actor_user_id, actor_source FROM events WHERE message IN (\'a\',\'b\',\'c\') ORDER BY id').all();
  expect(rows).toEqual([
    { actor: `user:${o.userId}`, actor_user_id: o.userId, actor_source: 'web' },
    { actor: 'service:pool:vm', actor_user_id: null, actor_source: 'service' },
    { actor: expect.any(String), actor_user_id: null, actor_source: null },
  ]);
});

test('auditoría de identidad: una fila por mutación, sin tokens ni nombres visibles', () => {
  const o = owner();
  const m = member(o, '130');
  const k = createUserKey(store, m, 'k', 'read', { write: true });
  changeUserRole(store, o, m.userId, 'admin');
  const all = JSON.stringify(store.db.query('SELECT * FROM identity_audit').all());
  for (const secret of [k.key.slice(-43), m.sessionId ? 'u130' : '', 'Dueña']) expect(all).not.toContain(secret);
  const actions = (store.db.query('SELECT action FROM identity_audit ORDER BY seq').all() as { action: string }[]).map((r) => r.action);
  expect(actions).toEqual(expect.arrayContaining(['user.bootstrap', 'session.issue', 'invitation.create', 'invitation.accept', 'key.create', 'user.role']));
});

test('T119a-H5: una invitación pendiente no sobrevive a la degradación ni a la baja de quien la emitió', () => {
  const o = owner();
  const b = member(o, '200', 'admin');
  const inv = inviteUser(store, b, { expectedIssuer: 'github', expectedSubject: '201', role: 'member' });
  changeUserRole(store, o, b.userId, 'member');
  throwsCode(() => acceptInvitation(store, { code: inv.code, issuer: 'github', subject: '201', displayName: 'x' }), 'forbidden');
  // Otro caso: un owner con una invitación a admin, degradado a viewer.
  const c = member(o, '202', 'admin');
  changeUserRole(store, o, c.userId, 'owner');
  const co = login(c.userId);
  const adm = inviteUser(store, co, { expectedIssuer: 'github', expectedSubject: '203', role: 'admin' });
  changeUserRole(store, o, c.userId, 'viewer');
  throwsCode(() => acceptInvitation(store, { code: adm.code, issuer: 'github', subject: '203', displayName: 'x' }), 'forbidden');
  // La baja también.
  const d = member(o, '204', 'admin');
  const inv2 = inviteUser(store, d, { expectedIssuer: 'github', expectedSubject: '205', role: 'viewer' });
  disableUser(store, o, d.userId);
  throwsCode(() => acceptInvitation(store, { code: inv2.code, issuer: 'github', subject: '205', displayName: 'x' }), 'forbidden');
  expect(findUserByIdentity(store, 'github', '203')).toBeNull();
});

test('T119a-H7: la caducidad de una clave se normaliza a UTC y no admite fechas pasadas', () => {
  const o = owner();
  throwsCode(() => createUserKey(store, o, 'pasada', 'read', { write: true, expiresAt: new Date(now - 1000).toISOString() }), 'invalid_input');
  throwsCode(() => createUserKey(store, o, 'mala', 'read', { write: true, expiresAt: 'no-es-fecha' }), 'invalid_input');
  // 12:00 en +05:00 son las 07:00Z, anterior a «ahora» (10:00Z): no se acepta como si fuera futura.
  throwsCode(() => createUserKey(store, o, 'zona', 'read', { write: true, expiresAt: '2026-11-22T12:00:00+05:00' }), 'invalid_input');
  // Un formato libre se guarda en ISO y caduca a su hora real (13:00Z).
  const k = createUserKey(store, o, 'libre', 'read', { write: true, expiresAt: '2026-11-22T18:00:00+05:00' });
  expect(store.db.query('SELECT expires_at FROM api_keys WHERE id = ?').get(k.id)).toEqual({ expires_at: '2026-11-22T13:00:00.000Z' });
  now = Date.parse('2026-11-22T13:00:01.000Z');
  expect(verifyUserKey(store, k.key)).toBeNull();
});

test('T119a-H11: las claves de usuario llevan prefijo propio y no valen como claves locales ni al revés', () => {
  const o = owner();
  const k = createUserKey(store, o, 'prefijo', 'decide', { write: true });
  expect(k.key).toMatch(/^fabu_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/);
  expect(verifyUserKey(store, k.key)).not.toBeNull();
  // Con el prefijo de las claves locales, el mismo secreto no autentica por ninguna vía.
  const asLocal = k.key.replace('fabu_', 'fabk_');
  expect(verifyUserKey(store, asLocal)).toBeNull();
  expect(store.verifyApiKey(asLocal)).toBeNull();
  expect(store.verifyApiKey(k.key)).toBeNull();
  const local = store.createApiKey('local', 'read');
  expect(local.key.startsWith('fabk_')).toBe(true);
  expect(verifyUserKey(store, local.key.replace('fabk_', 'fabu_'))).toBeNull();
});

test('T119a-H13: --write en las claves, runAs síncrono, auditoría exportada con op_id del llamador y clase de sesión', () => {
  const o = owner();
  // (b) Un servidor sin --write no crea ni revoca claves.
  throwsCode(() => createUserKey(store, o, 'sinwrite', 'read', { write: false }), 'forbidden');
  const k = createUserKey(store, o, 'conwrite', 'read', { write: true });
  throwsCode(() => revokeUserKey(store, o, k.id, false), 'forbidden');
  expect(verifyUserKey(store, k.key)).not.toBeNull();
  // (c) Una fn asíncrona se rechaza y su efecto se deshace.
  expect(() => runAs(store, o, 'session/list', { write: false }, (() => {
    store.db.query(`INSERT INTO identity_audit (op_id, at, actor, actor_source, action, result) VALUES ('x','t','a','cli','x','ok')`).run();
    return Promise.resolve(1);
  }) as never)).toThrow('síncrona');
  expect(store.db.query(`SELECT 1 FROM identity_audit WHERE op_id = 'x'`).get()).toBeNull();
  // (d) El llamador aporta el ID de la operación; repetirlo no duplica el asiento.
  audit(store, serviceActor('channel', 'c1'), 'provider.revoke-failed', null, { why: 'timeout' }, 'error', 'op-ajena-1');
  expect(store.db.query(`SELECT action, result, actor FROM identity_audit WHERE op_id = 'op-ajena-1'`).get())
    .toEqual({ action: 'provider.revoke-failed', result: 'error', actor: 'service:channel:c1' });
  expect(() => audit(store, consoleActor('op'), 'otra', null, undefined, 'ok', 'op-ajena-1')).toThrow();
});

test('T119a-H16: revalidación por clave, sin credencial y con sesión caducada', () => {
  const o = owner();
  const m = member(o, '300');
  const k = createUserKey(store, m, 'rev', 'decide', { write: true });
  const viaKey = verifyUserKey(store, k.key)!;
  expect(runAs(store, viaKey, 'changes/note', { write: true }, () => 'ok')).toBe('ok');
  // Caducada entre resolver y escribir.
  const short = createUserKey(store, m, 'corta', 'decide', { write: true, expiresAt: new Date(now + 1000).toISOString() });
  const pShort = verifyUserKey(store, short.key)!;
  now += 2000;
  throwsCode(() => runAs(store, pShort, 'changes/note', { write: true }, () => 1), 'unauthorized');
  // Revocada entre resolver y escribir.
  revokeUserKey(store, m, k.id, true);
  throwsCode(() => runAs(store, viaKey, 'changes/note', { write: true }, () => 1), 'unauthorized');
  // Principal sin sesión ni clave.
  throwsCode(() => runAs(store, { ...m, sessionId: undefined, keyId: undefined }, 'session/list', { write: false }, () => 1), 'unauthorized');
  // Sesión caducada entre resolver y escribir.
  const p = login(m.userId);
  now += 13 * 3600_000;
  throwsCode(() => runAs(store, p, 'session/list', { write: false }, () => 1), 'unauthorized');
});

test('T119a-H16: id correcto con secreto incorrecto no autentica; tope de claves activas por usuario', () => {
  const o = owner();
  const k = createUserKey(store, o, 'real', 'read', { write: true });
  const wrong = k.key.slice(0, -1) + (k.key.endsWith('A') ? 'B' : 'A');
  expect(verifyUserKey(store, k.key)).not.toBeNull();
  expect(verifyUserKey(store, wrong)).toBeNull();
  for (let i = 1; i < 20; i++) createUserKey(store, o, `k${i}`, 'read', { write: true });
  throwsCode(() => createUserKey(store, o, 'k-extra', 'read', { write: true }), 'limit_reached');
});

test('T119a-H16: invitaciones con el emisor dado de baja por SQL y las pendientes al entrar en recuperación no se canjean', () => {
  const o = owner();
  const a = member(o, '310', 'admin');
  const inv = inviteUser(store, a, { expectedIssuer: 'github', expectedSubject: '311', role: 'member' });
  store.db.query('UPDATE users SET disabled_at = ? WHERE id = ?').run(store.now(), a.userId); // sin pasar por disableUser
  throwsCode(() => acceptInvitation(store, { code: inv.code, issuer: 'github', subject: '311', displayName: 'x' }), 'forbidden');
  const inv2 = inviteUser(store, o, { expectedIssuer: 'github', expectedSubject: '312', role: 'member' });
  enterRecovery(store, 'op', 'x', o.userId);
  throwsCode(() => acceptInvitation(store, { code: inv2.code, issuer: 'github', subject: '312', displayName: 'x' }), 'forbidden');
});

test('T119a-H16: Store separa claves locales y de usuario en lista, revocación y nombres', () => {
  const o = owner();
  const uk = createUserKey(store, o, 'ci', 'read', { write: true });
  const local = store.createApiKey('ci', 'read'); // mismo nombre que una de usuario: permitido
  expect(store.listApiKeys().map((k) => k.id)).toEqual([local.id]);
  expect(() => store.revokeApiKey(uk.id)).toThrow(/no encontrada/);
  expect(() => store.revokeApiKey('ci')).not.toThrow(); // por nombre: solo la local
  expect(verifyUserKey(store, uk.key)).not.toBeNull();
  expect(store.verifyApiKey(local.key)).toBeNull(); // revocada
});
