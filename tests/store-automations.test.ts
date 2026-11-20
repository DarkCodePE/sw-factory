import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automationRevision, Store } from '../src/store.ts';

const initial = '2026-11-19T07:00:00.000Z';
const due = '2026-11-19T07:30:00.000Z';
const template = { workstream: 'demo', name: 'diaria', cron: '30 7 * * *', title: 'Resumen', body: '  Plantilla ñ {{fecha}}\n' };
let now: string;
const clock = () => new Date(now);
let store: Store;
let workstreamId: string;

function activeWorkstream(db: Store, slug: string): string {
  const ws = db.createWorkstream({ slug, goal: 'g', repo: '/repo' });
  return db.setWorkstreamState(ws.id, 'active').id;
}

beforeEach(() => {
  now = initial;
  store = new Store(':memory:', { clock });
  workstreamId = activeWorkstream(store, 'demo');
});

afterEach(() => store.close());

test('alta y disparo programado dejan solo una señal nueva con texto literal y fecha UTC', () => {
  const automation = store.createAutomation(template);
  expect(automation).toMatchObject({
    workstreamId, name: template.name, cron: template.cron, title: template.title, body: template.body,
    enabled: true, createdAt: initial, createdBy: expect.any(String),
    lastDueAt: null, lastResult: null, lastSignalId: null,
  });
  expect(store.listEvents(workstreamId, 1)[0]).toMatchObject({
    actor: automation.createdBy, message: 'automation diaria creada (30 7 * * *)',
  });
  expect(store.fireDueAutomations()).toEqual([]);
  // El tick llega el día 20 UTC, después del último vencimiento del día 19.
  now = '2026-11-19T16:05:00.000-08:00';
  const [result] = store.fireDueAutomations();
  expect(result).toEqual({ id: automation.id, result: 'created', signalId: expect.any(String) });
  expect(store.listSignals('demo')).toEqual([{
    id: result!.signalId!, workstreamId, source: 'automation:' + automation.id,
    title: 'Resumen (2026-11-19)', body: template.body, status: 'new', changeId: null,
    createdAt: '2026-11-20T00:05:00.000Z',
  }]);
  expect(store.listChanges(workstreamId)).toEqual([]);
  expect(store.listActivities({ workstream: workstreamId })).toEqual([]);
  expect(store.listAutomations('demo')[0]).toMatchObject({
    lastDueAt: due, lastResult: 'created', lastSignalId: result!.signalId,
  });
  expect(store.listEvents(workstreamId, 1)[0]!.message)
    .toBe(`automation diaria: señal ${result!.signalId!.slice(0, 8)} creada (vencía ${due})`);
});

test('los métodos de automation carecen de llamadas que creen trabajo', () => {
  const source = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8');
  const section = source.match(/\/\/ ---- automations[^]*?\/\/ ---- changes/)?.[0];
  expect(section).toBeDefined();
  expect(section).not.toMatch(/\b(?:triageSignal|createChange|insertActivity)\b/);
});

