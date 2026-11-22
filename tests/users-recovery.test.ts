import { afterEach, beforeEach, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, StoreError } from '../src/store.ts';
import {
  acceptInvitation, applyJournalToRestored, bootstrapOwner, changeUserRole, confirmRecovery, createUserKey, disableUser, enterRecovery,
  exportIdentityJournal, getUser, inviteUser, issueSession, listUsers, recoveryStatus, resolvePrincipal, runAs, verifyIdentityJournal, verifyUserKey,
  type Principal, type Role,
} from '../src/users.ts';

let dir: string;
let store: Store;
let n = 0;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fab-rec-')); store = new Store(join(dir, 'f.db')); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const login = (s: Store, id: string) => resolvePrincipal(s, issueSession(s, id, 'web').token)!;
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as StoreError).code; } return 'no lanzó'; };
function add(s: Store, by: Principal, role: Role): string {
  const sub = `s${++n}`;
  const inv = inviteUser(s, by, { expectedIssuer: 'github', expectedSubject: sub, role });
  return acceptInvitation(s, { code: inv.code, issuer: 'github', subject: sub, displayName: sub }).id;
}

test('diario: export idempotente, cadena válida y reanuda tras añadir asientos', () => {
  const j = join(dir, 'identity.jsonl');
  const o = bootstrapOwner(store, { issuer: 'github', subject: '1', displayName: 'A', operator: 'op' });
  const first = exportIdentityJournal(store, j);
  expect(first.exported).toBe(1);
  expect(exportIdentityJournal(store, j).exported).toBe(0);
  const owner = login(store, o.id);
  add(store, owner, 'member');
  const second = exportIdentityJournal(store, j);
  expect(second.exported).toBeGreaterThan(1);
  expect(verifyIdentityJournal(j)).toEqual({ ok: true, lastSeq: second.lastSeq, gaps: [], brokenAt: null });
  expect(store.db.query('SELECT COUNT(*) n FROM identity_audit WHERE exported_at IS NULL').get()).toEqual({ n: 0 });
});

test('diario: un hueco en la secuencia y un hash alterado se detectan', () => {
  const j = join(dir, 'identity.jsonl');
  const o = bootstrapOwner(store, { issuer: 'github', subject: '1', displayName: 'A', operator: 'op' });
  add(store, login(store, o.id), 'viewer');
  exportIdentityJournal(store, j);
  const lines = readFileSync(j, 'utf8').trim().split('\n');
  expect(lines.length).toBeGreaterThan(3);
  writeFileSync(j, [lines[0], ...lines.slice(2)].join('\n') + '\n');
  const gap = verifyIdentityJournal(j);
  expect(gap.ok).toBe(false);
  expect(gap.gaps).toEqual([2]);
  const tampered = JSON.parse(lines[1]!); tampered.action = 'user.nada';
  writeFileSync(j, [lines[0], JSON.stringify(tampered), ...lines.slice(2)].join('\n') + '\n');
  expect(verifyIdentityJournal(j).brokenAt).toBe(2);
});

