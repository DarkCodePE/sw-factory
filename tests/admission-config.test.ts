// T107-H4: `fab resident` usa resident.json como valores por defecto y los flags mandan.
import { afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { residentMain } from '../src/admission/cli.ts';
import { saveResidentConfig } from '../src/admission/config.ts';
import { Store } from '../src/store.ts';
import { dbPath, fakeGh, FIXTURE, REPO } from './helpers/admission.ts';

const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); });
const since = ['--once', '--since', '2026-01-01T00:00:00Z'];
function boot(cfg: Parameters<typeof saveResidentConfig>[1]) {
  const store = new Store(dbPath()); stores.push(store);
  saveResidentConfig(dirname(store.db.filename), cfg, 'test');
  return store;
}
const repos = (run: ReturnType<typeof fakeGh>) => run.calls.filter(c => c.includes('api')).map(c => c.join(' '));
const admitted = (s: Store) => (s.db.query('SELECT COUNT(*) n FROM adm_decisions WHERE would_admit = 1').get() as { n: number }).n;

test('sin flags, repo y etiqueta salen de resident.json', async () => {
  const store = boot({ repo: REPO, label: 'otra-etiqueta' });
  const run = fakeGh(FIXTURE);
  expect(await residentMain(since, store, { run })).toBe(0);
  expect(repos(run).some(c => c.includes(`repos/${REPO}/`))).toBe(true);
  expect(admitted(store)).toBe(0); // ningún issue lleva «otra-etiqueta»: la etiqueta guardada es la que decide
});

test('los flags mandan sobre resident.json (repo, etiqueta e intervalo)', async () => {
  const store = boot({ repo: 'otro/repo', label: 'otra-etiqueta', intervalSec: 5 });
  const run = fakeGh(FIXTURE);
  expect(await residentMain(['--repo', REPO, '--label', 'fab', ...since], store, { run })).toBe(0);
  expect(repos(run).every(c => !c.includes('otro/repo'))).toBe(true);
  expect(repos(run).some(c => c.includes(`repos/${REPO}/`))).toBe(true);
  expect(admitted(store)).toBeGreaterThan(0);
  const err = console.error; console.error = () => {};
  try { expect(await residentMain(['--interval', '0', ...since], store, { run: fakeGh([]) })).toBe(1); } finally { console.error = err; }
});

test('sin repo ni en flags ni en el fichero falla', async () => {
  const store = boot({ label: 'x' });
  const errors: string[] = [], err = console.error; console.error = (m: string) => { errors.push(String(m)); };
  try { expect(await residentMain(since, store, { run: fakeGh([]) })).toBe(1); } finally { console.error = err; }
  expect(errors.join()).toContain('--repo');
});
