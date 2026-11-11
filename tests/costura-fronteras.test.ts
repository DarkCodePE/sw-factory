// Condición de salida de la fase 2 (06 §7): la costura completa con un fallo inyectado en cada una de las 12 fronteras del 07 §6.
// Las fronteras 3, 7, 8, 10 y parte de la 4 y la 11 viven junto a la pieza que las cruza (se citan en el informe); aquí van el resto.
import { afterEach, expect, test } from 'bun:test';
import { CrashInjected } from '../src/admission/effects.ts';
import type { RawComment } from './helpers/admission.ts';
import { future, once, rig } from './helpers/auto.ts';
import { fakeLive } from './helpers/live.ts';

let t: ReturnType<typeof rig>;
afterEach(() => t.close());
const ASK = { reports: [{ state: 'awaiting' as const, summary: 's', human_action: '¿qué color?' }] };
const DONE = { reports: [{ state: 'done' as const, summary: 'listo' }], output: 'hecho' };
const labeled = () => t.issue(7, '2026-01-07T10:00:00Z', { labels: [{ name: 'fab' }], title: 'T', body: 'B' });
const n = (sql: string) => (t.store.db.query(sql).get() as { n: number }).n;
const act = () => t.store.listActivities({}).find(a => a.kind === 'investigation')!;

test('1: leer el canal → registrar el trigger: caer entre ambos no duplica el trigger', async () => {
  t = rig(); t.issues.push(labeled());
  await expect(t.cycle({ crash: once('after-read') })).rejects.toThrow(CrashInjected);
  expect(n('SELECT COUNT(*) n FROM adm_triggers')).toBe(0);
  await t.cycle(); await t.cycle();
  expect(n('SELECT COUNT(*) n FROM adm_triggers')).toBe(1);
  expect(n('SELECT COUNT(*) n FROM changes')).toBe(1);
});

test('2: registrar → admitir: caer entre ambos no pierde la admisión', async () => {
  t = rig(); t.issues.push(labeled());
  await expect(t.cycle({ crash: once('after-register') })).rejects.toThrow(CrashInjected);
  expect(n('SELECT COUNT(*) n FROM adm_triggers')).toBe(1);
  expect(n('SELECT COUNT(*) n FROM changes')).toBe(0); // el efecto quedó encolado, sin despachar
  await t.cycle();
  expect(n('SELECT COUNT(*) n FROM changes')).toBe(1);
  expect(n('SELECT COUNT(*) n FROM adm_decisions')).toBe(1);
});

test('4: claim → sesión escrita → proceso lanzado: morir tras escribir la sesión no lanza nada, y el reinicio lanza con esa misma sesión', async () => {
  t = rig(); t.channelChange();
  const backend = fakeLive([DONE]);
  await expect(t.pool(backend, { crash: once('session-written') })).rejects.toThrow(CrashInjected);
  expect(backend.turns).toHaveLength(0); // sin proceso
  const row = t.adm.db.query('SELECT session_id, launched_at FROM adm_sessions').get() as { session_id: string; launched_at: string | null };
  expect(row.launched_at).toBeNull(); // sesión escrita antes de lanzar
  t.store.requeueOrphans(t.ws.id, future());
  await t.pool(backend);
  expect(backend.turns[0]!.newSessionId).toBe(row.session_id);
  expect(act().status).toBe('completed');
});

test('5: pool muerto a mitad de turno con el agente aún vivo: nadie reclama la activity hasta que el agente muere (no hay dos agentes en el worktree)', async () => {
  t = rig(); t.channelChange();
  const agent = Bun.spawn(['sleep', '60'], { detached: true, stdout: 'ignore', stderr: 'ignore' });
  const a = t.store.claimActivity(t.ws.id, 'w1')!;
  t.store.setActivityAgentPgid(a.id, agent.pid);
  expect(t.store.requeueOrphans(t.ws.id, future())).toBe(0); // vivo: se mata, no se reencola
  await agent.exited;
  expect(t.store.claimActivity(t.ws.id, 'w2')).toBeNull(); // el lease sigue siendo del primero hasta la siguiente pasada
  expect(t.store.requeueOrphans(t.ws.id, future())).toBe(1);
  expect(t.store.claimActivity(t.ws.id, 'w2')?.id).toBe(a.id);
});

