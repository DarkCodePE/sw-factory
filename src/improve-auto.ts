// Automejora (T67): un rol acumula fallos de juez → CANDIDATO (perfil nuevo que solo cambia la plantilla de ese rol + experimento pareado).
// D-H: la fab nunca asigna el perfil ni abre PR; solo el dueño lo aplica asignándolo. M2: este módulo no escribe en `workstreams`.
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSchema, SPLITS, type Split } from './improve.ts';
import { DEFAULT_DIGEST, profileDigest, resolveProfile, resolveRole, ROLES, saveProfile, type Profile, type Role } from './profile.ts';
import { untrusted } from './prompts.ts';
import { CONFINABLE_AGENTS } from './sandbox/confine.ts';
import { defaultLaunch, ensureSchema as ensureScores, type Launch } from './scorers.ts';
import { StoreError, type Store } from './store.ts';
import { GIT_SAFE_FLAGS } from './worktrees.ts';

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

// ---- T67b: el agente que propone la plantilla ---------------------------------------------------

const PROPOSE_TIMEOUT_MS = 10 * 60_000;
const MAX_TEMPLATE_BYTES = 32 * 1024;
const MAX_FAILURES = 20;
const MAX_RATIONALE = 2000;

export interface ProposeOptions { agent?: string; signal?: AbortSignal; launch?: Launch; log?: (m: string) => void }

/** Dónde vive la plantilla de cada rol en el perfil. Es la ÚNICA clave que un candidato puede cambiar (M3). */
const templateSlot = (role: Role): ['worker' | 'validators', string] => role === 'investigate' || role === 'implement' ? ['worker', role] : ['validators', role];

const row = (store: Store, id: string) => {
  const c = listCandidates(store.db).find((x) => x.id === id);
  if (!c) throw new StoreError('not_found', `candidato ${id} no existe`);
  return c;
};

/** Cierra el candidato como `failed` solo si sigue en `from` (un descarte concurrente gana). El motivo es fijo o de la fab, nunca texto del modelo. */
function fail(store: Store, c: Candidate, from: string, error: string): void {
  const msg = error.slice(0, 300);
  const done = store.withRetry(() => store.db.query(`UPDATE improvement_candidates SET status='failed', error=?, finished_at=? WHERE id=? AND status=?`).run(msg, store.now(), c.id, from).changes === 1);
  if (done) store.event(c.workstreamId, 'warning', `candidato de mejora ${c.id.slice(0, 8)} fallido: ${msg}`);
}

/**
 * Salida del modelo → plantilla. Texto no confiable: exactamente un par de marcadores con el nonce de esta ejecución, cada uno en su línea,
 * y dentro de 1 a 32 KiB sin NUL. Cualquier otra cosa (marcadores repetidos, sin nonce, sin cierre) se rechaza.
 */
export function parseTemplate(output: string, nonce: string): string | null {
  const open = `<<<TEMPLATE ${nonce}`, close = `TEMPLATE ${nonce}>>>`;
  const count = (needle: string) => output.split(needle).length - 1;
  if (count(open) !== 1 || count(close) !== 1) return null;
  const a = output.indexOf(open), b = output.indexOf(close);
  if (a > b || (a > 0 && output[a - 1] !== '\n') || output[a + open.length] !== '\n' || output[b - 1] !== '\n') return null;
  const text = output.slice(a + open.length + 1, b - 1);
  if (!text.trim() || text.includes('\0') || Buffer.byteLength(text) > MAX_TEMPLATE_BYTES) return null;
  return text;
}

