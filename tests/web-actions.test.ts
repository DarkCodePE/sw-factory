import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { Store } from '../src/store.ts';
import { AdmissionDb } from '../src/admission/db.ts';
import { startWeb } from '../src/web.ts';

let dir: string, store: Store, server: ReturnType<typeof startWeb>, change: string, activity: string;
let cookie: string, csrf: string;
const req = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${server.port}${path}`, { redirect: 'manual', ...init });
const html = async (path: string) => (await req(path, { headers: { cookie } })).text();
const field = (page: string, name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(page)?.[1] ?? '';
async function login() {
  const r = await fetch(server.loginUrl!, { redirect: 'manual' });
  expect(r.status).toBe(303); cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  csrf = field(await html(`/activities/${activity}`), 'csrf') || field(await html(`/changes/${change}`), 'csrf');
  expect(csrf.length).toBe(64);
  return r;
}
const post = (path: string, data: Record<string, string> = {}, headers: Record<string, string> = {}) => req(path, {
  method: 'POST', headers: { cookie, origin: `http://127.0.0.1:${server.port}`, 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams({ csrf, ...data }),
});
const review = () => `/activities/${activity}/review`;
const retry = () => `/changes/${change}/retry`;
function seedReview() { store.db.query("UPDATE activities SET kind='change_review', status='completed', review_status='awaiting' WHERE id=?").run(activity); }
function seedFailure() {
  store.db.query("UPDATE activities SET kind='implementation',status='failed',review_status=NULL WHERE id=?").run(activity);
  store.db.query("UPDATE changes SET status='failed' WHERE id=?").run(change);
}
function seedQuestion() {
  const adm = new AdmissionDb(store);
  store.db.query("UPDATE activities SET kind='implementation',status='waiting_reply',review_status=NULL, question_id='q1' WHERE id=?").run(activity);
  adm.db.query("INSERT INTO adm_questions(id,activity_id,change_id,text,asked_at) VALUES ('q1',?,?,'¿Continuar <script>?',?)").run(activity, change, store.now());
  return adm;
}
beforeEach(() => {
  dir = mkdtempSync('/tmp/fab-web-actions-'); store = new Store(join(dir, 'fabrica.db'));
  const ws = store.createWorkstream({ slug: 'prueba', goal: 'g', repo: '/repo' });
  change = store.createChange(ws.id, 'Change sintético', 'd').id;
  activity = store.listActivities({ changeId: change })[0]!.id; seedReview();
  server = startWeb(dir, 0, { write: true }); cookie = ''; csrf = '';
});
afterEach(() => { server?.stop(true); store?.close(); rmSync(dir, { recursive: true, force: true }); });

