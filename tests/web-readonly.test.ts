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
