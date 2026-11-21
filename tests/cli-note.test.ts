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
test('T56c-H1: sin texto lista las notas con su estado (pendiente o entregada)', () => {
  expect(fab('note', id).stdout.toString()).toContain('sin notas');
  const s = new Store(join(dir, 'fabrica.db'));
  s.addChangeNote(id, 'primera'); s.addChangeNote(id, 'segunda');
  const act = s.listActivities({ changeId: id })[0]!; s.reserveNotes(id, act.id, 'att-1'); s.confirmNotes('att-1');
  s.addChangeNote(id, 'tercera'); s.close();
  const r = fab('note', id.slice(0, 8));
  const out = r.stdout.toString();
  expect(r.exitCode).toBe(0);
  expect(out).toMatch(/\S+ {2}entregada .*primera/); expect(out).toMatch(/pendiente {2}tercera/);
  expect(notes()).toHaveLength(3); // listar no crea nada
});
test('nota vacía: invalid_input', () => {
  const r = fab('note', id, '');
  expect(r.exitCode).not.toBe(0); expect(r.stderr.toString()).toContain('invalid_input');
});

test('T79: la ayuda de fab web documenta --write y --port 0 y no dice «solo lectura»', async () => {
  const p = Bun.spawn([process.execPath, 'src/cli.ts', '--help'], { cwd: join(import.meta.dir, '..'), env: { ...process.env, FABRICA_HOME: '/nonexistent-fab-help' }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const out = await new Response(p.stdout).text(); expect(await p.exited).toBe(0);
  const line = out.split('\n').filter(l => l.includes('fab web'));
  expect(line.length).toBe(1); expect(line[0]).toContain('--write'); expect(line[0]).toContain('--port 0');
  expect(line[0]).not.toMatch(/solo lectura/i);
});

// B de INT-O1: `fab note --file` adjunta con las mismas validaciones que la web (las hace el Store).
import { writeFileSync } from 'node:fs';
test('--file adjunta el fichero con su nombre y registra la nota', () => {
  writeFileSync(join(dir, 'datos.txt'), 'contenido del adjunto');
  const r = fab('note', id, 'mira', 'esto', '--file', join(dir, 'datos.txt'));
  expect(r.exitCode).toBe(0);
  expect(notes()).toMatchObject([{ body: 'mira esto', attachment: { name: 'datos.txt', size: 21 } }]);
});
test('--file rechaza un fichero ilegible, demasiado grande o con extensión no admitida, sin crear nota', () => {
  writeFileSync(join(dir, 'grande.txt'), 'x'.repeat(64 * 1024 + 1)); writeFileSync(join(dir, 'malo.exe'), 'x');
  for (const f of [join(dir, 'no-existe.txt'), join(dir, 'grande.txt'), join(dir, 'malo.exe')]) {
    const r = fab('note', id, 'texto', '--file', f);
    expect(r.exitCode).not.toBe(0); expect(r.stderr.toString()).toContain('invalid_input');
  }
  expect(notes()).toHaveLength(0);
});
test('C90-H2: --file exige un fichero regular (directorio y /dev/zero: invalid_input, ninguna nota)', () => {
  for (const f of [dir, '/dev/zero']) {
    const r = fab('note', id, 'texto', '--file', f);
    expect(r.exitCode).not.toBe(0); expect(r.stderr.toString()).toContain('no es un fichero regular');
  }
  expect(notes()).toHaveLength(0);
});
test('C90-H4: --file sin texto falla en vez de listar las notas', () => {
  const f = join(dir, 'a.txt'); writeFileSync(f, 'x');
  const r = fab('note', id, '--file', f);
  expect(r.exitCode).not.toBe(0); expect(r.stderr.toString()).toContain('necesita el texto');
  expect(notes()).toHaveLength(0);
});