test('sin write todos los POST siguen en 405 y no hay URL de acceso', async () => {
  server.stop(true); server = startWeb(dir, 0);
  expect(server.loginUrl).toBeUndefined();
  for (const path of [review(), retry(), '/questions/q1/answer', '/merge', '/style.css']) expect((await post(path)).status).toBe(405);
  expect(await html(`/activities/${activity}`)).not.toContain('method="post"');
});
test('sesión necesaria; token de 32 bytes, un solo uso y cookie segura durante el proceso', async () => {
  expect(new URL(server.loginUrl!).searchParams.get('token')).toMatch(/^[a-f0-9]{64}$/);
  expect((await post(review(), { decision: 'approve' })).status).toBe(401);
  expect((await req('/auth?token=incorrecto')).status).toBe(401);
  const r = await login();
  expect(r.headers.get('location')).toBe('/');
  for (const attr of ['HttpOnly', 'SameSite=Strict', 'Path=/']) expect(r.headers.get('set-cookie')).toContain(attr);
  expect(r.headers.get('set-cookie')).not.toMatch(/Expires|Max-Age/);
  expect((await fetch(server.loginUrl!, { redirect: 'manual' })).status).toBe(401);
  expect((await post(review(), {}, { cookie: 'fab_session=incorrecto' })).status).toBe(401);
  server.stop(true); server = startWeb(dir, 0, { write: true });
  expect((await post(review())).status).toBe(401);
});
test('CSRF y Origin son defensas independientes y Host sigue vigente', async () => {
  await login();
  for (const bad of ['', 'incorrecto']) expect((await post(review(), { csrf: bad, decision: 'approve' })).status).toBe(403);
  for (const origin of ['', 'http://ajeno.test', `http://127.0.0.1:${server.port! + 1}`, `https://localhost:${server.port}`]) expect((await post(review(), { decision: 'approve' }, { origin })).status).toBe(403);
  expect((await req(review(), { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }) })).status).toBe(403);
  expect((await post(review(), {}, { host: 'ajeno.test' })).status).toBe(403);
  expect(store.getActivity(activity).reviewStatus).toBe('awaiting');
});
for (const [decision, status] of [['approve', 'approved'], ['comment', 'commented'], ['decline', 'declined']] as const) {
  test(`revisión ${decision}: estado, actor, PRG, escapado y doble envío`, async () => {
    await login(); const count = store.listActivities({ changeId: change }).length;
    const comment = '<script>alert("x")</script> & comentario';
    const result = await post(review(), { decision, comment }); expect(result.status).toBe(303);
    expect(store.getActivity(activity).reviewStatus).toBe(status);
    const events = store.listEvents(store.getChange(change).workstreamId, 100, change);
    expect(events.at(-1)!.actor).toBe('web'); expect(events.at(-1)!.message).toContain(comment);
    const page = await html(result.headers.get('location')!);
    expect(page).toContain('&lt;script&gt;'); expect(page).not.toContain('<script>alert');
    const n = store.listActivities({ changeId: change }).length;
    expect(n).toBe(count + (decision === 'decline' ? 0 : 1));
    const duplicate = await post(review(), { decision, comment }); expect(duplicate.status).toBe(303);
    expect(await html(duplicate.headers.get('location')!)).toContain('conflict');
    expect(store.listActivities({ changeId: change }).length).toBe(n);
    expect(store.listEvents(store.getChange(change).workstreamId, 100, change).length).toBe(events.length);
  });
}
test('reintento preserva el patrón CLI y doble envío da conflict', async () => {
  seedFailure(); await login();
  const revision = field(await html(`/changes/${change}`), 'revision'); expect(revision).not.toBe('');
  const r = await post(retry(), { revision }); expect(r.status).toBe(303);
  expect(store.getChange(change).status).toBe('pending');
  expect(store.listActivities({ changeId: change }).at(-1)!.status).toBe('pending');
  expect(store.listEvents(store.getChange(change).workstreamId, 100, change).at(-1)!.actor).toBe('web');
  const n = store.listActivities({ changeId: change }).length;
  const dup = await post(retry(), { revision }); expect(await html(dup.headers.get('location')!)).toContain('conflict');
  expect(store.listActivities({ changeId: change }).length).toBe(n);
});
test('respuesta reencola una sola vez, guarda autor web y escapa pregunta', async () => {
  const adm = seedQuestion(); await login();
  expect(await html(`/activities/${activity}`)).toContain('¿Continuar &lt;script&gt;?');
  const r = await post('/questions/q1/answer', { answer: 'Sí, <script>texto</script>' }); expect(r.status).toBe(303);
  expect(adm.db.query('SELECT status,answer,answered_by FROM adm_questions').get()).toEqual({ status: 'answered', answer: 'Sí, <script>texto</script>', answered_by: 'web' });
  expect(store.getActivity(activity).status).toBe('pending');
  expect(store.listEvents(store.getChange(change).workstreamId, 100, change).at(-1)!.actor).toBe('web');
  const n = store.countEvents(store.getChange(change).workstreamId, change);
  const dup = await post('/questions/q1/answer', { answer: 'Otra' }); expect(await html(dup.headers.get('location')!)).toContain('conflict');
  expect(store.countEvents(store.getChange(change).workstreamId, change)).toBe(n);
});
test('errores de dominio sin stack y rutas fuera del alcance no ejecutan acciones', async () => {
  await login(); store.db.query("UPDATE activities SET kind='implementation' WHERE id=?").run(activity);
  const r = await post(review(), { decision: 'approve' }); expect(r.status).toBe(303);
  const page = await html(r.headers.get('location')!); expect(page).toContain('invalid_transition'); expect(page).not.toContain('at resolveReview');
  const missing = await post('/activities/ausente/review', { decision: 'approve' }); expect(missing.status).toBe(303);
  expect(await html(missing.headers.get('location')!)).toContain('not_found');
  expect((await post('/activities/a%3Cb/review', { decision: 'approve' })).status).toBe(400);
  for (const path of ['/merge', '/gate/allow', '/changes/new', '/stop', '/profiles']) expect((await post(path)).status).toBe(404);
});
test('límites reales en bytes, tipo, comentarios y respuestas vacías', async () => {
  await login();
  expect((await post(review(), { decision: 'comment', comment: 'é'.repeat(4097) })).status).toBe(413);
  expect((await post(review(), { decision: 'comment', comment: '' })).status).toBe(400);
  expect((await post(review(), { decision: 'invalid' })).status).toBe(400);
  expect((await post(review(), {}, { 'content-type': 'application/json' })).status).toBe(415);
  expect((await post(review(), { padding: 'a'.repeat(16385) })).status).toBe(413);
  const adm = seedQuestion();
  expect((await post('/questions/q1/answer', { answer: 'é'.repeat(4097) })).status).toBe(413);
  expect((await post('/questions/q1/answer', { answer: '  ' })).status).toBe(400);
  expect(adm.db.query('SELECT status FROM adm_questions').get()).toEqual({ status: 'open' });
  expect((await post('/questions/q1/answer', { answer: 'a'.repeat(8192) })).status).toBe(303);
});
test('sondeo conserva borradores incluso tras perder el foco', async () => {
  await login();
  const js = await (await req('/poll.js')).text();
  let dirty = false, fetches = 0, replacements = 0;
  let input!: (event: unknown) => void, poll!: () => Promise<void>;
  const form = { setAttribute: () => { dirty = true; } };
  const main = { innerHTML: 'anterior', replaceWith: () => { replacements++; } };
  const document = {
    hidden: false, activeElement: { matches: () => false },
    addEventListener: (_: string, fn: typeof input) => { input = fn; },
    querySelector: (selector: string) => selector === 'main' ? main : selector === 'form[data-dirty]' && dirty ? form : null,
  };
  runInNewContext(js, { document, location: { href: '/' }, window: { getSelection: () => '' },
    setInterval: (fn: typeof poll) => { poll = fn; },
    fetch: async () => { fetches++; return { ok: true, text: async () => '' }; },
    DOMParser: class { parseFromString() { return { querySelector: () => ({ innerHTML: 'nuevo' }) }; } },
  });
  await poll(); expect(fetches).toBe(1); expect(replacements).toBe(1);
  input({ target: { closest: () => form } });
  // El foco ya está fuera del campo; el borrador debe sobrevivir a los siguientes sondeos.
  await poll(); await poll();
  expect(fetches).toBe(1); expect(replacements).toBe(1);
});

