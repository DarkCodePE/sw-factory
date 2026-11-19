import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';

let dir: string, store: Store, server: ReturnType<typeof startWeb>, cookie: string, csrf: string, repo: string;
const req = (path: string, init?: RequestInit) => fetch(`http://${server.host ?? "127.0.0.1"}:${server.port}${path}`, { redirect: 'manual', ...init });
const html = async (path: string) => (await req(path, { headers: { cookie } })).text();
const post = (path: string, data: Record<string, string> = {}, headers: Record<string, string> = {}) => req(path, {
  method: 'POST', headers: { cookie, origin: `http://${server.host ?? "127.0.0.1"}:${server.port}`, 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams({ csrf, ...data }),
});
const ws = (slug = 'prueba') => store.getWorkstream(slug);
const events = (slug = 'prueba') => store.listEvents(slug, 100).map(e => `${e.actor}|${e.message}`);
beforeEach(async () => {
  dir = mkdtempSync('/tmp/fab-web-ws-'); store = new Store(join(dir, 'fabrica.db'));
  repo = join(dir, 'repo'); mkdirSync(join(repo, '.git'), { recursive: true });
  store.createWorkstream({ slug: 'prueba', goal: 'objetivo <b>inicial</b>', repo: '/repo' });
  server = startWeb(dir, 0, { write: true });
  const r = await fetch(server.loginUrl!, { redirect: 'manual' });
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  csrf = /name="csrf" value="([^"]+)"/.exec(await html('/workstreams'))?.[1] ?? '';
});
afterEach(() => { server?.stop(true); store?.close(); rmSync(dir, { recursive: true, force: true }); });

