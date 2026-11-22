/**
 * Política de permisos del modo servidor (diseño T118–T119 §4). Pura: sin Store ni red.
 * Cada capacidad enumera los roles autorizados (O owner, A admin, M member, V viewer). Falla cerrado ante una capacidad desconocida.
 */
export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export type Via = 'web' | 'cli' | 'api';
export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

interface Capability {
  /** Letras de rol autorizado; '' = solo consola de operador. */
  roles: string;
  /** Una clave `decide` puede pedirla por /api/v1 (además del rol). */
  api: boolean;
  /** Muta estado de negocio o de credenciales: exige `--write`, salvo `account`. */
  mutation: boolean;
  /** Control de la propia cuenta (login, logout, sesiones): vale también sin `--write`. */
  account?: boolean;
}

const A = (roles: string, api = false): Capability => ({ roles, api, mutation: true });
const R = (roles: string): Capability => ({ roles, api: false, mutation: false });

/** Acciones de `src/web-actions.ts` (§4.1). El test de inventario falla si ACTIONS gana o pierde una. */
export const ACTION_CAPABILITIES: Record<string, Capability> = {
  'api-keys/create': A('OAM'), 'api-keys/revoke': A('OAM'),
  'activities/review': A('OA', true), 'automejora/save': A('O'), 'benchmarks/cancel': A('OA'),
  'changes/suite-task': A('O'), 'changes/retry': A('OA', true), 'changes/note': A('OAM', true),
  'changes/rename': A('OAM', true), 'changes/cancel': A('OA', true), 'activities/score': A('OA', true),
  'scorers/backfill': A('OA', true), 'questions/answer': A('OAM', true), 'signals/create': A('OAM', true),
  'signals/triage': A('OA', true), 'signals/ignore': A('OA', true),
  'automations/create': A('OA'), 'automations/update': A('OA'), 'automations/delete': A('OA'),
  'automations/run': A('OA', true), 'automations/enable': A('OA', true), 'automations/disable': A('OA', true),
  'workstreams/create': A('O'), 'workstreams/settings': A('OA', true), 'workstreams/state': A('OA'),
  'workstreams/adaptador': A('O'), 'workstreams/archive': A('OA', true), 'workstreams/runner': A('O'),
  'workstreams/acceso': A('O'), 'resident/config': A('O'), 'jira/import': A('OA'),
  'runners/create': A('O'), 'runners/update': A('O'), 'runners/delete': A('O'), 'runners/check': A('O'),
  'perfiles/importar': A('O'), 'definicion/importar': A('O'),
  'perfiles/guardar': A('O'), 'perfiles/asignar': A('O'),
};

/** Operaciones de identidad y cuenta (§4.2). */
export const IDENTITY_CAPABILITIES: Record<string, Capability> = {
  'api-key/create': A('OAM'), 'api-key/list': R('OAM'), 'api-key/revoke': A('OAM'),
  'session/login': { ...A('OAMV'), account: true }, 'session/logout': { ...A('OAMV'), account: true },
  'session/list': R('OAMV'), 'session/revoke': { ...A('OAMV'), account: true },
  'user/list': R('OA'), 'user/invite': A('OA'), 'user/revoke-invite': A('OA'),
  'user/role': A('O'), 'user/disable': A('O'), 'user/resolve-work': A('O'),
  'user/bootstrap': A(''), 'user/recover': A(''),
  'recovery/confirm': A('O'),
  'credits/balance-self': R('OAMV'),
};

const CAPABILITIES: Record<string, Capability> = { ...ACTION_CAPABILITIES, ...IDENTITY_CAPABILITIES };

export interface PolicySubject { role: Role; recovery?: boolean }
export interface PolicyContext {
  via: Via;
  /** El servidor corre con `--write`. */
  write: boolean;
  /** Ámbito de la clave si `via` es api. */
  keyScope?: 'read' | 'decide';
  /** `api-key/revoke`: la clave pertenece a otro usuario (solo owner). */
  target?: 'own' | 'other';
  /** `user/invite` y `user/revoke-invite`: rol de la invitación (admin solo member/viewer). */
  inviteRole?: Role;
}
export type Decision = { ok: true } | { ok: false; reason: string };

const ROLE_LETTER: Record<Role, string> = { owner: 'O', admin: 'A', member: 'M', viewer: 'V' };

const deny = (reason: string): Decision => ({ ok: false, reason });

export function authorize(subject: PolicySubject, capability: string, ctx: PolicyContext): Decision {
  const cap = CAPABILITIES[capability];
  if (!cap) return deny('unknown_capability');
  if (subject.recovery && capability !== 'recovery/confirm') return deny('recovery_restricted');
  const letter = ROLE_LETTER[subject.role];
  if (!letter || !cap.roles.includes(letter)) return deny('role'); // un rol desconocido deniega
  if (ctx.via === 'api') {
    // D-2 A: un viewer no tiene claves de API; el rol se vuelve a comprobar aunque la clave exista.
    if (subject.role === 'viewer') return deny('viewer_no_api');
    if (!cap.api) return deny('api_false');
    if (cap.mutation && ctx.keyScope !== 'decide') return deny('key_scope');
  }
  if (cap.mutation && !cap.account && !ctx.write) return deny('write_required');
  if ((capability === 'api-key/revoke' || capability === 'api-key/list') && ctx.target === 'other' && subject.role !== 'owner') return deny('role');
  if ((capability === 'user/invite' || capability === 'user/revoke-invite') && subject.role === 'admin'
      && ctx.inviteRole !== 'member' && ctx.inviteRole !== 'viewer') return deny('invite_role');
  return { ok: true };
}
