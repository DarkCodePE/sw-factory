// Arreglos tras la verificación de T67 (H2 a H6).
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRun } from '../src/agents.ts';
import { createCandidate, dismissCandidate, listCandidates, proposeTemplate, recoverStuck, setConfig, tick, type TickOptions } from '../src/improve-auto.ts';
import { ensureSchema } from '../src/improve.ts';
import { defaultProfile, loadProfile, saveProfile, type Profile } from '../src/profile.ts';
import { ensureSchema as ensureScores } from '../src/scorers.ts';
import { Store } from '../src/store.ts';

let dir: string, repo: string, suite: string, store: Store, wsId: string, base: string, baseProfile: Profile, clock: number, n: number;
const git = (...a: string[]) => Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdout: 'pipe' }).stdout.toString().trim();
const ok = (output: string): AgentRun => ({ ok: true, output, exitCode: 0, durationMs: 1, status: { kind: 'done', reason: '' } });
const nonceOf = (p: string) => /<<<TEMPLATE (\S+)/.exec(p)![1]!;
const wrap = (p: string, body: string) => `<<<TEMPLATE ${nonceOf(p)}\n${body}\nTEMPLATE ${nonceOf(p)}>>>`;
const newTpl = () => baseProfile.worker.implement + '\nWrite tests first.';
const proposer: TickOptions = { launch: async (_a, p) => ok(wrap(p, newTpl())) };
const cfg = () => ({ enabled: true, suitePath: suite, split: 'development' as const, repeats: 1, window: 20, minScores: 10, threshold: 0.4 });
const cands = () => listCandidates(store.db);
const fails = (k: number, o: { scope?: string; rationale?: string } = {}) => {
  const ids: string[] = [];
  for (let i = 0; i < k; i++) {
    const id = `s${n++}`; ids.push(id);
    store.db.query(`INSERT INTO scores (id, scorer, profile_digest, scope, subject_activity_id, change_id, workstream_id, origin, status, label, passed, rationale, created_at, finished_at)
      VALUES (?,?,?,?,?,?,?,'sample','done','mal',0,?,?,?)`).run(id, 'tests', base, o.scope ?? 'implement', `a${id}`, 'c', wsId, o.rationale ?? 'porque sí', store.now(), store.now());
  }
  return ids;
};
const setStatus = (id: string, status: string, lease: string | null) => store.db.query('UPDATE improvement_candidates SET status=?, lease_expires_at=? WHERE id=?').run(status, lease, id);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-improve-fixes-'));
  repo = join(dir, 'repo');
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'init');
  suite = join(dir, 'suite.json');
  writeFileSync(suite, JSON.stringify({ tasks: [{ id: 't1', repo, base: git('rev-parse', 'HEAD'), description: 'tarea', verify: 'test -f a.txt', split: 'development' }] }));
  clock = 0; n = 0;
  store = new Store(join(dir, 'f.db'), { clock: () => new Date(Date.UTC(2026, 0, 1) + clock++ * 1000) });
  baseProfile = { ...defaultProfile(), schemaVersion: 2, harness: 'fake', scorers: { tests: { scope: 'implement', rubric: 'R', classes: [{ label: 'ok', score: 1 }, { label: 'mal', score: 0 }], passing: 0.5, sampling: 1 } } } as Profile;
  base = saveProfile(dir, baseProfile).digest;
  wsId = store.createWorkstream({ slug: 'ws', goal: 'g', repo, agent: 'fake', profile: base }).id;
  ensureScores(store.db);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

// ---- H2: lease y recuperación ----

test('H2: proposing con lease vencido vuelve a pending y el siguiente tick lo propone', async () => {
  setConfig(store, 'ws', cfg());
  const id = createCandidate(store, wsId, 'implement', 'manual', fails(2));
  setStatus(id, 'proposing', '2000-01-01T00:00:00.000Z'); // el proceso murió hace mucho
  await tick(store, dir, 'ws', { ...proposer, log: () => {} });
  expect(cands()[0]!.status).toBe('ready');
  expect(store.db.query(`SELECT message FROM events WHERE message LIKE '%interrumpido%'`).all()).toHaveLength(1);
});

test('H2: proposing con el lease vigente (otro proceso trabajando) no se toca', async () => {
  setConfig(store, 'ws', cfg());
  const id = createCandidate(store, wsId, 'implement', 'manual', fails(2));
  setStatus(id, 'proposing', '2999-01-01T00:00:00.000Z');
  recoverStuck(store, 'ws');
  expect(cands()[0]!.status).toBe('proposing');
});

