/**
 * Identidad del modo servidor (T119a): equipo singleton, usuarios, invitaciones, sesiones, claves por usuario,
 * diario de identidad y recuperación restringida. Diseño T118–T119 §2–§4.
 *
 * Contrato para T119b–e:
 *  - Un `Principal` solo sale de `resolvePrincipal` (sesión) o `verifyUserKey` (clave). Nunca del cuerpo de la petición.
 *  - Toda mutación pasa por `runAs`, que en una transacción inmediata revalida usuario, rol, credencial y recuperación
 *    y aplica `authorize`. Una revocación que gana la escritura impide la mutación.
 *  - `authorize` comprueba `--write` con `ctx.write`; las funciones de este módulo, que son de dominio, pasan `write: true`
 *    y dejan ese filtro al despacho HTTP/CLI.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { authorize, type PolicyContext, type Role, type Via } from './policy.ts';
import { API_KEY_ACTIVE_LIMIT, StoreError, type Store } from './store.ts';

export type { Role, Via } from './policy.ts';
export type ActorSource = 'web' | 'cli' | 'api' | 'console' | 'service' | 'channel';
export const SESSION_TTL_MS = { web: 12 * 3600_000, cli: 3600_000 } as const;
export const INVITATION_TTL_MS = 24 * 3600_000;

/** Quién actúa, de forma estable: ID de usuario, no nombre visible. */
export interface Actor { actor: string; userId: string | null; source: ActorSource }

export interface Principal {
  userId: string;
  role: Role;
  issuer: string;
  subject: string;
  displayName: string;
  via: Via;
  sessionId?: string;
  keyId?: string;
  keyScope?: 'read' | 'decide';
  /** El equipo está en recuperación restringida: solo `recovery/confirm`. */
  recovery: boolean;
}

export interface User {
  id: string; issuer: string; subject: string; displayName: string; teamId: string;
  role: Role; createdAt: string; disabledAt: string | null;
}

export const actorOf = (p: Principal): Actor => ({ actor: `user:${p.userId}`, userId: p.userId, source: p.via });
export const consoleActor = (osUser: string): Actor => ({ actor: `console:${osUser}`, userId: null, source: 'console' });
export const serviceActor = (kind: 'pool' | 'runner' | 'channel', id: string): Actor =>
  ({ actor: `service:${kind}:${id}`, userId: null, source: kind === 'channel' ? 'channel' : 'service' });

type Row = Record<string, unknown>;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const sameDigest = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const iso = (store: Store, plusMs = 0) => new Date(store.clock().getTime() + plusMs).toISOString();

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) {
    throw new StoreError('invalid_input', `${what} inválido`);
  }
  return v.trim();
}

const toUser = (r: Row): User => ({
  id: r.id as string, issuer: r.issuer as string, subject: r.subject as string, displayName: r.display_name as string,
  teamId: r.team_id as string, role: r.role as Role, createdAt: r.created_at as string, disabledAt: (r.disabled_at as string | null) ?? null,
});

// ---- auditoría ------------------------------------------------------------

