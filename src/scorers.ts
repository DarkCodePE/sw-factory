// Jueces (T64): clasifican una ejecución terminada contra una rúbrica. Su resultado es un aviso, nunca una puerta.
// Funciones puras (T64b) y cola, material y corredor (T64c). I1: solo se escribe en `scores` y se llama a `Store.event`; I2: nunca se toca el estado del change.
import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getAgent, MODEL_AGENTS, runAgent, type AgentRun } from './agents.ts';
import { runDirectory } from './manifest.ts';
import { DEFAULT_DIGEST, resolveProfile, type Profile, type ScorerDef, type ScorerScope } from './profile.ts';
import { untrusted } from './prompts.ts';
import { CONFINABLE_AGENTS } from './sandbox/confine.ts';
import { StoreError, type Activity, type Store } from './store.ts';
import { GIT_SAFE_FLAGS } from './worktrees.ts';

/** Decisión de muestreo determinista: la terna es la semilla, sin estado ni azar. `rate` 0 nunca, 1 siempre. */
export function sampled(scorer: string, profileDigest: string, subjectActivityId: string, rate: number): boolean {
  const u = createHash('sha256').update(`${scorer}\n${profileDigest}\n${subjectActivityId}`).digest().readUInt32BE(0);
  return u / 2 ** 32 < rate;
}

/** `material` va delimitado con `material` (no confiable); `output` es el nonce de la línea de salida y no aparece en el material. */
export interface ScorerNonces { material: string; output: string }

export function buildScorerPrompt(def: ScorerDef, material: string, nonce: ScorerNonces): string {
  return `You are a judge in a software factory. Classify ONE finished piece of work against the rubric.
You have no task other than classifying. Do not run commands and do not edit files.

# Rubric
${def.rubric}

# Classes
${def.classes.map((c) => `- ${c.label}`).join('\n')}

# Material
${untrusted(material, nonce.material)}

# Output
End with exactly one line:
CLASS ${nonce.output}: <one of the labels above>
followed by one short paragraph explaining why.`;
}

/** Acepta la salida solo con exactamente una línea `CLASS <nonce>: <etiqueta>` y la etiqueta es una clase del juez; si no, `null` (I3). */
export function parseScore(output: string, def: ScorerDef, nonce: string): { label: string; score: number; rationale: string } | null {
  const prefix = `CLASS ${nonce}:`;
  const lines = output.split('\n').map((l) => l.replace(/\r$/, ''));
  const hits = lines.flatMap((l, i) => (l.startsWith(prefix) ? [i] : []));
  if (hits.length !== 1) return null;
  const label = lines[hits[0]!]!.slice(prefix.length).trim();
  if (lines[hits[0]!] !== `${prefix} ${label}`) return null;
  const cls = def.classes.find((c) => c.label === label);
  if (!cls) return null;
  const para: string[] = [];
  for (const l of lines.slice(hits[0]! + 1)) {
    if (l.trim() === '') { if (para.length) break; continue; }
    para.push(l.trim());
  }
  return { label, score: cls.score, rationale: para.join(' ').slice(0, 600) };
}

// ---- T64c: tabla, cola y corredor -------------------------------------------------------------

const TIMEOUT_MS = 5 * 60_000;
const LEASE_MS = TIMEOUT_MS + 60_000; // el lease cubre el turno entero: no vence mientras el juez corre
const MAX_ATTEMPTS = 3;
const DIFF_MAX = 64 * 1024;

export function ensureSchema(db: Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY, scorer TEXT NOT NULL, profile_digest TEXT NOT NULL, scope TEXT NOT NULL,
  subject_activity_id TEXT NOT NULL, change_id TEXT NOT NULL, workstream_id TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL CHECK (origin IN ('sample','manual','backfill')),
  status TEXT NOT NULL CHECK (status IN ('pending','running','done','failed','skipped')),
  label TEXT, score REAL, passed INTEGER, rationale TEXT, agent TEXT, model TEXT, cost_usd REAL, duration_ms INTEGER,
  error TEXT, attempts INTEGER NOT NULL DEFAULT 0, lease_expires_at TEXT, created_at TEXT NOT NULL, finished_at TEXT,
  UNIQUE (scorer, profile_digest, subject_activity_id, round));
