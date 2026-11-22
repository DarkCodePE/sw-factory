// T114: rejilla de jueces con etiquetas de roles, tarjeta «Añadir juez» (solo con --write) y botón «Puesta en marcha».
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultProfile, loadProfile, saveProfile, type ScorerDef } from '../src/profile.ts';
import { ensureSchema } from '../src/scorers.ts';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';

let dir: string, store: Store, server: ReturnType<typeof startWeb> | undefined, cookie = '', csrf = '';
const def = (extra: Partial<ScorerDef> = {}): ScorerDef => ({ scope: 'implement', rubric: 'Evalúa.', classes: [{ label: 'ok', score: 1 }, { label: 'mal', score: 0 }], passing: 0.5, sampling: 0.1, ...extra });
const base = () => `http://${server!.host ?? '127.0.0.1'}:${server!.port}`;
const html = async (p: string) => (await fetch(base() + p, { headers: { cookie } })).text();
const post = (p: string, data: Record<string, string>, withCsrf = true) => fetch(base() + p, { method: 'POST', redirect: 'manual', headers: { cookie, origin: base(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...(withCsrf ? { csrf } : {}), ...data }) });
const ws = () => store.getWorkstream('ws');
const events = () => store.db.query("SELECT actor, message FROM events WHERE message LIKE 'juez creado%'").all() as Array<{ actor: string; message: string }>;
const form = (o: Record<string, string> = {}) => ({ ws: 'ws', name: 'claridad', scope: 'implement', rubric: 'Mide si el cambio se entiende.', classes: 'ok: 1\nmal: 0', passing: '0.5', sampling: '0.1', ...o });

