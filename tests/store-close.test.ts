import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

// Bun solo finaliza al cerrar las consultas que siguen en su caché; si una sesión usa más consultas distintas
// que la caché, las expulsadas dejan la conexión «zombi» y el checkpoint del WAL ocurre en un GC posterior.
test('close deja la base completa y sin WAL aunque la sesión use más consultas que la caché de Bun', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fab-store-close-'));
  try {
    const path = join(dir, 'fabrica.db');
    const store = new Store(path);
    for (let i = 0; i < 400; i++) store.db.query(`SELECT ${i} FROM workstreams`).all();
    store.createWorkstream({ slug: 'w', goal: 'g', repo: '/r', requireChangeApproval: false, requireApproval: false });
    store.close();
    expect(existsSync(`${path}-wal`)).toBe(false);
    const bytes = readFileSync(path);
    Bun.gc(true); // un cierre tardío del zombi no debe cambiar la base
    expect(readFileSync(path).equals(bytes)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