test('dos conexiones, 50 llamadas y reapertura procesan una vez el último vencimiento', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fab-automations-'));
  const path = join(dir, 'fabrica.db');
  let first: Store | undefined;
  let second: Store | undefined;
  try {
    first = new Store(path, { clock });
    const id = activeWorkstream(first, 'demo');
    first.createAutomation(template);
    second = new Store(path, { clock });
    now = due;
    const winner = first;
    const retry = second.withRetry.bind(second);
    const results: ReturnType<Store['fireDueAutomations']> = [];
    // La primera conexión procesa el vencimiento entre la lista de candidatos de la
    // segunda y su toma del lock. La segunda debe releer el vencimiento bajo el lock.
    const interleave = spyOn(second, 'withRetry').mockImplementationOnce(fn => {
      results.push(...winner.fireDueAutomations());
      return retry(fn);
    });
    try {
      results.push(...second.fireDueAutomations());
    } finally {
      interleave.mockRestore();
    }
    for (let i = 2; i < 50; i++) results.push(...(i % 2 ? first : second).fireDueAutomations());
    expect(results).toHaveLength(1);
    expect(results[0]!.result).toBe('created');
    expect(first.listSignals(id)).toHaveLength(1);
    first.ignoreSignal(results[0]!.signalId!);
    first.close();
    first = undefined;
    second.close();
    second = new Store(path, { clock });
    expect(second.fireDueAutomations()).toEqual([]);
    now = '2026-11-22T08:00:00.000Z';
    expect(second.fireDueAutomations()).toEqual([
      { id: results[0]!.id, result: 'created', signalId: expect.any(String) },
    ]);
    expect(second.listSignals(id).map(s => s.title)).toEqual(['Resumen (2026-11-19)', 'Resumen (2026-11-22)']);
    expect(second.listAutomations()[0]!.lastDueAt).toBe('2026-11-22T07:30:00.000Z');
    expect(second.fireDueAutomations()).toEqual([]);
  } finally {
    first?.close();
    second?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('una señal nueva bloquea el siguiente vencimiento y al ignorarla se libera', () => {
  const a = store.createAutomation(template);
  now = due;
  const [created] = store.fireDueAutomations();
  now = '2026-11-20T07:30:00.000Z';
  expect(store.fireDueAutomations()).toEqual([{ id: a.id, result: 'skipped_open' }]);
  expect(store.fireDueAutomations()).toEqual([]);
  expect(store.listAutomations()[0]).toMatchObject({
    lastDueAt: now, lastResult: 'skipped_open', lastSignalId: created!.signalId,
  });
  expect(store.listEvents(workstreamId, 1)[0]!.message).toContain('hay una señal o un change abierto');
  store.ignoreSignal(created!.signalId!);
  now = '2026-11-21T07:30:00.000Z';
  expect(store.fireDueAutomations()).toEqual([{ id: a.id, result: 'created', signalId: expect.any(String) }]);
});

test('un change triado abierto bloquea el disparo hasta que pasa a terminal', () => {
  const a = store.createAutomation(template);
  const original = store.runAutomationNow(a.id);
  const change = store.triageSignal(original.signalId!);
  expect(store.runAutomationNow(a.id)).toEqual({ result: 'skipped_open' });
  store.closeChange(change.id, 'canceled');
  expect(store.runAutomationNow(a.id)).toEqual({ result: 'created', signalId: expect.any(String) });
});

test('la comprobación de pendientes distingue automations incluso en el mismo workstream', () => {
  const a = store.createAutomation(template);
  const b = store.createAutomation({ ...template, name: 'otra' });
  store.addSignal(workstreamId, 'local', 'cuerpo');
  expect(store.runAutomationNow(a.id).result).toBe('created');
  expect(store.runAutomationNow(b.id).result).toBe('created');
  expect(store.listSignals(workstreamId)).toHaveLength(3);
});

test('un workstream pausado registra el vencimiento saltado aunque haya una señal abierta', () => {
  const a = store.createAutomation(template);
  store.runAutomationNow(a.id);
  store.setWorkstreamState(workstreamId, 'paused');
  now = due;
  expect(store.fireDueAutomations()).toEqual([{ id: a.id, result: 'skipped_inactive' }]);
  expect(store.fireDueAutomations()).toEqual([]);
  expect(store.listAutomations()[0]).toMatchObject({ lastDueAt: due, lastResult: 'skipped_inactive' });
  expect(store.runAutomationNow(a.id)).toEqual({ result: 'skipped_inactive' });
  expect(store.listEvents(workstreamId, 1)[0]!.message).toContain('workstream no activo');
  expect(store.listSignals(workstreamId)).toHaveLength(1);
});

test('filtra por workstream, omite automations pausadas y permite un disparo manual sin mover el horario', () => {
  const a = store.createAutomation(template);
  const other = activeWorkstream(store, 'otra');
  const b = store.createAutomation({ ...template, workstream: other });
  now = due;
  expect(store.fireDueAutomations('demo')).toEqual([{ id: a.id, result: 'created', signalId: expect.any(String) }]);
  expect(store.setAutomationEnabled(a.id, false).enabled).toBe(false);
  const [signal] = store.listSignals('demo');
  store.ignoreSignal(signal!.id);
  now = '2026-11-20T06:00:00.000Z';
  const manual = store.runAutomationNow(a.id);
  expect(manual.result).toBe('created');
  expect(store.listSignals('demo').at(-1)!.title).toBe('Resumen (2026-11-20)');
  expect(store.listAutomations(other)).toEqual([b]);
  expect(store.listAutomations('demo')[0]).toMatchObject({
    enabled: false, lastDueAt: due, lastResult: 'created', lastSignalId: manual.signalId,
  });
  store.ignoreSignal(manual.signalId!);
  now = '2026-11-20T07:30:00.000Z';
  expect(store.fireDueAutomations(workstreamId)).toEqual([]);
  expect(store.setAutomationEnabled(a.id, true).enabled).toBe(true);
  // Lo que venció durante la pausa no se recupera: el siguiente vencimiento sí.
  expect(store.fireDueAutomations(workstreamId)).toEqual([]);
  now = '2026-11-21T07:30:00.000Z';
  expect(store.fireDueAutomations(workstreamId)[0]!.result).toBe('created');
  expect(store.listEvents(workstreamId, -1).map(e => e.message)).toContain('automation diaria pausada');
  expect(store.listEvents(workstreamId, -1).map(e => e.message)).toContain('automation diaria activada');
});

test('valida nombre, título, cuerpo en bytes y expresión cron al guardar', () => {
  const variants = [
    { name: 'A' }, { name: 'a'.repeat(42) }, { name: 'a<script>' }, { name: 'a\n' },
    { title: '' }, { title: 'x'.repeat(201) }, { body: '' }, { body: 'é'.repeat(4096) + 'x' },
  ];
  for (const change of variants) {
    expect(() => store.createAutomation({ ...template, ...change })).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  }
  expect(() => store.createAutomation({ ...template, cron: '*/5 7 * * *' }))
    .toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining('minuto') }));
  expect(store.listAutomations()).toEqual([]);
  expect(store.createAutomation({ ...template, name: 'a'.repeat(41), title: 'á'.repeat(200), body: 'é'.repeat(4096) }).body)
    .toBe('é'.repeat(4096));
});

