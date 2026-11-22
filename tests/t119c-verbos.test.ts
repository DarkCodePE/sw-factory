// T119c: verbos de §4.2 que faltaban (lecturas, `triage --all`, `validate`, `improve dismiss`, `runner enable|disable`, lecturas de configuración):
// capacidad de policy.ts por rol, actor de sesión, `--write` y proyección.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cliRoutes } from '../src/web-cli.ts';
import { parseVerb } from '../src/remote.ts';
import { cloud, ORIGIN, SECRET, type Cloud } from './helpers/cloud.ts';
import type { Role } from '../src/users.ts';

let c: Cloud;
let ws: { id: string; slug: string };
let changeId: string;
const HOST = 'fab.example.test';
beforeEach(() => {
  c = cloud();
  const repo = join(c.dir, 'repo'); mkdirSync(join(repo, '.git'), { recursive: true });
  ws = c.store.createWorkstream({ slug: 'nube', goal: 'g', repo, requireChangeApproval: false });
  changeId = c.store.createChange(ws.id, 'cambio', 'd').id;
});
afterEach(() => c.close());

const send = (role: Role, body: Record<string, unknown>, write = true) => cliRoutes({ stateDir: c.stateDir, publicOrigin: ORIGIN, write, secret: SECRET }).handle(
  new Request(`${ORIGIN}/cli/v1/commands`, { method: 'POST', body: JSON.stringify(body), headers: { host: HOST, authorization: `Bearer ${c.tokens.cli[role]}`, 'content-type': 'application/json' } }), '203.0.113.7').then(r => r!);
const read = (role: Role, path: string) => send(role, { op: 'ops/read', fields: { path } });
const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer'];

test('lecturas nuevas: las cuatro roles (capacidad ops/read) las ven, con la forma esperada', async () => {
  c.store.addSignal(ws.slug, 'una idea', 'cuerpo');
  for (const role of ROLES) {
    for (const [path, shape] of [
      [`/signals?ws=${ws.slug}`, (d: any) => d[0].title === 'una idea' && d[0].body === undefined],
      [`/status?ws=${ws.slug}`, (d: any) => d.slug === 'nube' && d.changes[0].id === changeId],
      [`/events?ws=${ws.slug}&limit=5`, (d: any) => Array.isArray(d) && d.length > 0 && 'message' in d[0]],
      [`/automations?ws=${ws.slug}`, (d: any) => Array.isArray(d)],
      [`/scores?ws=${ws.slug}`, (d: any) => Array.isArray(d)],
      [`/validate/${changeId}`, (d: any) => typeof d === 'object'],
      [`/improve?ws=${ws.slug}`, (d: any) => Array.isArray(d)],
    ] as [string, (d: unknown) => boolean][]) {
      const res = await read(role, path);
      expect([role, path, res.status]).toEqual([role, path, 200]);
      expect([role, path, shape(((await res.json()) as { data: unknown }).data)]).toEqual([role, path, true]);
    }
    // El objeto inexistente es 404 (la política ya pasó), no 403.
    expect((await read(role, '/bench/no-existe')).status).toBe(404);
    expect((await read(role, '/improve/no-existe')).status).toBe(404);
  }
  expect((await read('owner', '/signals')).status).toBe(400); // falta ?ws=
});

test('triage --all: owner y admin triaban las señales nuevas con su usuario como actor; member y viewer, 403; sin --write, 403', async () => {
  c.store.addSignal(ws.slug, 's1', 'b'); c.store.addSignal(ws.slug, 's2', 'b');
  for (const role of ['member', 'viewer'] as const) expect((await send(role, { op: 'triage/all', fields: { ws: ws.slug } })).status).toBe(403);
  expect((await send('admin', { op: 'triage/all', fields: { ws: ws.slug } }, false)).status).toBe(403);
  expect(c.store.listSignals(ws.id, 'new')).toHaveLength(2);
  const res = await send('admin', { op: 'triage/all', fields: { ws: ws.slug } });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { data: { triaged: unknown[] } }).data.triaged).toHaveLength(2);
  expect(c.store.listSignals(ws.id, 'new')).toHaveLength(0);
  const ev = c.store.db.query("SELECT actor, actor_source FROM events WHERE message LIKE 'signal%' OR change_id IS NOT NULL ORDER BY id DESC LIMIT 1").get() as { actor: string; actor_source: string };
  expect(ev).toEqual({ actor: `user:${c.web.admin.userId}`, actor_source: 'cli' });
});

