import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRun } from '../src/agents.ts';
import { createCandidate, dismissCandidate, listCandidates, proposeTemplate, runCandidateExperiment, setConfig, tick, type TickOptions } from '../src/improve-auto.ts';
import { defaultProfile, listProfiles, saveProfile, type Profile } from '../src/profile.ts';
import { ensureSchema as ensureScores } from '../src/scorers.ts';
import { Store } from '../src/store.ts';

let dir: string, repo: string, suite: string, store: Store, wsId: string, base: string, baseProfile: Profile, clock: number;
const git = (...a: string[]) => Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdout: 'pipe' }).stdout.toString().trim();
const ok = (output: string): AgentRun => ({ ok: true, output, exitCode: 0, durationMs: 1, status: { kind: 'done', reason: '' } });
const nonceOf = (p: string) => /<<<TEMPLATE (\S+)/.exec(p)![1]!;
const proposer: TickOptions = { launch: async (_a, p) => ok(`<<<TEMPLATE ${nonceOf(p)}\n${baseProfile.worker.implement}\nWrite tests first.\nTEMPLATE ${nonceOf(p)}>>>`) };
const cfg = { enabled: true, suitePath: '', split: 'development' as const, repeats: 1, window: 20, minScores: 10, threshold: 0.4 };
const cands = () => listCandidates(store.db);
let n = 0;
const failing = (k = 10, fails = 5) => { for (let i = 0; i < k; i++) { const id = `s${n++}`; store.db.query(`INSERT INTO scores (id, scorer, profile_digest, scope, subject_activity_id, change_id, workstream_id, origin, status, label, passed, rationale, created_at, finished_at)
  VALUES (?,?,?,?,?,?,?,'sample','done',?,?,?,?,?)`).run(id, 'tests', base, 'implement', `a${id}`, 'c', wsId, i < fails ? 'mal' : 'ok', i < fails ? 0 : 1, 'porque sí', store.now(), store.now()); } };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-improve-exp-'));
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

test('ciclo completo con fake: pending → proposing → proposed → experimenting → ready; el workstream no cambia (A1)', async () => {
  failing();
  setConfig(store, 'ws', { ...cfg, suitePath: suite, repeats: 2 });
  const seen: string[] = [];
  const status = () => cands()[0]!.status;
  const tpl = baseProfile.worker.implement + '\nWrite tests first.';
  await tick(store, dir, 'ws', {
    launch: async (_a, p) => { seen.push(status()); return ok(`<<<TEMPLATE ${nonceOf(p)}\n${tpl}\nTEMPLATE ${nonceOf(p)}>>>`); },
    log: () => { if (seen[seen.length - 1] !== 'experimenting') seen.push(status()); },
  });
  expect(seen.slice(0, 2)).toEqual(['proposing', 'experimenting']);
  const [c] = cands();
  expect(c).toMatchObject({ status: 'ready', origin: 'threshold', role: 'implement', baseDigest: base });
  expect(c!.experimentId).toMatch(/^auto-[0-9a-f]{8}$/);
  expect(c!.triggerScores).toHaveLength(5);
  expect(c!.candidateDigest).not.toBe(base);
  expect(store.getWorkstream('ws').profile).toBe(base); // A1: el dueño lo asigna, la fab no
  const runs = store.db.query('SELECT arm, confined, profile_digest FROM experiment_runs WHERE experiment_id = ?').all(c!.experimentId) as any[];
  expect(runs).toHaveLength(4); // 1 tarea × 2 repeticiones × 2 brazos
  expect(runs.every((r) => r.confined === 1)).toBe(true); // M5
  expect(new Set(runs.map((r) => r.profile_digest))).toEqual(new Set([base, c!.candidateDigest]));
  const ev = (store.db.query('SELECT message FROM events WHERE message LIKE ?').all('candidato de mejora%') as any[]).map((e) => e.message);
  expect(ev).toHaveLength(3);
  expect(ev[2]).toContain(`listo (experimento ${c!.experimentId})`);
  expect(JSON.stringify(ev)).not.toContain('Write tests first');
  await tick(store, dir, 'ws', proposer); // otro tick: nada nuevo
  expect(cands()).toHaveLength(1);
});

test('A5: diez puntuaciones fallidas crean un candidato, no diez; tras descartarlo no se crea otro', async () => {
  failing(10, 10);
  setConfig(store, 'ws', { ...cfg, suitePath: suite });
  for (let i = 0; i < 3; i++) await tick(store, dir, 'ws', proposer);
  expect(cands()).toHaveLength(1);
  dismissCandidate(store, cands()[0]!.id);
  await tick(store, dir, 'ws', proposer);
  expect(cands()).toHaveLength(1);
  expect(cands()[0]!.status).toBe('dismissed');
});

test('A4: adaptador no confinable → failed y no corre ningún brazo', async () => {
  failing();
  setConfig(store, 'ws', { ...cfg, suitePath: suite });
  const id = createCandidate(store, wsId, 'implement', 'manual', ['s0']);
  await proposeTemplate(store, dir, id, proposer);
  expect(cands()[0]!.status).toBe('proposed');
  store.db.query(`UPDATE workstreams SET agent='native' WHERE id=?`).run(wsId);
  const p2 = saveProfile(dir, { ...baseProfile, scorers: undefined, harness: 'native' }).digest;
  store.db.query(`UPDATE improvement_candidates SET base_digest=? WHERE id=?`).run(p2, id);
  await runCandidateExperiment(store, dir, id);
  expect(cands()[0]).toMatchObject({ status: 'failed' });
  expect(cands()[0]!.error).toMatch(/--confine/);
  expect(store.db.query('SELECT COUNT(*) n FROM experiment_runs').get()).toEqual({ n: 0 });
  expect(existsSync(join(dir, 'improve'))).toBe(false);
});

test('suite inexistente → failed y el perfil candidato sigue guardado', async () => {
  failing();
  setConfig(store, 'ws', { ...cfg, suitePath: join(dir, 'no-existe.json') });
  await tick(store, dir, 'ws', proposer);
  const [c] = cands();
  expect(c).toMatchObject({ status: 'failed', experimentId: null });
  expect(c!.error).toMatch(/suite no encontrada/);
  expect(listProfiles(dir)).toContain(c!.candidateDigest!);
});

test('runCandidateExperiment solo desde proposed', async () => {
  failing();
  const id = createCandidate(store, wsId, 'implement', 'manual', ['s0']);
  await expect(runCandidateExperiment(store, dir, id)).rejects.toThrow(/no proposed/);
});

test('A1 estructural: el módulo no escribe en workstreams ni asigna perfil', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'improve-auto.ts'), 'utf8');
  expect(src).not.toMatch(/UPDATE\s+workstreams|INSERT\s+(OR\s+\w+\s+)?INTO\s+workstreams|assignProfile|setWorkstreamProfile|pinProfile|SET\s+profile\b|\.profile\s*=[^=]/i);
  expect(src).not.toMatch(/gh pr|createPullRequest|\bmerge\(/);
});
