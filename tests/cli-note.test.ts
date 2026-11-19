import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

let dir: string, id: string;
const fab = (...args: string[]) => Bun.spawnSync(['bun', 'src/cli.ts', ...args], { env: { ...process.env, FABRICA_HOME: dir, FAB_ACTOR: 'dueño' } });
beforeEach(() => {
  dir = mkdtempSync('/tmp/fab-cli-note-'); const s = new Store(join(dir, 'fabrica.db'));
  id = s.createChange(s.createWorkstream({ slug: 'p', goal: 'g', repo: '/repo' }).id, 'C', 'd').id; s.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const notes = () => { const s = new Store(join(dir, 'fabrica.db')); try { return s.listChangeNotes(id); } finally { s.close(); } };

test('fab note guarda la nota con el actor y admite prefijo de id y varias palabras', () => {
  const r = fab('note', id.slice(0, 8), 'usa', 'la', 'rama X');
  expect(r.exitCode).toBe(0);
  expect(notes()).toMatchObject([{ body: 'usa la rama X', actor: 'dueño', deliveredAt: null }]);
});
test('change terminal: código distinto de 0, invalid_transition y ninguna fila', () => {
  const s = new Store(join(dir, 'fabrica.db')); s.db.query("UPDATE changes SET status='canceled' WHERE id=?").run(id); s.close();
  const r = fab('note', id, 'tarde');
  expect(r.exitCode).not.toBe(0); expect(r.stderr.toString()).toContain('invalid_transition');
  expect(notes()).toHaveLength(0);
});
test('nota vacía: invalid_input', () => {
  const r = fab('note', id);
  expect(r.exitCode).not.toBe(0); expect(r.stderr.toString()).toContain('invalid_input');
});
