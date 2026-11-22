/**
 * Trabajo en cola de una cuenta suspendida (T119c, diseño §4.4): vista previa con revisión y resolución idempotente
 * (reasignar o cancelar) por el owner. El bloqueo de las reclamaciones del pool es de T120.
 *
 * El responsable de un change es `changes.responsible_user_id` (lo fija una reasignación) o, si no, el usuario del primer evento
 * del change (el originador autenticado). Reasignar no toca ese evento ni los asientos previos: el originador histórico se conserva.
 */
import { createHash } from 'node:crypto';
import { actorOf, audit, getUser, runAs, type Principal } from './users.ts';
import { isTerminalChange, StoreError, type Store } from './store.ts';

export interface AffectedChange { id: string; title: string; status: string }
export interface ResolvePlan { userId: string; affected: AffectedChange[]; excluded: { id: string; reason: 'active_attempt' }[]; revision: string }
export type ResolveMode = { reassignTo: string } | { cancel: true };
export interface ResolveResult { opId: string; mode: 'reassign' | 'cancel'; userId: string; to: string | null; changeIds: string[] }

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Changes no terminales cuyo responsable es `userId`, con los que tienen un intento vivo aparte. */
function plan(store: Store, userId: string): ResolvePlan {
  const rows = store.db.query(`
    SELECT c.id, c.title, c.status FROM changes c
    WHERE COALESCE(c.responsible_user_id, (SELECT e.actor_user_id FROM events e WHERE e.change_id = c.id ORDER BY e.id LIMIT 1)) = ?
    ORDER BY c.created_at, c.id`).all(userId) as AffectedChange[];
  const open = rows.filter(r => !isTerminalChange(r.status));
  const live = new Set((store.db.query(`SELECT DISTINCT change_id FROM activities WHERE status = 'in_progress'`).all() as { change_id: string }[]).map(r => r.change_id));
  const affected = open.filter(r => !live.has(r.id));
  const excluded = open.filter(r => live.has(r.id)).map(r => ({ id: r.id, reason: 'active_attempt' as const }));
  const revision = sha(JSON.stringify([userId, affected.map(a => [a.id, a.status]), excluded.map(e => e.id)]));
  return { userId, affected, excluded, revision };
}

function suspended(store: Store, userId: string) {
  const u = getUser(store, userId);
  if (!u) throw new StoreError('not_found', 'usuario no encontrado');
  if (!u.disabledAt) throw new StoreError('conflict', 'el usuario no está suspendido');
  return u;
}

export function previewResolveWork(store: Store, p: Principal, userId: string): ResolvePlan {
  return runAs(store, p, 'user/resolve-work', { write: true }, () => { suspended(store, userId); return plan(store, userId); });
}

const REASON = /^[^\u0000-\u001f\u007f]{1,500}$/;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Aplica la resolución. El mismo `opId` con los mismos parámetros devuelve el resultado anterior; con otros, `conflict`. */
export async function resolveWork(store: Store, p: Principal, userId: string, mode: ResolveMode, reason: string, confirm: string, opId: string): Promise<ResolveResult> {
  if (!/^[0-9a-f-]{36}$/.test(opId)) throw new StoreError('invalid_input', 'op-id inválido');
  if (!REASON.test(reason.trim())) throw new StoreError('invalid_input', 'motivo inválido');
  const params = { userId, mode: 'cancel' in mode ? 'cancel' : 'reassign', to: 'reassignTo' in mode ? mode.reassignTo : null, reason: reason.trim(), confirm };
  const repos: string[] = [];
  const result = runAs(store, p, 'user/resolve-work', { write: true }, (me): ResolveResult => {
    const prior = store.db.query(`SELECT action, detail FROM identity_audit WHERE op_id = ?`).get(opId) as { action: string; detail: string | null } | null;
    if (prior) {
      const d = JSON.parse(prior.detail ?? '{}') as { params?: unknown; result?: ResolveResult };
      if (prior.action !== 'user.resolve-work' || !same(d.params, params) || !d.result) throw new StoreError('conflict', 'op-id ya usado con otra entrada');
      return d.result;
    }
    suspended(store, userId);
    if ('reassignTo' in mode) {
      const target = getUser(store, mode.reassignTo);
      if (!target || target.disabledAt || target.role === 'viewer') throw new StoreError('conflict', 'el destino no está activo o no puede originar trabajo');
    }
    const now = plan(store, userId);
    if (now.revision !== confirm) throw new StoreError('conflict', 'la cola cambió: pide una vista previa nueva');
    store.asActor({ ...actorOf(me), role: me.role });
    try {
      for (const c of now.affected) {
        if ('cancel' in mode) {
          const ws = store.getWorkstream(store.getChange(c.id).workstreamId);
          store.event(ws.id, 'warning', `user resolve-work: change cancelado (responsable suspendido): ${reason.trim()}`, c.id);
          store.closeChange(c.id, 'canceled');
          repos.push(`${ws.repo}\n${c.id}`);
        } else {
          store.db.query('UPDATE changes SET responsible_user_id = ? WHERE id = ?').run(mode.reassignTo, c.id);
          store.event(store.getChange(c.id).workstreamId, 'info', `user resolve-work: responsable ${userId} -> ${mode.reassignTo}: ${reason.trim()}`, c.id);
        }
      }
    } finally { store.asActor(undefined); }
    const out: ResolveResult = { opId, mode: params.mode as 'cancel' | 'reassign', userId, to: params.to, changeIds: now.affected.map(a => a.id) };
    audit(store, actorOf(me), 'user.resolve-work', userId, { params, result: out, from: userId, to: params.to, changes: out.changeIds }, 'ok', opId);
    return out;
  });
  // La limpieza del worktree no es transaccional (igual que `changes/cancel`): un fallo no deshace la cancelación.
  const { removeWorktree } = await import('./worktrees.ts');
  for (const r of repos) { const [repo, id] = r.split('\n'); try { await store.waitForRelease(id!); await removeWorktree(repo!, store.stateDir!, id!); } catch { /* queda para `fab worktree repair` */ } }
  return result;
}
