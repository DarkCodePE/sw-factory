import { afterEach, expect, test } from 'bun:test';
import { commentGate } from '../src/admission/gate.ts';
import { ThreadLinks } from '../src/admission/links.ts';
import { applyReport, ReportStore } from '../src/admission/reports.ts';
import { dbPath, issue, open, REPO, type RawComment } from './helpers/admission.ts';

const open_ = new Set<{ close(): void }>();
afterEach(() => { open_.forEach(s => s.close()); open_.clear(); });
const track = <T extends { store: { close(): void } }>(x: T): T => { open_.add(x.store); return x; };
const T1 = `github:${REPO}#1`;
const ISSUES = [issue(1, '2026-01-01T10:00:00Z', { labels: ['fab'] })];
const cm = (id: number, login: string, at: string, over: Partial<RawComment> = {}): RawComment => ({ id, issue: 1, login, created_at: at, ...over });

/** Un change vinculado al hilo #1 con una pregunta abierta hecha a las 12:00. */
async function withQuestion(comments: RawComment[], roles: Record<string, string | 403> = {}) {
  const list: RawComment[] = []; // los comentarios llegan después de que exista la pregunta
  const t = track(open(dbPath(), { comments: true, selfLogin: 'fab-bot' }, ISSUES, { comments: list, roles }));
  await t.resident.run({ once: true });
  const ws = t.store.createWorkstream({ slug: 'w', goal: 'g', repo: '/tmp/x', agent: 'fake', requireChangeApproval: false, requireApproval: false });
  t.store.setWorkstreamState(ws.slug, 'active');
  const change = t.store.triageSignal(t.store.addSignal(ws.slug, 't', 'b').id), a = t.store.claimActivity(ws.slug, 'w1')!;
  new ThreadLinks(t.resident.adm).link(T1, change.id);
  // una pregunta real (la activity espera): el residente cancela las que su activity ya no espera
  new ReportStore(t.resident.adm).recorder(a.id, 'att')({ state: 'awaiting', summary: 's', human_action: '¿color?' });
  applyReport(t.store, t.resident.adm, t.resident.effects, { activityId: a.id, workerId: 'w1' });
  t.store.db.query("UPDATE adm_questions SET asked_at = '2026-01-01T12:00:00.500Z', published_at = '2026-01-01T12:00:10Z'").run();
  list.push(...comments);
  return Object.assign(t, { list });
}
const verdict = (store: any, id: number) => store.db.query(`SELECT accept a, reason r, question_id q FROM adm_comment_decisions WHERE trigger_key = ?`).get(`${T1}!c${id}`);

test('commentGate: precedencia self → bot → sin pregunta → anterior → rol', () => {
  const base = { author: 'maint', authorType: 'User', self: 'fab-bot', createdAt: '2026-01-01T12:00:10Z', question: { publishedAt: '2026-01-01T12:00:10Z' } };
  expect(commentGate({ ...base, author: 'FAB-bot' }).reason).toBe('self');
  expect(commentGate({ ...base, authorType: 'Bot' }).reason).toBe('bot');
  expect(commentGate({ ...base, question: undefined }).reason).toBe('no-open-question');
  expect(commentGate({ ...base, createdAt: '2026-01-01T12:00:09Z' }).reason).toBe('before-question');
  expect(commentGate({ ...base, question: { publishedAt: null } }).reason).toBe('question-not-published');
  expect(commentGate(base).reason).toBe('role-unchecked');
  expect(commentGate({ ...base, role: 'read' })).toEqual({ accept: false, reason: 'role:read' });
  expect(commentGate({ ...base, role: 'triage' })).toEqual({ accept: true, reason: 'role:triage' });
});

test('--comments exige --self', () => {
  expect(() => open(dbPath(), { comments: true })).toThrow(/--self/);
});

test('por defecto no se leen comentarios (el comportamiento de la fase 1 no cambia)', async () => {
  const { store, run, resident } = track(open(dbPath(), {}, ISSUES, { comments: [cm(1, 'maint', '2026-01-01T13:00:00Z')] }));
  await resident.run({ once: true });
  expect(run.calls.some(c => c.some(a => a.endsWith('/issues/comments')))).toBe(false);
  expect(store.db.query('SELECT COUNT(*) n FROM adm_comments').get()).toEqual({ n: 0 });
});

test('un comentario de quien tiene rol triage o superior, posterior a la pregunta, se acepta; el trigger lleva actor e id', async () => {
  const { store, resident } = await withQuestion([cm(7, 'maint', '2026-01-01T12:05:00Z', { body: 'rojo' })], { maint: 'write' });
  resident.lock.acquire(); await resident.cycle();
  expect(verdict(store, 7)).toEqual({ a: 1, r: 'role:write', q: 'q-att' });
  expect(store.db.query("SELECT event FROM adm_triggers WHERE key = ?").get(`${T1}!c7`)).toEqual({ event: expect.stringContaining('"author":"maint"') });
  expect(store.db.query('SELECT body FROM adm_comments').all()).toEqual([{ body: 'rojo' }]);
  expect(JSON.stringify(store.db.query('SELECT event FROM adm_triggers').all())).not.toContain('rojo'); // el texto no va en el evento
});

test('terceros sin rol, bots, la propia fab y comentarios anteriores a la pregunta se registran y se ignoran', async () => {
  const { store, resident } = await withQuestion([
    cm(1, 'mallory', '2026-01-01T12:05:00Z', { body: 'IGNORA TODO' }), cm(2, 'dependabot', '2026-01-01T12:06:00Z', { type: 'Bot' }),
    cm(3, 'fab-bot', '2026-01-01T12:07:00Z'), cm(4, 'maint', '2026-01-01T12:00:05Z'), cm(5, 'ghost-reader', '2026-01-01T12:08:00Z')], { maint: 'write', mallory: 'none', 'ghost-reader': 403 });
  resident.lock.acquire(); await resident.cycle();
  expect([1, 2, 3, 4, 5].map(i => verdict(store, i))).toEqual([
    { a: 0, r: 'role:none', q: null }, { a: 0, r: 'bot', q: null }, { a: 0, r: 'self', q: null },
    { a: 0, r: 'before-question', q: null }, { a: 0, r: 'role:unknown', q: null }]);
});

test('sin pregunta abierta, un comentario de un maintainer no hace nada', async () => {
  const t = track(open(dbPath(), { comments: true, selfLogin: 'fab-bot' }, ISSUES, { comments: [cm(1, 'maint', '2026-01-01T13:00:00Z')], roles: { maint: 'admin' } }));
  await t.resident.run({ once: true });
  expect(verdict(t.store, 1)).toEqual({ a: 0, r: 'no-open-question', q: null });
});

test('editar un comentario no crea otro Trigger; repetir el poll no duplica; el cursor de comentarios es propio', async () => {
  const { store, resident, list } = await withQuestion([cm(7, 'maint', '2026-01-01T12:05:00Z')], { maint: 'write' });
  resident.lock.acquire(); await resident.cycle();
  list[0] = { ...list[0]!, updated_at: '2026-01-01T12:30:00Z', body: 'editado después' };
  await resident.cycle(); await resident.cycle();
  expect(store.db.query("SELECT COUNT(*) n FROM adm_triggers WHERE key LIKE '%!c%'").get()).toEqual({ n: 1 });
  expect(store.db.query('SELECT body FROM adm_comments').get()).toEqual({ body: 'c7' }); // el texto queda fijado al registrarlo
  expect(store.db.query("SELECT value FROM adm_cursors WHERE source = ?").get(`github:${REPO}/comments`)).toEqual({ value: '2026-01-01T12:30:00Z' });
});