/** Asiento en la misma transacción que la mutación. Sin contenido sensible: ni tokens, ni códigos, ni nombres visibles. */
function audit(store: Store, actor: Actor, action: string, object: string | null, detail?: Record<string, unknown>, result = 'ok'): void {
  store.db.query(
    `INSERT INTO identity_audit (op_id, at, actor, actor_user_id, actor_source, action, object, detail, result) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(randomUUID(), store.now(), actor.actor, actor.userId, actor.source, action, object, detail ? JSON.stringify(detail) : null, result);
}

// ---- equipo y bootstrap ---------------------------------------------------

export function teamId(store: Store): string | null {
  return (store.db.query('SELECT id FROM team WHERE singleton = 1').get() as { id: string } | null)?.id ?? null;
}
export const isBootstrapped = (store: Store): boolean => teamId(store) !== null;

/** Primer owner, desde la consola, una sola vez. El UUID del equipo nace aquí y no cambia. */
export function bootstrapOwner(store: Store, input: { issuer: string; subject: string; displayName: string; operator: string }): User {
  const issuer = text(input.issuer, 'emisor', 200), subject = text(input.subject, 'sujeto', 200);
  const displayName = text(input.displayName, 'nombre', 100);
  return store.withRetry(() => {
    if (isBootstrapped(store)) throw new StoreError('conflict', 'el equipo ya tiene bootstrap');
    const team = randomUUID(), id = randomUUID(), at = store.now();
    store.db.query('INSERT INTO team (singleton, id, created_at) VALUES (1, ?, ?)').run(team, at);
    store.db.query(`INSERT INTO users (id, issuer, subject, display_name, team_id, role, created_at) VALUES (?,?,?,?,?,'owner',?)`)
      .run(id, issuer, subject, displayName, team, at);
    audit(store, consoleActor(input.operator), 'user.bootstrap', id, { role: 'owner' });
    return getUser(store, id)!;
  });
}

export function getUser(store: Store, id: string): User | null {
  const r = store.db.query('SELECT * FROM users WHERE id = ?').get(id) as Row | null;
  return r ? toUser(r) : null;
}
export function findUserByIdentity(store: Store, issuer: string, subject: string): User | null {
  const r = store.db.query('SELECT * FROM users WHERE issuer = ? AND subject = ?').get(issuer, subject) as Row | null;
  return r ? toUser(r) : null;
}

const recoveryRestricted = (store: Store): boolean =>
  (store.db.query('SELECT recovery FROM team WHERE singleton = 1').get() as { recovery: string | null } | null)?.recovery === 'restricted';

/** Owner designado por el operador al entrar y si consta el diario aplicado (o un «sin diario» explícito) desde esa entrada. */
function recoveryState(store: Store): { ownerId: string | null; journalDone: boolean } | null {
  if (!recoveryRestricted(store)) return null;
  const enter = store.db.query(`SELECT seq, detail FROM identity_audit WHERE action = 'recovery.enter' ORDER BY seq DESC LIMIT 1`).get() as { seq: number; detail: string | null } | null;
  if (!enter) return { ownerId: null, journalDone: false }; // restringido sin asiento de entrada: nadie entra
  const done = store.db.query(`SELECT 1 FROM identity_audit WHERE action IN ('recovery.apply-journal','recovery.no-journal') AND seq > ?`).get(enter.seq);
  return { ownerId: (JSON.parse(enter.detail ?? '{}') as { ownerId?: string }).ownerId ?? null, journalDone: !!done };
}

// ---- revalidación y ejecución autorizada -----------------------------------

function activeOwners(store: Store, excluding?: string): number {
  return (store.db.query(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND disabled_at IS NULL AND id != ?`)
    .get(excluding ?? '') as { n: number }).n;
}

/** Vuelve a leer usuario, rol, credencial y recuperación. Lanza `unauthorized` si algo cambió. Debe llamarse dentro de la escritura. */
export function revalidatePrincipal(store: Store, p: Principal): Principal {
  const u = getUser(store, p.userId);
  const now = store.now();
  if (!u || u.disabledAt || u.role !== p.role) throw new StoreError('unauthorized', 'credencial no válida');
  if (p.sessionId) {
    const s = store.db.query('SELECT 1 FROM user_sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?').get(p.sessionId, p.userId, now);
    if (!s) throw new StoreError('unauthorized', 'credencial no válida');
  } else if (p.keyId) {
    const k = store.db.query('SELECT 1 FROM api_keys WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)').get(p.keyId, p.userId, now);
    if (!k) throw new StoreError('unauthorized', 'credencial no válida');
  } else throw new StoreError('unauthorized', 'credencial no válida');
  return { ...p, recovery: recoveryRestricted(store) };
}

