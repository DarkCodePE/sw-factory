// T103-H11 (2): fab profile import y fab definition import rechazan nombres MCP por rol fuera del registro, contando y sin nombrarlos.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportDefinition, importDefinition } from '../src/definition.ts';
import { defaultProfile, listProfiles, saveProfile } from '../src/profile.ts';
import { profileMain } from '../src/profile-cli.ts';
import { Store } from '../src/store.ts';

const HEX = '0123456789abcdef0123456789abcdef';
let dir: string, store: Store;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fab-profile-mcp-')); store = new Store(join(dir, 'fabrica.db')); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
const registry = (...names: string[]) => writeFileSync(join(dir, 'mcp-servers.json'), JSON.stringify({ servers: Object.fromEntries(names.map(n => [n, { url: `https://${n}.example.com/mcp`, headers: {} }])) }));
const profile = (mcp: string[]) => ({ ...defaultProfile(), schemaVersion: 2, harness: 'claude', roles: { qa: { harness: 'claude', mcp } } });
function cli(file: string) {
  const out: string[] = [], err = console.error, log = console.log;
  console.error = (m: string) => { out.push(String(m)); }; console.log = () => {};
  try { return { code: profileMain(['import', file], dir), err: out.join('\n') }; } finally { console.error = err; console.log = log; }
}

test('fab profile import rechaza un nombre fuera del registro sin nombrarlo y no guarda el perfil', () => {
  registry('tracker');
  for (const bad of [HEX, 'hunter2']) {
    const file = join(dir, 'p.json'); writeFileSync(file, JSON.stringify(profile(['tracker', bad])));
    const r = cli(file);
    expect(r.code).toBe(1);
    expect(r.err).toContain('1 nombre(s)');
    expect(r.err).not.toContain(bad);
  }
  expect(listProfiles(dir)).toEqual([]);
  writeFileSync(join(dir, 'p.json'), JSON.stringify(profile(['tracker'])));
  expect(cli(join(dir, 'p.json')).code).toBe(0);
});

test('sin registro (o roto) cualquier nombre MCP por rol se rechaza al importar', () => {
  const file = join(dir, 'p.json'); writeFileSync(file, JSON.stringify(profile(['tracker'])));
  expect(cli(file).code).toBe(1);
  writeFileSync(join(dir, 'mcp-servers.json'), '{roto');
  expect(cli(file).code).toBe(1);
  expect(listProfiles(dir)).toEqual([]);
});

test('fab definition import hace lo mismo y no deja perfil ni workstream nuevos', () => {
  registry('tracker');
  const { digest } = saveProfile(dir, profile(['tracker']) as never);
  store.createWorkstream({ slug: 'origen', goal: 'g', repo: join(dir, 'repo'), profile: digest });
  const tree = join(dir, 'tree'); exportDefinition(store, dir, 'origen', tree);
  const file = join(tree, 'profile/profile.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"tracker"', `"tracker", "${HEX}"`));
  let message = '';
  try { importDefinition(store, dir, tree, join(dir, 'repo'), 'copia'); } catch (e) { message = (e as Error).message; }
  expect(message).toContain('1 nombre(s)');
  expect(message).not.toContain(HEX);
  expect(store.listWorkstreams().map(w => w.slug)).toEqual(['origen']);
  expect(listProfiles(dir)).toEqual([digest]);
  writeFileSync(file, readFileSync(file, 'utf8').replace(`, "${HEX}"`, ''));
  expect(importDefinition(store, dir, tree, join(dir, 'repo'), 'copia').slug).toBe('copia');
});
