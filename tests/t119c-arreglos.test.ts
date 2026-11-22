// T119c, arreglos tras la verificación (H2…H12): cada test reproduce el exploit o mata la mutación del hallazgo.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AdmissionDb } from '../src/admission/db.ts';
import { ThreadLinks } from '../src/admission/links.ts';
import { serverWebAction } from '../src/web-actions.ts';
import { handleServerApi } from '../src/web-api.ts';
import { cliRoutes } from '../src/web-cli.ts';
import { csrfToken } from '../src/web-auth.ts';
import { runnerCheckAction } from '../src/web-runner-check.ts';
import { jiraImportAction } from '../src/web-entrada.ts';
import { cloud, ORIGIN, SECRET, type Cloud } from './helpers/cloud.ts';
import type { Principal } from '../src/users.ts';
import { Store } from '../src/store.ts';

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

const noRunner = runnerCheckAction('/nonexistent');
const noJira = jiraImportAction('/nonexistent', { getIssue: async () => { throw new Error('sin red'); }, comment: async () => {} });
const web = (p: Principal, path: string, fields: Record<string, string> = {}) => serverWebAction(
  new Request(`${ORIGIN}${path}`, { method: 'POST', body: new URLSearchParams({ csrf: csrfToken(SECRET, p.sessionId!), ...fields }), headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' } }),
  c.stateDir, { principal: p, write: true, publicOrigin: ORIGIN, secret: SECRET }, noRunner, () => {}, noJira);
const api = (key: string, path: string, body: unknown) => { const r = new Request(`${ORIGIN}/api/v1${path}`, { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } }); return handleServerApi(r, new URL(r.url), c.stateDir, true); };
const cli = (token: string, body: unknown) => cliRoutes({ stateDir: c.stateDir, publicOrigin: ORIGIN, write: true, secret: SECRET }).handle(
  new Request(`${ORIGIN}/cli/v1/commands`, { method: 'POST', body: JSON.stringify(body), headers: { host: HOST, authorization: `Bearer ${token}`, 'content-type': 'application/json' } }), '203.0.113.7').then(r => r!);

/** Pregunta abierta de la activity del change; con `channel` el change está unido a un hilo (T23). */
function seedQuestion(channel: boolean) {
  const adm = new AdmissionDb(c.store), act = c.store.listActivities({ changeId })[0]!.id;
  c.store.db.query("UPDATE activities SET kind='implementation',status='waiting_reply',review_status=NULL, question_id='q1' WHERE id=?").run(act);
  adm.db.query("INSERT INTO adm_questions(id,activity_id,change_id,text,asked_at) VALUES ('q1',?,?,'¿sigo?',?)").run(act, changeId, c.store.now());
  if (channel) { adm.db.query('INSERT INTO adm_threads(id, source, first_seen) VALUES (?,?,?)').run('github:o/r#1', 'github:o/r', 'x'); new ThreadLinks(adm).link('github:o/r#1', changeId); }
  return adm;
}
const state = (adm: AdmissionDb) => adm.db.query('SELECT status, answered_by FROM adm_questions').get();

test('T119c-H2: un member no responde la pregunta de un change de canal, ni por web, ni por API, ni por CLI; la de origen fab sí', async () => {
  const adm = seedQuestion(true);
  expect((await web(c.web.member, '/questions/q1/answer', { answer: 'sí' })).status).toBe(403);
  expect((await api(c.keys.member.decide, '/questions/q1/answer', { answer: 'sí' })).status).toBe(403);
  expect((await cli(c.tokens.cli.member, { op: 'questions/answer', id: 'q1', fields: { answer: 'sí' } })).status).toBe(403);
  expect((await web(c.web.owner, '/questions/q1/answer', { answer: 'sí' })).status).toBe(403); // tampoco el owner: manda el residente
  expect(state(adm)).toEqual({ status: 'open', answered_by: null });
});

test('T119c-H2 (contraste): la pregunta de un change sin hilo se responde con normalidad', async () => {
  const adm = seedQuestion(false);
  expect((await web(c.web.member, '/questions/q1/answer', { answer: 'sí' })).status).toBe(303);
  expect(state(adm)).toEqual({ status: 'answered', answered_by: `user:${c.web.member.userId}` });
});

// ---- H6: migraciones con ID ----------------------------------------------------

test('T119c-H6: las columnas de T119c entran por un paso con ID en schema_migrations, también en una base anterior', () => {
  const cols = (s: Store, t: string) => (s.db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(x => x.name);
  const registered = (s: Store) => s.db.query("SELECT 1 FROM schema_migrations WHERE id = 't119c-001-actor-de-notas-y-responsable'").get() !== null;
  expect(registered(c.store)).toBe(true);
  const path = join(c.dir, 'anterior.db');
  const old = new Store(path);
  old.db.exec("DELETE FROM schema_migrations WHERE id LIKE 't119c-%'; ALTER TABLE change_notes DROP COLUMN actor_user_id; ALTER TABLE change_notes DROP COLUMN actor_role; ALTER TABLE changes DROP COLUMN responsible_user_id;");
  old.close();
  const s = new Store(path);
  try {
    expect([cols(s, 'change_notes').includes('actor_role'), cols(s, 'change_notes').includes('actor_user_id'), cols(s, 'changes').includes('responsible_user_id'), registered(s)]).toEqual([true, true, true, true]);
  } finally { s.close(); }
});