/** Transacción inmediata: revalida el principal, aplica la política y ejecuta `fn` con el principal fresco. */
export function runAs<T>(store: Store, p: Principal, capability: string, ctx: Omit<PolicyContext, 'via'>, fn: (fresh: Principal) => T): T {
  return store.withRetry(() => {
    const fresh = revalidatePrincipal(store, p);
    const d = authorize(fresh, capability, { ...ctx, via: fresh.via, keyScope: fresh.keyScope });
    if (!d.ok) throw new StoreError('forbidden', `no autorizado (${d.reason})`);
    return fn(fresh);
  });
}

// ---- sesiones -------------------------------------------------------------

export function issueSession(store: Store, userId: string, cls: 'web' | 'cli'): { id: string; token: string; expiresAt: string } {
  return store.withRetry(() => {
    const u = getUser(store, userId);
    // Misma respuesta para cuenta inexistente, baja o recuperación sin ser el owner designado.
    const rec = recoveryState(store);
    if (!u || u.disabledAt || (rec && u.id !== rec.ownerId)) throw new StoreError('unauthorized', 'no se puede iniciar sesión');
    const id = randomBytes(6).toString('hex'), secret = randomBytes(32).toString('base64url');
    const expiresAt = iso(store, SESSION_TTL_MS[cls]);
    store.db.query('INSERT INTO user_sessions (id, user_id, class, token_digest, created_at, expires_at) VALUES (?,?,?,?,?,?)')
      .run(id, userId, cls, sha(secret), store.now(), expiresAt);
    audit(store, { actor: `user:${u.id}`, userId: u.id, source: cls }, 'session.issue', id, { class: cls });
    return { id, token: `fabs_${id}_${secret}`, expiresAt };
  });
}

