// Equipo de prueba del modo servidor: un owner, un admin, un member y un viewer con sesión web y CLI, y claves de usuario.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.ts';
import { acceptInvitation, bootstrapOwner, createUserKey, inviteUser, issueSession, resolvePrincipal, type Principal, type Role } from '../../src/users.ts';

export const ROLE_LIST = ['owner', 'admin', 'member', 'viewer'] as const;
export const SECRET = 'secreto-de-servicio-de-prueba';
export const ORIGIN = 'https://fab.example.test';

export interface Cloud {
  dir: string; stateDir: string; store: Store;
  web: Record<Role, Principal>; cli: Record<Role, Principal>;
  /** Clave de usuario `fabu_…` por rol (no hay de viewer: D-2 A). */
  keys: Record<'owner' | 'admin' | 'member', { read: string; decide: string }>;
  tokens: { web: Record<Role, string>; cli: Record<Role, string> };
  close(): void;
}

export function cloud(): Cloud {
  const dir = mkdtempSync(join(tmpdir(), 'fab-nube-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { mode: 0o700 });
  const store = new Store(join(stateDir, 'fabrica.db'));
  const o = bootstrapOwner(store, { issuer: 'github', subject: '1', displayName: 'Dueña', operator: 'op' });
  const ids: Record<Role, string> = { owner: o.id, admin: '', member: '', viewer: '' };
  const ownerWeb = resolvePrincipal(store, issueSession(store, o.id, 'web').token, 'web')!;
  (['admin', 'member', 'viewer'] as const).forEach((role, i) => {
    const inv = inviteUser(store, ownerWeb, { expectedIssuer: 'github', expectedSubject: String(10 + i), role });
    ids[role] = acceptInvitation(store, { code: inv.code, issuer: 'github', subject: String(10 + i), displayName: `u-${role}` }).id;
  });
  const web = {} as Record<Role, Principal>, cli = {} as Record<Role, Principal>;
  const tokens = { web: {} as Record<Role, string>, cli: {} as Record<Role, string> };
  for (const role of ROLE_LIST) {
    tokens.web[role] = issueSession(store, ids[role], 'web').token;
    tokens.cli[role] = issueSession(store, ids[role], 'cli').token;
    web[role] = resolvePrincipal(store, tokens.web[role], 'web')!;
    cli[role] = resolvePrincipal(store, tokens.cli[role], 'cli')!;
  }
  const keys = {} as Cloud['keys'];
  for (const role of ['owner', 'admin', 'member'] as const) {
    keys[role] = {
      read: createUserKey(store, web[role], `${role}-read`, 'read', { write: true }).key,
      decide: createUserKey(store, web[role], `${role}-decide`, 'decide', { write: true }).key,
    };
  }
  return { dir, stateDir, store, web, cli, keys, tokens, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
