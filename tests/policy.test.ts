import { expect, test } from 'bun:test';
import { ACTIONS } from '../src/web-actions.ts';
import { ACTION_CAPABILITIES, authorize, ROLES, type PolicyContext, type Role } from '../src/policy.ts';

const web: PolicyContext = { via: 'web', write: true };
const who = (cap: string, ctx: PolicyContext = web) => ROLES.filter((r) => authorize({ role: r }, cap, ctx).ok);

test('inventario: cada ACTION de la web tiene capacidad y su flag api coincide', () => {
  const names = Object.keys(ACTIONS);
  for (const n of names) expect(ACTION_CAPABILITIES[n], n).toBeDefined();
  // Fuera de ACTIONS (§4.1): solo perfiles guardar/asignar.
  expect(Object.keys(ACTION_CAPABILITIES).filter((n) => !names.includes(n)).sort()).toEqual(['perfiles/asignar', 'perfiles/guardar']);
  for (const n of names) {
    const api = ACTIONS[n]!.api !== false;
    const viaApi = authorize({ role: 'owner' }, n, { via: 'api', write: true, keyScope: 'decide' }).ok;
    expect(viaApi, `${n} api`).toBe(api);
  }
});

// Una fila de §4.2 por capacidad de T119a.
test.each([
  ['api-key/create', ['owner', 'admin', 'member']],
  ['api-key/list', ['owner', 'admin', 'member']],
  ['api-key/revoke', ['owner', 'admin', 'member']],
  ['session/login', ['owner', 'admin', 'member', 'viewer']],
  ['session/logout', ['owner', 'admin', 'member', 'viewer']],
  ['session/list', ['owner', 'admin', 'member', 'viewer']],
  ['session/revoke', ['owner', 'admin', 'member', 'viewer']],
  ['credits/balance-self', ['owner', 'admin', 'member', 'viewer']],
  ['user/list', ['owner', 'admin']],
  ['user/revoke-invite', ['owner', 'admin']],
  ['user/role', ['owner']],
  ['user/disable', ['owner']],
  ['user/resolve-work', ['owner']],
  ['recovery/confirm', ['owner']],
  ['user/bootstrap', []],
  ['user/recover', []],
] as [string, Role[]][])('matriz %s', (cap, roles) => {
  expect(who(cap, { ...web, inviteRole: 'member' })).toEqual(roles);
});

test('user/invite: admin solo member/viewer; owner cualquiera', () => {
  for (const r of ['member', 'viewer'] as Role[]) expect(authorize({ role: 'admin' }, 'user/invite', { ...web, inviteRole: r }).ok).toBe(true);
  for (const r of ['admin', 'owner'] as Role[]) expect(authorize({ role: 'admin' }, 'user/invite', { ...web, inviteRole: r })).toEqual({ ok: false, reason: 'invite_role' });
  expect(authorize({ role: 'owner' }, 'user/invite', { ...web, inviteRole: 'admin' }).ok).toBe(true);
  expect(authorize({ role: 'member' }, 'user/invite', { ...web, inviteRole: 'viewer' }).ok).toBe(false);
});

test('revocar clave ajena solo owner', () => {
  expect(authorize({ role: 'member' }, 'api-key/revoke', { ...web, target: 'other' }).ok).toBe(false);
  expect(authorize({ role: 'admin' }, 'api-key/revoke', { ...web, target: 'other' }).ok).toBe(false);
  expect(authorize({ role: 'owner' }, 'api-key/revoke', { ...web, target: 'other' }).ok).toBe(true);
  expect(authorize({ role: 'member' }, 'api-key/revoke', { ...web, target: 'own' }).ok).toBe(true);
});

test('sin --write las mutaciones de negocio y de claves caen; las de cuenta no', () => {
  const ro = { via: 'web', write: false } as const;
  expect(authorize({ role: 'owner' }, 'changes/note', ro)).toEqual({ ok: false, reason: 'write_required' });
  expect(authorize({ role: 'member' }, 'api-key/create', ro).ok).toBe(false);
  expect(authorize({ role: 'viewer' }, 'session/revoke', ro).ok).toBe(true);
  expect(authorize({ role: 'owner' }, 'user/list', ro).ok).toBe(true);
});

test('D-2 A: un viewer no tiene claves de API ni por rol ni por vía api', () => {
  expect(authorize({ role: 'viewer' }, 'api-key/create', web).ok).toBe(false);
  expect(authorize({ role: 'viewer' }, 'changes/note', { via: 'api', write: true, keyScope: 'decide' }).ok).toBe(false);
  expect(authorize({ role: 'viewer' }, 'session/list', { via: 'api', write: true, keyScope: 'read' })).toEqual({ ok: false, reason: 'viewer_no_api' });
});

test('API: exige api!==false, ámbito decide para mutar y respeta api:false aun siendo owner', () => {
  expect(authorize({ role: 'owner' }, 'changes/note', { via: 'api', write: true, keyScope: 'read' })).toEqual({ ok: false, reason: 'key_scope' });
  expect(authorize({ role: 'owner' }, 'workstreams/create', { via: 'api', write: true, keyScope: 'decide' })).toEqual({ ok: false, reason: 'api_false' });
  expect(authorize({ role: 'member' }, 'activities/review', { via: 'api', write: true, keyScope: 'decide' })).toEqual({ ok: false, reason: 'role' });
});

test('recuperación restringida: solo recovery/confirm; capacidad desconocida falla cerrado', () => {
  expect(authorize({ role: 'owner', recovery: true }, 'changes/note', web)).toEqual({ ok: false, reason: 'recovery_restricted' });
  expect(authorize({ role: 'owner', recovery: true }, 'recovery/confirm', web).ok).toBe(true);
  expect(authorize({ role: 'owner' }, 'nada/inventado', web)).toEqual({ ok: false, reason: 'unknown_capability' });
});

test('T119a-H12: un rol desconocido deniega aunque empiece como uno válido', () => {
  for (const r of ['observer', 'auditor', 'owners', 'Owner', '']) {
    expect(authorize({ role: r as Role }, 'session/list', web), r).toEqual({ ok: false, reason: 'role' });
  }
});