test('H2: experimenting con el lease vencido, o sin lease (base anterior), queda failed «interrumpido»', () => {
  const a = createCandidate(store, wsId, 'implement', 'manual', fails(2));
  setStatus(a, 'experimenting', '2000-01-01T00:00:00.000Z');
  recoverStuck(store, 'ws');
  expect(cands()[0]).toMatchObject({ status: 'failed', error: 'interrumpido' });
  const b = createCandidate(store, wsId, 'qa', 'manual', fails(2, { scope: 'qa' }));
  setStatus(b, 'experimenting', null);
  recoverStuck(store, 'ws');
  expect(cands().find((c) => c.id === b)).toMatchObject({ status: 'failed', error: 'interrumpido' });
});

test('H2: el claim deja un lease en el futuro', async () => {
  const id = createCandidate(store, wsId, 'implement', 'manual', fails(2));
  let lease = '';
  await proposeTemplate(store, dir, id, { launch: async () => { lease = (store.db.query('SELECT lease_expires_at l FROM improvement_candidates').get() as any).l; return ok('nada'); } });
  expect(Date.parse(lease)).toBeGreaterThan(Date.parse(store.now()));
});

test('H2: una base creada antes del lease se migra sin perder filas', () => {
  ensureSchema(store.db);
  store.db.exec('DROP INDEX improvement_open; DROP TABLE improvement_candidates');
  store.db.exec(`CREATE TABLE improvement_candidates (id TEXT PRIMARY KEY, workstream_id TEXT NOT NULL, role TEXT NOT NULL, base_digest TEXT NOT NULL, candidate_digest TEXT, experiment_id TEXT,
    origin TEXT NOT NULL, trigger_scores TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, finished_at TEXT)`);
  store.db.query(`INSERT INTO improvement_candidates (id, workstream_id, role, base_digest, origin, trigger_scores, status, created_at) VALUES ('x',?,'qa','d','manual','["s"]','proposing','2026-01-01')`).run(wsId);
  recoverStuck(store, 'ws'); // ensureSchema añade la columna; sin lease cuenta como vencido
  expect(cands()[0]).toMatchObject({ id: 'x', status: 'pending' });
});

// ---- H3: tope de la propuesta ----

test('H3: PROPOSE_TIMEOUT_MS se usa (lanzador propio con su tope), no solo se declara', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'improve-auto.ts'), 'utf8');
  expect(src.match(/PROPOSE_TIMEOUT_MS/g)!.length).toBeGreaterThanOrEqual(3);
  expect(src).toMatch(/runAgent\(getAgent\(adapter\), prompt, cwd, PROPOSE_TIMEOUT_MS/);
  expect(src).toMatch(/opts\.launch \?\? proposeLaunch/);
});

// ---- H4: directorio desechable ----

test('H4: un directorio de un intento anterior con .git plantado se borra antes de crear el repo', async () => {
  const id = createCandidate(store, wsId, 'implement', 'manual', fails(2));
  const old = join(dir, 'improve-auto', id, 'repo');
  mkdirSync(old, { recursive: true });
  symlinkSync('/etc', join(old, '.git')); writeFileSync(join(dir, 'improve-auto', id, 'resto'), 'x');
  let seen = null as { gitIsDir: boolean; resto: boolean } | null;
  await proposeTemplate(store, dir, id, { launch: async (_a, _p, cwd) => {
    seen = { gitIsDir: lstatSync(join(cwd, '.git')).isDirectory(), resto: existsSync(join(cwd, '..', 'resto')) };
    return ok('nada');
  } });
  expect(seen).toEqual({ gitIsDir: true, resto: false });
});

// ---- H6 ----

test('H6: setConfig rechaza min > window; min = window vale', () => {
  expect(() => setConfig(store, 'ws', { ...cfg(), window: 5, minScores: 10 })).toThrow(/--min/);
  setConfig(store, 'ws', { ...cfg(), window: 10, minScores: 10 });
});

// ---- H5: huecos de test ----