test('6: report recibido → fin de turno → aplicado: una caída en cada punto no pierde la pregunta ni la duplica', async () => {
  for (const point of ['report-recorded', 'turn-ended', 'report-applied'] as const) {
    t = rig(); t.channelChange();
    const backend = fakeLive([ASK]);
    await expect(t.pool(backend, { crash: once(point) })).rejects.toThrow(CrashInjected);
    t.store.requeueOrphans(t.ws.id, future());
    await t.pool(backend);
    expect(backend.turns).toHaveLength(1); // ningún reintento relanzó el agente
    expect(act().status).toBe('waiting_reply');
    expect(n("SELECT COUNT(*) n FROM adm_questions WHERE status = 'open'")).toBe(1);
    expect(n("SELECT COUNT(*) n FROM adm_effects WHERE kind = 'reply'")).toBe(1);
    t.close();
  }
});

/** Pregunta ya publicada y esperando; devuelve los comentarios para añadir respuestas. */
async function waiting(comments: RawComment[], backend = fakeLive([ASK, DONE])) {
  t = rig({ extra: { comments, roles: { alice: 'write', bob: 'read' } } });
  t.channelChange();
  await t.pool(backend);
  await t.cycle();
  return backend;
}

test('9: respuesta leída → registrada → reencolada: caer a mitad no reencola dos veces, y un comentario repetido tampoco', async () => {
  const comments: RawComment[] = [], backend = await waiting(comments);
  comments.push({ id: 1, issue: 7, login: 'alice', created_at: '2026-01-11T00:00:00Z', body: 'rojo' });
  await t.cycle({ crash: once('answer-applied') }); // el fallo dentro de la transacción la deshace y el efecto reintenta
  expect(t.adm.db.query("SELECT attempts FROM adm_effects WHERE key LIKE 'inbound:%'").get()).toEqual({ attempts: 2 });
  expect(act().status).toBe('pending');
  expect(n("SELECT COUNT(*) n FROM adm_questions WHERE status = 'answered'")).toBe(1);
  comments.push({ id: 2, issue: 7, login: 'alice', created_at: '2026-01-11T01:00:00Z', body: 'azul' });
  await t.cycle();
  await t.pool(backend);
  expect(backend.turns.filter(x => x.prompt === 'rojo')).toHaveLength(1); // la primera respuesta, entregada una vez
  expect(backend.turns.some(x => x.prompt === 'azul')).toBe(false); // el segundo comentario no reanuda nada (ya no hay pregunta abierta)
  expect(act().status).toBe('completed');
});

test('11: change cancelado mientras espera: no queda ninguna activity pendiente bajo un change cerrado y la pregunta se cancela', async () => {
  await waiting([]);
  const c = t.store.getChange(act().changeId);
  t.store.closeChange(c.id, 'canceled');
  await t.cycle();
  expect(t.store.listActivities({ changeId: c.id }).filter(a => a.status === 'pending' || a.status === 'waiting_reply' || a.status === 'in_progress')).toEqual([]);
  expect(n("SELECT COUNT(*) n FROM adm_questions WHERE status = 'canceled'")).toBe(1);
  expect(t.store.claimActivity(t.ws.id, 'w9')).toBeNull();
});

test('12: respuesta de alguien sin rol, anterior a la pregunta, de un bot o de la propia fab: no reanuda; la autorizada sí', async () => {
  const comments: RawComment[] = [], backend = await waiting(comments);
  comments.push(
    { id: 1, issue: 7, login: 'bob', created_at: '2026-01-11T00:00:00Z', body: 'sin rol' },
    { id: 2, issue: 7, login: 'alice', created_at: '2026-01-09T00:00:00Z', body: 'anterior a la pregunta' },
    { id: 3, issue: 7, login: 'dependabot', type: 'Bot', created_at: '2026-01-11T00:00:00Z', body: 'bot' },
    { id: 4, issue: 7, login: 'fab-bot', created_at: '2026-01-11T00:00:00Z', body: 'la propia fab' });
  await t.cycle();
  expect(act().status).toBe('waiting_reply');
  expect(t.adm.db.query('SELECT accept FROM adm_comment_decisions').all().every((d: any) => d.accept === 0)).toBe(true);
  comments.push({ id: 5, issue: 7, login: 'alice', created_at: '2026-01-11T02:00:00Z', body: 'verde' });
  await t.cycle(); await t.pool(backend);
  expect(backend.turns[1]!.prompt).toBe('verde');
});