CREATE INDEX IF NOT EXISTS scores_claim ON scores(status, created_at);
CREATE INDEX IF NOT EXISTS scores_change ON scores(change_id);`);
}

/** Ámbitos en los que una activity es sujeto: solo ejecuciones terminadas con éxito (validadores, con veredicto). */
function scopesOf(a: Activity): ScorerScope[] {
  if (a.status !== 'completed') return [];
  if (a.kind === 'investigation') return ['investigate'];
  if (a.kind === 'implementation') return ['implement', 'change'];
  if (a.validator === 'code_review' || a.validator === 'security_audit' || a.validator === 'qa') return a.reviewStatus ? [a.validator] : [];
  return [];
}

export function subjectsFor(store: Store, wsId: string, since?: string): { activity: Activity; scope: ScorerScope }[] {
  return store.listActivities({ workstream: wsId })
    .filter((a) => !since || (a.completedAt ?? '') >= since)
    .flatMap((activity) => scopesOf(activity).map((scope) => ({ activity, scope })));
}

/** Perfil de la activity juzgada (I6), no el vigente del workstream; null si no se puede cargar. */
function profileOf(stateDir: string, a: Activity): { digest: string; profile: Profile } | null {
  try { return resolveProfile(stateDir, a.profileDigest ?? DEFAULT_DIGEST); } catch { return null; }
}

/** Idempotente (I5): INSERT OR IGNORE sobre la terna + round 0. Devuelve las filas nuevas. */
export function enqueueSampled(store: Store, stateDir: string, wsId: string, opts: { since?: string } = {}): number {
  ensureSchema(store.db);
  const ws = store.getWorkstream(wsId);
  const rows: { def: string; a: Activity; digest: string; scope: ScorerScope }[] = [];
  const cache = new Map<string, Profile | null>();
  for (const { activity: a, scope } of subjectsFor(store, ws.id, opts.since)) {
    const d = a.profileDigest ?? DEFAULT_DIGEST;
    if (!cache.has(d)) cache.set(d, profileOf(stateDir, a)?.profile ?? null);
    for (const [name, def] of Object.entries(cache.get(d)?.scorers ?? {}))
      if (def.scope === scope && sampled(name, d, a.id, def.sampling)) rows.push({ def: name, a, digest: d, scope });
  }
  const now = store.now();
  return store.withRetry(() => {
    let n = 0;
    for (const r of rows)
      n += store.db.query(`INSERT OR IGNORE INTO scores (id, scorer, profile_digest, scope, subject_activity_id, change_id, workstream_id, round, origin, status, created_at)
        VALUES (?,?,?,?,?,?,?,0,'sample','pending',?)`).run(randomUUID(), r.def, r.digest, r.scope, r.a.id, r.a.changeId, r.a.workstreamId, now).changes;
    return n;
  });
}

/** Encola un juez a mano sobre una activity terminada, con el `round` siguiente. No ejecuta. */
export function enqueueManual(store: Store, stateDir: string, activityId: string, scorer: string, origin: 'manual' | 'backfill'): string {
  ensureSchema(store.db);
  const a = store.getActivity(activityId);
  const scopes = scopesOf(a);
  if (!scopes.length) throw new StoreError('invalid_transition', `la activity ${activityId} no está terminada con éxito: no se puede puntuar`);
  const p = profileOf(stateDir, a);
  const def = p?.profile.scorers?.[scorer];
  if (!p || !def) throw new StoreError('not_found', `el perfil de la activity no define el juez ${scorer}`);
  if (!scopes.includes(def.scope)) throw new StoreError('invalid_input', `el juez ${scorer} puntúa ${def.scope}, no esta activity`);
  const id = randomUUID();
  const now = store.now();
  store.withRetry(() => {
    const max = (store.db.query('SELECT MAX(round) AS r FROM scores WHERE scorer = ? AND profile_digest = ? AND subject_activity_id = ?').get(scorer, p.digest, a.id) as { r: number | null }).r;
    store.db.query(`INSERT INTO scores (id, scorer, profile_digest, scope, subject_activity_id, change_id, workstream_id, round, origin, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'pending',?)`).run(id, scorer, p.digest, def.scope, a.id, a.changeId, a.workstreamId, max === null ? 0 : max + 1, origin, now);
  });
  return id;
}

// ---- material -----------------------------------------------------------------------------------

const cap = (s: string, n: number) => (Buffer.byteLength(s) <= n ? s : Buffer.from(s).subarray(0, n).toString('utf8') + '\n[recortado]');

/** `git diff base head` en el host; head sale de run.json. Sin git, base o head: «(diff no disponible)». */
function diffOf(store: Store, stateDir: string, a: Activity): string {
  const none = '(diff no disponible)';
  try {
    const c = store.getChange(a.changeId);
    const runJson = join(runDirectory(stateDir, c.id), 'run.json');
    const head = existsSync(runJson) ? (JSON.parse(readFileSync(runJson, 'utf8')) as { head?: string | null }).head : null;
    if (!c.baseSha || !head) return none;
    const p = Bun.spawnSync(['git', '-C', store.getWorkstream(c.workstreamId).repo, ...GIT_SAFE_FLAGS, 'diff', '--no-ext-diff', '--no-textconv', c.baseSha, head], { stdout: 'pipe', stderr: 'pipe' });
    return p.exitCode === 0 ? cap(p.stdout.toString(), DIFF_MAX) || '(diff vacío)' : none;
  } catch { return none; }
}

const section = (title: string, body: string | null | undefined) => `## ${title}\n${body?.trim() || '(vacío)'}`;