test('H5/T16: el experimento compara base (vigente) contra candidato, no al revés', async () => {
  setConfig(store, 'ws', cfg());
  await tick(store, dir, 'ws', proposer); // sin fallos: nada
  createCandidate(store, wsId, 'implement', 'manual', fails(2));
  await tick(store, dir, 'ws', proposer);
  const [c] = cands();
  expect(c!.status).toBe('ready');
  expect(store.db.query('SELECT baseline, candidate FROM experiments WHERE id = ?').get(c!.experimentId)).toEqual({ baseline: base, candidate: c!.candidateDigest });
});

test('H5/T5,T7: descartar durante proposing no revive el candidato', async () => {
  const id = createCandidate(store, wsId, 'implement', 'manual', fails(2));
  await proposeTemplate(store, dir, id, { launch: async (_a, p) => { dismissCandidate(store, id); return ok(wrap(p, newTpl())); } });
  expect(cands()[0]).toMatchObject({ status: 'dismissed', candidateDigest: null });
});

test('H5/T5: un fallo tras un descarte no reescribe el estado', async () => {
  const id = createCandidate(store, wsId, 'implement', 'manual', fails(2));
  await proposeTemplate(store, dir, id, { launch: async () => { dismissCandidate(store, id); return ok('sin marcadores'); } });
  expect(cands()[0]).toMatchObject({ status: 'dismissed', error: null });
});

test('H5/T6: descartar durante experimenting no lo deja en ready', async () => {
  setConfig(store, 'ws', cfg());
  createCandidate(store, wsId, 'implement', 'manual', fails(2));
  let once = true;
  await tick(store, dir, 'ws', { ...proposer, log: () => { if (once) { once = false; dismissCandidate(store, cands()[0]!.id); } } });
  expect(cands()[0]!.status).toBe('dismissed');
  expect(store.db.query(`SELECT message FROM events WHERE message LIKE '%listo%'`).all()).toHaveLength(0);
});

test('H5/T9: abortar durante la propuesta devuelve el candidato a pending sin marcarlo fallido', async () => {
  const id = createCandidate(store, wsId, 'implement', 'manual', fails(2));
  const ctl = new AbortController();
  await proposeTemplate(store, dir, id, { signal: ctl.signal, launch: async () => { ctl.abort(); return { ...ok(''), ok: false, exitCode: 1 }; } });
  expect(cands()[0]).toMatchObject({ status: 'pending', error: null });
});

test('H5/T10: la base es la del candidato aunque el workstream ya tenga otro perfil', async () => {
  const id = createCandidate(store, wsId, 'implement', 'manual', fails(2));
  const other = saveProfile(dir, { ...baseProfile, worker: { ...baseProfile.worker, implement: baseProfile.worker.implement + '\nOTRA-BASE' } }).digest;
  store.db.query('UPDATE workstreams SET profile=? WHERE id=?').run(other, wsId);
  let prompt = '';
  await proposeTemplate(store, dir, id, { launch: async (_a, p) => { prompt = p; return ok(wrap(p, newTpl())); } });
  expect(prompt).not.toContain('OTRA-BASE');
  const c = cands()[0]!;
  expect(c).toMatchObject({ status: 'proposed', baseDigest: base });
  expect(loadProfile(dir, c.candidateDigest!).worker.implement).toBe(newTpl());
});

test('H5/T23: el rol investigate cambia worker.investigate y nada más', async () => {
  const id = createCandidate(store, wsId, 'investigate', 'manual', fails(2, { scope: 'investigate' }));
  const tpl = baseProfile.worker.investigate + '\nCita archivo:línea.';
  await proposeTemplate(store, dir, id, { launch: async (_a, p) => ok(wrap(p, tpl)) });
  const c = cands()[0]!;
  expect(c.status).toBe('proposed');
  const next = loadProfile(dir, c.candidateDigest!);
  expect(next.worker.investigate).toBe(tpl);
  expect({ ...next, worker: { ...next.worker, investigate: '' } }).toEqual({ ...baseProfile, worker: { ...baseProfile.worker, investigate: '' } });
});

test('H5/T17,T18: el prompt recorta cada explicación a 2000 y usa como mucho 20 fallos', async () => {
  const id = createCandidate(store, wsId, 'implement', 'manual', fails(25, { rationale: 'Z'.repeat(5000) }));
  let prompt = '';
  await proposeTemplate(store, dir, id, { launch: async (_a, p) => { prompt = p; return ok('nada'); } });
  expect(prompt.match(/^- \[tests: mal\]/gm)).toHaveLength(20);
  expect(prompt.match(/Z+/)![0]).toHaveLength(2000);
});