test('CSRF ausente, cookie duplicada y Unicode inválido se rechazan sin excepción', async () => {
  await login();
  expect((await req(review(), { method: 'POST', headers: { cookie, origin: `http://127.0.0.1:${server.port}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'decision=approve' })).status).toBe(403);
  expect((await post(review(), {}, { cookie: `${cookie}; ${cookie}` })).status).toBe(401);
  expect((await post(review(), {}, { cookie: `fab_session=${'é'.repeat(64)}` })).status).toBe(401);
  expect((await req(`/auth?token=${'é'.repeat(64)}`)).status).toBe(401);
});
test('el límite se aplica al stream sin Content-Length y con tipo parametrizado', async () => {
  await login();
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < 17; i++) controller.enqueue(new Uint8Array(1024).fill(97)); controller.close(); } });
  const r = await req(review(), { method: 'POST', headers: { cookie, origin: `http://localhost:${server.port}`, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body });
  expect(r.status).toBe(413); expect(store.getActivity(activity).reviewStatus).toBe('awaiting');
  const accepted = await post(review(), { decision: 'comment', comment: 'a'.repeat(8192) }, { origin: `http://localhost:${server.port}`, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' });
  expect([accepted.status, await accepted.text()]).toEqual([303, '']);
});
test('reintento abandona espera y reinicia el tope de sesión, como la CLI', async () => {
  const adm = seedQuestion();
  adm.db.query("INSERT INTO adm_sessions(change_id,kind,generation,session_id,backend,cwd,created_at,cap_from) VALUES (?,'implementation',3,'s1','fake','/repo',?,1)").run(change, store.now());
  await login();
  const revision = field(await html(`/changes/${change}`), 'revision');
  expect((await post(retry(), { revision })).status).toBe(303);
  expect(store.getActivity(activity).status).toBe('blocked');
  expect(store.listActivities({ changeId: change }).at(-1)!.status).toBe('pending');
  expect(adm.db.query('SELECT cap_from FROM adm_sessions').get()).toEqual({ cap_from: 3 });
  const events = store.listEvents(store.getChange(change).workstreamId, 100, change).slice(-3);
  expect(events.length).toBe(3); expect(events.every(e => e.actor === 'web')).toBe(true);
});
test('reintento de validador implementado: mismo estado no permite duplicar el POST', async () => {
  seedFailure(); store.db.query("UPDATE changes SET status='implemented' WHERE id=?").run(change);
  store.db.query("UPDATE activities SET kind='review',validator='v1' WHERE id=?").run(activity);
  await login(); const revision = field(await html(`/changes/${change}`), 'revision');
  const [a, b] = await Promise.all([post(retry(), { revision }), post(retry(), { revision })]);
  expect([await html(a.headers.get('location')!), await html(b.headers.get('location')!)].filter(s => s.includes('conflict')).length).toBe(1);
  expect(store.getChange(change).status).toBe('implemented'); expect(store.listActivities({ changeId: change }).length).toBe(2);
});
test('pregunta antigua no reencola activity cancelada ni deja una respuesta parcial', async () => {
  const adm = seedQuestion(); await login();
  store.db.query("UPDATE activities SET status='canceled' WHERE id=?").run(activity);
  const r = await post('/questions/q1/answer', { answer: 'tardía' });
  expect(await html(r.headers.get('location')!)).toContain('conflict');
  expect(store.getActivity(activity).status).toBe('canceled');
  expect(adm.db.query('SELECT answer FROM adm_questions').get()).toEqual({ answer: null });
});
test('FAB_ACTOR se restaura después de éxito y error', async () => {
  const previous = process.env.FAB_ACTOR;
  process.env.FAB_ACTOR = 'prueba-actor';
  try {
    await login(); await post(review(), { decision: 'approve' }); expect(process.env.FAB_ACTOR).toBe('prueba-actor');
    await post(review(), { decision: 'approve' }); expect(process.env.FAB_ACTOR).toBe('prueba-actor');
    store.event(store.getChange(change).workstreamId, 'info', 'después', change);
    expect(store.listEvents(store.getChange(change).workstreamId, 100, change).at(-1)!.actor).toBe('prueba-actor');
  } finally { if (previous === undefined) delete process.env.FAB_ACTOR; else process.env.FAB_ACTOR = previous; }
});
