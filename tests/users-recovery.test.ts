import { afterEach, beforeEach, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, StoreError } from '../src/store.ts';
import {
  acceptInvitation, recoveryUsers, applyJournalToRestored, bootstrapOwner, changeUserRole, confirmRecovery, createUserKey, declareNoJournal, disableUser, enterRecovery,
  exportIdentityJournal, getUser, inviteUser, issueSession, listUsers, recoveryStatus, resolvePrincipal, runAs, verifyIdentityJournal, verifyUserKey,
  type Principal, type Role,
} from '../src/users.ts';

let dir: string;
let store: Store;
let n = 0;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fab-rec-')); store = new Store(join(dir, 'f.db')); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const login = (s: Store, id: string) => resolvePrincipal(s, issueSession(s, id, 'web').token, 'web')!;
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
  expect(verifyIdentityJournal(j)).toEqual({ ok: true, lastSeq: second.lastSeq, gaps: [], brokenAt: null, truncated: false });
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
  const key = createUserKey(store, login(store, gone), 'k', 'read', { write: true });
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
    const stale = resolvePrincipal(restored, issueSession(restored, o.id, 'web').token, 'web')!;
    enterRecovery(restored, 'op', 'restauración de prueba', o.id);
    expect(recoveryStatus(restored)).toEqual({ restricted: true });
    // Sesiones y claves restauradas quedan revocadas; nada opera hasta que el owner confirme.
    expect(resolvePrincipal(restored, `fabs_${stale.sessionId}_${'A'.repeat(43)}`, 'web')).toBeNull();
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
  enterRecovery(store, 'op', 'x', o.id);
  declareNoJournal(store, 'op', 'sin diario');
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
  enterRecovery(store, 'op', 'x', o.id);
  expect(code(() => applyJournalToRestored(store, 'op', j))).toBe('conflict');
  expect(getUser(store, o.id)!.disabledAt).toBeNull();
});

test('T119a-H1: tras restaurar, los asientos nuevos de la base restaurada llegan al diario y no se marcan sin escribirse', () => {
  const j = join(dir, 'identity.jsonl');
  const backup = join(dir, 'backup.db');
  const o = bootstrapOwner(store, { issuer: 'github', subject: '1', displayName: 'A', operator: 'op' });
  const owner = login(store, o.id);
  const first = add(store, owner, 'member');
  exportIdentityJournal(store, j);
  store.db.exec('PRAGMA wal_checkpoint(FULL)');
  copyFileSync(store.dbPath, backup); // corte
  for (let i = 0; i < 3; i++) add(store, owner, 'viewer'); // el diario llega más lejos que la copia
  disableUser(store, owner, first);
  const before = exportIdentityJournal(store, j).lastSeq;

  const restored = new Store(backup);
  try {
    enterRecovery(restored, 'op', 'restauración de prueba', o.id);
    const pending = (restored.db.query('SELECT COUNT(*) n FROM identity_audit WHERE exported_at IS NULL').get() as { n: number }).n;
    expect(pending).toBe(1);
    const r = exportIdentityJournal(restored, j);
    expect(r.exported).toBe(1);
    expect(r.lastSeq).toBe(before + 1);
    expect(verifyIdentityJournal(j)).toEqual({ ok: true, lastSeq: before + 1, gaps: [], brokenAt: null, truncated: false });
    expect(readFileSync(j, 'utf8')).toContain('recovery.enter');
    expect(exportIdentityJournal(restored, j).exported).toBe(0);
  } finally { restored.close(); }
});

