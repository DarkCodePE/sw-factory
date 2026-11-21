import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdmissionDb } from '../src/admission/db.ts';
import { EVIDENCE_LIMIT } from '../src/evidence.ts';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';

const toolValue = 'credencial-de-prueba';
const token = 'ghp_' + 'x'.repeat(36);
const stream = [
  { type: 'system', subtype: 'init', cwd: '/metadato-no-es-un-paso' },
  { type: 'assistant', message: { content: [
    { type: 'text', text: `Mensaje del agente <script>alert(1)</script> ${token}` },
    { type: 'thinking', thinking: 'Pensamiento único' },
    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: '<archivo>', password: { nested: toolValue } } },
  ] } },
  { type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'Resultado único' }] },
  ] } },
  { type: 'result', result: 'Resumen duplicado' },
].map(row => JSON.stringify(row).replace(token, '\\u0067' + token.slice(1))).join('\n') + '\n\n[stderr]\nAviso del ejecutable\n';

let dir: string, store: Store, server: ReturnType<typeof startWeb>, change: string, activity: string, ws: string, run: string;
const get = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`);
const activityPage = (query = '') => get(`/activities/${activity}${query}`);
const turnPage = (id = change) => `/changes/${id}/turns/turno/transcript`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-transcript-'));
  store = new Store(join(dir, 'fabrica.db'));
  ws = store.createWorkstream({ slug: 'uno', goal: 'g', repo: '/r' }).id;
  change = store.createChange(ws, 'Cambio', 'd').id;
  activity = store.listActivities({ changeId: change })[0]!.id;
  run = join(dir, 'runs', change);
  mkdirSync(run, { recursive: true });
  new AdmissionDb(store);
  store.db.query(`INSERT INTO adm_sessions(change_id, kind, generation, session_id, backend, cwd, status, created_at)
    VALUES (?, 'implementation', 1, 'sesion', 'claude', '/r', 'open', '2026-11-21T10:00:00.000Z')`).run(change);
  store.db.query(`INSERT INTO adm_turns(attempt_id, activity_id, change_id, session_id, generation, plan, started_at, log)
    VALUES ('turno', ?, ?, 'sesion', 1, 'fresh', '2026-11-21T10:00:00.000Z', 'ignorar-esta-ruta.log')`).run(activity, change);
  server = startWeb(dir, 0);
});
afterEach(() => { server.stop(true); store.close(); rmSync(dir, { recursive: true, force: true }); });

test('T99: pasos de Claude plegables y filtros independientes sin JavaScript', async () => {
  writeFileSync(join(run, `${activity}.log`), stream);
  const base = await (await activityPage()).text();
  expect(base).toContain('<h2>Transcript</h2>');
  expect(base).toContain('name="pensamiento"');
  expect(base).toContain('name="herramientas"');
  expect(base).toMatch(/<details[^>]*><summary>Mensaje del agente<\/summary>/);
  expect(base).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  for (const text of ['Pensamiento único', 'Resultado único', 'Llamada a herramienta']) expect(base).not.toContain(text);
  const thoughts = await (await activityPage('?pensamiento=1')).text();
  expect(thoughts).toContain('Pensamiento único');
  expect(thoughts).not.toContain('Resultado único');
  const tools = await (await activityPage('?herramientas=1')).text();
  expect(tools).toContain('Llamada a herramienta');
  expect(tools).toContain('Resultado único');
  expect(tools).not.toContain('Pensamiento único');
  const all = await (await activityPage('?pensamiento=1&herramientas=1')).text();
  expect(all).toContain('Pensamiento único');
  expect(all).toContain('Resultado único');
  expect(all).toContain('&lt;archivo&gt;');
  expect(all).toContain('[REDACTED]');
  for (const unsafe of ['<script>alert', token, toolValue, 'metadato-no-es-un-paso', 'Resumen duplicado'])
    expect(all).not.toContain(unsafe);
});

test('T99: transcript por intento, enlace desde el change y log de texto redactado', async () => {
  writeFileSync(join(run, `${activity}.t-turno.log`), stream);
  expect(await (await get(`/changes/${change}`)).text()).toContain(`href="${turnPage()}"`);
  const result = await get(turnPage() + '?herramientas=1');
  expect(result.status).toBe(200);
  expect(await result.text()).toContain('Resultado único');
  const log = await get(`/changes/${change}/turns/turno/log`);
  expect(log.headers.get('content-type')).toStartWith('text/plain');
  const raw = await log.text();
  expect(raw).toContain('Aviso del ejecutable');
  expect(raw).not.toContain(toolValue);
  expect(raw).not.toContain(token);
  expect(raw).not.toContain('\\u0067hp_');
  const another = store.createChange(ws, 'Otro change', 'd').id;
  expect((await get(turnPage(another))).status).toBe(404);
});

test('T99: stream roto o truncado, evidencia ausente y symlink mantienen la página', async () => {
  const log = join(run, `${activity}.log`);
  for (const bad of [
    stream.replace('\n\n[stderr]', '\n{"type":\n\n[stderr]'),
    stream + 'x'.repeat(EVIDENCE_LIMIT),
    '{"type":"assistant","message":{"content":12}}',
  ]) {
    writeFileSync(log, bad);
    const response = await activityPage();
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/<h2>Transcript<\/h2><p[^>]*>No medido<\/p>/);
  }
  const target = join(dir, 'fuera.log');
  writeFileSync(target, stream);
  symlinkSync(target, join(run, `${activity}.t-turno.log`));
  const response = await get(turnPage());
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('No medido');
  expect(body).not.toContain('Mensaje del agente');
});

test('T99: el log histórico de texto sigue legible', async () => {
  writeFileSync(join(run, `${activity}.log`), 'Log histórico & seguro');
  const body = await (await activityPage()).text();
  expect(body).toMatch(/<h2>Transcript<\/h2><p[^>]*>No medido<\/p>/);
  expect(body).toContain('Log histórico &amp; seguro');
});
