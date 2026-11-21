import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { Store } from '../src/store.ts';
import { AdmissionDb } from '../src/admission/db.ts';
import { startWeb } from '../src/web.ts';
import { assertLoopback } from '../src/web-auth.ts';

let dir: string, store: Store, server: ReturnType<typeof startWeb>, change: string, activity: string;
let cookie: string, csrf: string;
const req = (path: string, init?: RequestInit) => fetch(`http://${server.host ?? "127.0.0.1"}:${server.port}${path}`, { redirect: 'manual', ...init });
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
  method: 'POST', headers: { cookie, origin: `http://${server.host ?? "127.0.0.1"}:${server.port}`, 'content-type': 'application/x-www-form-urlencoded', ...headers },
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
  expect(r.headers.get('set-cookie')).toMatch(/(?:^|; )Path=\/(?:;|$)/);
  expect(cookie).toMatch(/^fab_session=[a-f0-9]{64}$/);
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
  expect((await post(review(), { decision: 'comment', comment: 'é' + 'a'.repeat(8191) })).status).toBe(413);
  expect((await post(review(), { decision: 'comment', comment: '' })).status).toBe(400);
  expect((await post(review(), { decision: 'invalid' })).status).toBe(400);
  expect((await post(review(), {}, { 'content-type': 'application/json' })).status).toBe(415);
  expect((await post(review(), { padding: 'a'.repeat(16385) })).status).toBe(413);
  const adm = seedQuestion();
  expect((await post('/questions/q1/answer', { answer: 'é' + 'a'.repeat(8191) })).status).toBe(413);
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
  expect((await req(review(), { method: 'POST', headers: { cookie, origin: `http://${server.host ?? "127.0.0.1"}:${server.port}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'decision=approve' })).status).toBe(403);
  expect((await post(review(), {}, { cookie: `${cookie}; ${cookie}` })).status).toBe(401);
  expect((await post(review(), {}, { cookie: `fab_session=${'é'.repeat(64)}` })).status).toBe(401);
  expect((await req(`/auth?token=${'é'.repeat(64)}`)).status).toBe(401);
});
test('el límite se aplica al stream sin Content-Length y con tipo parametrizado', async () => {
  await login();
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < 17; i++) controller.enqueue(new Uint8Array(1024).fill(97)); controller.close(); } });
  const r = await req(review(), { method: 'POST', headers: { cookie, origin: `http://${server.host}:${server.port}`, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body });
  expect(r.status).toBe(413); expect(store.getActivity(activity).reviewStatus).toBe('awaiting');
  const accepted = await post(review(), { decision: 'comment', comment: 'a'.repeat(8192) }, { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' });
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
  expect(adm.db.query('SELECT status, answer FROM adm_questions').get()).toEqual({ status: 'canceled', answer: null });
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

test('los formularios conservan Origin en el navegador y el canje oculta el token', async () => {
  const exchange = await login();
  expect(exchange.headers.get('referrer-policy')).toBe('no-referrer');
  const page = await req(`/activities/${activity}`, { headers: { cookie } });
  expect(page.headers.get('referrer-policy')).toBe('same-origin');
});

test('H3: aviso solo tras POST de la sesión, una vez y sin marcador en la URL', async () => {
  expect(await (await req('/?web_result=ok')).text()).not.toContain('Acción registrada.');
  await login();
  expect(await html('/?web_result=ok')).not.toContain('Acción registrada.');
  const r = await post(review(), { decision: 'approve' });
  expect(r.status).toBe(303);
  const location = r.headers.get('location')!;
  expect(location).toBe(`/activities/${activity}`);
  expect(await (await req(location)).text()).not.toContain('Acción registrada.');
  expect(await html('/')).not.toContain('Acción registrada.');
  expect((await req(location, { method: 'HEAD', headers: { cookie } })).status).toBe(200);
  expect(await html(location)).toContain('Acción registrada.');
  expect(await html(location)).not.toContain('Acción registrada.');
});
test('H5 M13: Origin con sufijo ajeno no pasa una comprobación por prefijo', async () => {
  await login();
  for (const origin of [`http://${server.host ?? "127.0.0.1"}:${server.port}.evil.test`, `http://localhost:${server.port}.evil.test`]) {
    expect((await post(review(), { decision: 'approve' }, { origin })).status).toBe(403);
  }
  expect(store.getActivity(activity).reviewStatus).toBe('awaiting');
});
test('H5 M19: decisión desconocida con comentario no se convierte en commented', async () => {
  await login();
  const n = store.countEvents(store.getChange(change).workstreamId, change);
  expect((await post(review(), { decision: 'desconocida', comment: 'Comentario válido' })).status).toBe(400);
  expect(store.getActivity(activity).reviewStatus).toBe('awaiting');
  expect(store.countEvents(store.getChange(change).workstreamId, change)).toBe(n);
});
test('H5 M40: HEAD no canjea ni consume el token de acceso', async () => {
  const head = await fetch(server.loginUrl!, { method: 'HEAD', redirect: 'manual' });
  expect(head.status).toBe(405); expect(head.headers.get('set-cookie')).toBeNull();
  await login();
});
test('H5 M42: respuestas de acciones conservan cabeceras de seguridad', async () => {
  const responses: Response[] = [await post(review(), { decision: 'approve' })];
  await login();
  responses.push(await post(review(), { csrf: 'incorrecto', decision: 'approve' }));
  responses.push(await post('/fuera-de-alcance'));
  responses.push(await post(review(), {}, { 'content-type': 'application/json' }));
  responses.push(await post(review(), { decision: 'approve' }));
  expect(responses.map(r => r.status)).toEqual([401, 403, 404, 415, 303]);
  for (const r of responses) {
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
  }
});
test('H5 M48: web_result no puede reflejar HTML ni falsificar un aviso', async () => {
  const injection = '<script>alert("aviso")</script>';
  for (const authenticated of [false, true]) {
    if (authenticated) await login();
    const page = await (await req(`/?web_result=${encodeURIComponent(injection)}`, { headers: authenticated ? { cookie } : {} })).text();
    expect(page).not.toContain(injection);
    expect(page).not.toContain('role="status"');
  }
});
test('H5 M51: PUT, DELETE y PATCH autenticados no ejecutan acciones', async () => {
  await login();
  const n = store.countEvents(store.getChange(change).workstreamId, change);
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const r = await req(review(), { method, headers: { cookie, origin: `http://${server.host ?? "127.0.0.1"}:${server.port}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, decision: 'approve' }) });
    expect(r.status).toBe(405);
  }
  expect(store.getActivity(activity).reviewStatus).toBe('awaiting');
  expect(store.countEvents(store.getChange(change).workstreamId, change)).toBe(n);
});

test('T71c: ACTIONS tiene exactamente las acciones que ofrece la web', async () => {
  const { ACTIONS } = await import('../src/web-actions.ts');
  expect(Object.keys(ACTIONS).sort()).toEqual(['activities/review', 'activities/score', 'api-keys/create', 'api-keys/revoke', 'automations/create', 'automations/delete', 'automations/disable', 'automations/enable', 'automations/run', 'automations/update', 'automejora/save', 'benchmarks/cancel', 'changes/cancel', 'changes/note', 'changes/rename', 'changes/retry', 'changes/suite-task', 'questions/answer', 'runners/check', 'runners/create', 'runners/delete', 'runners/update', 'scorers/backfill', 'signals/create', 'signals/ignore', 'signals/triage', 'workstreams/adaptador', 'workstreams/archive', 'workstreams/create', 'workstreams/runner', 'workstreams/settings', 'workstreams/state']);
  for (const bad of ['merge', 'gate/allow', 'changes/merge']) expect(ACTIONS[bad]).toBeUndefined();
});
test('T71c: performAction fija el actor, valida la entrada y devuelve el destino', async () => {
  const { performAction, InputError } = await import('../src/web-actions.ts');
  const out = await performAction(dir, 'changes/rename', change, { title: 'Nuevo título' }, 'api:prueba');
  expect(out).toEqual({ destination: `/changes/${change}`, result: 'ok' });
  expect(store.getChange(change).title).toBe('Nuevo título');
  expect(await performAction(dir, 'changes/rename', 'no-existe', { title: 'x' }, 'web')).toEqual({ destination: '/', result: 'not_found' });
  await expect(performAction(dir, 'changes/rename', change, { title: '' }, 'web')).rejects.toBeInstanceOf(InputError);
  await expect(performAction(dir, 'merge', change, {}, 'web')).rejects.toBeInstanceOf(InputError);
  expect(process.env.FAB_ACTOR).toBeUndefined();
});

// T75 (F2 H1, D11 opción B): la sesión vive en un host único por arranque; otro servicio de loopback no la usa.
const lo = (init: RequestInit & { headers?: Record<string, string> }, host: string, path = review()) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, { redirect: 'manual', ...init, headers: { host, ...init.headers } });
test('T75: el host es fab-<aleatorio>.localhost, distinto en cada arranque, y la cookie es de ese host', async () => {
  expect(server.host).toMatch(/^fab-[0-9a-f]{16}\.localhost$/);
  expect(server.loginUrl).toStartWith(`http://${server.host}:${server.port}/auth?token=`);
  const other = startWeb(dir, 0, { write: true }); other.stop(true);
  expect(other.host).not.toBe(server.host);
  expect((await login()).headers.get('set-cookie')).not.toMatch(/Domain=/i); // host-only: el navegador no la envía a 127.0.0.1
});
test('T75: ataque de H1 — un servicio en 127.0.0.1:<otro puerto> que reenvía la cookie no ve la página ni aprueba', async () => {
  await login();
  const asLoopback = `127.0.0.1:${server.port}`;
  for (const host of [asLoopback, `localhost:${server.port}`]) {
    const page = await lo({ headers: { cookie } }, host, `/activities/${activity}`);
    expect(page.status).toBe(403); expect(await page.text()).not.toContain(csrf);
    const approve = await lo({ method: 'POST', headers: { cookie, origin: `http://${host}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, decision: 'approve' }) }, host);
    expect(approve.status).toBe(403);
  }
  expect(store.getActivity(activity).reviewStatus).toBe('awaiting');
});
test('T75: Origin solo acepta el host único; los antiguos 127.0.0.1 y localhost dan 403', async () => {
  await login();
  for (const origin of [`http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`, `http://${server.host}:${server.port + 1}`, `https://${server.host}:${server.port}`, `http://${server.host}`]) {
    expect((await post(review(), { decision: 'approve' }, { origin })).status).toBe(403);
  }
  expect(store.getActivity(activity).reviewStatus).toBe('awaiting');
  expect((await post(review(), { decision: 'approve' })).status).toBe(303);
});
test('T75: el enlace de acceso por 127.0.0.1 no canjea ni consume el token', async () => {
  const url = new URL(server.loginUrl!);
  expect((await lo({}, `127.0.0.1:${server.port}`, url.pathname + url.search)).status).toBe(403);
  expect((await login()).status).toBe(303);
});
test('T75: assertLoopback acepta loopback y falla cerrado con un host que no resuelve', async () => {
  await assertLoopback('localhost');
  await expect(assertLoopback('fab-x.invalid')).rejects.toThrow('no resuelve a loopback');
  await expect(assertLoopback('1.1.1.1')).rejects.toThrow('no resuelve a loopback'); // literal: resuelve, pero fuera de loopback
});

test('T71c-H1: con un campo repetido gana el primero (confirm=no&confirm=yes no cancela)', async () => {
  await login();
  const body = (c: string) => `csrf=${csrf}&${c}`;
  const r = await req(`/changes/${change}/cancel`, { method: 'POST', headers: { cookie, origin: `http://${server.host}:${server.port}`, 'content-type': 'application/x-www-form-urlencoded' }, body: body('confirm=no&confirm=yes') });
  expect(r.status).toBe(400);
  expect(store.getChange(change).status).not.toBe('canceled');
  const ok = await req(`/changes/${change}/cancel`, { method: 'POST', headers: { cookie, origin: `http://${server.host}:${server.port}`, 'content-type': 'application/x-www-form-urlencoded' }, body: body('confirm=yes&confirm=no') });
  expect(ok.status).toBe(303); expect(store.getChange(change).status).toBe('canceled');
});

test('T75-H2: el filtro de Host rechaza otro nombre .localhost y el host único con otro puerto', async () => {
  const get = (host: string) => fetch(`http://127.0.0.1:${server.port}/`, { headers: { host } });
  expect((await get(`${server.host}:${server.port}`)).status).toBe(200);
  for (const h of [`otro.localhost:${server.port}`, `${server.host}:${server.port + 1}`, `${server.host}`, `127.0.0.1:${server.port}`, `localhost:${server.port}`, `${server.host}.evil.test:${server.port}`])
    expect((await get(h)).status).toBe(403);
});
test('T75-H3: assertLoopback exige que todas las direcciones sean de loopback y webMain falla cerrado si no resuelve', async () => {
  await assertLoopback('x', async () => [{ address: '127.0.0.1' }, { address: '::1' }]);
  await expect(assertLoopback('x', async () => [{ address: '127.0.0.1' }, { address: '10.0.0.5' }])).rejects.toThrow('no resuelve a loopback');
  await expect(assertLoopback('x', async () => [])).rejects.toThrow('no resuelve a loopback');
  await expect(assertLoopback('x', async () => { throw new Error('dns'); })).rejects.toThrow('no resuelve a loopback');
  const { webMain } = await import('../src/web.ts');
  const err = console.error; console.error = () => {};
  try { expect(await webMain(['--port', '0', '--write'], dir, async () => [{ address: '8.8.8.8' }])).toBe(1); }
  finally { console.error = err; }
});

test('T78: un error de acción se muestra con menú y enlace de vuelta, con su código y sin ejecutar nada', async () => {
  await login();
  const before = store.countEvents(store.getChange(change).workstreamId, change);
  const r = await post(review(), { decision: 'comment', comment: '' }, { referer: `http://${server.host}:${server.port}/activities/${activity}` });
  expect(r.status).toBe(400);
  const page = await r.text();
  expect(page).toContain('<nav'); expect(page).toContain('Elige una decisión');
  expect(page).toContain(`href="/activities/${activity}"`);
  expect(store.getActivity(activity).reviewStatus).toBe('awaiting');
  expect(store.countEvents(store.getChange(change).workstreamId, change)).toBe(before);
  // Sin Referer, el enlace sale de la ruta de la acción.
  expect(await (await post(review(), { decision: 'invalid' })).text()).toContain(`href="/activities/${activity}"`);
  // Todo error de acción lleva la plantilla: validación, límites, tipo, ruta desconocida y CSRF.
  for (const [res, status] of [
    [await post('/questions/q1/answer', { answer: '  ' }), 400], [await post(review(), {}, { 'content-type': 'application/json' }), 415],
    [await post(review(), { padding: 'a'.repeat(16385) }), 413], [await post('/merge'), 404], [await post(review(), { csrf: 'x' }), 403],
    [await post('/activities/a%3Cb/review', { decision: 'approve' }), 400],
  ] as [Response, number][]) {
    expect(res.status).toBe(status); expect(await res.text()).toContain('<nav');
  }
});
test('T78: el texto del error se escapa y no se ofrece el sondeo que recargaría la ruta POST', async () => {
  await login();
  const page = await (await post(review(), { decision: 'comment', comment: '' }, { referer: `http://${server.host}:${server.port}/x"><script>alert(1)</script>` })).text();
  expect(page).not.toContain('<script>alert'); expect(page).toContain('%22%3E%3Cscript%3E');
  expect(page).not.toContain('poll.js');
});

test('T78-H1: si la base no abre al pintar el error, sale el error en texto con su estado y cabeceras, no un 500', async () => {
  await login();
  const { renameSync } = await import('node:fs');
  store.close(); renameSync(join(dir, 'fabrica.db'), join(dir, 'fabrica.db.off'));
  try {
    const r = await post(review(), { decision: 'comment', comment: '' });
    expect(r.status).toBe(400); expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    const t = await r.text(); expect(t).toContain('Elige una decisión'); expect(t).not.toContain('__bunfallback');
  } finally { renameSync(join(dir, 'fabrica.db.off'), join(dir, 'fabrica.db')); store = new Store(join(dir, 'fabrica.db')); }
});
test('T78-H2/H3: el enlace de vuelta ignora Referers ajenos o protocol-relative y no apunta a páginas inexistentes', async () => {
  await login();
  const base = `http://${server.host}:${server.port}`;
  for (const referer of [`${base}//evil.test/x`, `${base}/\\evil.test/x`, 'http://evil.test/activities/x']) {
    const page = await (await post(review(), { decision: 'comment', comment: '' }, { referer })).text();
    expect(page).not.toContain('evil.test'); expect(page).toContain(`href="/activities/${activity}"`);
  }
  // Sin Referer, una ruta de acción sin página padre vuelve a la raíz.
  seedQuestion();
  expect(await (await post('/questions/q1/answer', { answer: '  ' })).text()).toContain('<a href="/">Volver a la página de origen</a>');
});
