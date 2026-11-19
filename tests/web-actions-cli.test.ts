import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync('/tmp/fab-web-cli-');
  const store = new Store(join(dir, 'fabrica.db'));
  store.createWorkstream({ slug: 'fixture', goal: 'g', repo: '/repo' }); store.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const warning = 'No abras otros servicios de 127.0.0.1 en este navegador mientras dure la sesión';

test('H1: la ayuda advierte del riesgo de compartir la cookie entre puertos', () => {
  const r = Bun.spawnSync(['bun', 'src/cli.ts', 'web', '--help'], { env: { ...process.env, FABRICA_HOME: dir } });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain('--write');
  expect(r.stdout.toString()).toContain(warning);
});
for (const write of [false, true]) {
  test(`H5 M45 y H1: comando real ${write ? 'con' : 'sin'} --write`, async () => {
    const child = Bun.spawn(['bun', 'src/cli.ts', 'web', '--port', '0', ...(write ? ['--write'] : [])], {
      env: { ...process.env, FABRICA_HOME: dir }, stdout: 'pipe', stderr: 'pipe',
    });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder(); let output = '';
    try {
      // Esperar datos del pipe, sin pausas ni sondeo por tiempo.
      while (!/fab web · http:\/\/127\.0\.0\.1:\d+[^\n]*\n/.test(output)) {
        const { done, value } = await reader.read();
        if (done) throw new Error('El comando terminó antes de escuchar');
        output += decoder.decode(value, { stream: true });
      }
      const base = /http:\/\/127\.0\.0\.1:\d+/.exec(output)![0];
      const r = await fetch(`${base}/fuera-de-alcance`, { method: 'POST' });
      expect(r.status).toBe(write ? 401 : 405);
      expect(output.includes('/auth?token=')).toBe(write);
    } finally {
      child.kill('SIGTERM'); await child.exited;
      for (;;) { const { done, value } = await reader.read(); if (done) break; output += decoder.decode(value, { stream: true }); }
      reader.releaseLock();
      await new Response(child.stderr).text();
    }
    expect(output.includes(warning)).toBe(write);
  });
}
