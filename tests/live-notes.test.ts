import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerQuestion } from '../src/admission/answers.ts';
import { AdmissionDb } from '../src/admission/db.ts';
import { CrashInjected, type CrashPoint } from '../src/admission/effects.ts';
import { ThreadLinks } from '../src/admission/links.ts';
import { processActivity } from '../src/pool.ts';
import { buildWorkerPrompt } from '../src/prompts.ts';
import { LIVE_RULES } from '../src/live/turn.ts';
import { Store } from '../src/store.ts';
import { branchFor } from '../src/worktrees.ts';
import { fakeLive } from './helpers/live.ts';

const ASK = { state: 'awaiting', summary: 'Datos pendientes', human_action: '¿Color?' } as const;
const DONE = { state: 'done', summary: 'Trabajo resuelto' } as const;

let dir: string, repo: string, store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-live-notes-'));
  repo = join(dir, 'repo');
  expect(Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]).exitCode).toBe(0);
  expect(Bun.spawnSync(['git', '-C', repo, '-c', 'user.name=test', '-c', 'user.email=t@t',
    'commit', '--allow-empty', '-qm', 'init']).exitCode).toBe(0);
  store = new Store(join(dir, 'fab.db'), { clock: () => new Date('2026-01-01T00:00:00Z') });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function setup(confine = false) {
  const ws = store.createWorkstream({ slug: 'live-notes', goal: 'goal', repo, agent: 'fake',
    requireApproval: false, requireChangeApproval: false });
  store.setWorkstreamState(ws.id, 'active');
  const change = store.createChange(ws.id, 'Cambio sintético', 'Prueba de turnos');
  const adm = new AdmissionDb(store);
  const stateDir = join(dir, 'state');
  const run = async (backend: ReturnType<typeof fakeLive>, crash?: (point: CrashPoint) => void) => {
    const activity = store.claimActivity(ws.id, 'worker')!;
    await processActivity(store, activity, 'worker', {
      workstream: ws.id, stateDir, live: true, confine, liveBackends: { fake: backend }, log: () => {}, crash,
    });
    return store.getActivity(activity.id);
  };
  const reply = (questionId: string) =>
    expect(answerQuestion(store, adm, { questionId, answer: 'rojo', by: 'maint' })).toBe('answered');
  const recover = () => store.requeueOrphans(ws.id, '9999-01-01T00:00:00.000Z', () => true);
  const runAbortable = async (backend: ReturnType<typeof fakeLive>, abortController: AbortController) => {
    const activity = store.claimActivity(ws.id, 'worker')!;
    await processActivity(store, activity, 'worker', {
      workstream: ws.id, stateDir, live: true, confine, liveBackends: { fake: backend }, log: () => {},
    }, abortController);
    return store.getActivity(activity.id);
  };
  return { ws, change, adm, stateDir, run, runAbortable, reply, recover };
}

test('sin notas conserva byte a byte los prompts fresco y de respuesta', async () => {
  const { ws, change, stateDir, run, reply } = setup();
  const [activity] = store.listActivities({ changeId: change.id });
  const backend = fakeLive([{ reports: [ASK] }, { reports: [DONE] }]);
  const waiting = await run(backend);
  reply(waiting.questionId!);
  expect((await run(backend)).status).toBe('completed');
  expect(backend.turns.map(t => t.prompt)).toEqual([
    buildWorkerPrompt({ workstream: ws, change, activity: activity!, history: [],
      worktree: join(stateDir, 'worktrees', change.id.slice(0, 8)), branch: branchFor(change.id), nonce: 'fixed' }) + LIVE_RULES,
    'rojo',
  ]);
});