test('el nombre es único por workstream y la automation 21 excede el cupo', () => {
  store.createAutomation(template);
  expect(() => store.createAutomation(template)).toThrow(expect.objectContaining({ code: 'conflict' }));
  for (let i = 1; i < 20; i++) store.createAutomation({ ...template, name: `diaria-${i}` });
  expect(() => store.createAutomation({ ...template, name: 'exceso' })).toThrow(expect.objectContaining({ code: 'limit_reached' }));
  expect(store.listAutomations()).toHaveLength(20);
});

test('borrar una automation conserva sus señales y borrar el workstream borra sus automations', () => {
  const a = store.createAutomation(template);
  const b = store.createAutomation({ ...template, name: 'otra' });
  const { signalId } = store.runAutomationNow(a.id);
  store.deleteAutomation(a.id);
  expect(store.listSignals('demo')[0]).toMatchObject({ id: signalId, source: 'automation:' + a.id });
  expect(store.listEvents(workstreamId, 1)[0]!.message).toStartWith('automation diaria borrada ');
  expect(store.listAutomations()).toEqual([b]);
  for (const operation of [() => store.deleteAutomation(a.id), () => store.runAutomationNow(a.id), () => store.setAutomationEnabled(a.id, true)]) {
    expect(operation).toThrow(expect.objectContaining({ code: 'not_found' }));
  }
  store.db.query('DELETE FROM workstreams WHERE id = ?').run(workstreamId);
  expect(store.listAutomations()).toEqual([]);
});

