import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

const cols = (s: Store) => (s.db.query('PRAGMA table_info(activities)').all() as { name: string }[]).map(c => c.name);

function seed(path: string): string {
  const s = new Store(path);
  s.createWorkstream({ slug: 'p', goal: 'g', repo: '/repo' });
  const id = s.createChange('p', 't', 'd').id;
  const act = s.listActivities({ changeId: id })[0]!.id;
  s.close();
  return act;
}

test('una base anterior a T57 gana las columnas y devuelve null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fab-prov-'));
  const path = join(dir, 'f.db');
  try {
    const act = seed(path);
    const old = new Store(path);
    old.db.exec('ALTER TABLE activities DROP COLUMN agent; ALTER TABLE activities DROP COLUMN model;');
    expect(cols(old)).not.toContain('agent');
    old.close();
    const s = new Store(path);
    try {
      expect(cols(s)).toEqual(expect.arrayContaining(['agent', 'model']));
      const a = s.getActivity(act);
      expect(a.agent).toBeNull();
      expect(a.model).toBeNull();
    } finally { s.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readonly sin las columnas no falla y no las crea', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fab-prov-'));
  const path = join(dir, 'f.db');
  try {
    const act = seed(path);
    const old = new Store(path);
    old.db.exec('ALTER TABLE activities DROP COLUMN agent; ALTER TABLE activities DROP COLUMN model;');
    old.close();
    const ro = new Store(path, { readonly: true });
    try {
      const a = ro.getActivity(act);
      expect([a.agent, a.model]).toEqual([null, null]);
      expect(cols(ro)).not.toContain('agent');
    } finally { ro.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('setActivityProvenance: tres argumentos sigue valiendo; con run guarda agente y modelo', () => {
  const s = new Store(':memory:');
  s.createWorkstream({ slug: 'p', goal: 'g', repo: '/repo' });
  const id = s.createChange('p', 't', 'd').id;
  const act = s.listActivities({ changeId: id })[0]!.id;
  s.setActivityProvenance(act, 'd'.repeat(64), 'abc');
  let a = s.getActivity(act);
  expect([a.profileDigest, a.fabSha, a.agent, a.model]).toEqual(['d'.repeat(64), 'abc', null, null]);
  s.setActivityProvenance(act, 'e'.repeat(64), null, { agent: 'codex', model: 'm1' });
  a = s.getActivity(act);
  expect([a.profileDigest, a.agent, a.model]).toEqual(['e'.repeat(64), 'codex', 'm1']);
  s.setActivityProvenance(act, 'e'.repeat(64), null, { agent: 'claude', model: null });
  a = s.getActivity(act);
  expect([a.agent, a.model]).toEqual(['claude', null]);
  s.close();
});
