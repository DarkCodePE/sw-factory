import { expect, test } from 'bun:test';
import { ACTIONS } from '../src/web-actions.ts';
import { ACTION_CAPABILITIES, authorize, ROLES, READ_CAPABILITIES, VERB_CAPABILITIES, type PolicyContext, type Role } from '../src/policy.ts';

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
  for (const c of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(authorize({ role: 'owner' }, c, web)).toEqual({ ok: false, reason: 'unknown_capability' });
});

// T119e (cierra el residuo de T119b-H2): en recuperación solo valen confirmar y cerrar sesión; nada más, para ningún rol.
test('recuperación restringida permite session/revoke y nada más que confirmar', async () => {
  const { IDENTITY_CAPABILITIES } = await import('../src/policy.ts');
  const allowed = Object.keys({ ...ACTION_CAPABILITIES, ...IDENTITY_CAPABILITIES, ...READ_CAPABILITIES, ...VERB_CAPABILITIES }).filter(c => authorize({ role: 'owner', recovery: true }, c, web).ok).sort();
  expect(allowed).toEqual(['recovery/confirm', 'session/revoke']);
  for (const role of ['admin', 'member', 'viewer'] as const) expect(authorize({ role, recovery: true }, 'session/revoke', web).ok).toBe(true);
});

test('T119a-H12: un rol desconocido deniega aunque empiece como uno válido', () => {
  for (const r of ['observer', 'auditor', 'owners', 'Owner', '']) {
    expect(authorize({ role: r as Role }, 'session/list', web), r).toEqual({ ok: false, reason: 'role' });
  }
});

// Roles de cada acción, copiados de §4.1 del diseño (O owner, A admin, M member, V viewer).
const SECTION_4_1: Record<string, string> = {
  'api-keys/create': 'OAM', 'api-keys/revoke': 'OAM', 'activities/review': 'OA', 'automejora/save': 'O', 'benchmarks/cancel': 'OA',
  'changes/suite-task': 'O', 'changes/retry': 'OA', 'changes/note': 'OAM', 'changes/rename': 'OAM', 'changes/cancel': 'OA',
  'activities/score': 'OA', 'scorers/backfill': 'OA', 'questions/answer': 'OAM', 'signals/create': 'OAM', 'signals/triage': 'OA',
  'signals/ignore': 'OA', 'automations/create': 'OA', 'automations/update': 'OA', 'automations/delete': 'OA', 'automations/run': 'OA',
  'automations/enable': 'OA', 'automations/disable': 'OA', 'workstreams/create': 'O', 'workstreams/settings': 'OA', 'workstreams/state': 'OA',
  'workstreams/adaptador': 'O', 'workstreams/archive': 'OA', 'workstreams/runner': 'O', 'workstreams/acceso': 'O', 'resident/config': 'O',
  'jira/import': 'OA', 'runners/create': 'O', 'runners/update': 'O', 'runners/delete': 'O', 'runners/check': 'O',
  'perfiles/importar': 'O', 'definicion/importar': 'O', 'perfiles/guardar': 'O', 'perfiles/asignar': 'O',
};
const LETTER: Record<Role, string> = { owner: 'O', admin: 'A', member: 'M', viewer: 'V' };

test('T119a-H9: los roles de cada acción de la web son los de §4.1', () => {
  expect(Object.keys(SECTION_4_1).sort()).toEqual(Object.keys(ACTION_CAPABILITIES).sort());
  for (const [cap, letters] of Object.entries(SECTION_4_1)) {
    expect(who(cap).map((r) => LETTER[r]).join(''), cap).toBe(letters);
  }
});

// Lecturas y verbos remotos de §4.2: roles y si una clave puede pedirlos (api).
test.each([
  ['ops/read', 'OAMV', true], ['ops/metrics', 'OAMV', true], ['evidence/read', 'OAM', false], ['config/read', 'OA', false],
  ['config/credentials', 'O', false], ['triage/all', 'OA', false], ['validate/run', 'OA', false], ['improve/dismiss', 'OA', false],
  ['runner/enable', 'O', false], ['runner/disable', 'O', false], ['credits/read', 'O', false], ['credits/grant', 'O', false],
  ['credits/adjust', 'O', false], ['credits/limit', 'O', false], ['credits/threshold', 'O', false], ['credits/resume', 'O', false],
  ['credits/refund', '', false],
] as [string, string, boolean][])('T119a-H8: §4.2 %s', (cap, letters, api) => {
  expect(who(cap).map((r) => LETTER[r]).join('')).toBe(letters);
  // Una clave `decide` de owner lo pide por API solo si api es true; un viewer nunca llega por API.
  expect(authorize({ role: 'owner' }, cap, { via: 'api', write: true, keyScope: 'decide' }).ok).toBe(api && letters.includes('O'));
  expect(authorize({ role: 'viewer' }, cap, { via: 'api', write: true, keyScope: 'decide' }).ok).toBe(false);
});

test('T119a-H8: las lecturas no exigen --write, los verbos que mutan sí, y no hay nombres repetidos entre tablas', () => {
  const ro = { via: 'web', write: false } as const;
  for (const c of Object.keys(READ_CAPABILITIES)) expect(authorize({ role: 'owner' }, c, ro).ok, c).toBe(true);
  expect(authorize({ role: 'owner' }, 'triage/all', ro)).toEqual({ ok: false, reason: 'write_required' });
  expect(authorize({ role: 'owner' }, 'credits/read', ro).ok).toBe(true);
  const all = [ACTION_CAPABILITIES, READ_CAPABILITIES, VERB_CAPABILITIES].flatMap((t) => Object.keys(t));
  expect(new Set(all).size).toBe(all.length);
});
