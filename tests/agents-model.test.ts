import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgent, MODEL_AGENTS, runAgent } from '../src/agents.ts';

const argv = (name: string, model?: string, opts: Record<string, unknown> = {}) =>
  getAgent(name).command('p', { promptStdin: getAgent(name).promptStdin === true, ...opts, ...(model ? { model } : {}) });
const pair = (a: string[], flag: string, v: string) => a.some((x, i) => x === flag && a[i + 1] === v);

const envBackup = process.env.FABRICA_DROID_MODEL;
afterEach(() => { if (envBackup === undefined) delete process.env.FABRICA_DROID_MODEL; else process.env.FABRICA_DROID_MODEL = envBackup; });

test('el modelo viaja como elementos propios de argv', () => {
  expect(pair(argv('claude', 'm'), '--model', 'm')).toBe(true);
  expect(pair(argv('codex', 'm'), '-m', 'm')).toBe(true);
  expect(pair(argv('native', 'm'), '-m', 'm')).toBe(true);
  expect(pair(argv('codex', 'm', { readOnly: true }), '-m', 'm')).toBe(true);
  // codex: el flag va tras `exec`
  expect(argv('codex', 'm').indexOf('-m')).toBe(2);
});

test('droid usa el modelo pedido aunque exista FABRICA_DROID_MODEL', () => {
  process.env.FABRICA_DROID_MODEL = 'custom:env';
  expect(pair(argv('droid', 'm'), '-m', 'm')).toBe(true);
  expect(argv('droid', 'm')).not.toContain('custom:env');
  expect(pair(argv('droid'), '-m', 'custom:env')).toBe(true);
});

test('sin modelo el argv es el de siempre', () => {
  delete process.env.FABRICA_DROID_MODEL;
  for (const n of ['claude', 'codex', 'native', 'droid', 'fake']) {
    expect(argv(n).join(' ')).not.toMatch(/--model|(^| )-m m/);
  }
  expect(argv('claude')).not.toContain('--model');
  expect(argv('codex')).toEqual(['codex', 'exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-']);
  expect(argv('codex', undefined, { readOnly: true })).toEqual(['codex', 'exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '-']);
  expect(argv('droid')).toEqual(['droid', 'exec', '-m', 'custom:qwen-local', '--auto', 'medium', '--output-format', 'text', '--file', '/dev/stdin']);
  expect(argv('native')).not.toContain('-m');
  expect(argv('fake').length).toBe(5);
});

test('MODEL_AGENTS', () => {
  expect([...MODEL_AGENTS].sort()).toEqual(['claude', 'codex', 'droid', 'fake', 'native']);
  expect(MODEL_AGENTS).not.toContain('agy');
});

test('runAgent propaga el modelo y fake lo refleja', async () => {
  const withModel = await runAgent(getAgent('fake'), 'hola', process.cwd(), 10_000, { model: 'm' });
  expect(withModel.output).toContain('model=m');
  const without = await runAgent(getAgent('fake'), 'hola', process.cwd(), 10_000);
  expect(without.output).not.toContain('model=');
});

test('T57 H5a: runAgent pasa el modelo a confineAgent y ANTHROPIC_MODEL no entra al sandbox', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fab-runagent-'));
  mkdirSync(join(dir, 'bin'));
  Bun.spawnSync(['git', 'init', '-q', dir]);
  // bwrap falso: vuelca su argv y sale.
  writeFileSync(join(dir, 'bin/bwrap'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\n`, { mode: 0o755 });
  // claude falso: la CI no tiene el binario y confineAgent exige que exista; nunca se ejecuta (bwrap es falso).
  writeFileSync(join(dir, 'bin/claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const prev = { PATH: process.env.PATH, M: process.env.ANTHROPIC_MODEL };
  process.env.PATH = `${dir}/bin:${prev.PATH}`; process.env.ANTHROPIC_MODEL = 'canario-t57';
  try {
    await runAgent(getAgent('claude'), 'hola', dir, 10_000, { confine: true, model: 'm1' });
    expect(readFileSync(join(dir, 'argv'), 'utf8')).not.toContain('canario-t57');
  } finally {
    process.env.PATH = prev.PATH;
    if (prev.M === undefined) delete process.env.ANTHROPIC_MODEL; else process.env.ANTHROPIC_MODEL = prev.M;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gemini CLI usa JSONL y activa el modo de solo lectura para investigación', () => {
  expect(argv('gemini', undefined, { readOnly: true })).toEqual(['gemini', '--output-format', 'stream-json', '--approval-mode', 'plan']);
  expect(argv('gemini')).toEqual(['gemini', '--output-format', 'stream-json']);
});
