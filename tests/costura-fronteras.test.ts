// Condición de salida de la fase 2 (06 §7): la costura completa con un fallo inyectado en cada una de las 12 fronteras del 07 §6.
// Las fronteras 3, 7, 8, 10 y parte de la 4 y la 11 viven junto a la pieza que las cruza (se citan en el informe); aquí van el resto.
import { afterEach, expect, spyOn, test } from 'bun:test';
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

async function admittedChange(verify?: string[]) {
  t = rig({ verify }); t.issues.push(labeled()); await t.cycle();
  return t.store.listChanges(t.ws.id)[0]!;
}
function removeLabel() {
  Object.assign(t.issues[0]!, { labels: [], updated_at: '2026-01-08T00:00:00Z' });
}

test('13: mandate-revoked cae dentro de la transacción: revocación y cierre se recuperan juntos', async () => {
  const c = await admittedChange();
  removeLabel();
  let injected = false;
  let observed: { inTransaction: boolean; revokedAt: string | null; changeStatus: string } | undefined;
  await t.cycle({ crash: p => {
    if (p !== 'mandate-revoked' || injected) return;
    injected = true;
    observed = {
      inTransaction: t.adm.db.inTransaction,
      revokedAt: (t.adm.db.query('SELECT revoked_at FROM adm_thread_signals').get() as { revoked_at: string | null }).revoked_at,
      changeStatus: t.store.getChange(c.id).status,
    };
    throw new CrashInjected(p);
  }, maxAttempts: 1 });
  expect(injected).toBe(true);
  expect(observed).toEqual({ inTransaction: true, revokedAt: expect.any(String), changeStatus: 'pending' });
  expect(t.store.getChange(c.id).status).toBe('pending');
  expect(t.adm.db.query('SELECT revoked_at FROM adm_thread_signals').get()).toEqual({ revoked_at: null });
  // Recuperación del efecto tras la caída, sin fabricar un trigger nuevo.
  t.adm.db.query("UPDATE adm_effects SET status='pending', attempts=0 WHERE status='dead'").run();
  await t.cycle();
  expect(t.store.getChange(c.id).status).toBe('canceled');
  expect(t.adm.db.query('SELECT revoked_at FROM adm_thread_signals').get()).not.toEqual({ revoked_at: null });
  expect(n("SELECT COUNT(*) n FROM events WHERE message='change canceled'")).toBe(1);
});

test('14: revocar con pregunta pendiente de publicar cancela la pregunta antes del Outbox', async () => {
  const c = await admittedChange();
  await t.pool(fakeLive([ASK]));
  expect(act().status).toBe('waiting_reply');
  expect(n("SELECT COUNT(*) n FROM adm_effects WHERE kind='reply' AND status='pending'")).toBe(1);
  removeLabel(); await t.cycle();
  expect(t.store.getChange(c.id).status).toBe('canceled');
  expect(act().status).toBe('canceled');
  expect(n("SELECT COUNT(*) n FROM adm_questions WHERE status='canceled'")).toBe(1);
  expect(t.run.posts).toEqual([]);
  expect(n("SELECT COUNT(*) n FROM adm_effects WHERE kind='reply' AND status='done'")).toBe(1);
});

async function openChannelPr(crash?: (p: import('../src/admission/effects.ts').CrashPoint) => void) {
  const { connectorsMain } = await import('../src/connectors/cli.ts');
  const { createGhGateway } = await import('../src/connectors/github.ts');
  const c = t.store.listChanges(t.ws.id)[0]!;
  const commands: string[][] = [];
  let created = false;
  const run: import('../src/connectors/github.ts').CommandRunner = async cmd => {
    commands.push(cmd);
    if (cmd[0] === 'git') return { code: 0, stdout: cmd[1] === 'rev-list' ? '1' : '', stderr: '' };
    if (cmd.includes('create')) { created = true; return { code: 0, stdout: 'https://github.com/owner/project/pull/12', stderr: '' }; }
    if (cmd.includes('view')) return created
      ? { code: 0, stdout: JSON.stringify({ number: 12, url: 'https://github.com/owner/project/pull/12', headRefName: c.branch, baseRefName: 'main', state: 'OPEN' }), stderr: '' }
      : { code: 1, stdout: '', stderr: 'no pull requests found' };
    throw new Error('Comando no esperado');
  };
  const errors: string[] = [];
  const open = (fail = crash) => connectorsMain('pr', ['open', c.id, '--repo', 'owner/project'], {
    store: t.store, prs: createGhGateway({ run }), run, env: {}, crash: fail, log: () => {}, error: s => errors.push(s),
  });
  return { open, commands, errors };
}
function implementChannel() {
  for (let i = 0; i < 2; i++) {
    const a = t.store.claimActivity(t.ws.id, 'impl')!;
    t.store.completeActivity(a.id, 'impl', 'STATUS: done');
  }
  const c = t.store.listChanges(t.ws.id)[0]!;
  t.store.setChangeBranch(c.id, 'fab/test');
  return t.store.getChange(c.id);
}