test('validate <change>: owner y admin encolan validadores; un validador desconocido es 400; member y viewer, 403', async () => {
  for (const role of ['member', 'viewer'] as const) expect((await send(role, { op: 'validate/run', id: changeId })).status).toBe(403);
  expect((await send('admin', { op: 'validate/run', id: changeId, fields: { only: 'nada' } })).status).toBe(400);
  expect((await send('admin', { op: 'validate/run', id: changeId })).status).toBe(409); // aún no está implementado
  c.store.db.query("UPDATE changes SET status = 'implemented' WHERE id = ?").run(changeId);
  const ok = await send('admin', { op: 'validate/run', id: changeId });
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { data: { queued: string[] } }).data.queued.length).toBeGreaterThan(0);
});

test('runner enable|disable: solo owner; un admin recibe 403; el runner inexistente es 404', async () => {
  c.store.createRunner({ name: 'r1', kind: 'ssh', target: 'host' });
  for (const role of ['admin', 'member', 'viewer'] as const) expect((await send(role, { op: 'runner/disable', id: 'r1' })).status).toBe(403);
  expect(c.store.getRunner('r1').enabled).toBe(true);
  expect((await send('owner', { op: 'runner/disable', id: 'r1' })).status).toBe(200);
  expect(c.store.getRunner('r1').enabled).toBe(false);
  expect((await send('owner', { op: 'runner/enable', id: 'r1' })).status).toBe(200);
  expect((await send('owner', { op: 'runner/enable', id: 'otro' })).status).toBe(404);
});

test('improve dismiss: owner y admin; member y viewer 403; un candidato inexistente es 404', async () => {
  for (const role of ['member', 'viewer'] as const) expect((await send(role, { op: 'improve/dismiss', id: 'x' })).status).toBe(403);
  expect((await send('admin', { op: 'improve/dismiss', id: 'x' })).status).toBe(404);
});

test('lecturas de configuración: owner y admin; member y viewer 403; el runner no enseña su destino SSH', async () => {
  c.store.createRunner({ name: 'r1', kind: 'ssh', target: 'host-secreto' });
  for (const role of ['member', 'viewer'] as const) expect((await send(role, { op: 'config/read', fields: { what: 'runner list' } })).status).toBe(403);
  for (const role of ['owner', 'admin'] as const) {
    const res = await send(role, { op: 'config/read', fields: { what: 'runner list' } });
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('r1'); expect(text).not.toContain('host-secreto');
  }
  expect((await send('owner', { op: 'config/read', fields: { what: 'profile list' } })).status).toBe(200);
  expect((await send('owner', { op: 'config/read', id: ws.slug, fields: { what: 'ws access' } })).status).toBe(200);
  expect((await send('owner', { op: 'config/read', fields: { what: 'secretos' } })).status).toBe(400);
});

test('parseVerb de los verbos nuevos', () => {
  expect(parseVerb(['triage', '--all', 'nube'])).toMatchObject({ verb: { op: 'triage/all' }, fields: { ws: 'nube' } });
  expect(() => parseVerb(['reject', 'x', '--all'])).toThrow(/--all/);
  expect(parseVerb(['validate', 'abc', '--only', 'tests'])).toMatchObject({ verb: { op: 'validate/run' }, id: 'abc', fields: { only: 'tests' } });
  expect(parseVerb(['validate', 'status', 'abc'])).toMatchObject({ verb: { op: 'ops/read', read: '/validate/:id' }, id: 'abc' });
  expect(parseVerb(['events', 'nube', '--change', 'c1', '--limit', '5'])).toMatchObject({ fields: { ws: 'nube', change: 'c1', limit: '5' } });
  expect(parseVerb(['runner', 'disable', 'r1']).verb.op).toBe('runner/disable');
  expect(parseVerb(['ws', 'access', 'nube']).fields.what).toBe('ws access');
});
