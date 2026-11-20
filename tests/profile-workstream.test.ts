import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdmissionDb } from '../src/admission/db.ts';
import { ThreadLinks } from '../src/admission/links.ts';
import { SessionStore } from '../src/admission/sessions.ts';
import { DEFAULT_DIGEST, ROLES, defaultProfile, resolveRole, saveProfile, type Profile } from '../src/profile.ts';
import { Store } from '../src/store.ts';

let dir: string, store: Store, ws: string;
const v2 = (fields: Partial<Profile> = {}): Profile => ({ ...defaultProfile(), schemaVersion: 2, harness: 'claude', ...fields });
const save = (profile: Profile) => saveProfile(dir, profile).digest;
const switchAgent = (agent: string, previous = 'claude', expected = DEFAULT_DIGEST) =>
  store.setWorkstreamAgent(ws, agent, previous, expected);
const activeChange = () => {
  store.setWorkstreamState(ws, 'active');
  return store.createChange(ws, 'c', 'd');
};

beforeEach(() => {
  dir = mkdtempSync('/tmp/fab-profile-workstream-');
  store = new Store(join(dir, 'fabrica.db'));
  ws = store.createWorkstream({ slug: 'prueba', goal: 'g', repo: '/repo', agent: 'claude', requireChangeApproval: false }).id;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test('procedencia del modelo sigue la resolución de ejecución, incluido el override de CLI', () => {
  const profile = v2({ model: 'p', roles: { qa: { harness: 'codex', model: 'r' }, implement: { model: 'i' } } });
  const cases = [
    [profile, 'qa', 'claude', undefined, 'codex', 'r', 'role', 'role', null],
    [profile, 'qa', 'claude', 'claude', 'claude', 'p', 'override', 'profile', null],
    [profile, 'implement', 'codex', undefined, 'codex', null, 'workstream', 'adapter', 'incompatible'],
    [profile, 'investigate', 'claude', undefined, 'claude', 'p', 'workstream', 'profile', null],
    [v2(), 'qa', 'claude', undefined, 'claude', null, 'workstream', 'adapter', 'undeclared'],
    [{ ...defaultProfile(), model: 'histórico' }, 'implement', 'codex', undefined, 'codex', null, 'workstream', 'adapter', 'legacy'],
  ] as const;
  for (const [p, role, wsAgent, override, adapter, model, source, modelSource, modelDefaultReason] of cases) {
    expect(resolveRole(p, role, wsAgent, override)).toEqual({ adapter, model, source, modelSource, modelDefaultReason });
  }
});

test('dos escritores reutilizan el digest y validan un destino corrupto sin sustituirlo', async () => {
  const module = new URL('../src/profile.ts', import.meta.url).href;
  const script = `import { saveProfile, defaultProfile } from ${JSON.stringify(module)}; console.log(JSON.stringify(saveProfile(process.argv.at(-1), defaultProfile())));`;
  const writers = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, '-e', script, dir], { stdout: 'pipe' }));
  const results = await Promise.all(writers.map(async p => {
    expect(await p.exited).toBe(0);
    return await new Response(p.stdout).json();
  }));
  expect(results.filter(r => r.created)).toHaveLength(1);
  expect(results.every(r => r.digest === DEFAULT_DIGEST)).toBe(true);
  const file = join(dir, 'profiles', `${DEFAULT_DIGEST}.json`);
  rmSync(file);
  writeFileSync(file, JSON.stringify(v2()));
  expect(() => saveProfile(dir, defaultProfile())).toThrow(/corrupto/);
  expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(v2()));
});

test('configuración nueva exige confinamiento aunque todavía no haya canal; valida el par efectivo', () => {
  expect(() => switchAgent('droid')).toThrow(/confinable/);
  expect(() => switchAgent('desconocido')).toThrow(/adaptador/);
  const unsafe = save(v2({ roles: { code_review: { harness: 'droid' } } }));
  expect(() => store.assignProfile(ws, unsafe, DEFAULT_DIGEST, 'claude')).toThrow(/code_review.*confinable/);
  const safe = save(v2({ model: 'p', roles: { qa: { harness: 'codex', model: 'r' } } }));
  store.assignProfile(ws, safe, DEFAULT_DIGEST, 'claude');
  expect(store.getWorkstream(ws).profile).toBe(safe);
  switchAgent('codex', 'claude', safe);
  expect(resolveRole(v2({ model: 'p' }), 'implement', store.getWorkstream(ws).agent).model).toBeNull();
  expect(store.listEvents(ws, 10).at(-1)?.message).toContain('claude → codex');
});

