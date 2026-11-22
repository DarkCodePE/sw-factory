// T119c: actor estable, política antes de validar, revalidación al escribir y guardas del servidor.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { performAction, serverWebAction } from '../src/web-actions.ts';
import { handleServerApi } from '../src/web-api.ts';
import { csrfToken } from '../src/web-auth.ts';
import { runnerCheckAction } from '../src/web-runner-check.ts';
import { jiraImportAction } from '../src/web-entrada.ts';
import { notesBlock } from '../src/prompts.ts';
import { disableUser, revokeSession, revokeUserKey, type Principal } from '../src/users.ts';
import { repoByAlias, serverGuard } from '../src/web-server-guards.ts';
import { cloud, ORIGIN, SECRET, type Cloud } from './helpers/cloud.ts';

let c: Cloud;
let ws: { id: string; slug: string };
let changeId: string;
beforeEach(() => {
  c = cloud();
  const repo = join(c.dir, 'repo'); mkdirSync(join(repo, '.git'), { recursive: true });
  const w = c.store.createWorkstream({ slug: 'nube', goal: 'g', repo, requireChangeApproval: false });
  ws = w;
  changeId = c.store.createChange(w.id, 'cambio', 'd').id;
});
afterEach(() => c.close());

const reader = () => new Store(join(c.stateDir, 'fabrica.db'), { readonly: true });
const noRunner = runnerCheckAction('/nonexistent');
const noJira = jiraImportAction('/nonexistent', { getIssue: async () => { throw new Error('sin red'); }, comment: async () => {} });