export function resolvePrincipal(store: Store, token: string): Principal | null {
  const m = /^fabs_([a-f0-9]{12})_([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const s = store.db.query('SELECT * FROM user_sessions WHERE id = ?').get(m[1]!) as Row | null;
  if (!s || s.revoked_at || (s.expires_at as string) <= store.now() || !sameDigest(s.token_digest as string, sha(m[2]!))) return null;
  const u = getUser(store, s.user_id as string);
  if (!u || u.disabledAt) return null;
  const rec = recoveryState(store);
  if (rec && u.id !== rec.ownerId) return null;
  return { userId: u.id, role: u.role, issuer: u.issuer, subject: u.subject, displayName: u.displayName,
    via: s.class as 'web' | 'cli', sessionId: s.id as string, recovery: !!rec };
}

export function revokeSession(store: Store, p: Principal, sessionId: string): void {
  runAs(store, p, 'session/revoke', { write: true }, (me) => {
    const { changes } = store.db.query('UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .run(store.now(), sessionId, me.userId);
    if (!changes) throw new StoreError('not_found', 'sesión no encontrada');
    audit(store, actorOf(me), 'session.revoke', sessionId);
  });
}

export function listSessions(store: Store, p: Principal): { id: string; class: string; createdAt: string; expiresAt: string; current: boolean }[] {
  return runAs(store, p, 'session/list', { write: false }, (me) =>
    (store.db.query('SELECT id, class, created_at, expires_at FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at')
      .all(me.userId, store.now()) as Row[]).map((r) => ({
      id: r.id as string, class: r.class as string, createdAt: r.created_at as string, expiresAt: r.expires_at as string, current: r.id === me.sessionId })));
}

/** Corta todas las sesiones y claves del usuario, en la transacción del cambio que lo exige. */
function cutCredentials(store: Store, userId: string): void {
  store.db.query('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?').run(store.now(), userId);
  store.db.query('UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?').run(store.now(), userId);
}

// ---- usuarios -------------------------------------------------------------

export function listUsers(store: Store, p: Principal): User[] {
  return runAs(store, p, 'user/list', { write: false }, () =>
    (store.db.query('SELECT * FROM users ORDER BY created_at, id').all() as Row[]).map(toUser));
}

function target(store: Store, id: string): User {
  const u = getUser(store, id);
  if (!u) throw new StoreError('not_found', 'usuario no encontrado');
  return u;
}

/** Cambia el rol e invalida todas las sesiones y claves del afectado. Promover a owner exige un owner distinto del afectado. */
export function changeUserRole(store: Store, p: Principal, userId: string, role: Role): User {
  if (!['owner', 'admin', 'member', 'viewer'].includes(role)) throw new StoreError('invalid_input', 'rol inválido');
  return runAs(store, p, 'user/role', { write: true }, (me) => {
    const u = target(store, userId);
    if (u.disabledAt) throw new StoreError('conflict', 'el usuario está dado de baja');
    if (u.role === role) return u;
    if (u.role === 'owner' && activeOwners(store, u.id) < 1) throw new StoreError('conflict', 'debe quedar al menos un owner activo');
    store.db.query('UPDATE users SET role = ? WHERE id = ?').run(role, u.id);
    cutCredentials(store, u.id);
    audit(store, actorOf(me), 'user.role', u.id, { from: u.role, to: role });
    return getUser(store, u.id)!;
  });
}

export function disableUser(store: Store, p: Principal, userId: string): void {
  runAs(store, p, 'user/disable', { write: true }, (me) => {
    const u = target(store, userId);
    if (u.disabledAt) return;
    if (u.role === 'owner' && activeOwners(store, u.id) < 1) throw new StoreError('conflict', 'debe quedar al menos un owner activo');
    store.db.query('UPDATE users SET disabled_at = ? WHERE id = ?').run(store.now(), u.id);
    cutCredentials(store, u.id);
    audit(store, actorOf(me), 'user.disable', u.id, { role: u.role });
  });
}

// ---- invitaciones ---------------------------------------------------------

export interface Invitation { id: string; inviterId: string; expectedIssuer: string; expectedSubject: string; role: Role; createdAt: string; expiresAt: string; consumedAt: string | null; revokedAt: string | null }
const toInvitation = (r: Row): Invitation => ({ id: r.id as string, inviterId: r.inviter_id as string, expectedIssuer: r.expected_issuer as string,
  expectedSubject: r.expected_subject as string, role: r.role as Role, createdAt: r.created_at as string, expiresAt: r.expires_at as string,
  consumedAt: (r.consumed_at as string | null) ?? null, revokedAt: (r.revoked_at as string | null) ?? null });

/** El código se devuelve una vez; en la base solo queda su digest. No se invita a owner: se promueve a un usuario activo. */
export function inviteUser(store: Store, p: Principal, input: { expectedIssuer: string; expectedSubject: string; role: Role }): { id: string; code: string; expiresAt: string } {
  const expectedIssuer = text(input.expectedIssuer, 'emisor', 200), expectedSubject = text(input.expectedSubject, 'sujeto', 200);
  if (!['admin', 'member', 'viewer'].includes(input.role)) throw new StoreError('invalid_input', 'rol de invitación inválido');
  return runAs(store, p, 'user/invite', { write: true, inviteRole: input.role }, (me) => {
    const id = randomUUID(), code = randomBytes(24).toString('base64url'), expiresAt = iso(store, INVITATION_TTL_MS);
    store.db.query(`INSERT INTO user_invitations (id, inviter_id, expected_issuer, expected_subject, role, code_digest, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, me.userId, expectedIssuer, expectedSubject, input.role, sha(code), store.now(), expiresAt);
    audit(store, actorOf(me), 'invitation.create', id, { role: input.role });
    return { id, code, expiresAt };
  });
}

/** Canje atómico con identidad ya verificada por el proveedor. Todo fallo da el mismo error. */
export function acceptInvitation(store: Store, input: { code: string; issuer: string; subject: string; displayName: string }): User {
  const fail = () => new StoreError('forbidden', 'invitación no válida');
  if (typeof input.code !== 'string' || input.code.length > 200) throw fail();
  const displayName = text(input.displayName, 'nombre', 100);
  return store.withRetry(() => {
    const row = store.db.query('SELECT * FROM user_invitations WHERE code_digest = ?').get(sha(input.code)) as Row | null;
    if (!row) throw fail();
    const inv = toInvitation(row);
    const inviter = getUser(store, inv.inviterId), team = teamId(store);
    if (inv.consumedAt || inv.revokedAt || inv.expiresAt <= store.now() || !team || !inviter || inviter.disabledAt
        || inv.expectedIssuer !== input.issuer || inv.expectedSubject !== input.subject
        || findUserByIdentity(store, input.issuer, input.subject)) throw fail();
    const id = randomUUID();
    store.db.query(`INSERT INTO users (id, issuer, subject, display_name, team_id, role, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, input.issuer, input.subject, displayName, team, inv.role, store.now());
    store.db.query('UPDATE user_invitations SET consumed_at = ? WHERE id = ?').run(store.now(), inv.id);
    audit(store, { actor: `user:${id}`, userId: id, source: 'web' }, 'invitation.accept', inv.id, { role: inv.role });
    return getUser(store, id)!;
  });
}

export function revokeInvitation(store: Store, p: Principal, invitationId: string): void {
  const row = store.db.query('SELECT * FROM user_invitations WHERE id = ?').get(invitationId) as Row | null;
  runAs(store, p, 'user/revoke-invite', { write: true, inviteRole: row ? (row.role as Role) : undefined }, (me) => {
    const fresh = store.db.query('SELECT * FROM user_invitations WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL').get(invitationId) as Row | null;
    // Admin solo revoca las suyas; owner, cualquiera.
    if (!fresh || (me.role === 'admin' && fresh.inviter_id !== me.userId)) throw new StoreError('not_found', 'invitación no encontrada');
    store.db.query('UPDATE user_invitations SET revoked_at = ? WHERE id = ?').run(store.now(), invitationId);
    audit(store, actorOf(me), 'invitation.revoke', invitationId);
  });
}

export function listInvitations(store: Store, p: Principal): Invitation[] {
  return runAs(store, p, 'user/list', { write: false }, (me) =>
    (store.db.query('SELECT * FROM user_invitations ORDER BY created_at').all() as Row[]).map(toInvitation)
      .filter((i) => me.role === 'owner' || i.inviterId === me.userId));
}

// ---- claves de API por usuario ---------------------------------------------

export interface UserKey { id: string; name: string; scope: 'read' | 'decide'; userId: string; createdAt: string; expiresAt: string | null; revokedAt: string | null }

/** D-2 A: la política rechaza a viewer; `verifyUserKey` lo vuelve a rechazar. El valor sale una sola vez. */
export function createUserKey(store: Store, p: Principal, name: string, scope: 'read' | 'decide', expiresAt?: string): { id: string; key: string } {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new StoreError('invalid_input', 'nombre de clave API inválido');
  if (scope !== 'read' && scope !== 'decide') throw new StoreError('invalid_input', 'ámbito de clave API inválido');
  if (expiresAt !== undefined && Number.isNaN(Date.parse(expiresAt))) throw new StoreError('invalid_input', 'caducidad inválida');
  return runAs(store, p, 'api-key/create', { write: true }, (me) => {
    if (store.db.query('SELECT 1 FROM api_keys WHERE user_id = ? AND name = ?').get(me.userId, name)) throw new StoreError('conflict', 'ya tienes una clave con ese nombre');
    const { n } = store.db.query('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL').get(me.userId) as { n: number };
    if (n >= API_KEY_ACTIVE_LIMIT) throw new StoreError('limit_reached', `ya hay ${API_KEY_ACTIVE_LIMIT} claves API activas`);
    const id = randomBytes(6).toString('hex'), secret = randomBytes(32).toString('base64url');
    store.db.query(`INSERT INTO api_keys (id, name, scope, hash, created_at, created_by, user_id, expires_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, name, scope, sha(secret), store.now(), `user:${me.userId}`, me.userId, expiresAt ?? null);
    audit(store, actorOf(me), 'key.create', id, { scope });
    return { id, key: `fabk_${id}_${secret}` };
  });
}

const toKey = (r: Row): UserKey => ({ id: r.id as string, name: r.name as string, scope: r.scope as 'read' | 'decide', userId: r.user_id as string,
  createdAt: r.created_at as string, expiresAt: (r.expires_at as string | null) ?? null, revokedAt: (r.revoked_at as string | null) ?? null });

/** Metadatos propios; `all` (todas las del equipo) es solo de owner. */
export function listUserKeys(store: Store, p: Principal, opts: { all?: boolean } = {}): UserKey[] {
  return runAs(store, p, 'api-key/list', { write: false, target: opts.all ? 'other' : 'own' }, (me) =>
    (store.db.query(`SELECT id, name, scope, user_id, created_at, expires_at, revoked_at FROM api_keys WHERE user_id IS NOT NULL ${opts.all ? '' : 'AND user_id = ?'} ORDER BY created_at, id`)
      .all(...(opts.all ? [] : [me.userId])) as Row[]).map(toKey));
}

/** Por ID. Una clave ajena solo la revoca el owner. */
export function revokeUserKey(store: Store, p: Principal, keyId: string): void {
  const owner = (store.db.query('SELECT user_id FROM api_keys WHERE id = ? AND user_id IS NOT NULL').get(keyId) as { user_id: string } | null)?.user_id;
  runAs(store, p, 'api-key/revoke', { write: true, target: owner && owner !== p.userId ? 'other' : 'own' }, (me) => {
    const { changes } = store.db.query(
      `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND user_id IS NOT NULL AND (user_id = ? OR ? = 'owner')`,
    ).run(store.now(), keyId, me.userId, me.role);
    if (!changes) throw new StoreError('not_found', 'clave API no encontrada');
    audit(store, actorOf(me), 'key.revoke', keyId, owner === me.userId ? undefined : { ownerId: owner });
  });
}

/** Autentica una clave de usuario. Las claves locales (sin usuario) no entran por aquí. */
export function verifyUserKey(store: Store, key: string): Principal | null {
  const m = /^fabk_([a-f0-9]{12})_([A-Za-z0-9_-]{43})$/.exec(key);
  if (!m) return null;
  const k = store.db.query('SELECT * FROM api_keys WHERE id = ? AND user_id IS NOT NULL AND revoked_at IS NULL').get(m[1]!) as Row | null;
  if (!k || (k.expires_at && (k.expires_at as string) <= store.now()) || !sameDigest(k.hash as string, sha(m[2]!))) return null;
  const u = getUser(store, k.user_id as string);
  if (!u || u.disabledAt || u.role === 'viewer') return null;
  const recovery = recoveryRestricted(store);
  if (recovery) return null;
  return { userId: u.id, role: u.role, issuer: u.issuer, subject: u.subject, displayName: u.displayName, via: 'api',
    keyId: k.id as string, keyScope: k.scope as 'read' | 'decide', recovery };
}

// ---- diario de identidad (solo añadir, fuera de SQLite) ---------------------

const ZERO = '0'.repeat(64);
interface JournalLine { seq: number; opId: string; at: string; actor: string; actorUserId: string | null; actorSource: string; action: string; object: string | null; detail: unknown; result: string; prev: string; hash: string }
const lineHash = (l: Omit<JournalLine, 'hash'>) => sha(JSON.stringify(l));

function readJournal(path: string): JournalLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as JournalLine);
}

/**
 * Vuelca los asientos pendientes con la secuencia propia del diario y la cadena de hashes. Cada asiento se identifica por su `op_id`,
 * no por el `seq` local: una base restaurada numera desde el corte y el diario ya va más lejos. Idempotente tras una caída entre
 * escribir y marcar.
 */
export function exportIdentityJournal(store: Store, path: string): { exported: number; lastSeq: number } {
  return store.withRetry(() => {
    const lines = readJournal(path);
    let last = lines.at(-1)?.seq ?? 0, prev = lines.at(-1)?.hash ?? ZERO, exported = 0;
    const known = new Set(lines.map((l) => l.opId));
    const mark = store.db.query('UPDATE identity_audit SET exported_at = ? WHERE op_id = ? AND exported_at IS NULL');
    for (const r of store.db.query('SELECT * FROM identity_audit WHERE exported_at IS NULL ORDER BY seq').all() as Row[]) {
      const opId = r.op_id as string;
      if (!known.has(opId)) {
        const body = { seq: last + 1, opId, at: r.at as string, actor: r.actor as string, actorUserId: (r.actor_user_id as string | null) ?? null,
          actorSource: r.actor_source as string, action: r.action as string, object: (r.object as string | null) ?? null,
          detail: r.detail ? JSON.parse(r.detail as string) : null, result: r.result as string, prev };
        const hash = lineHash(body);
        appendFileSync(path, JSON.stringify({ ...body, hash }) + '\n', { mode: 0o600 });
        prev = hash; last = body.seq; exported++;
      }
      mark.run(store.now(), opId);
    }
    return { exported, lastSeq: last };
  });
}

/** Comprueba la cadena y la secuencia. Un hueco o un hash roto no se arreglan solos: lo resuelve una revisión conservadora. */
export function verifyIdentityJournal(path: string): { ok: boolean; lastSeq: number; gaps: number[]; brokenAt: number | null } {
  const gaps: number[] = [];
  let prev = ZERO, seq = 0, brokenAt: number | null = null;
  for (const l of readJournal(path)) {
    for (let s = seq + 1; s < l.seq; s++) gaps.push(s);
    const { hash, ...body } = l;
    if (brokenAt === null && (l.prev !== prev || lineHash(body) !== hash)) brokenAt = l.seq;
    prev = hash; seq = l.seq;
  }
  return { ok: !gaps.length && brokenAt === null, lastSeq: seq, gaps, brokenAt };
}

// ---- recuperación restringida (§3.3) ---------------------------------------

export const recoveryStatus = (store: Store): { restricted: boolean } => ({ restricted: recoveryRestricted(store) });

/**
 * Consola, tras restaurar una copia: corta sesiones, claves e invitaciones y deja solo la confirmación del owner que el operador
 * designa (D-R1 A, §3.3 paso 2), a partir del registro de autoridad conservado fuera de la copia.
 */
export function enterRecovery(store: Store, operator: string, reason: string, ownerId: string): void {
  const why = text(reason, 'motivo', 500);
  store.withRetry(() => {
    if (!isBootstrapped(store)) throw new StoreError('not_found', 'el equipo no tiene bootstrap');
    const designated = getUser(store, ownerId);
    if (!designated || designated.role !== 'owner' || designated.disabledAt) throw new StoreError('invalid_input', 'el owner designado no es un owner activo');
    store.db.query(`UPDATE team SET recovery = 'restricted'`).run();
    store.db.query('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, ?)').run(store.now());
    store.db.query('UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id IS NOT NULL').run(store.now());
    store.db.query('UPDATE user_invitations SET revoked_at = COALESCE(revoked_at, ?) WHERE consumed_at IS NULL').run(store.now());
    audit(store, consoleActor(operator), 'recovery.enter', null, { reason: why, ownerId });
  });
}

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/**
 * Reaplica bajas y reducciones de rol del diario externo posteriores al corte. Rechaza un diario con la cadena rota.
 * La cadena de hashes da integridad frente a errores, no autenticidad: SHA-256 sin clave lo recalcula quien edite el fichero. */
export function applyJournalToRestored(store: Store, operator: string, journalPath: string): { applied: number; gaps: number[] } {
  const v = verifyIdentityJournal(journalPath);
  if (v.brokenAt !== null) throw new StoreError('conflict', 'el diario de identidad tiene la cadena rota');
  return store.withRetry(() => {
    if (!recoveryRestricted(store)) throw new StoreError('conflict', 'solo en recuperación restringida');
    let applied = 0;
    for (const l of readJournal(journalPath)) {
      if (l.result !== 'ok' || !l.object) continue;
      const u = getUser(store, l.object);
      if (!u) continue;
      const d = (l.detail ?? {}) as { to?: Role };
      if (l.action === 'user.disable' && !u.disabledAt) {
        store.db.query('UPDATE users SET disabled_at = ? WHERE id = ?').run(store.now(), u.id); cutCredentials(store, u.id); applied++;
      } else if (l.action === 'user.role' && d.to && RANK[d.to] < RANK[u.role]) { // solo reducciones: un ascenso no se reaplica
        store.db.query('UPDATE users SET role = ? WHERE id = ?').run(d.to, u.id); cutCredentials(store, u.id); applied++;
      }
    }
    if (activeOwners(store) < 1) throw new StoreError('conflict', 'el diario dejaría al equipo sin owner: decide el operador');
    audit(store, consoleActor(operator), 'recovery.apply-journal', null, { applied, gaps: v.gaps.length });
    return { applied, gaps: v.gaps };
  });
}

/** El operador declara que no hay diario externo que aplicar; sin esto o `applyJournalToRestored`, la recuperación no se confirma. */
export function declareNoJournal(store: Store, operator: string, reason: string): void {
  const why = text(reason, 'motivo', 500);
  store.withRetry(() => {
    if (!recoveryRestricted(store)) throw new StoreError('conflict', 'solo en recuperación restringida');
    audit(store, consoleActor(operator), 'recovery.no-journal', null, { reason: why });
  });
}

/**
 * El owner designado confirma la lista completa de identidades y roles. Quien no esté confirmado con su rol queda dado de baja;
 * después se reabre el login. Un owner no puede quedarse fuera de su propia lista.
 */
export function confirmRecovery(store: Store, p: Principal, confirmed: { userId: string; role: Role }[]): { confirmed: number; suspended: string[] } {
  return runAs(store, p, 'recovery/confirm', { write: true }, (me) => {
    const rec = recoveryState(store);
    if (!rec) throw new StoreError('conflict', 'no hay recuperación en curso');
    if (me.userId !== rec.ownerId) throw new StoreError('forbidden', 'solo confirma el owner designado por el operador');
    if (!rec.journalDone) throw new StoreError('conflict', 'aplica el diario de identidad (o declara que no hay) antes de confirmar');
    if (!confirmed.some((c) => c.userId === me.userId && c.role === 'owner')) throw new StoreError('invalid_input', 'la lista debe incluir al owner que confirma');
    const want = new Map(confirmed.map((c) => [c.userId, c.role]));
    if (want.size !== confirmed.length) throw new StoreError('invalid_input', 'la lista repite un usuario'); // «A owner, A admin» dejaría sin owner
    for (const id of want.keys()) if (!getUser(store, id)) throw new StoreError('invalid_input', 'la lista nombra un usuario desconocido');
    const suspended: string[] = [];
    for (const u of (store.db.query('SELECT * FROM users WHERE disabled_at IS NULL').all() as Row[]).map(toUser)) {
      if (want.get(u.id) === u.role) continue;
      store.db.query('UPDATE users SET disabled_at = ? WHERE id = ?').run(store.now(), u.id);
      cutCredentials(store, u.id);
      audit(store, actorOf(me), 'user.disable', u.id, { role: u.role, reason: 'recovery_unconfirmed' });
      suspended.push(u.id);
    }
    store.db.query('UPDATE team SET recovery = NULL').run();
    audit(store, actorOf(me), 'recovery.confirm', null, { confirmed: confirmed.length, suspended: suspended.length });
    return { confirmed: confirmed.length, suspended };
  });
}
