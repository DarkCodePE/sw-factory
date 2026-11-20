import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCandidate, dismissCandidate, evaluateThreshold, getConfig, listCandidates, setConfig, tick } from '../src/improve-auto.ts';
import { defaultProfile, DEFAULT_DIGEST, saveProfile } from '../src/profile.ts';
import { ensureSchema as ensureScores } from '../src/scorers.ts';
import { Store } from '../src/store.ts';

let dir: string, repo: string, store: Store, clock: number, wsId: string;
const tickClock = () => new Date(Date.UTC(2026, 0, 1) + clock++ * 1000);
const cfg = { enabled: true, suitePath: '/x/suite.json', split: 'development' as const, repeats: 1, window: 20, minScores: 10, threshold: 0.4 };
let n = 0;
/** Siembra una puntuación; el reloj avanza para que `finished_at` sea creciente. */
function score(passed: boolean | null, o: { scope?: string; digest?: string; status?: string } = {}): string {
  const id = `s${n++}`;
  store.db.query(`INSERT INTO scores (id, scorer, profile_digest, scope, subject_activity_id, change_id, workstream_id, origin, status, passed, created_at, finished_at)
    VALUES (?,?,?,?,?,?,?,'sample',?,?,?,?)`).run(id, 'j', o.digest ?? DEFAULT_DIGEST, o.scope ?? 'implement', `a${id}`, 'c', wsId, o.status ?? 'done', passed === null ? null : Number(passed), store.now(), store.now());
  return id;
}
const seed = (fails: number, total: number, o = {}) => { for (let i = 0; i < total; i++) score(i >= fails, o); };
const candidates = () => store.db.query('SELECT * FROM improvement_candidates').all() as any[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-improve-auto-'));
  repo = join(dir, 'repo');
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  clock = 0; n = 0;
  store = new Store(join(dir, 'f.db'), { clock: tickClock });
  wsId = store.createWorkstream({ slug: 'ws', goal: 'g', repo, agent: 'fake' }).id;
  ensureScores(store.db);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test('con 9 puntuaciones no evalúa; con 10 y 3 fallos (0,3) no dispara; con 10 y 4 dispara', () => {
  seed(9, 9);
  expect(evaluateThreshold(store, wsId, 'implement')).toMatchObject({ fire: false, total: 9 });
  store.db.exec('DELETE FROM scores'); seed(3, 10);
  expect(evaluateThreshold(store, wsId, 'implement')).toMatchObject({ fire: false, total: 10, fails: 3 });
  store.db.exec('DELETE FROM scores'); seed(4, 10);
  const e = evaluateThreshold(store, wsId, 'implement');
  expect(e).toMatchObject({ fire: true, total: 10, fails: 4 });
  expect(e.scores).toHaveLength(4);
});

test('dispara una vez; la segunda llamada es conflict (M1)', () => {
  seed(4, 10);
  const e = evaluateThreshold(store, wsId, 'implement');
  const id = createCandidate(store, wsId, 'implement', 'threshold', e.scores, e.total);
  expect(() => createCandidate(store, wsId, 'implement', 'threshold', e.scores)).toThrow(/conflict|ya hay/);
  expect(candidates()).toHaveLength(1);
  expect(candidates()[0]).toMatchObject({ id, status: 'pending', role: 'implement', base_digest: DEFAULT_DIGEST, origin: 'threshold' });
  expect(JSON.parse(candidates()[0].trigger_scores)).toEqual(e.scores);
  // Otro rol sí puede tener su candidato.
  seed(5, 10, { scope: 'qa' });
  createCandidate(store, wsId, 'qa', 'manual', evaluateThreshold(store, wsId, 'qa').scores);
  expect(candidates()).toHaveLength(2);
});

test('A5: tras descartar no vuelve a disparar hasta tener min_scores puntuaciones nuevas', () => {
  seed(5, 10);
  const id = createCandidate(store, wsId, 'implement', 'threshold', evaluateThreshold(store, wsId, 'implement').scores);
  dismissCandidate(store, id);
  expect(candidates()[0].status).toBe('dismissed');
  expect(evaluateThreshold(store, wsId, 'implement')).toMatchObject({ fire: false, total: 0 });
  seed(9, 9);
  expect(evaluateThreshold(store, wsId, 'implement').fire).toBe(false);
  seed(1, 1);
  expect(evaluateThreshold(store, wsId, 'implement')).toMatchObject({ fire: true, total: 10 });
  expect(() => dismissCandidate(store, id)).toThrow(/ya está dismissed/);
  expect(() => dismissCandidate(store, 'nope')).toThrow(/no existe/);
});

test('las puntuaciones sin nota (failed, skipped, passed NULL) no cuentan', () => {
  seed(5, 10);
  for (let i = 0; i < 20; i++) score(null, { status: i % 2 ? 'failed' : 'skipped' });
  score(false, { status: 'failed' });
  expect(evaluateThreshold(store, wsId, 'implement')).toMatchObject({ total: 10, fails: 5, fire: true });
});

test('solo cuentan las del perfil vigente y las del ámbito del rol', () => {
  const p = saveProfile(dir, { ...defaultProfile(), worker: { ...defaultProfile().worker, rules: defaultProfile().worker.rules + '\n' } }).digest;
  seed(10, 10, { digest: p });
  seed(10, 10, { scope: 'qa' });
  expect(evaluateThreshold(store, wsId, 'implement')).toMatchObject({ total: 0, fire: false });
  store.db.query('UPDATE workstreams SET profile = ? WHERE id = ?').run(p, wsId);
  expect(evaluateThreshold(store, wsId, 'implement')).toMatchObject({ total: 10, fire: true });
});

test('la ventana toma las `window` más recientes', () => {
  seed(10, 10); seed(0, 10);
  setConfig(store, 'ws', { ...cfg, window: 10 });
  expect(evaluateThreshold(store, wsId, 'implement')).toMatchObject({ total: 10, fails: 0, fire: false });
});

test('tick: sin configuración o con enabled = 0 no crea nada; habilitado crea un candidato y no más', async () => {
  seed(10, 10);
  await tick(store, dir, 'ws');
  expect(candidates()).toHaveLength(0);
  setConfig(store, 'ws', { ...cfg, enabled: false });
  await tick(store, dir, 'ws');
  expect(candidates()).toHaveLength(0);
  setConfig(store, 'ws', cfg);
  await tick(store, dir, 'ws'); await tick(store, dir, 'ws');
  expect(candidates()).toHaveLength(1);
  expect(store.db.query(`SELECT message FROM events WHERE message LIKE 'candidato de mejora%'`).all()).toHaveLength(1);
});

test('listCandidates sobre una base sin las tablas devuelve vacío y no las crea', () => {
  const p = join(dir, 'vieja.db');
  const db = new Database(p);
  expect(listCandidates(db)).toEqual([]);
  expect(listCandidates(db, 'ws')).toEqual([]);
  expect(db.query(`SELECT name FROM sqlite_master WHERE name LIKE 'improvement%'`).all()).toEqual([]);
  db.close();
});

test('setConfig valida y getConfig lo devuelve', () => {
  expect(getConfig(store, 'ws')).toBeNull();
  expect(() => setConfig(store, 'ws', { ...cfg, threshold: 0 })).toThrow(/threshold/);
  expect(() => setConfig(store, 'ws', { ...cfg, repeats: 0 })).toThrow(/repeats/);
  expect(() => setConfig(store, 'ws', { ...cfg, split: 'x' as any })).toThrow(/split/);
  setConfig(store, 'ws', cfg);
  expect(getConfig(store, 'ws')).toEqual({ workstreamId: wsId, ...cfg });
});

test('createCandidate rechaza rol desconocido y evidencia vacía', () => {
  expect(() => createCandidate(store, wsId, 'x' as any, 'manual', ['a'])).toThrow(/rol/);
  expect(() => createCandidate(store, wsId, 'qa', 'manual', [])).toThrow(/puntuación/);
});
