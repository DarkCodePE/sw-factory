import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportDefinition, importDefinition } from '../src/definition.ts';
import { defaultProfile, listProfiles, saveProfile } from '../src/profile.ts';
import { Store } from '../src/store.ts';

let dir: string, repo: string, a: string, b: string, storeA: Store, storeB: Store, tree: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fabrica-def-'));
  repo = join(dir, 'repo'); a = join(dir, 'a'); b = join(dir, 'b'); tree = join(dir, 'tree');
  mkdirSync(join(repo, '.agents/skills/lint'), { recursive: true });
  writeFileSync(join(repo, '.agents/skills/lint/SKILL.md'), 'usa el linter\n');
  mkdirSync(a); mkdirSync(b);
  for (const d of [a, b]) writeFileSync(join(d, 'mcp-servers.json'), JSON.stringify({ servers: { docs: { url: 'https://docs.example.com/mcp', headers: {} } } })); // el perfil de seed declara el MCP «docs»
  storeA = new Store(join(a, 'fab.db')); storeB = new Store(join(b, 'fab.db'));
});
afterEach(() => { storeA.close(); storeB.close(); rmSync(dir, { recursive: true, force: true }); });

function seed() {
  const p: any = { ...defaultProfile(), schemaVersion: 2, harness: 'claude', roles: { implement: { harness: 'claude', env: ['GH_TOKEN'], mcp: ['docs'] } },
    scorers: { calidad: { scope: 'change', rubric: 'r', classes: [{ label: 'ok', score: 1 }, { label: 'mal', score: 0 }], passing: 0.5, sampling: 0.1 } } };
  const { digest } = saveProfile(a, p);
  storeA.createWorkstream({ slug: 'demo', goal: 'meta', repo, profile: digest, verify: ["bun test 'a b'"], protectedPaths: ['x/**'] });
  return digest;
}

test('exportar e importar en un estado vacío da el mismo digest, sin rutas ni valores', () => {
  const digest = seed();
  const files = exportDefinition(storeA, a, 'demo', tree);
  expect(files).toContain('skills/lint/SKILL.md');
  const r = importDefinition(storeB, b, tree, join(dir, 'otro'), undefined);
  expect(r.digest).toBe(digest);
  const ws = storeB.getWorkstream('demo');
  expect(ws.profile).toBe(digest);
  expect(ws.state).toBe('draft');
  expect(ws.verify).toEqual([['bun', 'test', 'a b']]);
  for (const f of files) expect(readFileSync(join(tree, f), 'utf8')).not.toContain(dir);
  expect(readFileSync(join(tree, 'profile/profile.json'), 'utf8')).toContain('GH_TOKEN'); // solo el nombre
});

test('importar sobre un slug existente falla sin tocar nada', () => {
  seed(); exportDefinition(storeA, a, 'demo', tree);
  storeB.createWorkstream({ slug: 'demo', goal: 'otra', repo });
  expect(() => importDefinition(storeB, b, tree, repo)).toThrow(/ya existe/);
  expect(storeB.getWorkstream('demo').goal).toBe('otra');
  expect(listProfiles(b)).toEqual([]);
});

test('un fichero desconocido, un symlink o un perfil inválido se rechazan sin crear nada', () => {
  seed(); exportDefinition(storeA, a, 'demo', tree);
  writeFileSync(join(tree, 'extra.txt'), 'x');
  expect(() => importDefinition(storeB, b, tree, repo)).toThrow(/fichero desconocido: ?|desconocido en la definición: extra.txt/);
  rmSync(join(tree, 'extra.txt'));
  symlinkSync('/etc/passwd', join(tree, 'skills/lint/link'));
  expect(() => importDefinition(storeB, b, tree, repo)).toThrow(/solo se admiten ficheros/);
  rmSync(join(tree, 'skills/lint/link'));
  writeFileSync(join(tree, 'profile/worker/rules.md'), 'sin marca');
  expect(() => importDefinition(storeB, b, tree, repo)).toThrow(/STATUS:/);
  expect(storeB.listWorkstreams()).toEqual([]);
  expect(listProfiles(b)).toEqual([]);
});

test('no exporta si el perfil lleva una ruta local ni sobre un directorio con contenido', () => {
  seed();
  const p: any = { ...defaultProfile(), schemaVersion: 2, repo: repo };
  storeA.createWorkstream({ slug: 'fuga', goal: 'g', repo, profile: saveProfile(a, p).digest });
  expect(() => exportDefinition(storeA, a, 'fuga', join(dir, 't2'))).toThrow(/ruta local/);
  mkdirSync(join(dir, 't3')); writeFileSync(join(dir, 't3/x'), '');
  expect(() => exportDefinition(storeA, a, 'demo', join(dir, 't3'))).toThrow(/no está vacío/);
});

test('el workstream sin perfil propio exporta el perfil por defecto y vuelve a su digest', () => {
  mkdirSync(join(dir, 'vacio'));
  storeA.createWorkstream({ slug: 'plano', goal: 'g', repo: join(dir, 'vacio') });
  exportDefinition(storeA, a, 'plano', tree);
  expect(importDefinition(storeB, b, tree, repo).digest).toBe(saveProfile(b, defaultProfile()).digest);
  expect(readdirSync(join(tree, 'profile'))).toContain('worker');
  expect(existsSync(join(tree, 'skills'))).toBe(false);
});

test('si crear el workstream falla, no queda el perfil recién importado', () => {
  seed(); exportDefinition(storeA, a, 'demo', tree);
  const f = join(tree, 'workstream.json');
  writeFileSync(f, readFileSync(f, 'utf8').replace('bun test', 'bun test; rm'));
  expect(() => importDefinition(storeB, b, tree, repo)).toThrow(/simple command/);
  expect(listProfiles(b)).toEqual([]);
});