test('T119a-H2 / D-R1: solo el owner designado abre sesión y confirma, y solo con el diario aplicado o un «sin diario» explícito', () => {
  const j = join(dir, 'identity.jsonl');
  const backup = join(dir, 'backup.db');
  const a = bootstrapOwner(store, { issuer: 'github', subject: '1', displayName: 'A', operator: 'op' });
  const ownerA = login(store, a.id);
  const b = add(store, ownerA, 'member');
  changeUserRole(store, ownerA, b, 'owner');
  store.db.exec('PRAGMA wal_checkpoint(FULL)');
  copyFileSync(store.dbPath, backup); // corte: A y B son owners
  changeUserRole(store, login(store, b), a.id, 'viewer'); // después de la copia B degrada a A
  exportIdentityJournal(store, j);

  const restored = new Store(backup);
  try {
    expect(code(() => enterRecovery(restored, 'op', 'x', 'nadie'))).toBe('invalid_input');
    enterRecovery(restored, 'op', 'x', b);
    // A seguía siendo owner en la copia, pero no es el designado: no abre sesión.
    expect(code(() => issueSession(restored, a.id, 'web'))).toBe('unauthorized');
    const ownerB = login(restored, b);
    // Sin diario aplicado ni «sin diario»: no se confirma.
    expect(code(() => confirmRecovery(restored, ownerB, [{ userId: b, role: 'owner' }]))).toBe('conflict');
    applyJournalToRestored(restored, 'op', j);
    expect(getUser(restored, a.id)!.role).toBe('viewer');
    expect(confirmRecovery(restored, login(restored, b), [{ userId: b, role: 'owner' }]).suspended).toEqual([a.id]);
    expect(recoveryStatus(restored)).toEqual({ restricted: false });
  } finally { restored.close(); }
});

test('T119a-H2: una sesión de otro owner no confirma aunque el diario esté aplicado', () => {
  const a = bootstrapOwner(store, { issuer: 'github', subject: '1', displayName: 'A', operator: 'op' });
  const ownerA = login(store, a.id);
  const b = add(store, ownerA, 'member');
  changeUserRole(store, ownerA, b, 'owner');
  enterRecovery(store, 'op', 'x', b);
  declareNoJournal(store, 'op', 'sin diario');
  // Sesión de A insertada por SQL (no puede salir de issueSession): la guarda de confirmRecovery la rechaza por sí sola.
  store.db.query(`INSERT INTO user_sessions (id, user_id, class, token_digest, created_at, expires_at) VALUES ('raw', ?, 'web', 'd', ?, '2999-01-01T00:00:00.000Z')`).run(a.id, store.now());
  expect(code(() => confirmRecovery(store, { ...ownerA, sessionId: 'raw', recovery: true }, [{ userId: a.id, role: 'owner' }]))).toBe('forbidden');
  expect(() => confirmRecovery(store, login(store, b), [{ userId: b, role: 'owner' }])).not.toThrow();
});

test('T119a-H3: la lista de confirmación no admite IDs repetidos y el único owner no queda de baja', () => {
  const o = bootstrapOwner(store, { issuer: 'github', subject: '1', displayName: 'A', operator: 'op' });
  enterRecovery(store, 'op', 'x', o.id);
  declareNoJournal(store, 'op', 'sin diario');
  const p = login(store, o.id);
  expect(code(() => confirmRecovery(store, p, [{ userId: o.id, role: 'owner' }, { userId: o.id, role: 'admin' }]))).toBe('invalid_input');
  expect(recoveryStatus(store)).toEqual({ restricted: true });
  expect(getUser(store, o.id)!.disabledAt).toBeNull();
});

