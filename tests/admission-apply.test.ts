import { expect, test } from 'bun:test';
import { applyAdmission } from '../src/admission/apply.ts';
import type { CrashPoint } from '../src/admission/effects.ts';
import { claimed } from './helpers/live.ts';
import { REPO } from './helpers/admission.ts';

const T = `github:${REPO}#3`;
function setup() {
  const t = claimed();
  t.adm.db.query('INSERT INTO adm_threads(id, source, first_seen) VALUES (?,?,?)').run(T, `github:${REPO}`, 'x');
  t.adm.db.query("INSERT INTO adm_content(thread_id, title, body, hash, labeled_at, captured_at) VALUES (?,'Título admitido','Cuerpo admitido','h','2026-01-01T00:00:00Z','x')").run(T);
  const n = () => (t.store.listSignals('ws').length);
  return { ...t, n };
}

test('propose: solo un signal nuevo para triage humano, con el contenido admitido; ni change ni vínculo', () => {
  const t = setup(), before = t.n();
  const r = applyAdmission(t.store, t.adm, { thread: T, workstream: 'ws', decision: { would_admit: true, scope_max: 'propose' } });
  expect(r.scope).toBe('propose');
  expect(t.n()).toBe(before + 1);
  const s = t.store.listSignals('ws', 'new').find(x => x.title === 'Título admitido')!;
  expect([s.body, s.status, s.changeId]).toEqual(['Cuerpo admitido', 'new', null]);
  expect(t.adm.db.query('SELECT COUNT(*) n FROM adm_thread_changes').get()).toEqual({ n: 0 });
});

test('change: triageSignal crea el change y une el hilo (ExternalRef github); repetir no duplica', () => {
  const t = setup(), before = t.n();
  const a = applyAdmission(t.store, t.adm, { thread: T, workstream: 'ws', decision: { would_admit: true, scope_max: 'change' } });
  const b = applyAdmission(t.store, t.adm, { thread: T, workstream: 'ws', decision: { would_admit: true, scope_max: 'change' } });
  expect(a).toEqual(b);
  expect(t.n()).toBe(before + 1);
  expect(a.scope === 'change' && t.store.getChange(a.changeId).title).toBe('Título admitido');
});

test('none o would_admit=false no crean nada', () => {
  const t = setup(), before = t.n();
  expect(applyAdmission(t.store, t.adm, { thread: T, workstream: 'ws', decision: { would_admit: true, scope_max: 'none' } })).toEqual({ scope: 'none' });
  expect(applyAdmission(t.store, t.adm, { thread: T, workstream: 'ws', decision: { would_admit: false, scope_max: 'change' } })).toEqual({ scope: 'none' });
  expect(t.n()).toBe(before);
});

test('caída tras crear el signal y antes de cerrar: nada a medias, y al repetir no se duplica', () => {
  const t = setup(), before = t.n(), crash = (p: CrashPoint) => { if (p === 'signal-created') throw new Error('crash'); };
  expect(() => applyAdmission(t.store, t.adm, { thread: T, workstream: 'ws', decision: { would_admit: true, scope_max: 'change' }, crash })).toThrow('crash');
  expect(t.n()).toBe(before);
  expect(t.adm.db.query('SELECT COUNT(*) n FROM adm_thread_signals').get()).toEqual({ n: 0 });
  applyAdmission(t.store, t.adm, { thread: T, workstream: 'ws', decision: { would_admit: true, scope_max: 'change' } });
  expect(t.n()).toBe(before + 1);
});

test('sin copia admitida no se crea el signal (no se relee el issue)', () => {
  const t = setup();
  t.adm.db.query('DELETE FROM adm_content').run();
  expect(() => applyAdmission(t.store, t.adm, { thread: T, workstream: 'ws', decision: { would_admit: true, scope_max: 'propose' } })).toThrow(/contenido admitido/);
});
