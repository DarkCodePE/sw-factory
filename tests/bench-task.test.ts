import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdmissionDb } from '../src/admission/db.ts';
import { ThreadLinks } from '../src/admission/links.ts';
import { parseSuite, suiteDigest } from '../src/improve.ts';
import { Store } from '../src/store.ts';
import { suiteTaskFromChange, writeSuiteWithTask } from '../src/bench-task.ts';

const BASE = 'a'.repeat(40);
let dir: string;
let store: Store;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fab-bench-task-')); store = new Store(join(dir, 'fabrica.db')); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function change(o: { verify?: string[]; status?: string; base?: string | null } = {}): string {
  const ws = store.createWorkstream({ slug: `w${Math.random().toString(36).slice(2, 8)}`, goal: 'g', repo: '/repo', ...(o.verify && { verify: o.verify }) });
  const c = store.createChange(ws.id, 'Título', 'Descripción del change');
  if (o.base !== null) store.setChangeBase(c.id, o.base ?? BASE);
  store.db.query('UPDATE changes SET status = ? WHERE id = ?').run(o.status ?? 'completed', c.id);
  return c.id;
}
const spec = { id: 'tarea-nueva', split: 'development' as const };

test('la tarea generada pasa parseSuite y copia repo, base y descripción del change', () => {
  const id = change({ verify: ['bun test tests/a.test.ts'] });
  const t = suiteTaskFromChange(store, id, spec);
  expect(t).toEqual({ id: 'tarea-nueva', repo: '/repo', base: BASE, description: 'Descripción del change', verify: 'bun test tests/a.test.ts', split: 'development' });
  expect(parseSuite({ tasks: [t] }).tasks[0]).toEqual(t);
});

test('un argv con espacios o comillas se reconstruye y vuelve al mismo argv', () => {
  const id = change({ verify: [`bun test "tests/un fichero.test.ts" -t 'it''s'`] });
  const t = suiteTaskFromChange(store, id, spec);
  const { verifierArgv } = require('../src/agent/mission-evidence.ts');
  expect(verifierArgv(t.verify)).toEqual(store.getWorkstream(store.getChange(id).workstreamId).verify[0]!);
});

test('varios comandos de verificación, o ninguno, sin --verify: error que lo pide; con --verify se usa', () => {
  expect(() => suiteTaskFromChange(store, change({ verify: ['bun test a', 'bun test b'] }), spec)).toThrow(/--verify/);
  expect(() => suiteTaskFromChange(store, change(), spec)).toThrow(/--verify/);
  expect(suiteTaskFromChange(store, change(), { ...spec, verify: 'bun test c' }).verify).toBe('bun test c');
  expect(() => suiteTaskFromChange(store, change(), { ...spec, verify: 'a && b' })).toThrow(/verify/);
});

test('change no completed o sin baseSha: error', () => {
  expect(() => suiteTaskFromChange(store, change({ verify: ['bun test a'], status: 'implemented' }), spec)).toThrow(/completed/);
  expect(() => suiteTaskFromChange(store, change({ verify: ['bun test a'], base: null }), spec)).toThrow(/baseSha/);
  expect(() => suiteTaskFromChange(store, 'no-existe', spec)).toThrow(/not found/);
});

test('B1: un change de canal se rechaza y no se escribe fichero', () => {
  const id = change({ verify: ['bun test a'] });
  const adm = new AdmissionDb(store);
  adm.db.query('INSERT INTO adm_threads(id, source, first_seen) VALUES (?,?,?)').run('github:o/r#1', 'github:o/r', 'x');
  new ThreadLinks(adm).link('github:o/r#1', id);
  const out = join(dir, 'suite.json');
  expect(() => writeSuiteWithTask(store, id, { ...spec, out })).toThrow(/un change que entró por un canal no se añade a una suite/);
  expect(existsSync(out)).toBe(false);
});

test('B1: un change sin hilo pero nacido de un signal de la admisión también es de canal', () => {
  const id = change({ verify: ['bun test a'] });
  const adm = new AdmissionDb(store);
  const ws = store.getChange(id).workstreamId;
  const sig = store.addSignal(ws, 's', 'x'); store.db.query('UPDATE signals SET change_id = ? WHERE id = ?').run(id, sig.id);
  adm.db.query('INSERT INTO adm_threads(id, source, first_seen) VALUES (?,?,?)').run('github:o/r#2', 'github:o/r', 'x');
  adm.db.query('INSERT INTO adm_thread_signals(thread_id, signal_id, scope, created_at) VALUES (?,?,?,?)').run('github:o/r#2', sig.id, 'x', 'x');
  expect(() => suiteTaskFromChange(store, id, spec)).toThrow(/canal/);
});

test('B2: --out existente: error y el fichero no cambia; con --suite, la existente no se toca y la nueva la contiene más la tarea', () => {
  const id = change({ verify: ['bun test a'] });
  const existing = join(dir, 'vieja.json');
  writeFileSync(existing, JSON.stringify({ tasks: [{ id: 'vieja', repo: '/repo', base: BASE, description: 'd', verify: 'bun test z', split: 'validation' }] }));
  const antes = readFileSync(existing, 'utf8');
  const digest = suiteDigest(parseSuite(JSON.parse(antes)));
  expect(() => writeSuiteWithTask(store, id, { ...spec, suitePath: existing, out: existing })).toThrow(/existe/);
  expect(readFileSync(existing, 'utf8')).toBe(antes);

  const out = join(dir, 'nueva.json');
  writeSuiteWithTask(store, id, { ...spec, suitePath: existing, out });
  const nueva = parseSuite(JSON.parse(readFileSync(out, 'utf8')));
  expect(nueva.tasks.map(t => t.id)).toEqual(['vieja', 'tarea-nueva']);
  expect(readFileSync(existing, 'utf8')).toBe(antes);
  expect(suiteDigest(parseSuite(JSON.parse(readFileSync(existing, 'utf8'))))).toBe(digest);
  expect(() => writeSuiteWithTask(store, id, { ...spec, out })).toThrow(/existe/);
});

test('sin --suite: el fichero nuevo contiene solo la tarea; id repetido en la suite: error y sin fichero', () => {
  const id = change({ verify: ['bun test a'] });
  const out = join(dir, 'solo.json');
  writeSuiteWithTask(store, id, { ...spec, out });
  expect(parseSuite(JSON.parse(readFileSync(out, 'utf8'))).tasks.map(t => t.id)).toEqual(['tarea-nueva']);
  const out2 = join(dir, 'dup.json');
  expect(() => writeSuiteWithTask(store, id, { ...spec, suitePath: out, out: out2 })).toThrow(/repetido/);
  expect(existsSync(out2)).toBe(false);
});