test('T119a-H4: el diario solo reaplica reducciones, no ascensos, y no deja al equipo sin owner', () => {
  const j = join(dir, 'identity.jsonl');
  const backup = join(dir, 'backup.db');
  const a = bootstrapOwner(store, { issuer: 'github', subject: '1', displayName: 'A', operator: 'op' });
  const ownerA = login(store, a.id);
  const m = add(store, ownerA, 'member');
  store.db.exec('PRAGMA wal_checkpoint(FULL)');
  copyFileSync(store.dbPath, backup); // corte: A owner, m member
  changeUserRole(store, ownerA, m, 'owner'); // ascenso posterior al corte
  exportIdentityJournal(store, j);
  const restored = new Store(backup);
  try {
    enterRecovery(restored, 'op', 'x', a.id);
    expect(applyJournalToRestored(restored, 'op', j).applied).toBe(0);
    expect(getUser(restored, m)!.role).toBe('member');
  } finally { restored.close(); }

  // Otro caso: un owner creado tras el corte degrada al único owner de la copia; aplicar lo dejaría sin owner.
  const j2 = join(dir, 'identity2.jsonl'), backup2 = join(dir, 'backup2.db');
  store.db.exec('PRAGMA wal_checkpoint(FULL)');
  copyFileSync(store.dbPath, backup2); // corte: A y m owners
  const c = add(store, ownerA, 'viewer');
  changeUserRole(store, ownerA, c, 'owner');
  changeUserRole(store, login(store, c), a.id, 'viewer');
  changeUserRole(store, login(store, c), m, 'viewer');
  exportIdentityJournal(store, j2);
  const restored2 = new Store(backup2);
  try {
    enterRecovery(restored2, 'op', 'x', a.id);
    expect(code(() => applyJournalToRestored(restored2, 'op', j2))).toBe('conflict');
    expect(getUser(restored2, a.id)!.role).toBe('owner'); // rollback completo
    expect(getUser(restored2, m)!.role).toBe('owner');
  } finally { restored2.close(); }
});

test('T119a-H14: aplicar el diario y confirmar cortan las sesiones de quien cambia de rol o queda de baja', () => {
  const j = join(dir, 'identity.jsonl');
  const backup = join(dir, 'backup.db');
  const a = bootstrapOwner(store, { issuer: 'github', subject: '1', displayName: 'A', operator: 'op' });
  const ownerA = login(store, a.id);
  const b = add(store, ownerA, 'member');
  changeUserRole(store, ownerA, b, 'owner');
  store.db.exec('PRAGMA wal_checkpoint(FULL)');
  copyFileSync(store.dbPath, backup);
  changeUserRole(store, ownerA, b, 'viewer'); // tras el corte A degrada a B
  exportIdentityJournal(store, j);
  const restored = new Store(backup);
  try {
    enterRecovery(restored, 'op', 'x', b); // el operador designa a B; el diario lo degrada
    const sessionB = issueSession(restored, b, 'web').token;
    expect(resolvePrincipal(restored, sessionB, 'web')).not.toBeNull();
    applyJournalToRestored(restored, 'op', j);
    expect(resolvePrincipal(restored, sessionB, 'web')).toBeNull(); // la sesión de B no sobrevive a su degradación

  } finally { restored.close(); }

  const r2 = new Store(backup);
  try {
    enterRecovery(r2, 'op', 'x', a.id);
    declareNoJournal(r2, 'op', 'sin diario');
    r2.db.query(`INSERT INTO user_sessions (id, user_id, class, token_digest, created_at, expires_at) VALUES ('raw', ?, 'web', 'd', ?, '2999-01-01T00:00:00.000Z')`).run(b, r2.now());
    confirmRecovery(r2, login(r2, a.id), [{ userId: a.id, role: 'owner' }]); // B queda suspendido
    expect(r2.db.query(`SELECT revoked_at FROM user_sessions WHERE id = 'raw'`).get()).not.toEqual({ revoked_at: null });
  } finally { r2.close(); }
});

test('T119a-H19: una última línea íntegra sin salto final se conserva; una línea encadenada falsa o cortada se descarta', () => {
  const j = join(dir, 'identity.jsonl');
  const o = bootstrapOwner(store, { issuer: 'github', subject: '1', displayName: 'A', operator: 'op' });
  const owner = login(store, o.id);
  for (let i = 0; i < 5; i++) add(store, owner, 'viewer');
  const { exported } = exportIdentityJournal(store, j);
  const full = readFileSync(j, 'utf8');
  writeFileSync(j, full.slice(0, -1)); // solo se quita el salto final
  expect(verifyIdentityJournal(j)).toMatchObject({ ok: true, lastSeq: exported, truncated: false });
  add(store, owner, 'viewer');
  const r = exportIdentityJournal(store, j);
  expect(r.exported).toBeGreaterThan(0);
  const lines = readFileSync(j, 'utf8').split('\n');
  expect(lines.length).toBe(exported + r.exported + 1); // todas las líneas y el vacío final: la última conservada no se perdió
  expect(verifyIdentityJournal(j)).toMatchObject({ ok: true, lastSeq: exported + r.exported, gaps: [], brokenAt: null, truncated: false });
  // Una última línea íntegra pero que no encadena no se acepta.
  const forged = JSON.stringify({ ...JSON.parse(lines[exported - 1]!), prev: 'x'.repeat(64) });
  writeFileSync(j, lines.slice(0, exported - 1).join('\n') + '\n' + forged);
  expect(verifyIdentityJournal(j)).toMatchObject({ truncated: true });
});