test('15: caída después de gh pr create: repetir fab pr repara el enlace sin crear otro PR', async () => {
  await admittedChange(); const c = implementChannel();
  const { open, commands } = await openChannelPr(once('pr-created'));
  expect(await open()).toBe(1);
  expect(commands.filter(cmd => cmd.includes('create'))).toHaveLength(1);
  const { ThreadLinks } = await import('../src/admission/links.ts');
  const links = new ThreadLinks(t.adm);
  expect(links.changeOf('github:owner/project#12')).toBeUndefined();
  expect(await open(() => {})).toBe(0);
  expect(commands.filter(cmd => cmd.includes('create'))).toHaveLength(1);
  expect(links.changeOf('github:owner/project#12')).toBe(c.id);
  expect(await open(() => {})).toBe(0);
  expect(links.threadsOf(c.id)).toHaveLength(2);
});

test('respuesta triage en el PR creado por fab contesta y reanuda la pregunta del issue', async () => {
  await admittedChange(['true']); const c = implementChannel();
  const { open, errors } = await openChannelPr();
  expect(await open()).toBe(0);
  expect(errors).toEqual([]);
  t.store.requestValidation(c.id, ['qa']);
  const gate = t.store.claimActivity(t.ws.id, 'review')!;
  t.store.blockActivity(gate.id, 'review', 'revisar implementación');
  t.store.retryChange(c.id);
  const backend = fakeLive([ASK, DONE]);
  await t.pool(backend); await t.cycle();
  expect(t.run.posts[0]?.issue).toBe(7);
  const comments: RawComment[] = [
    { id: 21, issue: 12, login: 'outsider', created_at: '2026-01-11T00:00:00Z', body: 'no' },
    { id: 22, issue: 12, login: 'maint', created_at: '2026-01-11T01:00:00Z', body: 'verde en el PR' },
  ];
  const { fakeGh } = await import('./helpers/admission.ts');
  await t.cycle({ run: fakeGh(t.issues, { comments, roles: { maint: 'triage', outsider: 'read' }, self: 'fab-bot' }) });
  expect(t.adm.db.query('SELECT status, answer, answered_by FROM adm_questions').get()).toEqual({ status: 'answered', answer: 'verde en el PR', answered_by: 'maint' });
  await t.pool(backend);
  expect(backend.turns[1]!.prompt).toBe('verde en el PR');
});


test('revocar durante un turno vivo: el siguiente latido aborta y no se aplica su pregunta tardía', async () => {
  const c = await admittedChange();
  const interval = globalThis.setInterval;
  let beat: (() => void) | undefined;
  const timer = spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number, ...args: unknown[]) => {
    if (ms === 123456) beat = fn;
    return interval(fn, ms, ...args);
  }) as typeof setInterval);
  let aborted = false;
  try {
    const backend = fakeLive([{ ...ASK, before: async turn => {
      expect(turn.signal?.aborted).toBe(false);
      removeLabel(); await t.cycle();
      expect(t.store.getChange(c.id).status).toBe('canceled');
      expect(beat).toBeDefined();
      beat!();
      aborted = turn.signal!.aborted;
    } }]);
    await t.pool(backend, { heartbeatMs: 123456 });
    expect(aborted).toBe(true);
    expect(t.store.listActivities({ changeId: c.id }).every(a => a.status === 'canceled')).toBe(true);
    expect(n("SELECT COUNT(*) n FROM adm_questions WHERE status='open'")).toBe(0);
    await t.cycle(); expect(t.run.posts).toEqual([]);
  } finally { timer.mockRestore(); }
});
