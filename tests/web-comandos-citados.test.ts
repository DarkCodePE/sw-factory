import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const home = mkdtempSync(join(tmpdir(), 'fab-t80-'));
const run = async (...args: string[]) => {
  const p = Bun.spawn([process.execPath, 'src/cli.ts', ...args], { cwd: root, env: { ...process.env, FABRICA_HOME: home }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const out = await new Response(p.stdout).text(); return { out, code: await p.exited };
};
// Palabras que siguen a «fab» en prosa y no son un verbo.
const PROSA = new Set(['existente']);

test('T80: cada verbo de fab que cita la web está en `fab --help`', async () => {
  const { out: help } = await run('--help');
  const verbos = new Set<string>();
  for (const f of readdirSync(join(root, 'src')).filter(f => /^web.*\.ts$/.test(f)))
    for (const m of readFileSync(join(root, 'src', f), 'utf8').matchAll(/\bfab ([a-z][a-z-]*)/g)) if (!PROSA.has(m[1]!)) verbos.add(m[1]!);
  expect(verbos.size).toBeGreaterThan(5);
  const ausentes = [...verbos].filter(v => !new RegExp(`^\\s*fab (?:[a-z|]*\\|)?${v}\\b`, 'm').test(help));
  expect(ausentes).toEqual([]);
});

test('T80: fab automation add --help responde con su ayuda y no abre el chat', async () => {
  const { out, code } = await run('automation', 'add', '--help');
  expect(code).toBe(0); expect(out).toContain('fab automation add'); expect(out).toContain('--body-file');
});

test('T80-H1: -h corto también muestra la ayuda de automation', async () => {
  const { out, code } = await run('automation', '-h');
  expect(code).toBe(0); expect(out).toContain('fab automation add');
});
