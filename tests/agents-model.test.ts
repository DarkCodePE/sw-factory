import { afterEach, expect, test } from 'bun:test';
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
  expect(argv('codex')).toEqual(['codex', 'exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-']);
  expect(argv('codex', undefined, { readOnly: true })).toEqual(['codex', 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-']);
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
