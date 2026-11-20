import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// T96-H1: con una umask abierta, el estado que crea fab debe quedar privado para que los adjuntos funcionen.
test('fab crea un estado nuevo en 0700 aunque la umask sea 002', () => {
  const root = mkdtempSync(join(tmpdir(), 'fab-estado-'));
  const state = join(root, 'nuevo');
  try {
    Bun.spawnSync(['sh', '-c', `umask 002; exec bun ${join(import.meta.dir, '../src/cli.ts')} status`], { env: { ...process.env, FABRICA_HOME: state } });
    expect(statSync(state).mode & 0o777).toBe(0o700);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