test.each(['hilo', 'señal'] as const)('evidencia de canal por %s exige todos los roles y fallback, incluso si no cambian', evidence => {
  const profile = v2({ roles: { qa: { harness: 'droid' } } });
  const old = save(profile);
  store.db.query('UPDATE workstreams SET profile = ? WHERE id = ?').run(old, ws);
  const next = save({ ...profile, worker: { ...profile.worker, investigate: 'otra plantilla' } });
  // Antes de existir evidencia, las plantillas se pueden editar si el par efectivo se conserva.
  store.assignProfile(ws, next, old, 'claude');
  const adm = new AdmissionDb(store);
  const thread = 'github:test/repo#1';
  adm.db.query('INSERT INTO adm_threads VALUES (?, ?, ?)').run(thread, 'github', adm.iso());
  if (evidence === 'hilo') new ThreadLinks(adm).link(thread, store.createChange(ws, 'c', 'd').id);
  else {
    const signal = store.addSignal(ws, 's', 'd');
    adm.db.query('INSERT INTO adm_thread_signals(thread_id, signal_id, scope, created_at) VALUES (?, ?, ?, ?)').run(thread, signal.id, 'investigate', adm.iso());
  }
  expect(() => store.assignProfile(ws, old, next, 'claude')).toThrow(/qa.*confinable/);
  const allConfined = save(v2({ roles: Object.fromEntries(ROLES.map(role => [role, { harness: 'claude' }])) }));
  store.db.query('UPDATE workstreams SET agent = ? WHERE id = ?').run('droid', ws);
  expect(() => store.assignProfile(ws, allConfined, next, 'droid')).toThrow(/fallback.*confinable/);
  store.db.query('UPDATE workstreams SET profile = ? WHERE id = ?').run('a'.repeat(64), ws);
  expect(() => store.assignProfile(ws, DEFAULT_DIGEST, 'a'.repeat(64), 'droid')).toThrow(/confinable/);
  expect(store.getWorkstream(ws).profile).toBe('a'.repeat(64));
});

test('restaurar un digest corrupto conserva un fallback manual y las dos mutaciones comparan el estado completo', () => {
  const corrupt = 'a'.repeat(64);
  store.db.query('UPDATE workstreams SET profile = ?, agent = ? WHERE id = ?').run(corrupt, 'native', ws);
  store.assignProfile(ws, DEFAULT_DIGEST, corrupt, 'native');
  const digest = save(v2());
  const other = new Store(join(dir, 'fabrica.db'));
  try {
    other.assignProfile(ws, digest, DEFAULT_DIGEST, 'native');
    expect(() => switchAgent('codex', 'native')).toThrow(/cambió/);
    other.setWorkstreamAgent(ws, 'claude', 'native', digest);
    expect(() => store.assignProfile(ws, DEFAULT_DIGEST, digest, 'native')).toThrow(/cambió/);
    expect(store.getWorkstream(ws)).toMatchObject({ agent: 'claude', profile: digest });
  } finally { other.close(); }
});

test('impide activar con trabajo reclamado, en espera y reencolado para reanudar, no con una próxima pendiente', () => {
  const change = activeChange();
  const digest = save(v2());
  const a = store.claimActivity(ws, 'worker')!;
  const sessions = new SessionStore(new AdmissionDb(store));
  const { session } = sessions.begin(change.id, a.kind, { backend: 'claude', cwd: '/repo' });
  const blocked = () => {
    expect(() => store.assignProfile(ws, digest, DEFAULT_DIGEST, 'claude')).toThrow(/trabajo vivo/);
    expect(() => switchAgent('codex')).toThrow(/trabajo vivo/);
    expect(store.getWorkstream(ws)).toMatchObject({ agent: 'claude', profile: null });
  };
  blocked();
  sessions.markLaunched(session.sessionId);
  store.awaitHuman(a.id, 'worker', { questionId: 'q', waitUntil: '2099-01-01T00:00:00Z' });
  blocked();
  expect(store.answerAwaiting(a.id, 'q')).toBe(true);
  blocked();
  store.db.query("UPDATE adm_sessions SET status = 'closed' WHERE session_id = ?").run(session.sessionId);
  store.assignProfile(ws, digest, DEFAULT_DIGEST, 'claude');
  expect(store.getActivity(a.id).status).toBe('pending');
  expect(store.getWorkstream(ws).profile).toBe(digest);
});

test('sin evidencia de canal, un modelo efectivo nuevo también exige un adaptador confinable', () => {
  const prior = save(v2({ roles: { qa: { harness: 'droid', model: 'anterior' } } }));
  store.db.query('UPDATE workstreams SET profile = ? WHERE id = ?').run(prior, ws);
  const next = save(v2({ roles: { qa: { harness: 'droid', model: 'nuevo' } } }));
  expect(() => store.assignProfile(ws, next, prior, 'claude')).toThrow(/qa.*confinable/);
  expect(store.getWorkstream(ws).profile).toBe(prior);
});

test('una pendiente nueva no continúa sesiones de otro tipo ni generaciones anteriores', () => {
  const change = activeChange();
  const a = store.listActivities({ changeId: change.id })[0]!;
  const adm = new AdmissionDb(store);
  const sessions = new SessionStore(adm);
  const meta = { backend: 'claude', cwd: '/repo' };
  const other = sessions.begin(change.id, a.kind === 'implementation' ? 'investigation' : 'implementation', meta);
  sessions.markLaunched(other.session.sessionId);
  const first = sessions.begin(change.id, a.kind, meta);
  sessions.markLaunched(first.session.sessionId);
  adm.db.query(`INSERT INTO adm_sessions(change_id, kind, generation, session_id, backend, cwd, created_at)
    VALUES (?, ?, 2, 'todavía-no-lanzada', 'claude', '/repo', ?)`).run(change.id, a.kind, adm.iso());
  const digest = save(v2());
  store.assignProfile(ws, digest, DEFAULT_DIGEST, 'claude');
  expect(store.getActivity(a.id).status).toBe('pending');
  expect(store.getWorkstream(ws).profile).toBe(digest);
});
