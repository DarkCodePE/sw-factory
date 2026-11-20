import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Store } from '../src/store.ts';
import { reserveTurnPrompt } from '../src/note-delivery.ts';
import { assertNoteAttachmentMounts, assertPrivateNoteDatabase } from '../src/note-attachments.ts';

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

function privateNotes(run: (writer: Store, id: string, cwd: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'fab-adjuntos-'));
  const cwd = join(dir, 'repo'), state = join(dir, 'state');
  mkdirSync(cwd);
  mkdirSync(state, { mode: 0o700 });
  expect(Bun.spawnSync(['git', 'init', '-q', cwd]).exitCode).toBe(0);
  const writer = new Store(join(state, 'fabrica.db'), { clock });
  try {
    const ws = writer.createWorkstream({ slug: 'archivos', goal: 'g', repo: cwd, requireChangeApproval: false });
    run(writer, writer.createChange(ws.id, 't', 'd').id, cwd);
  } finally {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const attachment = (name = 'datos.txt', bytes = new TextEncoder().encode('<b>MARCADOR PRIVADO</b>')) => ({ name, bytes });

test('adjunto: metadatos sin BLOB, reserva elegible por intento y confirmación única', () => privateNotes((writer, id, cwd) => {
  const file = attachment();
  const n = writer.addChangeNote(id, 'consulta', file);
  expect(n.attachment).toEqual({ name: file.name, size: file.bytes.length });
  expect(writer.listChangeNotes(id)).toEqual([n]);
  const a = writer.listActivities({ changeId: id })[0]!;
  expect(writer.reserveNotes(id, a.id, 'omitido')).toEqual([]);
  expect(writer.confirmNotes('omitido')).toBe(0);
  const target = { cwd };
  expect(writer.reserveNotes(id, a.id, 'huérfano', target)[0]?.attachmentBytes).toEqual(file.bytes);
  expect(writer.reserveNotes(id, a.id, 'nuevo', target)[0]?.attachmentBytes).toEqual(file.bytes);
  expect(writer.confirmNotes('huérfano')).toBe(0);
  expect(writer.confirmNotes('nuevo')).toBe(1);
  expect(writer.confirmNotes('nuevo')).toBe(0);
  expect(writer.reserveNotes(id, a.id, 'otro', target)).toEqual([]);
  const events = JSON.stringify(writer.listEvents(a.workstreamId, -1, id));
  expect(events).not.toContain(file.name);
  expect(events).not.toContain('MARCADOR PRIVADO');
}));

test('adjunto: validación de nombre, tamaño original, UTF-8 y controles en el Store', () => privateNotes((writer, id) => {
  for (const name of ['../x.txt', 'a..b.txt', 'a/b.txt', 'a\\b.txt', 'a\x00.txt', 'a.txt ', 'a.svg', 'a\n.txt']) {
    expect(() => writer.addChangeNote(id, 'cuerpo', attachment(name))).toThrow(/nombre/);
  }
  for (const bytes of [new Uint8Array(), new Uint8Array(65537), Uint8Array.of(0xC0, 0x80), Uint8Array.of(0), Uint8Array.of(127), Uint8Array.of(0xc2, 0x85)]) {
    expect(() => writer.addChangeNote(id, 'cuerpo', attachment('a.txt', bytes))).toThrow(/adjunto/);
  }
  expect(() => writer.addChangeNote(id, 'cuerpo', { name: 'a.txt' } as ReturnType<typeof attachment>)).toThrow(/adjunto/);
  expect(writer.listChangeNotes(id)).toEqual([]);
  expect(writer.addChangeNote(id, 'cuerpo', attachment('a.JSON', Uint8Array.of(9, 10, 13))).attachment?.size).toBe(3);
}));

test('adjunto: cuotas incluyen reservas, son visibles a otro escritor y alta con evento es atómica', () => privateNotes((writer, id, cwd) => {
  const a = writer.listActivities({ changeId: id })[0]!;
  const second = new Store(writer.dbPath);
  const max = attachment('64k.txt', new Uint8Array(65536).fill(65));
  try {
    for (let i = 0; i < 16; i++) {
      writer.addChangeNote(id, 'cuerpo', max);
      writer.reserveNotes(id, a.id, 'intento-' + i, { cwd });
      expect(() => second.addChangeNote(id, 'cuerpo', attachment())).toThrow(/pendientes/);
      expect(second.confirmNotes('intento-' + i)).toBe(1);
    }
    expect(() => second.addChangeNote(id, 'cuerpo', attachment())).toThrow(/histórico/);
    const other = writer.createChange(a.workstreamId, 'otro', 'd');
    writer.db.exec("CREATE TRIGGER adjunto_evento BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'evento rechazado'); END");
    expect(() => second.addChangeNote(other.id, 'cuerpo', attachment())).toThrow('evento rechazado');
    expect(writer.listChangeNotes(other.id)).toEqual([]);
  } finally { second.close(); }
}));

test('adjunto: una base con notas anteriores se proyecta antes y después de migrar', () => privateNotes((writer, id) => {
  const old = writer.addChangeNote(id, 'antigua');
  writer.db.exec('ALTER TABLE change_notes DROP COLUMN attachment_name; ALTER TABLE change_notes DROP COLUMN attachment_bytes');
  const reader = new Store(writer.dbPath, { readonly: true });
  try { expect(reader.listChangeNotes(id)).toEqual([old]); }
  finally { reader.close(); }
  const migrated = new Store(writer.dbPath);
  try {
    expect(migrated.listChangeNotes(id)).toEqual([old]);
    expect(migrated.addChangeNote(id, 'nueva', attachment()).attachment?.name).toBe('datos.txt');
  } finally { migrated.close(); }
}));

test('adjunto: reserva revalida permisos, destino y montaje persistente sin confirmar la nota omitida', () => privateNotes((writer, id, cwd) => {
  writer.addChangeNote(id, 'archivo', attachment());
  writer.addChangeNote(id, 'solo texto');
  const a = writer.listActivities({ changeId: id })[0]!;
  const second = new Store(writer.dbPath);
  try {
    second.createRunner({ name: 'remoto', kind: 'ssh', target: 'host' });
    second.createRunner({ name: 'local', kind: 'local' });
    second.setWorkstreamRunner(a.workstreamId, 'remoto');
    expect(() => writer.addChangeNote(id, 'nuevo', attachment())).toThrow(/remoto/);
    expect(writer.reserveNotes(id, a.id, 'remoto', { cwd }).map(note => note.body)).toEqual(['solo texto']);
    expect(writer.confirmNotes('remoto')).toBe(1);
    second.setWorkstreamRunner(a.workstreamId, 'local');
    expect(writer.reserveNotes(id, a.id, 'montaje', { cwd, persistentMounts: [writer.stateDir!] })).toEqual([]);
    expect(writer.confirmNotes('montaje')).toBe(0);
    chmodSync(writer.stateDir!, 0o755);
    expect(writer.reserveNotes(id, a.id, 'publico', { cwd })).toEqual([]);
    chmodSync(writer.stateDir!, 0o700);
    expect(writer.reserveNotes(id, a.id, 'local', { cwd })[0]?.attachment?.name).toBe('datos.txt');
  } finally { second.close(); }
}));

test('adjunto: la comprobación de estado es de lectura y rechaza enlaces y estado dentro de Git', () => privateNotes((writer, _id, cwd) => {
  const parent = dirname(cwd), victim = join(parent, 'victima');
  writeFileSync(victim, 'intacto', { mode: 0o600 });
  chmodSync(victim, 0o600); // sin depender de la umask: así solo nlink o el enlace pueden rechazar
  const alias = join(parent, 'alias');
  symlinkSync(writer.stateDir!, alias);
  expect(() => assertPrivateNoteDatabase(join(alias, 'fabrica.db'))).toThrow(/estado privado/);
  for (const ext of ['', '-wal', '-shm', '-journal']) {
    const another = join(writer.stateDir!, 'otra.db');
    if (ext) writeFileSync(another, 'base sintética', { mode: 0o600 });
    const link = another + ext;
    for (const create of [symlinkSync, linkSync]) {
      create(victim, link);
      expect(() => assertPrivateNoteDatabase(another)).toThrow(/estado privado/);
      unlinkSync(link);
    }
    if (ext) unlinkSync(another);
  }
  for (const root of [cwd, join(cwd, '.git')]) {
    const privateDir = join(root, 'privado');
    mkdirSync(privateDir, { mode: 0o700 });
    const db = join(privateDir, 'fabrica.db');
    writeFileSync(db, 'base sintética');
    expect(() => assertNoteAttachmentMounts(db, [cwd])).toThrow(/montajes escribibles/);
    expect(readdirSync(privateDir)).toEqual(['fabrica.db']);
  }
  expect(readFileSync(victim, 'utf8')).toBe('intacto');
}));

test('T96-H2: el repo ausente de otro workstream no bloquea los adjuntos, y uno vivo dentro del estado sí', () => privateNotes((writer, id, cwd) => {
  const gone = join(dirname(cwd), 'otro-repo');
  mkdirSync(gone);
  expect(Bun.spawnSync(['git', 'init', '-q', gone]).exitCode).toBe(0);
  writer.createWorkstream({ slug: 'otro', goal: 'g', repo: gone });
  expect(writer.addChangeNote(id, 'con otro repo vivo', attachment()).attachment?.name).toBe('datos.txt');
  rmSync(gone, { recursive: true });
  expect(writer.addChangeNote(id, 'con otro repo ausente', attachment()).attachment?.name).toBe('datos.txt');
  const a = writer.listActivities({ changeId: id })[0]!;
  expect(writer.reserveNotes(id, a.id, 'intento', { cwd }).map(n => n.attachmentBytes !== undefined)).toEqual([true, true]);
}));

test('T96-H7: Git no corre dentro de la transacción del alta ni de la reserva', () => privateNotes((writer, id, cwd) => {
  const spawn = Bun.spawnSync, inTx: boolean[] = [];
  Bun.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => { inTx.push(writer.db.inTransaction); return spawn(...args); }) as typeof Bun.spawnSync;
  try {
    writer.addChangeNote(id, 'con archivo', attachment());
    const a = writer.listActivities({ changeId: id })[0]!;
    // El turno vivo envuelve la reserva en su propia transacción: el inventario se prepara antes.
    const route = { cwd, confine: true, adapter: 'claude', promptStdin: true };
    const out = reserveTurnPrompt(writer, a, 'intento', route, notes => notes.map(n => n.body).join());
    expect(out.hasAttachments).toBe(true);
    expect(inTx.length).toBeGreaterThan(2);
  } finally { Bun.spawnSync = spawn; }
  expect(inTx.filter(Boolean)).toEqual([]);
}));