test('sin --write no hay formularios ni POST', async () => {
  server.stop(true); server = startWeb(dir, 0);
  expect(await (await req('/workstreams')).text()).not.toContain('method="post"');
  expect((await post('/workstreams/prueba/settings', { goal: 'x' })).status).toBe(405);
});
test('el formulario exige sesión, origin y CSRF', async () => {
  expect(csrf).toHaveLength(64);
  expect((await post('/workstreams/prueba/settings', { goal: 'x' }, { cookie: '' })).status).toBe(401);
  expect((await post('/workstreams/prueba/settings', { goal: 'x' }, { origin: 'http://evil.test' })).status).toBe(403);
  expect((await post('/workstreams/prueba/settings', { goal: 'x', csrf: 'a'.repeat(64) })).status).toBe(403);
  expect(ws().goal).toBe('objetivo <b>inicial</b>');
});
test('ajustes: cambia objetivo, concurrencia y tope y deja un evento por valor con anterior y actor', async () => {
  const r = await post('/workstreams/prueba/settings', { goal: 'nuevo objetivo', concurrency: '4', task_limit: '7' });
  expect(r.status).toBe(303);
  expect(ws()).toMatchObject({ goal: 'nuevo objetivo', workerConcurrency: 4, taskLimit: 7 });
  const e = events().join('\n');
  expect(e).toContain('web|workstream prueba: goal "objetivo <b>inicial</b>" -> "nuevo objetivo"');
  expect(e).toContain('web|workstream prueba: worker_concurrency 2 -> 4');
  expect(e).toContain('web|workstream prueba: task_limit 20 -> 7');
});
test('ajustes: sin cambios no hay eventos; valores inválidos se rechazan sin tocar nada', async () => {
  const before = events().length;
  await post('/workstreams/prueba/settings', { goal: 'objetivo <b>inicial</b>', concurrency: '2', task_limit: '20' });
  expect(events().length).toBe(before);
  for (const bad of [{ goal: '   ' }, { concurrency: '0' }, { concurrency: 'x' }, { task_limit: '-1' }, { concurrency: '1.5' }]) {
    await post('/workstreams/prueba/settings', { goal: 'ok', concurrency: '2', task_limit: '20', ...bad });
    expect(ws()).toMatchObject({ goal: 'objetivo <b>inicial</b>', workerConcurrency: 2, taskLimit: 20 });
  }
});
test('D-F: un POST con require_approval, rutas protegidas, agente o repo se ignora', async () => {
  const before = ws();
  await post('/workstreams/prueba/settings', {
    goal: 'otro', require_approval: '0', requireApproval: '0', require_change_approval: '0', protected_paths: '', protect_none: '1',
    agent: 'codex', repo: '/otro', state: 'archived', profile: 'x', verify: 'rm -rf /',
  });
  const after = ws();
  expect(after.goal).toBe('otro');
  expect({ ...after, goal: before.goal }).toEqual(before);
});
test('estado: activar y pausar por la ruta del Store; archivar exige el slug escrito', async () => {
  await post('/workstreams/prueba/state', { state: 'active' }); expect(ws().state).toBe('active');
  await post('/workstreams/prueba/state', { state: 'paused' }); expect(ws().state).toBe('paused');
  await post('/workstreams/prueba/state', { state: 'archived' }); expect(ws().state).toBe('paused'); // archivar solo con confirmación
  await post('/workstreams/prueba/state', { state: 'draft' }); expect(ws().state).toBe('paused');
  await post('/workstreams/prueba/archive', { confirm: 'otro' }); expect(ws().state).toBe('paused');
  await post('/workstreams/prueba/archive', {}); expect(ws().state).toBe('paused');
  expect((await post('/workstreams/prueba/archive', { confirm: 'prueba' })).status).toBe(303);
  expect(ws().state).toBe('archived');
  expect(events()).toContain('web|workstream active -> paused');
  expect(events()).toContain('web|workstream paused -> archived');
});
test('archivar uno ya archivado da invalid_transition y borrar no elimina filas', async () => {
  store.setWorkstreamState('prueba', 'archived');
  const r = await post('/workstreams/prueba/archive', { confirm: 'prueba' });
  const page = await (await req(r.headers.get('location')!, { headers: { cookie } })).text();
  expect(page).toContain('invalid_transition');
  expect(store.listWorkstreams()).toHaveLength(1);
  await post('/workstreams/prueba/state', { state: 'paused' }); expect(ws().state).toBe('paused');
});
test('un workstream inexistente da not_found y la ruta no admite otras acciones', async () => {
  const r = await post('/workstreams/nada/settings', { goal: 'x' });
  expect(await (await req(r.headers.get('location')!, { headers: { cookie } })).text()).toContain('not_found');
  expect((await post('/workstreams/prueba/delete', {})).status).toBe(404);
  expect((await post('/workstreams/Bad%20Slug/settings', {})).status).toBe(400);
});
test('la página escapa el objetivo y muestra los formularios con CSRF', async () => {
  const page = await html('/workstreams');
  expect(page).not.toContain('<b>inicial</b>');
  expect(page).toContain('&lt;b&gt;inicial&lt;/b&gt;');
  expect(page).toContain('action="/workstreams/prueba/settings"');
  expect(page).toContain('action="/workstreams/prueba/archive"');
});

