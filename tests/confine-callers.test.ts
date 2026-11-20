import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// T72d/T98: la lista exige revisión de rutas nuevas. El lanzador fija el entorno.
const REVISADOS = ['src/agents.ts', 'src/runners/serve.ts'];

const llamadores = () => [...new Bun.Glob('src/**/*.ts').scanSync('.')].filter(f => f !== 'src/sandbox/confine.ts' && /\bconfineAgent\s*\(/.test(readFileSync(f, 'utf8'))).sort();

test('confineAgent solo se llama desde ficheros revisados', () => {
  expect(llamadores()).toEqual(REVISADOS);
});

test('cada llamador revisado usa el lanzador preparado', () => {
  for (const f of REVISADOS) {
    const src = readFileSync(f, 'utf8');
    expect(src).toMatch(/\bconfined\.spawn\(/);
  }
});