const reasons = (writer: Store, id: string) => writer.listEvents(writer.getChange(id).workstreamId, -1, id).map(e => String(e.message));

test('T96-H6: la reserva solo lleva adjuntos a investigación e implementación sin validador', () => privateNotes((writer, id, cwd) => {
  writer.addChangeNote(id, 'texto');
  writer.addChangeNote(id, 'archivo', attachment());
  const a = writer.listActivities({ changeId: id })[0]!;
  const set = (kind: string, validator: string | null) =>
    writer.db.query('UPDATE activities SET kind = ?, validator = ? WHERE id = ?').run(kind, validator, a.id);
  const delivered = (attempt: string) => writer.reserveNotes(id, a.id, attempt, { cwd }).map(n => n.attachmentBytes !== undefined);
  set('change_review', null);
  expect(delivered('revision')).toEqual([false]);
  set('investigation', 'verifier');
  expect(delivered('validador')).toEqual([false]);
  set('implementation', null);
  expect(delivered('implementa')).toEqual([false, true]);
}));

test('T96-H6: la reserva revalida el BLOB almacenado y deja la nota con archivo pendiente', () => privateNotes((writer, id, cwd) => {
  const n = writer.addChangeNote(id, 'archivo', attachment());
  writer.addChangeNote(id, 'texto');
  const a = writer.listActivities({ changeId: id })[0]!;
  for (const bytes of [Uint8Array.of(0, 1, 2), Uint8Array.of(0xff, 0xfe)]) {
    writer.db.query('UPDATE change_notes SET attachment_bytes = ? WHERE id = ?').run(bytes, n.id);
    expect(writer.reserveNotes(id, a.id, 'x' + bytes.length, { cwd }).map(note => note.body)).toEqual(['texto']);
    expect(writer.listChangeNotes(id).find(note => note.id === n.id)).toMatchObject({ deliveredAt: null, activityId: null });
  }
  expect(writer.noteAttachmentWait(id)).toContain('validación');
}));