// ---- T61 ----
const wiz = (q: Record<string, string>) => html(`/workstreams/nuevo?${new URLSearchParams(q)}`);
const base = () => ({ repo, slug: 'nuevo-ws', goal: 'Mi objetivo', agent: 'native', profile: '', verify: '' });
test('asistente: cada paso valida lo suyo y vuelve a su paso si falla', async () => {
  expect(await wiz({ paso: '2', repo: join(dir, 'no-existe') })).toContain('no existe');
  mkdirSync(join(dir, 'sin-git')); 
  const p = await wiz({ paso: '3', ...base(), repo: join(dir, 'sin-git') });
  expect(p).toContain('no es un repositorio git'); expect(p).toContain('name="repo"');
  expect(await wiz({ paso: '2', repo: 'relativa' })).toContain('ruta absoluta');
  expect(await wiz({ paso: '4', ...base(), slug: 'Mal Slug' })).toContain('slug');
  expect(await wiz({ paso: '4', ...base(), slug: 'prueba' })).toContain('Ya existe');
  expect(await wiz({ paso: '4', ...base(), agent: 'inventado' })).toContain('adaptador');
  expect(await wiz({ paso: '5', ...base(), verify: 'echo "sin cerrar' })).toContain('name="verify"');
  expect(await wiz({ paso: '5', ...base() })).toContain('action="/workstreams/nuevo"');
});
test('asistente: crea en draft idéntico a fab ws create con los mismos valores', async () => {
  const r = await post('/workstreams/nuevo', { ...base(), verify: 'bun test' });
  expect(r.status).toBe(303);
  const cli = new Store(join(dir, 'cli.db'));
  const ref = cli.createWorkstream({ slug: 'nuevo-ws', goal: 'Mi objetivo', repo, agent: undefined, workerConcurrency: undefined, taskLimit: undefined, requireChangeApproval: true, requireApproval: true, protectedPaths: undefined, protectNone: undefined, verify: ['bun test'], verifySetup: undefined, profile: undefined });
  const got = ws('nuevo-ws');
  const strip = (w: Record<string, unknown>) => ({ ...w, id: 0, createdAt: 0 });
  expect(strip(got as never)).toEqual(strip(ref as never));
  expect(got.state).toBe('draft');
  expect(events('nuevo-ws').join()).toContain('created (draft)');
  cli.close();
});
test('asistente: el POST revalida (repo falso, agente inválido, slug duplicado) y no crea nada', async () => {
  for (const bad of [{ repo: join(dir, 'nada') }, { repo: 'rel' }, { agent: 'zzz' }, { slug: 'prueba' }, { goal: '' }, { slug: 'A B' }, { profile: 'f'.repeat(64) }]) {
    await post('/workstreams/nuevo', { ...base(), ...bad });
  }
  expect(store.listWorkstreams().map(w => w.slug)).toEqual(['prueba']);
});
test('asistente: ni el POST ni el GET aceptan flags de aprobación ni rutas protegidas', async () => {
  await post('/workstreams/nuevo', { ...base(), require_approval: '0', no_spec_approval: '1', protect_none: '1', protected_paths: '' });
  const w = ws('nuevo-ws');
  expect(w.requireApproval).toBe(true); expect(w.requireChangeApproval).toBe(true);
  expect(w.protectedPaths.length).toBeGreaterThan(0);
});
test('checklist: un adaptador sin binario verificado queda pendiente', async () => {
  const bin = join(dir, 'bin'); mkdirSync(bin); const prev = [process.env.PATH, process.env.FABRICA_HOME];
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\n'); chmodSync(join(bin, 'codex'), 0o755);
  process.env.PATH = bin; process.env.FABRICA_HOME = dir;
  try {
    const sinPin = await wiz({ paso: '5', ...base(), agent: 'codex' });
    expect(sinPin).toMatch(/Pendiente[^<]*codex[^<]*sin pin/i);
    const noInstalado = await wiz({ paso: '5', ...base(), agent: 'claude' });
    expect(noInstalado).toMatch(/Pendiente[^<]*claude[^<]*no instalado/i);
    expect(await wiz({ paso: '5', ...base(), agent: 'native' })).not.toMatch(/Pendiente[^<]*native/i);
    expect(await wiz({ paso: '5', ...base() })).toMatch(/Pendiente[^<]*verificación/i);
  } finally { process.env.PATH = prev[0]; if (prev[1] === undefined) delete process.env.FABRICA_HOME; else process.env.FABRICA_HOME = prev[1]; }
});
test('asistente: escapa los valores reflejados y sin sesión no ofrece el formulario', async () => {
  expect(await wiz({ paso: '5', ...base(), goal: '"><script>alert(1)</script>' })).not.toContain('<script>alert');
  const anon = await (await req('/workstreams/nuevo?paso=1')).text();
  expect(anon).not.toContain('name="csrf"');
});