test('T119a-H10: una última línea cortada no rompe el diario y se reescribe; tres exportadores a la vez no duplican ni rompen la cadena', async () => {
  const j = join(dir, 'identity.jsonl');
  const o = bootstrapOwner(store, { issuer: 'github', subject: '1', displayName: 'A', operator: 'op' });
  const owner = login(store, o.id);
  for (let i = 0; i < 6; i++) add(store, owner, 'viewer');
  exportIdentityJournal(store, j);
  const intact = readFileSync(j, 'utf8');
  add(store, owner, 'viewer');
  // Caída a mitad de una línea: el fichero acaba sin salto de línea.
  writeFileSync(j, intact + '{"seq":99,"opId":"a medias');
  expect(verifyIdentityJournal(j)).toMatchObject({ ok: true, truncated: true });
  const r = exportIdentityJournal(store, j);
  expect(r.exported).toBeGreaterThan(0);
  expect(verifyIdentityJournal(j)).toMatchObject({ ok: true, truncated: false, gaps: [], brokenAt: null });
  expect(readFileSync(j, 'utf8')).not.toContain('a medias');

  // Exportadores simultáneos sobre la misma base (procesos reales).
  for (let i = 0; i < 12; i++) add(store, owner, 'viewer');
  store.db.exec('PRAGMA wal_checkpoint(FULL)');
  const go = String(Date.now() + 800);
  const procs = [1, 2, 3].map(() => Bun.spawn(['bun', join(import.meta.dir, 'helpers', 'identity-exporter.ts'), store.dbPath, j, go], { stdout: 'pipe', stderr: 'pipe' }));
  for (const p of procs) expect(await p.exited, await new Response(p.stderr).text()).toBe(0);
  const v = verifyIdentityJournal(j);
  expect(v).toMatchObject({ ok: true, gaps: [], brokenAt: null });
  const ops = readFileSync(j, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { opId: string }).opId);
  expect(new Set(ops).size).toBe(ops.length);
  expect(ops.length).toBe((store.db.query('SELECT COUNT(*) n FROM identity_audit').get() as { n: number }).n);
});

test('recoveryUsers (T119e-H8): solo en recuperación, solo el owner designado, y no lista a los dados de baja', () => {
  const o = bootstrapOwner(store, { issuer: 'github', subject: 'o', displayName: 'O', operator: 'op' });
  const owner = login(store, o.id);
  const otro = add(store, owner, 'member'), baja = add(store, owner, 'member');
  changeUserRole(store, owner, otro, 'owner');
  disableUser(store, owner, baja);
  const otroP = login(store, otro);
  expect(code(() => recoveryUsers(store, owner))).toBe('conflict'); // fuera de recuperación
  enterRecovery(store, 'op', 'restauración', o.id);
  declareNoJournal(store, 'op', 'sin diario');
  const designado = login(store, o.id);
  const ids = recoveryUsers(store, designado).map(u => u.id);
  expect(ids).toContain(o.id); expect(ids).toContain(otro); expect(ids).not.toContain(baja);
  // Otro owner con la sesión aún viva (no debería existir: entrar en recuperación las revoca): la guarda del designado lo para.
  store.db.query('UPDATE user_sessions SET revoked_at = NULL WHERE id = ?').run(otroP.sessionId!);
  expect(code(() => recoveryUsers(store, { ...otroP, recovery: true }))).toBe('forbidden');
});
