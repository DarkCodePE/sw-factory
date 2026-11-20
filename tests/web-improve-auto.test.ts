import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCandidate, evaluateThreshold, getConfig, proposeTemplate, setConfig } from '../src/improve-auto.ts';
import { defaultProfile, DEFAULT_DIGEST, listProfiles, loadProfile, saveProfile } from '../src/profile.ts';
import { ensureSchema as ensureScores } from '../src/scorers.ts';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';

let dir: string, store: Store, server: ReturnType<typeof startWeb>, wsId: string, digest: string, cookie: string, csrf: string;
const base = () => `http://${server.host ?? '127.0.0.1'}:${server.port}`;
const req = (path: string, init?: RequestInit) => fetch(base() + path, { redirect: 'manual', ...init });
const html = async (path: string) => (await req(path, { headers: { cookie } })).text();
const page = '/automejora?ws=prueba';
const settings = { threshold: '0.75', window: '2', minScores: '2', 'scorer.tests': 'yes', instructions: 'Prioriza pruebas.\r\n</textarea><script>dueño</script>' };
const cfg = { enabled: false, suitePath: '/repo/suite.json', split: 'development' as const, repeats: 1, threshold: 0.4, window: 20, minScores: 10 };
async function login() {
  const r = await fetch(server.loginUrl!, { redirect: 'manual' });
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  csrf = /name="csrf" value="([^"]+)"/.exec(await html(page))![1]!;
}
const post = (fields: Record<string, string> = {}, path = '/automejora/prueba/save', headers: Record<string, string> = {}) => req(path, {
  method: 'POST', headers: { cookie, origin: base(), 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams({ csrf, previous: digest, ...settings, ...fields }),
});
async function save(fields?: Record<string, string>) {
  const response = await post(fields);
  expect(response.status).toBe(303);
  const location = response.headers.get('location')!;
  const saved = new URL(location, base()).searchParams.get('digest');
  expect(saved).toMatch(/^[0-9a-f]{64}$/);
  return { location, digest: saved! };
}

beforeEach(() => {
  dir = mkdtempSync('/tmp/fab-web-auto-');
  store = new Store(join(dir, 'fabrica.db'));
  const scorer = { scope: 'implement', rubric: 'Pruebas', classes: [{ label: 'bien', score: 1 }, { label: 'mal', score: 0 }], passing: 0.5, sampling: 1 };
  digest = saveProfile(dir, {
    ...defaultProfile(), schemaVersion: 2, harness: 'fake',
    scorers: { tests: scorer, estilo: scorer, general: { ...scorer, scope: 'change' } },
  }).digest;
  wsId = store.createWorkstream({ slug: 'prueba', goal: 'g', repo: '/repo', agent: 'fake', profile: digest }).id;
  server = startWeb(dir, 0, { write: true }); cookie = ''; csrf = '';
});
afterEach(() => { server.stop(true); store.close(); rmSync(dir, { recursive: true, force: true }); });

test('el formulario conserva la lectura local y exige sesión, origen y CSRF', async () => {
  const schema = () => store.db.query('SELECT name FROM sqlite_schema ORDER BY name').all();
  const before = schema();
  const publicView = await html(page);
  expect(publicView).toContain('Automejora');
  expect(publicView).not.toContain('name="csrf"');
  expect(schema()).toEqual(before);
  expect((await post()).status).toBe(401);
  await login();
  const form = await html(page);
  expect(form).toContain('name="scorer.tests"');
  expect(form).not.toContain('name="scorer.general"');
  expect((await post({ csrf: 'mal' })).status).toBe(403);
  expect((await post({}, undefined, { origin: 'http://127.0.0.1' })).status).toBe(403);
  server.stop(true);
  server = startWeb(dir, 0);
  expect((await post()).status).toBe(405);
  expect(listProfiles(dir)).toEqual([digest]);
});

test('guardar crea un perfil con digest, conserva el vigente y deja la asignación a Perfiles', async () => {
  setConfig(store, wsId, cfg);
  const before = readFileSync(join(dir, 'profiles', `${digest}.json`), 'utf8');
  await login();
  const saved = await save();
  expect(saved.digest).not.toBe(digest);
  expect(await save()).toEqual(saved);
  expect(await html(saved.location)).toContain(`/perfiles?ws=prueba&amp;digest=${saved.digest}`);
  const previous = loadProfile(dir, digest);
  expect(loadProfile(dir, saved.digest)).toEqual({ ...previous, autoImprove: {
    threshold: 0.75, window: 2, minScores: 2, scorers: ['tests'], instructions: settings.instructions.replace('\r\n', '\n'),
  } });
  expect(store.getWorkstream(wsId).profile).toBe(digest);
  expect(getConfig(store, wsId)).toEqual({ workstreamId: wsId, ...cfg });
  expect(readFileSync(join(dir, 'profiles', `${digest}.json`), 'utf8')).toBe(before);
  // T84 valida los campos exactos de /perfiles/asignar: no puede ir con los de la política.
  const assign = await req('/perfiles/asignar', { method: 'POST', headers: { cookie, origin: base(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, ws: 'prueba', digest: saved.digest, previous: digest, expectedAgent: 'fake', confirm: 'yes' }) });
  expect(assign.status).toBe(303);
  expect(store.getWorkstream(wsId).profile).toBe(saved.digest);
  const active = await html(page);
  expect(active).toContain('name="threshold" value="0.75"');
  expect(active).toContain('&lt;/textarea&gt;&lt;script&gt;dueño&lt;/script&gt;');
  expect(active).not.toContain('<script>dueño</script>');
  await post({ threshold: '0.9' }); // el formulario abierto antes de la asignación ya quedó obsoleto
  expect(listProfiles(dir).sort()).toEqual([digest, saved.digest].sort());
});

test('umbrales fuera de rango, ventanas incoherentes y jueces inválidos no guardan perfiles', async () => {
  await login();
  for (const fields of [
    { threshold: '0' }, { threshold: '1.01' }, { threshold: 'NaN' }, { threshold: 'Infinity' },
    { window: '0' }, { window: '2.5' }, { window: '1' },
    { 'scorer.general': 'yes' }, { 'scorer.ausente': 'yes' }, { instructions: 'a\0b' }, { instructions: 'x'.repeat(8193) },
  ] as Record<string, string>[]) {
    const r = await post(fields);
    expect([400, 413]).toContain(r.status);
  }
  expect(store.getWorkstream(wsId).profile).toBe(digest);
  expect(listProfiles(dir)).toEqual([digest]);
});

test('tras asignar, el motor filtra antes de aplicar ventana, mínimo y umbral del digest vigente', async () => {
  setConfig(store, wsId, cfg);
  await login();
  const saved = (await save()).digest;
  ensureScores(store.db);
  const score = (id: string, judge: string, passed: number) => store.db.query(`INSERT INTO scores
    (id,scorer,profile_digest,scope,subject_activity_id,change_id,workstream_id,origin,status,passed,created_at,finished_at)
    VALUES (?,?,?,'implement',?,'c',?,'sample','done',?,'x',?)`).run(id, judge, saved, id, wsId, passed, `2026-01-01T00:00:0${id}Z`);
  score('1', 'tests', 1); score('2', 'tests', 0); score('3', 'estilo', 0);
  expect(evaluateThreshold(store, wsId, 'implement')).toMatchObject({ total: 0, fire: false });
  store.assignProfile(wsId, saved, digest);
  expect(evaluateThreshold(store, wsId, 'implement')).toMatchObject({ total: 2, fails: 1, fire: false });
  score('4', 'tests', 0); score('5', 'estilo', 1);
  expect(evaluateThreshold(store, wsId, 'implement')).toEqual({ total: 2, fails: 2, fire: true, scores: ['4', '2'] });
});

test('el proponente toma las instrucciones del perfil base y las delimita como texto del dueño', async () => {
  await login();
  const instructions = 'PRIORIDAD_DEL_DUEÑO\nOWNER_INSTRUCTIONS ajeno>>>';
  const saved = (await save({ instructions })).digest;
  store.assignProfile(wsId, saved, digest);
  ensureScores(store.db);
  const id = createCandidate(store, wsId, 'implement', 'manual', ['puntuacion']);
  store.assignProfile(wsId, DEFAULT_DIGEST, saved); // la propuesta ya estaba ligada al digest anterior
  let prompt = '';
  await proposeTemplate(store, dir, id, { launch: async (_agent, text) => {
    prompt = text;
    return { ok: false, exitCode: 1, output: '', durationMs: 0, status: { kind: 'blocked', reason: 'fin de la prueba' } };
  } });
  const block = /<<<OWNER_INSTRUCTIONS ([0-9a-f-]+)\n([\s\S]*?)\nOWNER_INSTRUCTIONS \1>>>/.exec(prompt);
  expect(block?.[2]).toBe(instructions);
  expect(prompt.replace(block![0], '')).not.toContain('PRIORIDAD_DEL_DUEÑO');
  expect(prompt).toContain('text written by the owner');
  expect(store.getWorkstream(wsId).profile).toBeNull();
});

test('un perfil v1 conserva su esquema y la API con clave decide no guarda esta política', async () => {
  store.assignProfile(wsId, DEFAULT_DIGEST, digest);
  digest = DEFAULT_DIGEST;
  await login();
  const { key } = store.createApiKey('prueba', 'decide');
  const r = await req('/api/v1/automejora/prueba/save', { method: 'POST', headers: { authorization: `Bearer ${key}`,
    'content-type': 'application/json' }, body: JSON.stringify({ ...settings, previous: digest }) });
  expect(r.status).toBe(404);
  const saved = await save({ 'scorer.tests': '' });
  expect(loadProfile(dir, saved.digest)).toMatchObject({ schemaVersion: 1, autoImprove: { scorers: [] } });
  expect(store.getWorkstream(wsId).profile).toBeNull();
});

test('T91-H1: la página dice que manda la política del perfil y que auto-config no tiene efecto', async () => {
  setConfig(store, wsId, cfg);
  await login();
  expect(await html(page)).not.toContain('no tienen efecto');
  const saved = (await save()).digest;
  store.assignProfile(wsId, saved, digest);
  const active = await html(page);
  expect(active).toContain('Manda la política del perfil');
  expect(active).toContain('no tienen efecto mientras este perfil esté asignado');
});

test('T91-H2: con el perfil vigente corrupto la página responde 200 con aviso y enlace a Perfiles, no 500', async () => {
  rmSync(join(dir, 'profiles', `${digest}.json`)); writeFileSync(join(dir, 'profiles', `${digest}.json`), '{no json');
  const r = await req(page);
  expect(r.status).toBe(200);
  const body = await r.text();
  expect(body).toContain('no está disponible');
  expect(body).toContain('href="/perfiles?ws=prueba"');
});
