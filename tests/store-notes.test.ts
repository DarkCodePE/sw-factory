import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

const at = '2026-11-19T18:00:00.000Z';
const clock = () => new Date(at);
let store: Store;
let workstreamId: string;
let changeId: string;
let actorBefore: string | undefined;

beforeEach(() => {
  actorBefore = process.env.FAB_ACTOR;
  process.env.FAB_ACTOR = 'dueno';
  store = new Store(':memory:', { clock });
  workstreamId = store.createWorkstream({ slug: 'notas', goal: 'g', repo: '/r', requireChangeApproval: false }).id;
  store.setWorkstreamState(workstreamId, 'active');
  changeId = store.createChange(workstreamId, 't', 'd').id;
});

afterEach(() => {
  if (actorBefore === undefined) delete process.env.FAB_ACTOR;
  else process.env.FAB_ACTOR = actorBefore;
  store.close();
});

test('registra una nota sin su cuerpo en eventos y sin mover la activity en espera', () => {
  const running = store.claimActivity(workstreamId, 'worker')!;
  const waiting = store.awaitHuman(running.id, 'worker', { questionId: 'q', waitUntil: '2026-11-20T18:00:00.000Z' });
  const change = store.getChange(changeId);
  delete process.env.FAB_ACTOR;
  const body = '  instrucción privada ñ  ';
  const note = store.addChangeNote(changeId, body);
  expect(note).toEqual({
    id: expect.any(String), changeId, body, actor: userInfo().username, createdAt: at,
    activityId: null, attemptId: null, deliveredAt: null,
  });
  expect(store.listChangeNotes(changeId)).toEqual([note]);
  expect(store.getChange(changeId)).toEqual(change);
  expect(store.getActivity(waiting.id)).toEqual(waiting);
  const [event] = store.listEvents(workstreamId, 1, changeId);
  expect(event).toMatchObject({
    severity: 'info', actor: userInfo().username,
    message: `nota del dueño registrada (${note.id.slice(0, 8)}, ${Buffer.byteLength(body)} bytes)`,
  });
});

test.each(['completed', 'canceled', 'failed', 'declined', 'blocked', 'quarantined'])(
  'rechaza la nota en un change %s sin insertar fila ni evento',
  status => {
    store.db.query('UPDATE changes SET status = ? WHERE id = ?').run(status, changeId);
    const before = store.listEvents(workstreamId, -1, changeId);
    expect(() => store.addChangeNote(changeId, 'nota')).toThrow(expect.objectContaining({ code: 'invalid_transition' }));
    expect(store.listChangeNotes(changeId)).toEqual([]);
    expect(store.listEvents(workstreamId, -1, changeId)).toEqual(before);
  },
);

test('valida el cuerpo y mide el límite en bytes UTF-8', () => {
  const max = 'é'.repeat(4096);
  for (const body of ['', ' \t\n', max + 'x']) {
    expect(() => store.addChangeNote(changeId, body)).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  }
  expect(store.listChangeNotes(changeId)).toEqual([]);
  expect(store.addChangeNote(changeId, max).body).toBe(max);
});

test('el cupo cuenta notas reservadas y se libera al confirmar', () => {
  for (let i = 0; i < 20; i++) store.addChangeNote(changeId, `nota ${i}`);
  const activity = store.listActivities({ changeId })[0]!;
  expect(store.reserveNotes(changeId, activity.id, 'intento').map(note => note.body))
    .toEqual(Array.from({ length: 20 }, (_, i) => `nota ${i}`));
  expect(() => store.addChangeNote(changeId, 'exceso')).toThrow(expect.objectContaining({ code: 'limit_reached' }));
  expect(store.listChangeNotes(changeId)).toHaveLength(20);
  expect(store.confirmNotes('intento')).toBe(20);
  expect(store.addChangeNote(changeId, 'cabe').deliveredAt).toBeNull();
  expect(store.listChangeNotes(changeId)).toHaveLength(21);
});

