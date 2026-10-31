import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildWorkerPrompt } from '../src/prompts.ts';
import { runPool } from '../src/pool.ts';
import { canonicalJson, defaultProfile, DEFAULT_DIGEST, loadProfile, profileDigest, saveProfile } from '../src/profile.ts';
import { Store } from '../src/store.ts';
import { buildValidatorPrompt } from '../src/validators/prompts.ts';
import golden from './fixtures/prompts-golden.json';

let dir: string;
let repo: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fabrica-profile-'));
  repo = join(dir, 'repo');
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.']);
  Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const candidate = () => {
  const p = defaultProfile();
  p.worker.implement = p.worker.implement.replace('3. Run the test suite', '3. Run the test suite BEFORE finishing');
  return p;
};

test('digest estable e independiente del orden de claves', () => {
  const p = defaultProfile();
  const shuffled = JSON.parse(JSON.stringify({ validators: p.validators, worker: p.worker, harness: p.harness, schemaVersion: 1 }));
  expect(profileDigest(shuffled)).toBe(profileDigest(p));
  expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  expect(profileDigest(candidate())).not.toBe(DEFAULT_DIGEST);
  expect(DEFAULT_DIGEST).toMatch(/^[0-9a-f]{64}$/);
});

test('import es idempotente, inmutable y direccionado por contenido', () => {
  const first = saveProfile(dir, candidate());
  expect(first.created).toBe(true);
  expect(saveProfile(dir, JSON.parse(JSON.stringify(candidate())))).toEqual({ digest: first.digest, created: false });
  expect(readdirSync(join(dir, 'profiles'))).toEqual([`${first.digest}.json`]);
  expect(loadProfile(dir, first.digest)).toEqual(candidate());
  // Un archivo alterado ya no corresponde a su digest.
  const path = join(dir, 'profiles', `${first.digest}.json`);
  rmSync(path);
  writeFileSync(path, canonicalJson(defaultProfile()));
  expect(() => loadProfile(dir, first.digest)).toThrow(/corrupto/);
});

test('plantilla o esquema inválido se rechaza sin escribir nada', () => {
  const bad = (mut: (p: any) => void, re: RegExp) => {
    const p: any = defaultProfile(); mut(p);
    expect(() => saveProfile(dir, p)).toThrow(re);
  };
  bad(p => { p.worker.investigate = ' '; }, /worker\.investigate/);
  bad(p => { delete p.validators.qa; }, /validators\.qa/);
  bad(p => { p.worker.extra = 'x'; }, /desconocida/);
  bad(p => { p.harness = 'nope'; }, /harness/);
  bad(p => { p.worker.rules = 'sin marca'; }, /STATUS/);
  bad(p => { p.validators.rules = 'STATUS: done'; }, /VERDICT/);
  bad(p => { p.worker.implement = 'implementa'; }, /commit/);
  bad(p => { p.schemaVersion = 2; }, /schemaVersion/);
  expect(existsSync(join(dir, 'profiles'))).toBe(false);
});

test('precondición: el perfil por defecto reproduce byte a byte los prompts de antes', () => {
  const ws: any = { goal: 'goal G' }, change: any = { title: 'T', description: 'D\nmore' };
  const history: any[] = [{ kind: 'investigation', status: 'completed', reviewStatus: 'approved', result: 'STATUS: done\nspec', reviewComment: 'ok' }];
  const prof = defaultProfile();
  for (const kind of ['investigation', 'implementation']) {
    const input: any = { workstream: ws, change, activity: { kind }, history, worktree: '/w', branch: 'fab/x' };
    for (const tpl of [undefined, prof.worker]) {
      expect(buildWorkerPrompt(input, {}, tpl)).toBe((golden as any)[`worker:${kind}`]);
      expect(buildWorkerPrompt(input, { factoryCommits: true }, tpl)).toBe((golden as any)[`worker:${kind}:factory`]);
    }
  }
  for (const v of ['code_review', 'security_audit', 'qa'] as const) {
    const input = { change, diffStat: ' a.txt | 1 +', base: 'main', branch: 'fab/x', worktree: '/w', history };
    expect(buildValidatorPrompt(v, input)).toBe((golden as any)[`validator:${v}`]);
    expect(buildValidatorPrompt(v, input, prof.validators)).toBe((golden as any)[`validator:${v}`]);
  }
});

test('--profile desconocido se rechaza y uno importado se fija en el workstream', () => {
  const store = new Store(join(dir, 'f.db'));
  try {
    expect(() => store.createWorkstream({ slug: 'a', goal: 'g', repo, profile: 'f'.repeat(64) })).toThrow(/perfil desconocido/);
    expect(() => store.createWorkstream({ slug: 'a', goal: 'g', repo, profile: 'xyz' })).toThrow(/inválido/);
    expect(store.getWorkstream(store.createWorkstream({ slug: 'd', goal: 'g', repo }).id).profile).toBeNull();
    const { digest } = saveProfile(dir, candidate());
    expect(store.createWorkstream({ slug: 'b', goal: 'g', repo, profile: digest }).profile).toBe(digest);
  } finally { store.close(); }
});

test('el digest y el sha de fab llegan a la activity y al run.json, y el prompt usa el perfil', async () => {
  const store = new Store(join(dir, 'f.db'));
  try {
    const { digest } = saveProfile(dir, candidate());
    const ws = store.createWorkstream({ slug: 'p', goal: 'g', repo, agent: 'fake', requireChangeApproval: false, profile: digest });
    store.setWorkstreamState(ws.id, 'active');
    const c = store.createChange(ws.id, 'fix it', 'desc');
    process.env.FAB_SHA = 'abc123';
    await runPool(store, { workstream: ws.id, stateDir: dir, untilIdle: true, log: () => {} });
    const [inv] = store.listActivities({ changeId: c.id });
    expect(inv?.profileDigest).toBe(digest);
    expect(inv?.fabSha).toBe('abc123');
    const run = JSON.parse(readFileSync(join(dir, 'runs', c.id, 'run.json'), 'utf8'));
    expect(run.profile).toBe(digest);
    expect(run.activities[0].profileDigest).toBe(digest);
    expect(run.activities[0].fabSha).toBe('abc123');
  } finally { delete process.env.FAB_SHA; store.close(); }
});