test('baja → restaurar: la cuenta no entra y el rol degradado no recupera privilegios', () => {
  const j = join(dir, 'identity.jsonl');
  const backup = join(dir, 'backup.db');
  const o = bootstrapOwner(store, { issuer: 'github', subject: '1', displayName: 'A', operator: 'op' });
  const owner = login(store, o.id);
  const gone = add(store, owner, 'member'), demoted = add(store, owner, 'admin'), stays = add(store, owner, 'member');
  const key = createUserKey(store, login(store, gone), 'k', 'read');
  store.db.exec('PRAGMA wal_checkpoint(FULL)');
  copyFileSync(store.dbPath, backup); // copia del RPO
  disableUser(store, owner, gone);
  changeUserRole(store, owner, demoted, 'viewer');
  exportIdentityJournal(store, j); // el diario vive fuera de la base

  const restored = new Store(backup);
  try {
    // La copia aún los trae activos y con el rol antiguo.
    expect(getUser(restored, gone)!.disabledAt).toBeNull();
    expect(getUser(restored, demoted)!.role).toBe('admin');
    const stale = resolvePrincipal(restored, issueSession(restored, o.id, 'web').token)!;
    enterRecovery(restored, 'op', 'restauración de prueba');
    expect(recoveryStatus(restored)).toEqual({ restricted: true });
    // Sesiones y claves restauradas quedan revocadas; nada opera hasta que el owner confirme.
    expect(resolvePrincipal(restored, `fabs_${stale.sessionId}_${'A'.repeat(43)}`)).toBeNull();
    expect(code(() => runAs(restored, stale, 'session/list', { write: false }, () => 1))).toBe('unauthorized');
    expect(verifyUserKey(restored, key.key)).toBeNull();
    // Solo el owner puede abrir sesión mientras dura la recuperación.
    expect(code(() => issueSession(restored, stays, 'web'))).toBe('unauthorized');
    const applied = applyJournalToRestored(restored, 'op', j);
    expect(applied.applied).toBe(2);
    expect(code(() => issueSession(restored, gone, 'web'))).toBe('unauthorized');
    expect(getUser(restored, demoted)!.role).toBe('viewer');

    const ownerR = login(restored, o.id);
    expect(ownerR.recovery).toBe(true);
    expect(code(() => listUsers(restored, ownerR))).toBe('forbidden'); // restringido: solo confirmar
    // Confirma al owner y a `demoted` con su rol antiguo (admin): ese desacuerdo lo suspende; `stays` no se confirma: suspendido.
    const r = confirmRecovery(restored, ownerR, [{ userId: o.id, role: 'owner' }, { userId: demoted, role: 'admin' }]);
    expect(r.suspended.sort()).toEqual([demoted, stays].sort());
    expect(recoveryStatus(restored)).toEqual({ restricted: false });
    expect(code(() => issueSession(restored, demoted, 'web'))).toBe('unauthorized');
    expect(listUsers(restored, login(restored, o.id)).filter((u) => !u.disabledAt).map((u) => u.id)).toEqual([o.id]);
    const acts = (restored.db.query('SELECT action FROM identity_audit').all() as { action: string }[]).map((x) => x.action);
    expect(acts).toEqual(expect.arrayContaining(['recovery.enter', 'recovery.apply-journal', 'recovery.confirm']));
  } finally { restored.close(); }
});

test('confirmar: la lista debe incluir al owner y no nombrar desconocidos; sin recuperación no hay confirmación', () => {
  const o = bootstrapOwner(store, { issuer: 'github', subject: '1', displayName: 'A', operator: 'op' });
  expect(code(() => confirmRecovery(store, login(store, o.id), [{ userId: o.id, role: 'owner' }]))).toBe('conflict');
  enterRecovery(store, 'op', 'x');
  const p = login(store, o.id);
  expect(code(() => confirmRecovery(store, p, []))).toBe('invalid_input');
  expect(code(() => confirmRecovery(store, p, [{ userId: o.id, role: 'owner' }, { userId: 'nadie', role: 'member' }]))).toBe('invalid_input');
  expect(confirmRecovery(store, p, [{ userId: o.id, role: 'owner' }]).suspended).toEqual([]);
});

test('un diario con la cadena rota no se aplica; fuera de recuperación tampoco', () => {
  const j = join(dir, 'identity.jsonl');
  const o = bootstrapOwner(store, { issuer: 'github', subject: '1', displayName: 'A', operator: 'op' });
  exportIdentityJournal(store, j);
  expect(code(() => applyJournalToRestored(store, 'op', j))).toBe('conflict');
  const line = JSON.parse(readFileSync(j, 'utf8').trim()); line.object = 'otro';
  writeFileSync(j, JSON.stringify(line) + '\n');
  enterRecovery(store, 'op', 'x');
  expect(code(() => applyJournalToRestored(store, 'op', j))).toBe('conflict');
  expect(getUser(store, o.id)!.disabledAt).toBeNull();
});