async function post(p: Principal, path: string, fields: Record<string, string> = {}, write = true): Promise<Response> {
  const body = new URLSearchParams({ csrf: csrfToken(SECRET, p.sessionId!), ...fields });
  const req = new Request(`${ORIGIN}${path}`, { method: 'POST', body, headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' } });
  return serverWebAction(req, c.stateDir, { principal: p, write, publicOrigin: ORIGIN, secret: SECRET }, noRunner, () => {}, noJira);
}

test('una nota de member lleva ID de usuario y rol verificados; el nombre visible no entra en la identidad', async () => {
  const p = c.web.member;
  expect((await post(p, `/changes/${changeId}/note`, { body: 'hola' })).status).toBe(303);
  const r = reader();
  try {
    const [n] = r.listChangeNotes(changeId);
    expect(n).toMatchObject({ actor: `user:${p.userId}`, actorUserId: p.userId, actorRole: 'member' });
    const ev = r.db.query("SELECT actor, actor_user_id, actor_source FROM events WHERE message LIKE 'nota del dueño%'").get() as Record<string, string>;
    expect(ev).toEqual({ actor: `user:${p.userId}`, actor_user_id: p.userId, actor_source: 'web' });
    expect(JSON.stringify([n, ev])).not.toContain('u-member');
  } finally { r.close(); }
});

test('el rol de la nota queda el de ese momento aunque luego cambie, y el prompt lo muestra fuera del texto de la nota', async () => {
  const p = c.web.member;
  await post(p, `/changes/${changeId}/note`, { body: 'una nota' });
  c.store.db.query('UPDATE users SET role = ? WHERE id = ?').run('viewer', p.userId);
  const [n] = c.store.listChangeNotes(changeId);
  expect(n!.actorRole).toBe('member');
  const block = notesBlock([{ id: n!.id, body: n!.body, createdAt: n!.createdAt, actorUserId: n!.actorUserId, actorRole: n!.actorRole }], 'fijo');
  expect(block).toContain(`[user:${p.userId} role:member] una nota`);
  // Sin metadata (nota local o histórica) el formato es el de siempre.
  expect(notesBlock([{ id: 'x', body: 'b', createdAt: 't' }], 'fijo')).toContain('[t] b');
});

test('la señal y su evento llevan al usuario de la sesión (no el del sistema), también por API', async () => {
  const p = c.web.member;
  expect((await post(p, '/signals', { title: 'desde web', workstream: ws.slug })).status).toBe(303);
  const req = new Request(`${ORIGIN}/api/v1/signals`, { method: 'POST', body: JSON.stringify({ title: 'desde api', workstream: ws.slug }), headers: { authorization: `Bearer ${c.keys.member.decide}`, 'content-type': 'application/json' } });
  expect((await handleServerApi(req, new URL(req.url), c.stateDir, true)).status).toBe(200);
  const r = reader();
  try {
    const rows = r.db.query("SELECT actor, actor_user_id, actor_source, message FROM events WHERE message LIKE 'signal creada%' ORDER BY id").all() as Record<string, string>[];
    expect(rows.map(x => [x.actor, x.actor_user_id, x.actor_source])).toEqual([[`user:${p.userId}`, p.userId, 'web'], [`user:${p.userId}`, p.userId, 'api']]);
  } finally { r.close(); }
});

test('la política va antes que la validación: un viewer con un formulario roto recibe 403, no 400', async () => {
  expect((await post(c.web.viewer, `/changes/${changeId}/rename`, { title: '' })).status).toBe(403);
  expect((await post(c.web.member, `/changes/${changeId}/rename`, { title: '' })).status).toBe(400);
});

test('una sesión revocada o un usuario de baja no ejecutan: 401, y nada se escribe', async () => {
  const p = c.web.member;
  revokeSession(c.store, p, p.sessionId!);
  expect((await post(p, '/signals', { title: 't', workstream: ws.slug })).status).toBe(401);
  const o = c.web.owner, d = c.web.admin;
  disableUser(c.store, o, d.userId);
  expect((await post(d, '/signals', { title: 't', workstream: ws.slug })).status).toBe(401);
  expect(c.store.listSignals(ws.id)).toEqual([]);
});

test('una sesión CLI o una cookie de otra superficie no sirve a la web', async () => {
  expect((await post(c.cli.owner, '/signals', { title: 't', workstream: ws.slug })).status).toBe(401);
});

test('Origin ajeno y CSRF de otra sesión dan 403 sin ejecutar', async () => {
  const p = c.web.owner;
  const mk = (origin: string, token: string) => new Request(`${ORIGIN}/signals`, { method: 'POST', body: new URLSearchParams({ csrf: token, title: 't', workstream: ws.slug }), headers: { origin, 'content-type': 'application/x-www-form-urlencoded' } });
  const run = (r: Request) => serverWebAction(r, c.stateDir, { principal: p, write: true, publicOrigin: ORIGIN, secret: SECRET }, noRunner, () => {}, noJira);
  expect((await run(mk('https://otro.example', csrfToken(SECRET, p.sessionId!)))).status).toBe(403);
  expect((await run(mk(ORIGIN, csrfToken(SECRET, c.web.admin.sessionId!)))).status).toBe(403);
  expect(c.store.listSignals(ws.id)).toEqual([]);
});

// ---- guardas de servidor -----------------------------------------------------

test('workstreams/create: el repo es un alias del inventario; sin inventario, ruta ajena, enlace que sale y verify fallan cerrado', async () => {
  const fields = (repo: string, extra: Record<string, string> = {}) => ({ repo, slug: 'otro', goal: 'objetivo', agent: 'claude', profile: '', verify: '', ...extra });
  const result = async (f: Record<string, string>) => { await post(c.web.owner, '/workstreams/nuevo', f); return c.store.listWorkstreams().some(w => w.slug === 'otro'); };
  expect(await result(fields('alias'))).toBe(false); // sin inventario
  const real = join(c.dir, 'repo');
  writeFileSync(join(c.stateDir, 'server-inventory.json'), JSON.stringify({ repos: { buena: real, enlace: join(c.dir, 'enlace'), sinGit: c.dir } }));
  expect(await result(fields(real))).toBe(false); // una ruta no es un alias
  expect(await result(fields('buena', { verify: 'bun test' }))).toBe(false); // verify, en consola
  expect(await result(fields('sinGit'))).toBe(false);
  symlinkSync('/etc', join(c.dir, 'enlace'));
  expect(await result(fields('enlace'))).toBe(false);
  expect(await result(fields('buena'))).toBe(true);
  expect(c.store.listWorkstreams().find(w => w.slug === 'otro')!.repo).toBe(real);
});

test('workstreams/acceso: legacy se rechaza en servidor y activar un workstream en modo anterior también', async () => {
  const bad = await post(c.web.owner, `/workstreams/${ws.slug}/acceso`, { kind: 'env', mode: 'legacy', names: '' });
  expect(c.store.getWorkstream(ws.slug).envAllow).toBeNull(); // sigue legacy: no se guardó
  expect(bad.status).toBe(400);
  const before = c.store.getWorkstream(ws.slug).state;
  await post(c.web.owner, `/workstreams/${ws.slug}/state`, { state: 'active' });
  expect(c.store.getWorkstream(ws.slug).state).toBe(before);
  c.store.setWorkstreamEnvAllow(ws.slug, []); c.store.setWorkstreamMcpAllow(ws.slug, []);
  await post(c.web.owner, `/workstreams/${ws.slug}/state`, { state: 'active' });
  expect(c.store.getWorkstream(ws.slug).state).toBe('active');
});

test('workstreams/settings respeta el techo del inventario', async () => {
  writeFileSync(join(c.stateDir, 'server-inventory.json'), JSON.stringify({ ceiling: { concurrency: 2, taskLimit: 10 } }));
  await post(c.web.admin, `/workstreams/${ws.slug}/settings`, { goal: 'g2', concurrency: '5', task_limit: '5' });
  expect(c.store.getWorkstream(ws.slug).goal).toBe('g');
  await post(c.web.admin, `/workstreams/${ws.slug}/settings`, { goal: 'g2', concurrency: '2', task_limit: '5' });
  expect(c.store.getWorkstream(ws.slug).goal).toBe('g2');
});

test('runners: destino SSH solo del inventario y runner local solo confinado', async () => {
  writeFileSync(join(c.stateDir, 'server-inventory.json'), JSON.stringify({ runnerTargets: ['caja-buena'] }));
  const create = (f: Record<string, string>) => post(c.web.owner, '/config/runners/alta', f);
  await create({ name: 'r1', kind: 'ssh', target: 'caja-mala' });
  await create({ name: 'r2', kind: 'local' });
  expect(c.store.listRunnerSummaries().length).toBe(0);
  await create({ name: 'r3', kind: 'ssh', target: 'caja-buena' });
  await create({ name: 'r4', kind: 'local', confine: 'yes' });
  expect(c.store.listRunnerSummaries().map(r => r.name).sort()).toEqual(['r3', 'r4']);
});

test('resident/config: el repo debe estar preaprobado', async () => {
  writeFileSync(join(c.stateDir, 'server-inventory.json'), JSON.stringify({ residentRepos: ['org/ok'] }));
  expect((await post(c.web.owner, '/config/entrada', { repo: 'org/otro', label: '', interval: '', mode: 'observe' })).status).toBe(303);
  expect(await Bun.file(join(c.stateDir, 'resident.json')).exists()).toBe(false);
  await post(c.web.owner, '/config/entrada', { repo: 'org/ok', label: '', interval: '', mode: 'observe' });
  expect(await Bun.file(join(c.stateDir, 'resident.json')).exists()).toBe(true);
});

test('perfiles: member y viewer no llegan al guardado; el owner sí llega a validar', async () => {
  const f = { ws: ws.slug, expectedAgent: 'claude', base: 'a'.repeat(64) };
  expect((await post(c.web.member, '/perfiles/guardar', f)).status).toBe(403);
  expect((await post(c.web.viewer, '/perfiles/asignar', f)).status).toBe(403);
  expect([401, 403]).not.toContain((await post(c.web.owner, '/perfiles/guardar', f)).status);
});

test('jira/import: una revocación que gana mientras espera al proveedor impide el efecto local', async () => {
  const p = c.web.admin;
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const slow = jiraImportAction(c.stateDir, {
    getIssue: async () => { await gate; return { ref: { system: 'jira', key: 'KAN-1', url: 'u' }, summary: 's', description: 'd', status: 's', issueType: 't', subtasks: [] }; },
    comment: async () => {},
  });
  const form = new URLSearchParams({ csrf: 'x', ws: ws.slug, key: 'KAN-1', confirm: 'yes' });
  const pending = slow(form, { principal: p, write: true });
  await new Promise(r => setTimeout(r, 30));
  disableUser(c.store, c.web.owner, p.userId);
  release();
  const out = await pending.then(r => r, e => e);
  expect(c.store.listSignals(ws.id)).toEqual([]);
  expect(out instanceof Error || (out as { result: string }).result === 'jira_error').toBe(true);
});

test('performAction directo con un principal: member no cancela; owner sí llega al objeto', async () => {
  const deny = await performAction(c.stateDir, 'changes/cancel', changeId, { confirm: 'yes' }, { principal: c.web.member, write: true });
  expect(deny.result).toBe('forbidden');
  const ok = await performAction(c.stateDir, 'changes/cancel', changeId, { confirm: 'yes' }, { principal: c.web.owner, write: true });
  expect(ok.result).not.toBe('forbidden'); // el repo del fixture no es un worktree real: la limpieza posterior puede fallar
  expect(c.store.getChange(changeId).status).toBe('canceled');
});

test('performAction directo: la política va antes que la validación del formulario (viewer con campos rotos: forbidden, no InputError)', async () => {
  const out = await performAction(c.stateDir, 'changes/rename', changeId, { title: '' }, { principal: c.web.viewer, write: true });
  expect(out.result).toBe('forbidden');
  await expect(performAction(c.stateDir, 'changes/rename', changeId, { title: '' }, { principal: c.web.member, write: true })).rejects.toMatchObject({ status: 400 });
});

test('definicion/importar: el destino debe ser un repo del inventario (alias → ruta real)', () => {
  const repo = join(c.dir, 'repo');
  writeFileSync(join(c.stateDir, 'server-inventory.json'), JSON.stringify({ repos: { ok: repo } }));
  expect(() => serverGuard('definicion/importar', { repo: '/etc' }, c.store, c.stateDir, '')).toThrow('inventario');
  expect(() => serverGuard('definicion/importar', { repo: c.dir }, c.store, c.stateDir, '')).toThrow('inventario');
  expect(serverGuard('definicion/importar', { repo }, c.store, c.stateDir, '')).toEqual({ repo });
  expect(repoByAlias(c.stateDir, 'ok')).toBe(repo);
  expect(() => repoByAlias(c.stateDir, 'constructor')).toThrow('inventario');
});

test('API: una clave local fabk_ no vale en servidor, una clave revocada tampoco y la lectura funciona con una clave de usuario', async () => {
  const get = (token: string) => { const r = new Request(`${ORIGIN}/api/v1/workstreams`, { headers: { authorization: `Bearer ${token}` } }); return handleServerApi(r, new URL(r.url), c.stateDir, true); };
  const local = c.store.createApiKey('local', 'decide');
  expect((await get(local.key)).status).toBe(401);
  const ok = await get(c.keys.member.read);
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { data: { slug: string }[] }).data[0]!.slug).toBe('nube');
  const id = /^fabu_([a-f0-9]{12})_/.exec(c.keys.member.read)![1]!;
  revokeUserKey(c.store, c.web.member, id, true);
  expect((await get(c.keys.member.read)).status).toBe(401);
});
