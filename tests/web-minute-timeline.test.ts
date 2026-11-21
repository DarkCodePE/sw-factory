import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdmissionDb } from '../src/admission/db.ts';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';

const time = (hms: string) => `2026-11-21T${hms}.000Z`;
let dir: string, store: Store, server: ReturnType<typeof startWeb>, ws: string, change: string, primary: string;
const extra = 'actividad-b';
const target = (id = change) => fetch(`http://127.0.0.1:${server.port}/changes/${id}`);
const event = (id: string, activity: string | null, at: string, text: string) =>
  store.db.query(`INSERT INTO events(workstream_id, change_id, activity_id, severity, message, created_at, actor)
    VALUES (?, ?, ?, 'info', ?, ?, 'mismo-actor')`).run(ws, id, activity, text, at);
const turn = (attempt: string, activity: string, from: string, to: string | null) =>
  store.db.query(`INSERT INTO adm_turns(attempt_id, activity_id, change_id, session_id, generation, plan, started_at, ended_at, outcome)
    VALUES (?, ?, ?, 's1', 1, 'fresh', ?, ?, 'done')`).run(attempt, activity, change, from, to);

function section(html: string): string {
  return html.match(/<section[^>]*>\s*<h2 id="timeline-minutos">[\s\S]*?<\/section>/)?.[0] ?? '';
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-minutos-'));
  store = new Store(join(dir, 'fabrica.db'));
  ws = store.createWorkstream({ slug: 'uno', goal: 'g', repo: '/r' }).id;
  change = store.createChange(ws, 'Cambio', 'd').id;
  primary = store.listActivities({ changeId: change })[0]!.id;
  // Quita los eventos de alta, para controlar todos los timestamps de este fixture.
  store.db.query('DELETE FROM events WHERE change_id = ?').run(change);
  server = startWeb(dir, 0);
});
afterEach(() => { server.stop(true); store.close(); rmSync(dir, { recursive: true, force: true }); });

test('T100: dos activities simultáneas tienen columnas distintas y sus marcas ordenadas por minuto UTC', async () => {
  store.db.query(`INSERT INTO activities(id, workstream_id, change_id, kind, status, worker_id, created_at)
    VALUES (?, ?, ?, 'implementation', 'in_progress', 'mismo-worker', ?)`).run(extra, ws, change, time('09:00:00'));
  store.db.query("UPDATE activities SET worker_id = 'mismo-worker' WHERE id = ?").run(primary);
  new AdmissionDb(store);
  store.db.query(`INSERT INTO adm_sessions(change_id, kind, generation, session_id, backend, cwd, status, created_at)
    VALUES (?, 'implementation', 1, 's1', 'claude', '/r', 'open', ?)`).run(change, time('09:00:00'));
  turn('primero', primary, time('10:00:58'), time('10:01:08'));
  turn('segundo', extra, time('10:00:59'), time('10:01:17'));
  event(change, extra, time('10:01:11'), 'Evento B posterior');
  event(change, primary, time('10:00:59'), 'Evento A <img src=x>');
  event(change, null, time('11:45:30'), 'Evento general');
  const other = store.createChange(ws, 'Otro', 'd').id;
  event(other, null, time('11:46:30'), 'Evento ajeno');

  const response = await target();
  expect(response.status).toBe(200);
  const table = section(await response.text());
  expect(table).toContain('Minuto (UTC)');
  expect(table).toContain('scope="col"');
  expect(table).toContain('scope="row"');
  expect(table).toContain(`href="/activities/${primary}"`);
  expect(table).toContain(`href="/activities/${extra}"`);
  expect(table).not.toContain('Evento ajeno');
  expect(table).not.toContain('<img src=x>');
  const rows = [...table.matchAll(/<tr><th scope="row"><time datetime="([^"]+)">.*?<\/time><\/th>(.*?)<\/tr>/gs)];
  expect(rows.map(row => row[1])).toEqual([time('10:00:00'), time('10:01:00'), time('11:45:00')]);
  const columns = [...table.matchAll(/<th scope="col">(.*?)<\/th>/gs)].map(m => m[1]!);
  const cell = (row: number, label: string) => {
    const index = columns.findIndex(c => c.includes(label));
    expect(index).toBeGreaterThan(0);
    return [...rows[row]![2]!.matchAll(/<td>(.*?)<\/td>/gs)][index - 1]![1]!;
  };
  expect(cell(0, primary)).toContain('Inicio de turno');
  expect(cell(0, primary)).toContain('Evento A &lt;img src=x&gt;');
  expect(cell(0, extra)).toContain('Inicio de turno');
  expect(cell(0, extra)).not.toContain('Evento A');
  expect(cell(1, primary)).toContain('Fin de turno');
  expect(cell(1, extra)).toMatch(/Evento B posterior.*Fin de turno/s);
  expect(cell(2, 'Change')).toContain('Evento general');
});

test('T100: base sin turnos, con fechas inválidas o sin datos, muestra No medido', async () => {
  const before = section(await (await target()).text());
  expect(before).toContain('No medido');
  expect(before).not.toContain('<table');
  event(change, primary, '1', 'Fecha ambigua');
  event(change, primary, time('10:12:55').replace('11-21', '02-31'), 'Fecha imposible');
  const invalid = section(await (await target()).text());
  expect(invalid).toContain('No medido');
  expect(invalid).not.toContain('<table');
  event(change, primary, time('10:01:30'), 'Fecha medida');
  const partial = section(await (await target()).text());
  expect(partial).toContain('No medido');
  expect(partial).toContain('Fecha medida');
  expect(partial).not.toContain('Fecha ambigua');
  expect(store.db.query("SELECT 1 FROM sqlite_master WHERE name = 'adm_turns'").get()).toBeNull();
});
