import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

test('H8: lector WAL y lector deserializado esperan bloqueos hasta 5000 ms', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fab-web-timeout-'));
  const path = join(dir, 'fabrica.db');
  const writer = new Store(path);
  try {
    const ro = new Store(path, { readonly: true });
    try { expect(ro.db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 }); } finally { ro.close(); }
    writer.close();
    const snapshot = new Store(path, { readonly: true });
    try { expect(snapshot.db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 }); } finally { snapshot.close(); }
  } finally { writer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('H1: abrir/escribir/cerrar con lectores concurrentes produce cero fallos del escritor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fab-web-locks-'));
  const path = join(dir, 'fabrica.db');
  const seed = new Store(path); seed.createWorkstream({ slug: 'p', goal: 'g', repo: '/repo' }); seed.db.exec('DELETE FROM events'); seed.close();
  const source = `import {Store} from ${JSON.stringify(join(process.cwd(), 'src/store.ts'))};
await Bun.stdin.text();let errors=0;const messages=[];
for(let i=0;i<1500;i++){let s;try{s=new Store(${JSON.stringify(path)});s.event(s.getWorkstream('p').id,'info','evento');}catch(e){errors++;messages.push(String(e));}finally{s?.close();}}
console.log(JSON.stringify({errors,messages}));`;
  const writer = Bun.spawn(['bun', '-e', source], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  try {
    writer.stdin.end();
    let reads = 0;
    while (writer.exitCode === null) {
      for (let i = 0; i < 64; i++) {
      let reader: Store | undefined;
      try { reader = new Store(path, { readonly: true }); reader.listWorkstreams(); reads++; }
      catch (e) { expect(String(e)).toMatch(/WAL sin índice|base cambió|locked/); }
      finally { reader?.close(); }
      }
      await Bun.sleep(0); // Cede el turno para recoger la salida del hijo, sin esperar una duración que decida el resultado.
    }
    expect(await writer.exited).toBe(0);
    const result = JSON.parse(await new Response(writer.stdout).text());
    expect(result).toEqual({ errors: 0, messages: [] }); expect(reads).toBeGreaterThan(0);
    const check = new Store(path);
    try {
      expect(check.listEvents('p', -1).length).toBe(1500);
      expect(check.db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally { check.close(); }
  } finally { writer.kill(); await writer.exited; rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