export function buildMaterial(store: Store, stateDir: string, a: Activity, scope: ScorerScope): string {
  const c = store.getChange(a.changeId);
  const done = store.listActivities({ changeId: c.id }).filter((x) => x.status === 'completed' && x.createdAt <= a.createdAt);
  const spec = [...done].reverse().find((x) => x.kind === 'investigation');
  const head = [section('Título', c.title), section('Descripción', c.description)];
  if (scope === 'investigate') return [...head, section('Resultado', a.result)].join('\n\n');
  if (scope === 'implement') return [...head, section('Spec', spec?.result), section('Resultado', a.result), section('Diff', diffOf(store, stateDir, a))].join('\n\n');
  if (scope === 'change')
    return [...head, ...done.filter((x) => x.result).map((x) => section(`Resultado de ${x.validator ?? x.kind}`, x.result)), section('Diff', diffOf(store, stateDir, a))].join('\n\n');
  return [...head, section('Diff', diffOf(store, stateDir, a)), section('Resultado', a.result)].join('\n\n');
}

// ---- corredor -----------------------------------------------------------------------------------

export interface Row { id: string; scorer: string; profile_digest: string; scope: ScorerScope; subject_activity_id: string; change_id: string; workstream_id: string; attempts: number }

/** Reclama una fila `pending` (o `running` con lease vencido) de forma atómica; null si no queda ninguna. */
function claim(store: Store): Row | null {
  const now = store.now();
  const lease = new Date(store.clock().getTime() + LEASE_MS).toISOString();
  return store.withRetry(() => {
    const q = store.db;
    q.query(`UPDATE scores SET status='failed', error='attempts_exhausted', lease_expires_at=NULL, finished_at=? WHERE status='running' AND lease_expires_at < ? AND attempts >= ?`).run(now, now, MAX_ATTEMPTS);
    q.query(`UPDATE scores SET status='pending', lease_expires_at=NULL WHERE status='running' AND lease_expires_at < ?`).run(now);
    const row = q.query(`SELECT * FROM scores WHERE status='pending' ORDER BY created_at, id LIMIT 1`).get() as Row | null;
    if (!row) return null;
    const won = q.query(`UPDATE scores SET status='running', attempts=attempts+1, lease_expires_at=? WHERE id=? AND status='pending'`).run(lease, row.id).changes === 1;
    return won ? { ...row, attempts: row.attempts + 1 } : null;
  });
}

export type Outcome = { status: 'done'; label: string; score: number; passed: boolean; rationale: string } | { status: 'failed' | 'skipped'; error: string };
export type Launch = (adapter: string, prompt: string, cwd: string, model: string | undefined, signal?: AbortSignal) => Promise<AgentRun>;

export interface RunPendingOpts {
  max?: number; budgetUsd?: number; agentOverride?: string; signal?: AbortSignal; log?: (m: string) => void;
  /** Inyectable en tests; por defecto `runAgent` confinado y de solo lectura. */
  launch?: Launch;
}

export const defaultLaunch: Launch = (adapter, prompt, cwd, model, signal) =>
  runAgent(getAgent(adapter), prompt, cwd, TIMEOUT_MS, { confine: true, readOnly: true, signal, ...(model ? { model } : {}) });

