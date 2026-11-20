// Automejora (T67): un rol acumula fallos de juez → CANDIDATO (perfil nuevo que solo cambia la plantilla de ese rol + experimento pareado).
// D-H: la fab nunca asigna el perfil ni abre PR; solo el dueño lo aplica asignándolo. M2: este módulo no escribe en `workstreams`.
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { ensureSchema, SPLITS, type Split } from './improve.ts';
import { DEFAULT_DIGEST, ROLES, type Role } from './profile.ts';
import { ensureSchema as ensureScores } from './scorers.ts';
import { StoreError, type Store } from './store.ts';

const OPEN = ['pending', 'proposing', 'proposed', 'experimenting', 'ready'];
export interface AutoConfig { workstreamId: string; enabled: boolean; suitePath: string; split: Split; repeats: number; window: number; minScores: number; threshold: number }
export interface Candidate {
  id: string; workstreamId: string; role: Role; baseDigest: string; candidateDigest: string | null; experimentId: string | null;
  origin: 'threshold' | 'manual'; triggerScores: string[]; status: string; error: string | null; createdAt: string; finishedAt: string | null;
}

const bad = (m: string) => new StoreError('invalid_input', m);
const int = (n: unknown, min: number, what: string): number => { if (!Number.isSafeInteger(n) || (n as number) < min) throw bad(`${what} debe ser un entero ≥ ${min}`); return n as number; };

const toConfig = (r: any): AutoConfig => ({ workstreamId: r.workstream_id, enabled: r.enabled === 1, suitePath: r.suite_path, split: r.split, repeats: r.repeats, window: r.window, minScores: r.min_scores, threshold: r.threshold });

export function getConfig(store: Store, wsId: string): AutoConfig | null {
  ensureSchema(store.db);
  const r = store.db.query('SELECT * FROM improvement_config WHERE workstream_id = ?').get(store.getWorkstream(wsId).id);
  return r ? toConfig(r) : null;
}

/** Guarda la configuración (`enabled` apagado por defecto). Valida todo: viene de la CLI. */
export function setConfig(store: Store, wsId: string, c: Omit<AutoConfig, 'workstreamId'>): void {
  ensureSchema(store.db);
  if (!c.suitePath) throw bad('falta --suite');
  if (!SPLITS.includes(c.split)) throw bad(`split debe ser ${SPLITS.join('|')}`);
  int(c.repeats, 1, '--repeats'); int(c.window, 1, '--window'); int(c.minScores, 1, '--min');
  if (!(c.threshold > 0 && c.threshold <= 1)) throw bad('--threshold debe estar en (0, 1]');
  store.withRetry(() => store.db.query(`INSERT OR REPLACE INTO improvement_config (workstream_id, enabled, suite_path, split, repeats, window, min_scores, threshold) VALUES (?,?,?,?,?,?,?,?)`)
    .run(store.getWorkstream(wsId).id, c.enabled ? 1 : 0, c.suitePath, c.split, c.repeats, c.window, c.minScores, c.threshold));
}

const DEFAULTS = { window: 20, minScores: 10, threshold: 0.4 };

/**
 * Regla del umbral: últimas `window` puntuaciones `done` del rol con el perfil vigente, posteriores al último candidato del rol (cualquier estado).
 * `scores` son los ids de las que fallaron; `fire` solo si hay `min_scores` y fallos/total ≥ umbral. Las sin nota no cuentan.
 */
export function evaluateThreshold(store: Store, wsId: string, role: Role): { fire: boolean; scores: string[]; total: number; fails: number } {
  ensureSchema(store.db); ensureScores(store.db);
  const ws = store.getWorkstream(wsId);
  const cfg = getConfig(store, ws.id) ?? DEFAULTS;
  const rows = store.db.query(`SELECT id, passed FROM scores WHERE workstream_id = ? AND scope = ? AND status = 'done' AND profile_digest = ?
      AND finished_at > COALESCE((SELECT MAX(created_at) FROM improvement_candidates WHERE workstream_id = ? AND role = ?), '')
    ORDER BY finished_at DESC, id DESC LIMIT ?`).all(ws.id, role, ws.profile ?? DEFAULT_DIGEST, ws.id, role, cfg.window) as { id: string; passed: number | null }[];
  const scores = rows.filter((r) => r.passed === 0).map((r) => r.id);
  return { fire: rows.length >= cfg.minScores && scores.length / rows.length >= cfg.threshold, scores, total: rows.length, fails: scores.length };
}