test('T96-H6: la reserva anuncia que los adjuntos vuelven a ser aptos una sola vez', () => privateNotes((writer, id, cwd) => {
  writer.addChangeNote(id, 'archivo', attachment());
  const a = writer.listActivities({ changeId: id })[0]!;
  expect(writer.reserveNotes(id, a.id, 'sin-destino')).toEqual([]);
  expect(reasons(writer, id).filter(m => m.startsWith('Adjuntos pendientes'))).toHaveLength(1);
  expect(writer.reserveNotes(id, a.id, 'apto', { cwd })).toHaveLength(1);
  expect(reasons(writer, id).filter(m => m === 'Adjuntos aptos para este turno.')).toHaveLength(1);
}));

test('T96-H6: el estado dentro de un worktree enlazado, del cwd, de state/live o de state/worktrees se rechaza', () => privateNotes((writer, _id, cwd) => {
  const base = dirname(cwd);
  expect(Bun.spawnSync(['git', '-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'i']).exitCode).toBe(0);
  const linked = join(base, 'enlazado');
  expect(Bun.spawnSync(['git', '-C', cwd, 'worktree', 'add', '-q', linked, '-b', 'rama-enlazada']).exitCode).toBe(0);
  const inside = (root: string) => {
    const db = join(root, 'privado', 'fabrica.db');
    mkdirSync(dirname(db), { mode: 0o700 });
    writeFileSync(db, 'base sintética', { mode: 0o600 });
    return db;
  };
  // El repo principal está limpio: solo el worktree enlazado contiene el estado.
  expect(() => assertNoteAttachmentMounts(inside(linked), [cwd])).toThrow(/montajes escribibles/);
  // Sin repos configurados, el cwd del turno basta para rechazarlo.
  const turn = join(base, 'turno');
  mkdirSync(turn);
  expect(Bun.spawnSync(['git', 'init', '-q', turn]).exitCode).toBe(0);
  expect(() => assertNoteAttachmentMounts(inside(turn), [], { cwd: turn })).toThrow(/montajes escribibles/);
  // state/live y state/worktrees que resuelven a un directorio que contiene el estado.
  for (const name of ['live', 'worktrees']) {
    const state = join(base, 'estado-' + name);
    mkdirSync(state, { mode: 0o700 });
    writeFileSync(join(state, 'fabrica.db'), 'base sintética', { mode: 0o600 });
    expect(() => assertNoteAttachmentMounts(join(state, 'fabrica.db'), [cwd])).not.toThrow();
    symlinkSync(base, join(state, name));
    expect(() => assertNoteAttachmentMounts(join(state, 'fabrica.db'), [cwd])).toThrow(/montajes escribibles/);
  }
}));

test('T96-H6: si git worktree list falla, el inventario falla cerrado', () => privateNotes((_writer, _id, cwd) => {
  const db = join(dirname(cwd), 'estado-git', 'fabrica.db');
  mkdirSync(dirname(db), { mode: 0o700 });
  writeFileSync(db, 'base sintética', { mode: 0o600 });
  expect(() => assertNoteAttachmentMounts(db, [cwd])).not.toThrow();
  const spawn = Bun.spawnSync;
  Bun.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => {
    const cmd = args[0] as string[] | { cmd: string[] };
    const argv = Array.isArray(cmd) ? cmd : cmd.cmd;
    return argv.includes('worktree') ? { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) } as ReturnType<typeof spawn> : spawn(...args);
  }) as typeof Bun.spawnSync;
  try { expect(() => assertNoteAttachmentMounts(db, [cwd])).toThrow(/Git/); }
  finally { Bun.spawnSync = spawn; }
}));

test('T96-H6: una base en memoria nunca es un estado privado', () => {
  expect(() => assertPrivateNoteDatabase(':memory:')).toThrow(/estado privado/);
});

test('T96-H6: la entrega solo lleva archivos con adaptador confinable, entrada por stdin y confinamiento', () => privateNotes((writer, id, cwd) => {
  writer.addChangeNote(id, 'archivo', attachment());
  const a = writer.listActivities({ changeId: id })[0]!;
  const route = { cwd, confine: true, adapter: 'claude', promptStdin: true };
  const build = (notes: { body: string }[]) => notes.map(n => n.body).join();
  const sent = (over: Partial<typeof route>, attempt: string) => reserveTurnPrompt(writer, a, attempt, { ...route, ...over }, build).hasAttachments;
  expect([sent({ adapter: 'sin-confinar' }, 'a'), sent({ promptStdin: false }, 'b'), sent({ confine: false }, 'c')]).toEqual([false, false, false]);
  expect(sent({}, 'd')).toBe(true);
}));

test('T96-H9: un repo que ya no es repo Git, o que es un fichero, no bloquea los adjuntos de los demás workstreams', () => privateNotes((writer, id, cwd) => {
  const plain = join(dirname(cwd), 'sin-git'); mkdirSync(plain);
  const file = join(dirname(cwd), 'fichero'); writeFileSync(file, 'x');
  writer.createWorkstream({ slug: 'sin-git', goal: 'g', repo: plain });
  writer.createWorkstream({ slug: 'colgado', goal: 'g', repo: join(file, 'repo') }); // cuelga de un fichero: ENOTDIR
  expect(writer.addChangeNote(id, 'con repos raros', attachment()).attachment?.name).toBe('datos.txt');
}));

test('T96-H10: el aviso de ancestro nombra el directorio que falla y el de ficheros habla de permisos', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fab-anc-'));
  try {
    const loose = join(dir, 'suelto'); mkdirSync(loose); chmodSync(loose, 0o775); // escribible por el grupo: no es privado
    const state = join(loose, 'estado'); mkdirSync(state, { mode: 0o700 });
    expect(() => assertPrivateNoteDatabase(join(state, 'fabrica.db'))).toThrow(`Directorio: ${loose}`);
    writeFileSync(join(state, 'fabrica.db'), 'x', { mode: 0o664 });
    chmodSync(loose, 0o700);
    expect(() => assertPrivateNoteDatabase(join(state, 'fabrica.db'))).toThrow('chmod 600');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('T96-H12: el alta directa en el Store rechaza un estado 0755, sin depender de la comprobación previa de la web', () => privateNotes((writer, id) => {
  chmodSync(dirname(writer.dbPath), 0o755); // S03: quitar la comprobación del alta la dejaba pasar
  expect(() => writer.addChangeNote(id, 'con archivo', attachment())).toThrow('estado privado');
  expect(writer.addChangeNote(id, 'solo texto').attachment).toBeUndefined();
  chmodSync(dirname(writer.dbPath), 0o700);
  expect(writer.addChangeNote(id, 'ya privado', attachment()).attachment?.name).toBe('datos.txt');
}));

test('T96-H12: si Git falla al inventariar, el alta falla cerrada y no acepta un inventario vacío', () => privateNotes((writer, id) => {
  const spawn = Bun.spawnSync;
  Bun.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => {
    const argv = args[0] as string[];
    return argv.includes('worktree') && argv.includes('list') ? { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('boom') } as never : spawn(...args);
  }) as typeof Bun.spawnSync;
  try { expect(() => writer.addChangeNote(id, 'con archivo', attachment())).toThrow('No se pudo inventariar'); } // S06: devolver [] fuera aceptaba el alta
  finally { Bun.spawnSync = spawn; }
  expect(writer.listChangeNotes(id)).toHaveLength(0);
}));