function seed(scorers: Record<string, ScorerDef> = { calidad: def() }) {
  const digest = saveProfile(dir, { ...defaultProfile(), schemaVersion: 2, harness: 'fake', scorers } as any).digest;
  store.createWorkstream({ slug: 'ws', goal: 'g', repo: dir, agent: 'fake', requireChangeApproval: false, profile: digest });
  const c = store.createChange('ws', 'Cambio', 'd');
  const inv = store.listActivities({ changeId: c.id })[0]!;
  const impl = (store as any).insertActivity(c.workstreamId, c.id, inv.id, 'implementation', 'pending', null);
  store.db.query("UPDATE activities SET status='completed', profile_digest=? WHERE change_id=?").run(digest, c.id);
  return { digest, c, inv: inv.id, impl: (impl.id ?? impl) as string };
}
function score(digest: string, activity: string, scorer = 'calidad') {
  ensureSchema(store.db);
  const a = store.getActivity(activity);
  store.db.query(`INSERT INTO scores (id, scorer, profile_digest, scope, subject_activity_id, change_id, workstream_id, round, origin, status, label, score, passed, cost_usd, created_at, finished_at)
    VALUES (?,?,?,?,?,?,?,0,'sample','done','ok',1,1,0.1,?,?)`).run(crypto.randomUUID(), scorer, digest, 'implement', activity, a.changeId, a.workstreamId, store.now(), store.now());
}
async function login() {
  cookie = (await fetch(server!.loginUrl!, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
  csrf = /name="csrf" value="([^"]+)"/.exec(await html('/metricas?tab=jueces&ws=ws'))?.[1] ?? '';
  expect(csrf.length).toBe(64);
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fab-rejilla-')); mkdirSync(join(dir, 'x')); store = new Store(join(dir, 'fabrica.db')); cookie = ''; csrf = ''; });
afterEach(() => { server?.stop(true); server = undefined; store.close(); rmSync(dir, { recursive: true, force: true }); });

test('rejilla vacía: sin jueces definidos lo dice, y sin --write no hay tarjeta de crear', async () => {
  store.createWorkstream({ slug: 'ws', goal: 'g', repo: dir, agent: 'fake' });
  server = startWeb(dir, 0);
  const h = await html('/metricas?tab=jueces');
  expect(h).toContain('No hay jueces definidos'); expect(h).not.toContain('Añadir juez'); expect(h).not.toContain('/scorers/nuevo');
});

test('rejilla con datos: un juez definido sin puntuaciones sale «No medido»; el puntuado, con su cifra', async () => {
  const { digest, impl } = seed({ calidad: def(), claridad: def({ scope: 'qa' }) }); score(digest, impl);
  server = startWeb(dir, 0);
  const h = await html('/metricas?tab=jueces&range=all');
  expect(h).toContain('id="t-juez-calidad"'); expect(h).toContain('id="t-juez-claridad"');
  expect(h).toMatch(/id="t-juez-calidad".*?<p class="fig">100 %<\/p>/s);
  expect(h).toMatch(/id="t-juez-claridad".*?<p class="fig">No medido<\/p>/s);
  expect(h).toContain('validador:qa'); // etiqueta del rol del ámbito del juez sin puntuaciones
  expect(h).not.toContain('Añadir juez');
});

test('etiquetas de roles: las tres primeras y «y N más»', async () => {
  const { digest, impl, inv, c } = seed();
  const mk = (id: string, kind: string, validator: string | null) => store.db.query("INSERT INTO activities(id,workstream_id,change_id,kind,status,validator,retry_count,created_at,profile_digest) VALUES (?,?,?,?,'completed',?,0,?,?)").run(id, c.workstreamId, c.id, kind, validator, store.now(), digest);
  mk('v1', 'change_review', 'qa'); mk('v2', 'change_review', 'code_review'); mk('v3', 'change_review', 'security_audit');
  for (const a of [impl, inv, 'v1', 'v2', 'v3']) score(digest, a);
  server = startWeb(dir, 0);
  const h = await html('/metricas?tab=jueces&range=all');
  expect(h.match(/<span class="chip">/g)).toHaveLength(4); // tres roles y «y 2 más» expect(h).toContain('y 2 más');
});

test('con --write aparece «Añadir juez»; crear guarda un perfil nuevo SIN asignarlo y deja evento con actor', async () => {
  const { digest } = seed();
  server = startWeb(dir, 0, { write: true }); await login();
  expect(await html('/metricas?tab=jueces&ws=ws')).toContain('Añadir juez');
  const r = await post('/scorers/nuevo', form());
  expect(r.status).toBe(303);
  const loc = new URL(r.headers.get('location')!, base());
  expect(loc.pathname).toBe('/perfiles'); const created = loc.searchParams.get('digest')!;
  expect(created).not.toBe(digest);
  expect(ws().profile).toBe(digest); // D-H: solo el dueño asigna
  const p = loadProfile(dir, created);
  expect(Object.keys(p.scorers!).sort()).toEqual(['calidad', 'claridad']);
  expect(p.scorers!.claridad).toMatchObject({ scope: 'implement', passing: 0.5, sampling: 0.1, classes: [{ label: 'ok', score: 1 }, { label: 'mal', score: 0 }] });
  expect(events()).toEqual([{ actor: 'web', message: expect.stringContaining('claridad') }]);
});

test('crear sobre el perfil por defecto promueve a v2 y no toca el workstream', async () => {
  store.createWorkstream({ slug: 'ws', goal: 'g', repo: dir, agent: 'claude' });
  server = startWeb(dir, 0, { write: true }); await login();
  const r = await post('/scorers/nuevo', form({ harness: 'claude' })); // el perfil por defecto usa native, que no se confina
  expect(r.status).toBe(303);
  expect(ws().profile).toBeNull();
  expect(loadProfile(dir, new URL(r.headers.get('location')!, base()).searchParams.get('digest')!).schemaVersion).toBe(2);
});

test('un perfil con adaptador no confinable rechaza el juez sin adaptador propio', async () => {
  store.createWorkstream({ slug: 'ws', goal: 'g', repo: dir, agent: 'claude' });
  server = startWeb(dir, 0, { write: true }); await login();
  const r = await post('/scorers/nuevo', form());
  expect(r.status).toBe(400); expect(await r.text()).toContain('confinable'); expect(events()).toEqual([]);
});

test('rechazos: nombre repetido, clases inválidas, sin CSRF y sin sesión; ninguno deja evento', async () => {
  seed();
  server = startWeb(dir, 0, { write: true }); await login();
  for (const bad of [form({ name: 'calidad' }), form({ classes: 'solo: 1' }), form({ classes: 'a: 1\nb: 7' }), form({ rubric: '' }), form({ name: 'Mal Nombre' }), form({ scope: 'nada' }), form({ ws: 'no-existe' })]) {
    const r = await post('/scorers/nuevo', bad);
    expect(r.status === 303 && new URL(r.headers.get('location')!, base()).searchParams.has('digest')).toBe(false);
  }
  expect((await post('/scorers/nuevo', form(), false)).status).toBeGreaterThanOrEqual(400);
  expect((await fetch(base() + '/scorers/nuevo', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base() }, body: new URLSearchParams({ csrf, ...form() }) })).status).toBe(401);
  expect(events()).toEqual([]);
});

test('«Puesta en marcha» sin nada: 0 de 5 en las tres pestañas, enlazando al alta', async () => {
  server = startWeb(dir, 0);
  for (const tab of ['productividad', 'gasto', 'jueces']) expect(await html(`/metricas?tab=${tab}`)).toContain('Puesta en marcha · 0 de 5');
  expect(await html('/metricas')).toContain('href="/workstreams/nuevo"');
});

test('«Puesta en marcha»: un workstream creado cuenta 1 y activarlo cuenta 2', async () => {
  store.createWorkstream({ slug: 'ws', goal: 'g', repo: dir, agent: 'fake' });
  server = startWeb(dir, 0);
  expect(await html('/metricas')).toContain('Puesta en marcha · 1 de 5');
  store.setWorkstreamState('ws', 'active');
  expect(await html('/metricas')).toContain('Puesta en marcha · 2 de 5');
});

test('«Puesta en marcha» completa: perfil asignado, juez definido y primer change', async () => {
  seed(); store.setWorkstreamState('ws', 'active');
  server = startWeb(dir, 0);
  const h = await html('/metricas?tab=jueces');
  expect(h).toContain('Puesta en marcha · 5 de 5'); expect(h).toContain('Hecho');
});