/** M1: como mucho un candidato abierto por workstream y rol; si ya hay uno, `conflict`. `total` solo adorna el evento. */
export function createCandidate(store: Store, wsId: string, role: Role, origin: 'threshold' | 'manual', scores: string[], total = scores.length): string {
  ensureSchema(store.db);
  if (!ROLES.includes(role)) throw bad(`rol desconocido ${role}`);
  if (!scores.length) throw bad('un candidato necesita al menos una puntuación fallida como evidencia');
  const ws = store.getWorkstream(wsId);
  const id = randomUUID();
  try {
    store.withRetry(() => store.db.query(`INSERT INTO improvement_candidates (id, workstream_id, role, base_digest, origin, trigger_scores, status, created_at) VALUES (?,?,?,?,?,?,'pending',?)`)
      .run(id, ws.id, role, ws.profile ?? DEFAULT_DIGEST, origin, JSON.stringify(scores), store.now()));
  } catch (e) {
    if (/UNIQUE|constraint/i.test((e as Error).message)) throw new StoreError('conflict', `ya hay un candidato abierto para el rol ${role} en ${ws.slug}`);
    throw e;
  }
  store.event(ws.id, 'info', `candidato de mejora ${id.slice(0, 8)} creado para el rol ${role} (${scores.length}/${total} puntuaciones)`);
  return id;
}

/** Descarta un candidato abierto. Quien lo avance después debe actualizar con `WHERE status = <esperado>` para no revivirlo. */
export function dismissCandidate(store: Store, candidateId: string): void {
  ensureSchema(store.db);
  const r = store.db.query('SELECT workstream_id, status FROM improvement_candidates WHERE id = ?').get(candidateId) as { workstream_id: string; status: string } | null;
  if (!r) throw new StoreError('not_found', `candidato ${candidateId} no existe`);
  if (!OPEN.includes(r.status)) throw new StoreError('invalid_transition', `candidato ${candidateId.slice(0, 8)} ya está ${r.status}`);
  store.withRetry(() => store.db.query(`UPDATE improvement_candidates SET status = 'dismissed', finished_at = ? WHERE id = ? AND status IN (${OPEN.map(() => '?').join(',')})`).run(store.now(), candidateId, ...OPEN));
  store.event(r.workstream_id, 'info', `candidato de mejora ${candidateId.slice(0, 8)} descartado`);
}

/** Solo lectura: sobre una base sin la tabla devuelve vacío y no la crea. */
export function listCandidates(db: Database, wsId?: string): Candidate[] {
  if (!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'improvement_candidates'`).get()) return [];
  const rows = (wsId
    ? db.query('SELECT * FROM improvement_candidates WHERE workstream_id = ? OR workstream_id IN (SELECT id FROM workstreams WHERE slug = ?) ORDER BY created_at, id').all(wsId, wsId)
    : db.query('SELECT * FROM improvement_candidates ORDER BY created_at, id').all()) as any[];
  return rows.map((r) => ({ id: r.id, workstreamId: r.workstream_id, role: r.role, baseDigest: r.base_digest, candidateDigest: r.candidate_digest, experimentId: r.experiment_id,
    origin: r.origin, triggerScores: JSON.parse(r.trigger_scores), status: r.status, error: r.error, createdAt: r.created_at, finishedAt: r.finished_at }));
}

export interface TickOptions { agent?: string }

/** Evalúa el umbral de cada rol y crea los candidatos que toquen. Apagado sin configuración o con `enabled = 0`. */
export async function tick(store: Store, _stateDir: string, wsId: string, _opts: TickOptions = {}): Promise<void> {
  if (!getConfig(store, wsId)?.enabled) return;
  for (const role of ROLES) {
    const e = evaluateThreshold(store, wsId, role);
    if (!e.fire) continue;
    try { createCandidate(store, wsId, role, 'threshold', e.scores, e.total); } catch (err) { if (!(err instanceof StoreError && err.code === 'conflict')) throw err; }
  }
}