/** `profileDir` es donde vive el perfil del juez (por defecto `stateDir`); un benchmark juzga el Store de un brazo con el perfil del benchmark. */
export async function judge(store: Store, stateDir: string, row: Row, o: Pick<RunPendingOpts, 'agentOverride' | 'signal' | 'launch'>, meter: { agent?: string; model?: string; cost?: number; ms?: number }, profileDir = stateDir): Promise<Outcome> {
  let p: { profile: Profile } | null = null;
  try { p = resolveProfile(profileDir, row.profile_digest); } catch { /* perfil desaparecido */ }
  const def = p?.profile.scorers?.[row.scorer];
  if (!p || !def) return { status: 'skipped', error: 'el perfil ya no define este juez' };
  const own = def.harness ?? p.profile.harness;
  const adapter = o.agentOverride ?? own;
  const model = adapter === own && def.model && MODEL_AGENTS.includes(adapter) ? def.model : undefined;
  meter.agent = adapter; meter.model = model;
  if (!CONFINABLE_AGENTS.includes(adapter)) return { status: 'failed', error: `--confine: adaptador ${adapter} no soportado` };
  const dir = join(stateDir, 'scores', row.id);
  try {
    const repo = join(dir, 'repo'); // cwd desechable y vacío: nada del change queda montado (I4)
    mkdirSync(repo, { recursive: true, mode: 0o700 });
    const init = Bun.spawnSync(['git', ...GIT_SAFE_FLAGS, 'init', '-q', repo], { stdout: 'pipe', stderr: 'pipe' });
    if (init.exitCode !== 0) return { status: 'failed', error: 'git init falló' };
    const nonce = { material: randomUUID().slice(0, 12), output: randomUUID().slice(0, 12) };
    const prompt = buildScorerPrompt(def, buildMaterial(store, stateDir, store.getActivity(row.subject_activity_id), row.scope), nonce);
    const run = await (o.launch ?? defaultLaunch)(adapter, prompt, repo, model, o.signal);
    meter.cost = run.usage?.costUsd; meter.ms = run.durationMs;
    if (!run.ok) return { status: 'failed', error: `agent_failed: exit ${run.exitCode}` };
    const s = parseScore(run.output, def, nonce.output);
    return s ? { status: 'done', ...s, passed: s.score >= def.passing } : { status: 'failed', error: 'invalid_output' };
  } catch (e) {
    return { status: 'failed', error: String((e as Error).message ?? e).slice(0, 300) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runPending(store: Store, stateDir: string, opts: RunPendingOpts = {}): Promise<{ ran: number; done: number; failed: number }> {
  ensureSchema(store.db);
  const out = { ran: 0, done: 0, failed: 0 };
  const max = opts.max ?? 20;
  let spent = 0;
  while (out.ran < max && !opts.signal?.aborted && !(opts.budgetUsd !== undefined && spent >= opts.budgetUsd)) {
    const row = claim(store);
    if (!row) break;
    const meter: { agent?: string; model?: string; cost?: number; ms?: number } = {};
    const r = await judge(store, stateDir, row, opts, meter);
    spent += meter.cost ?? 0;
    out.ran++;
    if (opts.signal?.aborted && r.status === 'failed') { // cortado por el usuario: vuelve a la cola, no es una mala nota
      store.withRetry(() => store.db.query(`UPDATE scores SET status='pending', lease_expires_at=NULL WHERE id=? AND status='running' AND attempts=?`).run(row.id, row.attempts));
      out.ran--;
      break;
    }
    // Solo cierra quien aún posee el reclamo: un corredor lento no pisa una fila reclamada de nuevo (A7).
    const closed = store.withRetry(() => store.db.query(`UPDATE scores SET status=?, label=?, score=?, passed=?, rationale=?, agent=?, model=?, cost_usd=?, duration_ms=?, error=?, lease_expires_at=NULL, finished_at=?
      WHERE id=? AND status='running' AND attempts=?`).run(r.status, r.status === 'done' ? r.label : null, r.status === 'done' ? r.score : null,
      r.status === 'done' ? Number(r.passed) : null, r.status === 'done' ? r.rationale : null, meter.agent ?? null, meter.model ?? null,
      meter.cost ?? null, meter.ms ?? null, r.status === 'done' ? null : r.error, store.now(), row.id, row.attempts).changes === 1);
    if (!closed) continue;
    if (r.status === 'done') out.done++; else if (r.status === 'failed') out.failed++;
    opts.log?.(`juez ${row.scorer} → ${r.status === 'done' ? r.label : r.status}`);
    if (r.status === 'done' && !r.passed) {
      const def = resolveProfile(stateDir, row.profile_digest).profile.scorers![row.scorer]!;
      try { store.event(row.workstream_id, 'warning', `aviso de juez ${row.scorer}: ${r.label} (${r.score} < ${def.passing})`, row.change_id, row.subject_activity_id); } catch { /* el aviso no es una puerta */ }
    }
  }
  return out;
}