test('una nota durante la espera se entrega solo al reanudar y una nota durante el turno espera al siguiente', async () => {
  const { change, adm, run, reply } = setup();
  const backend = fakeLive([{ reports: [ASK] }, { reports: [ASK], before: turn => {
    expect(turn.prompt).not.toContain('Nota escrita durante el turno');
    store.addChangeNote(change.id, 'Nota escrita durante el turno');
    expect(store.listChangeNotes(change.id).every(n => n.deliveredAt === null)).toBe(true);
  } }, { reports: [DONE] }]);
  const first = await run(backend);
  expect(first.status).toBe('waiting_reply');
  const effects = adm.db.query('SELECT * FROM adm_effects').all();
  const note = store.addChangeNote(change.id, 'Nota escrita durante la espera');
  expect(store.getActivity(first.id)).toEqual(first);
  expect(adm.db.query('SELECT * FROM adm_effects').all()).toEqual(effects);
  expect(backend.turns).toHaveLength(1);
  reply(first.questionId!);
  const second = await run(backend);
  expect(second.status).toBe('waiting_reply');
  const turn = backend.turns[1]!;
  expect(turn.prompt).toMatch(/^rojo\n\n# Notes from the factory owner/);
  expect(turn.prompt).toContain(note.body);
  expect(turn.prompt).toContain(LIVE_RULES);
  expect(store.listChangeNotes(change.id)).toEqual([
    expect.objectContaining({ id: note.id, attemptId: turn.attemptId, deliveredAt: expect.any(String) }),
    expect.objectContaining({ body: 'Nota escrita durante el turno', attemptId: null, deliveredAt: null }),
  ]);
  reply(second.questionId!);
  expect((await run(backend)).status).toBe('completed');
  const third = backend.turns[2]!;
  expect(third.prompt).not.toContain(note.body);
  expect(third.prompt).toContain('Nota escrita durante el turno');
});

test('session-launched deja la nota pendiente y el turno que recupera vuelve a reservarla', async () => {
  const { change, adm, run, recover } = setup();
  const note = store.addChangeNote(change.id, 'Nota reservada en el turno interrumpido');
  const backend = fakeLive([{ reports: [DONE] }]);
  await expect(run(backend, p => { if (p === 'session-launched') throw new CrashInjected(p); })).rejects.toThrow(CrashInjected);
  expect(backend.turns).toHaveLength(0);
  const interrupted = adm.db.query('SELECT attempt_id FROM adm_turns').get() as { attempt_id: string };
  expect(store.listChangeNotes(change.id)[0]).toMatchObject({ id: note.id, attemptId: interrupted.attempt_id, deliveredAt: null });
  recover();
  expect((await run(backend)).status).toBe('completed');
  const resumed = backend.turns.at(-1)!;
  expect(resumed.attemptId).not.toBe(interrupted.attempt_id);
  expect(resumed.prompt).toContain(note.body);
  expect(store.listChangeNotes(change.id)[0]).toMatchObject({ attemptId: resumed.attemptId, deliveredAt: expect.any(String) });
});

test('un error del backend vuelve a entregar la respuesta y la nota con el mismo turno de reintento', async () => {
  const { change, adm, run, reply } = setup();
  const backend = fakeLive([{ reports: [ASK] }, { error: new Error('Límite de uso sintético') }, { reports: [DONE] }]);
  const waiting = await run(backend);
  const note = store.addChangeNote(change.id, 'Nota para el reintento vivo');
  reply(waiting.questionId!);
  const answerDelivered = () => adm.db.query('SELECT delivered_at FROM adm_questions WHERE id = ?').get(waiting.questionId!);
  expect((await run(backend)).status).toBe('pending');
  expect(answerDelivered()).toEqual({ delivered_at: null });
  expect(store.listChangeNotes(change.id)[0]).toMatchObject({ attemptId: backend.turns[1]!.attemptId, deliveredAt: null });
  expect((await run(backend)).status).toBe('completed');
  const retry = backend.turns[2]!;
  expect(retry.prompt).toStartWith('rojo\n');
  expect(retry.prompt).toContain(note.body);
  expect(answerDelivered()).toEqual({ delivered_at: expect.any(String) });
  expect(store.listChangeNotes(change.id)[0]).toMatchObject({ attemptId: retry.attemptId, deliveredAt: expect.any(String) });
});

test('si falla la confirmación viva se revierte también la entrega de la respuesta', async () => {
  const { change, adm, run, reply } = setup();
  const backend = fakeLive([{ reports: [ASK] }, { reports: [DONE] }]);
  const waiting = await run(backend);
  store.addChangeNote(change.id, 'Nota cuya confirmación falla');
  reply(waiting.questionId!);
  const confirm = store.confirmNotes.bind(store);
  let confirmed = 0;
  store.confirmNotes = id => {
    confirmed = confirm(id);
    throw new Error('confirmación interrumpida');
  };
  expect((await run(backend)).status).toBe('pending');
  expect(confirmed).toBe(1);
  expect(adm.db.query('SELECT delivered_at FROM adm_questions WHERE id = ?').get(waiting.questionId!)).toEqual({ delivered_at: null });
  expect(store.listChangeNotes(change.id)[0]!.deliveredAt).toBeNull();
});

test('al reconstruir se repiten las notas entregadas y se confirma solo la pendiente, fuera del bloque de canal', async () => {
  const { ws, change, adm, run, reply } = setup();
  const thread = 'github:synthetic/notes#1';
  adm.db.query('INSERT INTO adm_threads(id, source, first_seen) VALUES (?, ?, ?)').run(thread, 'github:synthetic/notes', store.now());
  new ThreadLinks(adm).link(thread, change.id);
  const historical = store.addChangeNote(change.id, 'Nota histórica');
  const backend = fakeLive([{ reports: [ASK] }, { reports: [DONE] }]);
  const waiting = await run(backend);
  const fresh = backend.turns[0]!;
  expect(fresh.confine).toBe(true);
  expect(fresh.prompt).toContain(historical.body);
  expect(store.listChangeNotes(change.id)[0]!.attemptId).toBe(fresh.attemptId);
  const pending = store.addChangeNote(change.id, 'Nota pendiente');
  reply(waiting.questionId!);
  backend.known.clear();
  expect((await run(backend)).status).toBe('completed');
  const [, lost, rebuilt] = backend.turns;
  expect(lost!.prompt).not.toContain(historical.body);
  expect(rebuilt!.prompt).toContain('Answer (maint): rojo');
  const channelEnd = rebuilt!.prompt.indexOf('>>>\n\n# Earlier work');
  const ownerStart = rebuilt!.prompt.indexOf('<<<OWNER_NOTE');
  expect(channelEnd).toBeGreaterThan(-1);
  expect(ownerStart).toBeGreaterThan(channelEnd);
  expect(rebuilt!.prompt.slice(ownerStart)).toContain(historical.body);
  expect(rebuilt!.prompt.slice(ownerStart)).toContain(pending.body);
  expect(store.listChangeNotes(change.id)).toEqual([
    expect.objectContaining({ id: historical.id, attemptId: fresh.attemptId, deliveredAt: expect.any(String) }),
    expect.objectContaining({ id: pending.id, attemptId: rebuilt!.attemptId, deliveredAt: expect.any(String) }),
  ]);
  expect(store.listEvents(ws.id).filter(e => String(e.message).includes('entregada (turno'))).toHaveLength(2);
});

test('apply-report recupera sin reservar ni entregar una nota nueva', async () => {
  const { change, run, recover } = setup();
  const backend = fakeLive([{ reports: [DONE] }]);
  await expect(run(backend, p => { if (p === 'report-recorded') throw new CrashInjected(p); })).rejects.toThrow(CrashInjected);
  const note = store.addChangeNote(change.id, 'Nota tras un report durable');
  recover();
  expect((await run(backend)).status).toBe('completed');
  expect(backend.turns).toHaveLength(1);
  expect(store.listChangeNotes(change.id)).toEqual([note]);
});

test('un turno abortado no confirma la nota reservada (H3)', async () => {
  const { change, runAbortable } = setup();
  const note = store.addChangeNote(change.id, 'Nota de un turno abortado');
  const abortController = new AbortController();
  const backend = fakeLive([{ reports: [DONE], before: () => abortController.abort() }]);
  await runAbortable(backend, abortController);
  expect(backend.turns[0]!.prompt).toContain(note.body);
  expect(store.listChangeNotes(change.id)[0]).toMatchObject({ attemptId: backend.turns[0]!.attemptId, deliveredAt: null });
});

test('si falla la reserva no queda sesión marcada ni se gasta una generación (H1)', async () => {
  const { adm, run } = setup();
  const backend = fakeLive([{ reports: [DONE] }]);
  store.reserveNotes = () => { throw new Error('contención sostenida'); };
  expect((await run(backend)).status).toBe('pending');
  expect(backend.turns).toHaveLength(0);
  expect(adm.db.query('SELECT COUNT(*) AS n FROM adm_sessions WHERE launched_at IS NOT NULL').get()).toEqual({ n: 0 });
  expect(adm.db.query('SELECT COUNT(*) AS n FROM adm_turns').get()).toEqual({ n: 0 });
});

const file = (text: string) => ({ name: 'datos.txt', bytes: new TextEncoder().encode(text) });

test('reconstrucción: solo bytes de la reserva, cuerpos entregados y ninguna nota posterior al snapshot', async () => {
  const { change, run, reply } = setup(true);
  const historical = store.addChangeNote(change.id, 'Cuerpo histórico', file('PRIMER-ARCHIVO'));
  const backend = fakeLive([{ reports: [ASK] }, { reports: [DONE] }]);
  const waiting = await run(backend);
  expect(backend.turns[0]!.prompt).toContain('PRIMER-ARCHIVO');
  expect(store.listChangeNotes(change.id)[0]).toMatchObject({ id: historical.id, deliveredAt: expect.any(String) });
  const pending = store.addChangeNote(change.id, 'Cuerpo pendiente', file('SEGUNDO-ARCHIVO'));
  reply(waiting.questionId!);
  backend.known.clear();
  let added = false;
  expect((await run(backend, point => {
    if (point === 'session-written' && backend.turns.length === 2 && !added) {
      added = true;
      store.addChangeNote(change.id, 'LLEGÓ DESPUÉS DE RESERVAR', file('ARCHIVO-TARDÍO'));
    }
  })).status).toBe('completed');
  const rebuilt = backend.turns[2]!.prompt;
  expect(rebuilt).toContain(historical.body);
  expect(rebuilt).not.toContain('PRIMER-ARCHIVO');
  expect(rebuilt.split('SEGUNDO-ARCHIVO')).toHaveLength(2);
  expect(rebuilt.split(pending.body)).toHaveLength(2);
  expect(rebuilt).not.toContain('LLEGÓ DESPUÉS DE RESERVAR');
  expect(rebuilt).not.toContain('ARCHIVO-TARDÍO');
  expect(store.listChangeNotes(change.id).map(n => n.deliveredAt !== null)).toEqual([true, true, false]);
});

test('un prompt grande aplaza el adjunto y deduplica el motivo hasta que cambia la condición', async () => {
  const { change, ws, run, reply } = setup(true);
  const txt = 'ü'.repeat(32768);
  store.db.query('UPDATE workstreams SET goal = ? WHERE id = ?').run('é'.repeat(65536), ws.id);
  const pending = store.addChangeNote(change.id, 'ARCHIVO PENDIENTE', file(txt));
  const plain = store.addChangeNote(change.id, 'TEXTO QUE SÍ VIAJA');
  const backend = fakeLive([{ reports: [ASK] }, { reports: [DONE] }]);
  const waiting = await run(backend);
  expect(backend.turns[0]!.prompt).toContain(plain.body);
  expect(backend.turns[0]!.prompt).not.toContain(pending.body);
  expect(store.listChangeNotes(change.id)[0]).toEqual(pending);
  const deferred = () => store.listEvents(ws.id).filter(e => e.severity === 'warning' && String(e.message).includes('Adjuntos pendientes'));
  expect(deferred()).toHaveLength(1);
  reply(waiting.questionId!);
  expect((await run(backend)).status).toBe('completed');
  expect(backend.turns[1]!.prompt).toContain(txt);
  expect(store.listChangeNotes(change.id).every(n => n.deliveredAt !== null)).toBe(true);
  expect(deferred()).toHaveLength(1);
});

test('un turn vivo abortado con archivo queda pendiente sin confirmación durable', async () => {
  const { change, runAbortable } = setup(true);
  const n = store.addChangeNote(change.id, 'Nota abortada', file('ARCHIVO ABORTADO'));
  const controller = new AbortController();
  const backend = fakeLive([{ reports: [DONE], before: () => controller.abort() }]);
  await runAbortable(backend, controller);
  expect(backend.turns[0]!.prompt).toContain('ARCHIVO ABORTADO');
  expect(store.listChangeNotes(change.id)[0]).toMatchObject({ id: n.id, attemptId: backend.turns[0]!.attemptId, deliveredAt: null });
});

test('reconstruir sin confinamiento tampoco incluye el cuerpo pendiente de un adjunto inelegible', async () => {
  const { change, run, reply } = setup();
  const backend = fakeLive([{ reports: [ASK] }, { reports: [DONE] }]);
  const waiting = await run(backend);
  const pending = store.addChangeNote(change.id, 'CUERPO INELEGIBLE', file('ARCHIVO INELEGIBLE'));
  const legacy = store.addChangeNote(change.id, 'TEXTO SIN ARCHIVO');
  reply(waiting.questionId!);
  backend.known.clear();
  expect((await run(backend)).status).toBe('completed');
  const rebuilt = backend.turns[2]!.prompt;
  expect(rebuilt.split(legacy.body)).toHaveLength(2);
  expect(rebuilt).not.toContain(pending.body);
  expect(rebuilt).not.toContain('ARCHIVO INELEGIBLE');
  expect(store.listChangeNotes(change.id)[0]).toEqual(pending);
  const warnings = store.listEvents(store.getChange(change.id).workstreamId).filter(e => String(e.message).startsWith('Adjuntos pendientes:'));
  expect(warnings).toHaveLength(1); // El intento de reanudación y el reconstruido vieron la misma condición.
});

test('una caída antes de lanzar no consume el archivo reservado y el siguiente intento lo confirma', async () => {
  const { change, ws, run, recover } = setup(true);
  const n = store.addChangeNote(change.id, 'Nota de caída', file('ARCHIVO HUÉRFANO'));
  const backend = fakeLive([{ reports: [DONE] }]);
  await expect(run(backend, point => { if (point === 'session-launched') throw new CrashInjected(point); })).rejects.toThrow(CrashInjected);
  const orphan = store.listChangeNotes(change.id)[0];
  expect(orphan).toMatchObject({ id: n.id, attemptId: expect.any(String), deliveredAt: null });
  expect(backend.turns).toHaveLength(0);
  recover();
  expect((await run(backend)).status).toBe('completed');
  const used = backend.turns.at(-1)!;
  expect(used.prompt).toContain('ARCHIVO HUÉRFANO');
  expect(used.attemptId).not.toBe(orphan!.attemptId);
  expect(store.listChangeNotes(change.id)[0]).toMatchObject({ attemptId: used.attemptId, deliveredAt: expect.any(String) });
  expect(store.listEvents(ws.id).filter(e => String(e.message).includes('entregada (turno'))).toHaveLength(1);
});

// T96-H6: cada condición que deja pendiente el archivo en un turno vivo.
test('un turno vivo con salida distinta de cero no confirma el archivo aunque reporte done', async () => {
  const { change, run } = setup(true);
  store.addChangeNote(change.id, 'cuerpo', file('ARCHIVO SALIDA'));
  const backend = fakeLive([{ reports: [DONE], exitCode: 1 }]);
  await run(backend);
  expect(backend.turns[0]!.prompt).toContain('ARCHIVO SALIDA');
  expect(store.listChangeNotes(change.id)[0]!.deliveredAt).toBeNull();
});

test.each([
  ['entrada por argv', { promptStdin: false }, true],
  ['adaptador no confinable', { confinable: false }, true],
  ['sin confinamiento', {}, false],
] as const)('un turno vivo con %s conserva pendiente el archivo y entrega el texto', async (_name, over, confine) => {
  const { change, run } = setup(confine);
  const pending = store.addChangeNote(change.id, 'CUERPO CON ARCHIVO', file('ARCHIVO NO APTO'));
  const plain = store.addChangeNote(change.id, 'TEXTO QUE VIAJA');
  const backend = fakeLive([{ reports: [DONE] }], over);
  await run(backend);
  expect(backend.turns[0]!.prompt).toContain(plain.body);
  expect(backend.turns[0]!.prompt).not.toContain('ARCHIVO NO APTO');
  expect(backend.turns[0]!.prompt).not.toContain(pending.body);
  expect(store.listChangeNotes(change.id)[0]).toEqual(pending);
});

test('un turno vivo cuyo estado cae en state/live conserva pendiente el archivo', async () => {
  const nested = join(dir, 'state', 'live', 's');
  mkdirSync(nested, { recursive: true, mode: 0o700 });
  store.close();
  store = new Store(join(nested, 'fab.db'), { clock: () => new Date('2026-01-01T00:00:00Z') });
  const { change, run } = setup(true);
  const pending = store.addChangeNote(change.id, 'CUERPO', file('ARCHIVO EN LIVE'));
  const backend = fakeLive([{ reports: [DONE] }]);
  await run(backend);
  expect(backend.turns[0]!.prompt).not.toContain('ARCHIVO EN LIVE');
  expect(store.listChangeNotes(change.id)[0]).toEqual(pending);
});
