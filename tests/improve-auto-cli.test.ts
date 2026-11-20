import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRun } from '../src/agents.ts';
import { improveMain } from '../src/improve-cli.ts';
import { listCandidates, proposeTemplate } from '../src/improve-auto.ts';
import { defaultProfile, saveProfile, type Profile } from '../src/profile.ts';
import { ensureSchema as ensureScores } from '../src/scorers.ts';
import { Store } from '../src/store.ts';

let dir: string, repo: string, suite: string, store: Store, wsId: string, base: string, baseProfile: Profile, clock: number;
let out: string[], err: string[];
const git = (...a: string[]) => Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdout: 'pipe' }).stdout.toString().trim();
const run = (...a: string[]) => improveMain(a, store, dir);
const ok = (output: string): AgentRun => ({ ok: true, output, exitCode: 0, durationMs: 1, status: { kind: 'done', reason: '' } });
let n = 0;
const failing = (k: number, scope = 'implement') => { for (let i = 0; i < k; i++) { const id = `s${n++}`; store.db.query(`INSERT INTO scores (id, scorer, profile_digest, scope, subject_activity_id, change_id, workstream_id, origin, status, label, passed, rationale, created_at, finished_at)
  VALUES (?,?,?,?,?,?,?,'sample','done','mal',0,'porque sí',?,?)`).run(id, 'tests', base, scope, `a${id}`, 'c', wsId, store.now(), store.now()); } };
const baseConfig = () => run('auto-config', 'ws', '--suite', suite, '--split', 'development', '--repeats', '1', '--enable');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-improve-cli-'));
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
  out = []; err = [];
  spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
});
afterEach(() => { (console.log as any).mockRestore(); (console.error as any).mockRestore(); store.close(); rmSync(dir, { recursive: true, force: true }); });

test('auto-config guarda, conserva lo anterior y valida', async () => {
  expect(await run('auto-config', 'ws', '--split', 'development', '--repeats', '1')).toBe(1);
  expect(err.join()).toContain('falta --suite');
  expect(await baseConfig()).toBe(0);
  expect(out.join()).toContain('activada');
  expect(await run('auto-config', 'ws', '--threshold', '0.7', '--disable')).toBe(0);
  const r = store.db.query('SELECT * FROM improvement_config').get() as any;
  expect(r).toMatchObject({ enabled: 0, threshold: 0.7, suite_path: suite, repeats: 1, window: 20, min_scores: 10 });
  err = [];
  expect(await run('auto-config', 'ws', '--threshold', '2')).toBe(1);
  expect(await run('auto-config', 'ws', '--enable', '--disable')).toBe(1);
});

test('propose con un candidato abierto para ese rol: conflict; sin fallos: invalid_input', async () => {
  expect(await run('propose', 'ws', '--role', 'implement')).toBe(1);
  expect(err.join()).toContain('error (invalid_input)');
  failing(2);
  expect(await run('propose', 'ws', '--role', 'implement')).toBe(0); // sin mirar el umbral: 2 fallos bastan
  expect(listCandidates(store.db)[0]).toMatchObject({ origin: 'manual', status: 'pending', role: 'implement' });
  err = [];
  expect(await run('propose', 'ws', '--role', 'implement')).toBe(1);
  expect(err.join()).toContain('error (conflict)');
  expect(await run('propose', 'ws', '--role', 'x')).toBe(1);
  expect(listCandidates(store.db)).toHaveLength(1);
});

test('candidates --json incluye el resumen del experimento (experimentRunsJson); la tabla no imprime plantillas', async () => {
  failing(2);
  await baseConfig();
  await run('propose', 'ws', '--role', 'implement');
  const id = listCandidates(store.db)[0]!.id;
  const tpl = 'PLANTILLA-SECRETA';
  await proposeTemplate(store, dir, id, { launch: async (_a, p) => { const nn = /<<<TEMPLATE (\S+)/.exec(p)![1]; return ok(`<<<TEMPLATE ${nn}\n${baseProfile.worker.implement}\n${tpl}\nTEMPLATE ${nn}>>>`); } });
  out = [];
  expect(await run('auto', 'ws', '--once', '--agent', 'fake')).toBe(0);
  expect(out.join()).toContain('1 candidato(s) listo(s)');
  expect(store.getWorkstream('ws').profile).toBe(base);
  out = [];
  expect(await run('candidates', 'ws', '--json')).toBe(0);
  const j = JSON.parse(out.join('\n'));
  expect(j).toHaveLength(1);
  expect(j[0]).toMatchObject({ status: 'ready', role: 'implement' });
  expect(j[0].experiment.runs).toHaveLength(2);
  expect(j[0].experiment.runs[0]).toMatchObject({ confined: true, success: 1 });
  out = [];
  expect(await run('candidates')).toBe(0);
  expect(out.join('\n')).toMatch(/ready/);
  expect(out.join('\n')).not.toContain(tpl);
});

test('candidates sin candidatos, y dismiss por prefijo', async () => {
  expect(await run('candidates')).toBe(0);
  expect(out.join()).toContain('sin candidatos');
  failing(1);
  await run('propose', 'ws', '--role', 'implement');
  const id = listCandidates(store.db)[0]!.id;
  err = [];
  expect(await run('dismiss', 'zzzz')).toBe(1);
  expect(await run('dismiss', id.slice(0, 8))).toBe(0);
  expect(listCandidates(store.db)[0]!.status).toBe('dismissed');
  expect(await run('dismiss', id.slice(0, 8))).toBe(1);
  expect(err.join()).toContain('invalid_transition');
});

test('auto --agent desconocido: error; subcomando desconocido lista los nuevos', async () => {
  expect(await run('auto', 'ws', '--once', '--agent', 'nope')).toBe(1);
  expect(await run('x')).toBe(1);
  expect(err.join()).toContain('dismiss');
});
