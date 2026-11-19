import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

test('readonly no reconstruye shm cuando un WAL quedó sin índice', () => {
  const dir = mkdtempSync('/tmp/fab-web-wal-');
  try {
    const source = `import {Store} from ${JSON.stringify(join(process.cwd(), 'src/store.ts'))}; const store=new Store(${JSON.stringify(join(dir, 'fabrica.db'))});store.createWorkstream({slug:'prueba',repo:'/repo',goal:'g'});process.exit(0);`;
    expect(Bun.spawnSync(['bun', '-e', source]).exitCode).toBe(0);
    rmSync(join(dir, 'fabrica.db-shm'));
    const before = readdirSync(dir).sort();
    expect(() => { const store = new Store(join(dir, 'fabrica.db'), { readonly: true }); store.listWorkstreams(); store.close(); }).toThrow();
    expect(readdirSync(dir).sort()).toEqual(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readonly sobre una base WAL cerrada no crea auxiliares y conserva los datos', () => {
  const dir = mkdtempSync('/tmp/fab-web-closed-');
  try {
    const path = join(dir, 'fabrica.db');
    const writer = new Store(path);
    writer.createWorkstream({ slug: 'demo', repo: '/repo', goal: 'g' }); writer.close();
    const before = readdirSync(dir).sort();
    const reader = new Store(path, { readonly: true });
    expect(reader.listWorkstreams()[0]!.slug).toBe('demo'); reader.close();
    expect(readdirSync(dir).sort()).toEqual(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('un lector conserva su snapshot si el escritor cierra antes de consultar', () => {
  const dir = mkdtempSync('/tmp/fab-web-writer-close-');
  try {
    const path = join(dir, 'fabrica.db');
    const writer = new Store(path); writer.createWorkstream({ slug: 'demo', repo: '/repo', goal: 'g' });
    const reader = new Store(path, { readonly: true });
    writer.close();
    const before = readdirSync(dir).sort();
    expect(reader.listWorkstreams()[0]!.slug).toBe('demo');
    expect(readdirSync(dir).sort()).toEqual(before);
    reader.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