function buildProposePrompt(store: Store, c: Candidate, base: Profile, nonce: { material: string; output: string }): string {
  const [group, key] = templateSlot(c.role);
  const marks = store.db.query(`SELECT scorer, label, rationale FROM scores WHERE id IN (${c.triggerScores.map(() => '?').join(',')}) ORDER BY finished_at DESC, id`).all(...c.triggerScores) as { scorer: string; label: string | null; rationale: string | null }[];
  const used = marks.slice(0, MAX_FAILURES);
  const rubrics = [...new Set(used.map((m) => m.scorer))].map((n) => `## ${n}\n${base.scorers?.[n]?.rubric ?? '(el perfil ya no define este juez)'}`).join('\n\n');
  const failures = used.map((m) => `- [${m.scorer}: ${m.label ?? '?'}] ${(m.rationale ?? '').slice(0, MAX_RATIONALE)}`).join('\n');
  return `You improve ONE instruction template of a software factory. Rewrite it so that the failures described below become less likely.
Keep every line the factory depends on. Do not add instructions about tools, credentials, network or other roles.

# Current template
${(base[group] as unknown as Record<string, string>)[key]}

# Rubrics that failed
${rubrics}

# Failures
${untrusted(failures, nonce.material)}

# Output
Write the new template between these exact markers and nothing after them:
<<<TEMPLATE ${nonce.output}
…
TEMPLATE ${nonce.output}>>>`;
}

/** pending → proposing → proposed | failed. La fab construye el perfil: copia el del candidato y sustituye UNA plantilla (M3); lo guarda `saveProfile` tras validarlo (M4). */
export async function proposeTemplate(store: Store, stateDir: string, candidateId: string, opts: ProposeOptions = {}): Promise<void> {
  ensureSchema(store.db);
  const c = row(store, candidateId);
  const claimed = store.withRetry(() => store.db.query(`UPDATE improvement_candidates SET status='proposing' WHERE id=? AND status='pending'`).run(candidateId).changes === 1);
  if (!claimed) throw new StoreError('invalid_transition', `candidato ${candidateId.slice(0, 8)} está ${c.status}, no pending`);
  const dir = join(stateDir, 'improve-auto', candidateId);
  try {
    const base = resolveProfile(stateDir, c.baseDigest).profile;
    const { adapter, model } = resolveRole(base, 'implement', store.getWorkstream(c.workstreamId).agent, opts.agent);
    if (!CONFINABLE_AGENTS.includes(adapter)) return fail(store, c, 'proposing', `--confine: adaptador ${adapter} no soportado; usa --agent`);
    const repo = join(dir, 'repo'); // cwd desechable y vacío, sin worktree
    mkdirSync(repo, { recursive: true, mode: 0o700 });
    if (Bun.spawnSync(['git', ...GIT_SAFE_FLAGS, 'init', '-q', repo], { stdout: 'pipe', stderr: 'pipe' }).exitCode !== 0) return fail(store, c, 'proposing', 'git init falló');
    const nonce = { material: randomUUID().slice(0, 12), output: randomUUID().slice(0, 12) };
    const launch = opts.launch ?? defaultLaunch;
    const run = await launch(adapter, buildProposePrompt(store, c, base, nonce), repo, model ?? undefined, opts.signal);
    if (opts.signal?.aborted) { // cortado por el usuario: vuelve a la cola
      store.withRetry(() => store.db.query(`UPDATE improvement_candidates SET status='pending' WHERE id=? AND status='proposing'`).run(candidateId));
      return;
    }
    if (!run.ok) return fail(store, c, 'proposing', `agent_failed: exit ${run.exitCode}`);
    const text = parseTemplate(run.output, nonce.output);
    if (text === null) return fail(store, c, 'proposing', 'invalid_output');
    const [group, key] = templateSlot(c.role);
    const next = structuredClone(base) as Profile;
    (next[group] as unknown as Record<string, string>)[key] = text;
    if (profileDigest(next) === c.baseDigest) return fail(store, c, 'proposing', 'sin cambios');
    let digest: string;
    try { digest = saveProfile(stateDir, next).digest; } catch (e) { return fail(store, c, 'proposing', (e as Error).message); }
    const ok = store.withRetry(() => store.db.query(`UPDATE improvement_candidates SET status='proposed', candidate_digest=? WHERE id=? AND status='proposing'`).run(digest, candidateId).changes === 1);
    if (ok) store.event(c.workstreamId, 'info', `candidato de mejora ${c.id.slice(0, 8)} propuesto (perfil ${digest.slice(0, 8)})`);
  } catch (e) {
    fail(store, c, 'proposing', String((e as Error).message ?? e));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