test('addSignal admite web y rechaza un origen reservado por tipo y en tiempo de ejecución', () => {
  expect(store.addSignal('demo', 'local', 'texto').source).toBeNull();
  expect(store.addSignal('demo', 'web', 'texto', { source: 'web' }).source).toBe('web');
  expect(() =>
    // @ts-expect-error El origen de automation es privado del Store.
    store.addSignal('demo', 'falsa', 'texto', { source: 'automation:x' }),
  ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  expect(store.listSignals('demo')).toHaveLength(2);
});

test('migra una base anterior y un lector puede listar antes de migrarla sin cambiarla', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fab-automations-migrate-'));
  const path = join(dir, 'fabrica.db');
  try {
    const previous = new Database(path, { create: true });
    try {
      previous.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE workstreams (
          id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, goal TEXT NOT NULL, repo TEXT NOT NULL,
          state TEXT NOT NULL, agent TEXT NOT NULL, worker_concurrency INTEGER NOT NULL,
          task_limit INTEGER NOT NULL, require_change_approval INTEGER NOT NULL,
          require_approval INTEGER NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE signals (
          id TEXT PRIMARY KEY, workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
          title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, change_id TEXT, created_at TEXT NOT NULL);
      `);
      previous.query("INSERT INTO workstreams VALUES ('ws','demo','g','/repo','active','native',2,20,1,1,?)").run(initial);
      previous.query("INSERT INTO signals VALUES ('s','ws','anterior','cuerpo','new',NULL,?)").run(initial);
    } finally {
      previous.close();
    }
    const bytes = readFileSync(path);
    const reader = new Store(path, { readonly: true });
    try {
      expect(reader.listAutomations()).toEqual([]);
      expect(() => reader.getAutomation('ausente')).toThrow(expect.objectContaining({ code: 'not_found' }));
      expect(reader.listSignals('demo')[0]!.source).toBeNull();
    } finally {
      reader.close();
    }
    expect(readFileSync(path)).toEqual(bytes);

    const writer = new Store(path, { clock });
    try {
      expect(writer.listSignals('demo')[0]).toMatchObject({ title: 'anterior', source: null });
      expect(writer.db.query("PRAGMA index_info('idx_signals_source')").all())
        .toEqual([expect.objectContaining({ name: 'source' }), expect.objectContaining({ name: 'status' })]);
      const a = writer.createAutomation(template);
      const migratedReader = new Store(path, { readonly: true });
      try {
        expect(migratedReader.listAutomations('demo')).toEqual([a]);
      } finally {
        migratedReader.close();
      }
    } finally {
      writer.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('si falla el evento se revierten la señal y el avance, y el vencimiento se puede reintentar', () => {
  const a = store.createAutomation(template);
  now = due;
  store.db.exec("CREATE TRIGGER rechazar_evento BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'evento rechazado'); END");
  expect(() => store.fireDueAutomations()).toThrow('evento rechazado');
  expect(store.listSignals('demo')).toEqual([]);
  expect(store.listAutomations()).toEqual([a]);
  store.db.exec('DROP TRIGGER rechazar_evento');
  expect(store.fireDueAutomations()[0]!.result).toBe('created');
});

const raw = (db: Store) => (db as unknown as { db: Database }).db;

test('una fila con horario o last_due_at ilegible no para a las demás y avisa una vez (H1, H3)', () => {
  const bad = store.createAutomation({ ...template, name: 'a-rota' });
  const badDate = store.createAutomation({ ...template, name: 'b-fecha' });
  const good = store.createAutomation({ ...template, name: 'c-buena' });
  raw(store).query('UPDATE automations SET cron = ? WHERE id = ?').run('*/5 7 * * *', bad.id);
  raw(store).query('UPDATE automations SET last_due_at = ? WHERE id = ?').run('no-es-fecha', badDate.id);
  now = due;
  expect(store.fireDueAutomations()).toEqual([{ id: good.id, result: 'created', signalId: expect.any(String) }]);
  store.fireDueAutomations();
  const warnings = store.listEvents(workstreamId, -1).filter(e => e.severity === 'warning').map(e => e.message);
  expect(warnings).toHaveLength(2);
  expect(warnings[0]).toContain('automation a-rota: no se puede procesar');
  expect(warnings[1]).toContain('automation b-fecha: no se puede procesar');
});

test('una automation pausada no dispara sin filtro de workstream ni si la pausan entre la lista y el lock (H4)', () => {
  const a = store.createAutomation(template);
  store.setAutomationEnabled(a.id, false);
  now = '2026-11-20T08:00:00.000Z';
  expect(store.fireDueAutomations()).toEqual([]);
  store.setAutomationEnabled(a.id, true);
  now = '2026-11-21T08:00:00.000Z';
  const retry = store.withRetry.bind(store);
  const spy = spyOn(store, 'withRetry').mockImplementationOnce(fn => {
    store.setAutomationEnabled(a.id, false);
    return retry(fn);
  });
  try {
    expect(store.fireDueAutomations()).toEqual([]);
  } finally {
    spy.mockRestore();
  }
  expect(store.listSignals(workstreamId)).toEqual([]);
});

test('sin vencimiento no abre transacciones de escritura (H6)', () => {
  store.createAutomation(template);
  const spy = spyOn(store, 'withRetry');
  try {
    expect(store.fireDueAutomations()).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

test('edición valida, preserva identidad y audita solamente los valores anteriores efectivos', () => {
  const before = store.createAutomation({ ...template, body: 'texto\n"api_key": "valor sintético con espacios"\nfin' });
  const revision = automationRevision(before);
  const { workstream: _, ...fields } = template;
  const count = store.listEvents(workstreamId, -1).length;
  expect(store.updateAutomation(before.id, revision, { ...fields, body: before.body })).toEqual(before);
  expect(store.listEvents(workstreamId, -1)).toHaveLength(count);
  store.createAutomation({ ...template, name: 'ocupada' });
  for (const [patch, code] of [
    [{ name: 'ocupada' }, 'conflict'], [{ name: 'MAL' }, 'invalid_input'], [{ title: '' }, 'invalid_input'],
    [{ body: 'é'.repeat(4097) }, 'invalid_input'], [{ cron: '99 7 * * *' }, 'invalid_input'],
  ] as const) {
    expect(() => store.updateAutomation(before.id, revision, { ...fields, ...patch }))
      .toThrow(expect.objectContaining({ code }));
    expect(store.getAutomation(before.id)).toEqual(before);
  }
  const after = store.updateAutomation(before.id, revision, { ...fields, name: 'renombrada' });
  expect(after).toEqual({ ...before, name: 'renombrada', body: template.body });
  expect(store.listEvents(workstreamId, 1)[0]).toMatchObject({ actor: before.createdBy });
  const message = String(store.listEvents(workstreamId, 1)[0]!.message);
  expect(JSON.parse(message.slice(message.indexOf('{')))).toEqual({
    id: before.id, previous: { name: before.name, body: 'texto\n"api_key": [REDACTED]\nfin' },
  });
  expect(message).not.toContain('valor sintético');
  expect(message).not.toContain('renombrada');
  expect(() => store.deleteAutomation(before.id, revision)).toThrow(expect.objectContaining({ code: 'conflict' }));
  store.deleteAutomation(before.id, automationRevision(after));
  const deletion = String(store.listEvents(workstreamId, 1)[0]!.message);
  expect(JSON.parse(deletion.slice(deletion.indexOf('{')))).toEqual({
    id: before.id, previous: { name: after.name, cron: after.cron, title: after.title, body: after.body },
  });
  expect(() => store.getAutomation(before.id)).toThrow(expect.objectContaining({ code: 'not_found' }));
  expect(store.listSignals(workstreamId)).toEqual([]);
});

test('cambiar cron avanza el suelo sin retroceder y conserva pausa y último resultado', () => {
  const a = store.createAutomation(template);
  now = due;
  const [run] = store.fireDueAutomations();
  expect(automationRevision(store.getAutomation(a.id))).toBe(automationRevision(a));
  store.setAutomationEnabled(a.id, false);
  expect(() => store.deleteAutomation(a.id, automationRevision(a))).toThrow(expect.objectContaining({ code: 'conflict' }));
  const edit = (patch: Partial<typeof template>) => store.updateAutomation(a.id, automationRevision(store.getAutomation(a.id)), {
    name: a.name, cron: a.cron, title: a.title, body: a.body, ...patch,
  });
  now = '2026-11-19T07:10:00.000Z';
  expect(edit({ title: 'Otra' }).lastDueAt).toBe(due);
  expect(edit({ cron: '20 7 * * *' })).toMatchObject({
    enabled: false, lastDueAt: due, lastResult: 'created', lastSignalId: run!.signalId,
  });
  expect(store.setAutomationEnabled(a.id, true).lastDueAt).toBe(due);
  now = '2026-11-20T07:45:00.000Z';
  store.ignoreSignal(run!.signalId!);
  expect(edit({ cron: '35 7 * * *' }).lastDueAt).toBe(now);
  expect(store.fireDueAutomations()).toEqual([]);
  now = '2026-11-21T07:35:00.000Z';
  expect(store.fireDueAutomations()[0]!.result).toBe('created');
});

test.each(['tick primero', 'edición primero', 'borrado primero'])('dos conexiones ordenan tick y mutación: %s', order => {
  const dir = mkdtempSync(join(tmpdir(), 'fab-t86-'));
  const path = join(dir, 'fabrica.db');
  const editor = new Store(path, { clock });
  const tick = new Store(path, { clock });
  try {
    const ws = activeWorkstream(editor, 'demo');
    const a = editor.createAutomation(template);
    const revision = automationRevision(a);
    const update = () => editor.updateAutomation(a.id, revision, { ...template, title: 'Nueva', body: '<texto literal>' });
    now = due;
    if (order === 'tick primero') {
      const [run] = tick.fireDueAutomations();
      update();
      expect(editor.getAutomation(a.id).lastSignalId).toBe(run!.signalId!);
      now = '2026-11-20T07:30:00.000Z';
      expect(tick.fireDueAutomations()).toEqual([{ id: a.id, result: 'skipped_open' }]);
      editor.triageSignal(run!.signalId!);
      expect(tick.runAutomationNow(a.id)).toEqual({ result: 'skipped_open' });
      editor.deleteAutomation(a.id, automationRevision(editor.getAutomation(a.id)));
      expect(editor.listSignals(ws)[0]).toMatchObject({ source: 'automation:' + a.id, body: a.body });
    } else {
      const retry = tick.withRetry.bind(tick);
      const interleave = spyOn(tick, 'withRetry').mockImplementationOnce(fn => {
        if (order === 'edición primero') update();
        else editor.deleteAutomation(a.id, revision);
        return retry(fn);
      });
      try { tick.fireDueAutomations(); } finally { interleave.mockRestore(); }
      expect(editor.listSignals(ws)).toEqual(order === 'edición primero' ? [
        expect.objectContaining({ source: 'automation:' + a.id, title: 'Nueva (2026-11-19)', body: '<texto literal>', status: 'new' }),
      ] : []);
      expect(editor.listChanges(ws)).toEqual([]);
      expect(editor.listActivities({ workstream: ws })).toEqual([]);
    }
  } finally {
    tick.close();
    editor.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('el fallo del evento revierte edición y borrado, incluso si cambia el cursor', () => {
  const a = store.createAutomation(template);
  const rev = automationRevision(a);
  now = due;
  store.db.exec("CREATE TRIGGER rechazar_evento BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'evento rechazado'); END");
  expect(() => store.updateAutomation(a.id, rev, { ...template, cron: '0 7 * * *' })).toThrow('evento rechazado');
  expect(store.getAutomation(a.id)).toEqual(a);
  expect(() => store.deleteAutomation(a.id, rev)).toThrow('evento rechazado');
  expect(store.getAutomation(a.id)).toEqual(a);
});

// T86-H1/H2: lo que el evento de edición conserva del valor anterior.
function auditedBody(body: string): string {
  const a = store.createAutomation({ ...template, name: `auditada-${Math.random().toString(36).slice(2, 8)}`, body });
  const { workstream: _, ...fields } = template;
  store.updateAutomation(a.id, automationRevision(a), { ...fields, name: a.name, body: 'reemplazo' });
  const message = String(store.listEvents(workstreamId, 1)[0]!.message);
  return JSON.parse(message.slice(message.indexOf('{'))).previous.body;
}

test.each([
  ['passwd=hunter2 y más', 'passwd= [REDACTED]'], ['pwd: otra clave larga', 'pwd: [REDACTED]'], ['key=abc123', 'key= [REDACTED]'],
  ['mi_key = valor con espacios', 'mi_key = [REDACTED]'], ['DB_PASSWORD=zzz\nlinea2', 'DB_PASSWORD= [REDACTED]\nlinea2'],
])('T86-H1: el valor anterior omite la credencial en «%s»', (body, expected) => {
  expect(auditedBody(body)).toBe(expected);
});

test('T86-H1: palabras que solo contienen «key» o «pass» no se tratan como credenciales', () => {
  expect(auditedBody('monkey=1 keyboard=azerty bypass=sí')).toBe('monkey=1 keyboard=azerty bypass=sí');
});

test('T86-H2: sin controles C0/C1 ni bidi, y lo serializado también respeta el tope de 8 KiB', () => {
  expect(auditedBody('a\u009bb‮c\u0001d\te\nf')).toBe('a b c d\te\nf');
  expect(auditedBody('\u0001'.repeat(8192))).toBe(' '.repeat(8192)); // antes: 49 304 bytes de «\u0001» en el evento
  const quotes = '"'.repeat(5000); // 5000 bytes, pero 10 002 al serializar
  expect(auditedBody(quotes)).toBe('[OMITIDO: más de 8 KiB]');
  const message = String(store.listEvents(workstreamId, 1)[0]!.message);
  expect(message.length).toBeLessThan(500);
});

test('T86-H4: el evento omite un valor anterior de más de 8 KiB (fila que el Store actual no escribiría) y una clave privada', () => {
  const a = store.createAutomation({ ...template, name: 'enorme' });
  store.db.query('UPDATE automations SET body = ? WHERE id = ?').run('x'.repeat(8193), a.id); // M15
  const { workstream: _, ...fields } = template;
  store.updateAutomation(a.id, automationRevision(store.getAutomation(a.id)), { ...fields, name: 'enorme', body: 'nuevo' });
  const message = String(store.listEvents(workstreamId, 1)[0]!.message);
  expect(JSON.parse(message.slice(message.indexOf('{'))).previous.body).toBe('[OMITIDO: más de 8 KiB]');
  expect(auditedBody('antes\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----\ndespués')).toBe('antes\n[REDACTED]'); // M15b
});