test('reasigna la reserva, confirma una vez y conserva el autor y el estado de las activities', () => {
  const other = store.createChange(workstreamId, 'otro', 'd');
  const otherNote = store.addChangeNote(other.id, 'otro cuerpo');
  const activities = store.listActivities({ changeId });
  const activityId = activities[0]!.id;
  const first = store.addChangeNote(changeId, 'primera');
  process.env.FAB_ACTOR = 'web';
  const second = store.addChangeNote(changeId, 'segunda');
  const notes = [first, second];
  const reserved = (attemptId: string) => notes.map(note => ({ ...note, activityId, attemptId }));

  expect(store.reserveNotes(changeId, activityId, 'intento-primero')).toEqual(reserved('intento-primero'));
  expect(store.reserveNotes(changeId, activityId, 'intento-segundo')).toEqual(reserved('intento-segundo'));
  expect(store.listChangeNotes(changeId)).toEqual(reserved('intento-segundo'));
  expect(store.listChangeNotes(other.id)).toEqual([otherNote]);
  const eventsBefore = store.listEvents(workstreamId, -1);
  process.env.FAB_ACTOR = 'pool';
  expect(store.confirmNotes('intento-primero')).toBe(0);
  expect(store.confirmNotes('intento-segundo')).toBe(2);
  expect(store.confirmNotes('intento-segundo')).toBe(0);
  expect(store.reserveNotes(changeId, activityId, 'intento-tercero')).toEqual([]);
  expect(store.listChangeNotes(changeId)).toEqual(reserved('intento-segundo').map(note => ({ ...note, deliveredAt: at })));
  expect(store.listActivities({ changeId })).toEqual(activities);
  const events = store.listEvents(workstreamId, -1).slice(eventsBefore.length);
  expect(events).toHaveLength(2);
  for (const note of notes) {
    expect(events).toContainEqual(expect.objectContaining({
      change_id: changeId, severity: 'info',
      message: `nota ${note.id.slice(0, 8)} de ${note.actor} entregada (turno intento-)`,
    }));
  }
});

test('una escritura de evento fallida revierte el alta o la confirmación de la nota', () => {
  store.db.exec("CREATE TRIGGER rechazar_evento BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'evento rechazado'); END");
  expect(() => store.addChangeNote(changeId, 'nota')).toThrow('evento rechazado');
  expect(store.listChangeNotes(changeId)).toEqual([]);

  store.db.exec('DROP TRIGGER rechazar_evento');
  store.addChangeNote(changeId, 'nota');
  const reserved = store.reserveNotes(changeId, store.listActivities({ changeId })[0]!.id, 'intento');
  const events = store.listEvents(workstreamId, -1);
  store.db.exec("CREATE TRIGGER rechazar_evento BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'evento rechazado'); END");
  expect(() => store.confirmNotes('intento')).toThrow('evento rechazado');
  expect(store.listChangeNotes(changeId)).toEqual(reserved);
  expect(store.listEvents(workstreamId, -1)).toEqual(events);
});

test('H2: borrar un change borra sus notas, no las de otro', () => {
  const other = store.createChange(workstreamId, 'otro', 'd').id;
  store.addChangeNote(changeId, 'mía');
  store.addChangeNote(other, 'ajena');
  store.db.query('DELETE FROM changes WHERE id = ?').run(changeId);
  expect(store.listChangeNotes(changeId)).toEqual([]);
  expect(store.listChangeNotes(other)).toHaveLength(1);
});

test('H2: si reserveNotes falla a mitad, la reserva se revierte entera', () => {
  const activityId = store.listActivities({ changeId })[0]!.id;
  store.addChangeNote(changeId, 'nota');
  const query = store.db.query.bind(store.db);
  store.db.query = sql => {
    if (sql.includes('SELECT * FROM change_notes')) throw new Error('fallo tras la reserva');
    return query(sql);
  };
  try {
    expect(() => store.reserveNotes(changeId, activityId, 'intento')).toThrow('fallo tras la reserva');
  } finally {
    store.db.query = query;
  }
  expect(store.listChangeNotes(changeId)).toEqual([expect.objectContaining({ activityId: null, attemptId: null })]);
});

test('una base anterior admite la lectura sin migrar y gana la tabla al abrirla en escritura', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fab-store-notes-'));
  const path = join(dir, 'fabrica.db');
  try {
    const legacy = new Store(path, { clock });
    const ws = legacy.createWorkstream({ slug: 'anterior', goal: 'g', repo: '/r' });
    const change = legacy.createChange(ws.id, 'change anterior', 'd');
    legacy.db.exec('DROP TABLE IF EXISTS change_notes');
    legacy.close();

    const reader = new Store(path, { readonly: true });
    const before = readFileSync(path);
    try {
      expect(reader.listChangeNotes(change.id)).toEqual([]);
      expect(reader.db.query("SELECT name FROM sqlite_schema WHERE name = 'change_notes'").get()).toBeNull();
    } finally { reader.close(); }
    expect(readFileSync(path)).toEqual(before);

    const reopened = new Store(path, { clock });
    try {
      expect(reopened.getChange(change.id)).toEqual(change);
      expect(reopened.listChangeNotes(change.id)).toEqual([]);
      expect(reopened.addChangeNote(change.id, 'nueva').body).toBe('nueva');
    } finally { reopened.close(); }

    const raw = new Database(path, { readonly: true });
    try { expect(raw.query("SELECT name FROM sqlite_schema WHERE name = 'idx_change_notes_pending'").get()).not.toBeNull(); }
    finally { raw.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
