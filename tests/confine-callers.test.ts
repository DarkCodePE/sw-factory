import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// T72d-H1 (opción 3): `confineAgent` ya no limpia el entorno (--clearenv); cada llamador debe lanzar con `confined.env`.
// Alarma, no defensa: si aparece un llamador nuevo, hay que revisarlo y añadirlo aquí.
// runAgent lo usa también el turno vivo (src/live/claude.ts); el runner serve (src/runners/serve.ts) llama a confineAgent directamente (revisado: lanza con confined.env).
const REVISADOS = ['src/agents.ts', 'src/runners/serve.ts'];

const llamadores = () => [...new Bun.Glob('src/**/*.ts').scanSync('.')].filter(f => f !== 'src/sandbox/confine.ts' && /\bconfineAgent\s*\(/.test(readFileSync(f, 'utf8'))).sort();

test('confineAgent solo se llama desde ficheros revisados', () => {
  expect(llamadores()).toEqual(REVISADOS);
});

test('cada llamador revisado lanza con el env de la llamada', () => {
  for (const f of REVISADOS) {
    const src = readFileSync(f, 'utf8');
    expect(src).toMatch(/Bun\.spawn\(\s*confined\??\.argv[^]*?env:\s*confined\??\.env/);
  }
});
