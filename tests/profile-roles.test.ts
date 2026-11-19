import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultProfile, DEFAULT_DIGEST, loadProfile, profileDigest, resolveRole, roleOf, saveProfile, validateProfile } from '../src/profile.ts';

const v2 = (extra: Record<string, unknown> = {}) => ({ ...defaultProfile(), schemaVersion: 2, harness: 'claude', ...extra }) as any;
const bad = (raw: unknown, msg: RegExp) => expect(() => validateProfile(raw)).toThrow(msg);

test('digest dorado: v1 no cambia (I1, I2)', () => {
  expect(DEFAULT_DIGEST).toBe('2dff534e629bba57f035f8c59aa154664a6f1b8e7dd149d585fab524af7bb1b6');
  expect(profileDigest({ ...defaultProfile(), harness: 'claude', model: 'claude-sonnet-5-5', repo: '/r' })).toBe('289ab61eb9e15a36de26a3566272d3fc648e13d1ba48f3d4ea27aebbf0242924');
  expect(defaultProfile().schemaVersion).toBe(1);
});

test('v2 válido; roles opcional y cada rol opcional', () => {
  expect(validateProfile(v2()).schemaVersion).toBe(2);
  expect(() => validateProfile(v2({ model: 'claude-sonnet-5-5', roles: { investigate: { harness: 'claude', model: 'claude-fable-5-2' }, qa: {}, implement: { model: 'a.b:c/d@e-1' } } }))).not.toThrow();
});

test('rechazos nombran el campo', () => {
  bad(v2({ roles: { steward: {} } }), /clave desconocida roles\.steward/);
  bad(v2({ roles: { qa: { temperature: 1 } } }), /clave desconocida roles\.qa\.temperature/);
  bad(v2({ roles: { qa: { harness: 'nope' } } }), /roles\.qa\.harness/);
  bad(v2({ roles: 'x' }), /roles/);
  bad(v2({ roles: { qa: 'x' } }), /roles\.qa/);
  bad({ ...defaultProfile(), roles: {} }, /clave desconocida roles/); // v1
  bad(v2({ schemaVersion: 3 }), /schemaVersion/);
  for (const m of ['-x', '--foo', 'a b', 'a;b', '', 'a'.repeat(129)]) {
    bad(v2({ roles: { implement: { model: m } } }), /roles\.implement\.model/);
    bad(v2({ model: m }), /perfil inválido: model/);
  }
  expect(() => validateProfile(v2({ roles: { implement: { model: 'a'.repeat(128) } } }))).not.toThrow();
  bad(v2({ roles: { qa: { harness: 'agy', model: 'm' } } }), /roles\.qa\.model/);
  bad(v2({ harness: 'agy', roles: { qa: { model: 'm' } } }), /roles\.qa\.model/);
  bad(v2({ harness: 'agy', model: 'm' }), /perfil inválido: model/);
  expect(() => validateProfile(v2({ harness: 'agy', roles: { qa: { harness: 'claude', model: 'm' } } }))).not.toThrow();
});

test('v1 conserva su regla de model laxa', () => {
  expect(() => validateProfile({ ...defaultProfile(), harness: 'agy', model: '-raro modelo' })).not.toThrow();
});

test('roleOf', () => {
  expect(roleOf({ kind: 'investigation', validator: null })).toBe('investigate');
  expect(roleOf({ kind: 'implementation', validator: null })).toBe('implement');
  expect(roleOf({ kind: 'change_review', validator: 'qa' })).toBe('qa');
  expect(roleOf({ kind: 'change_review', validator: 'security_audit' })).toBe('security_audit');
  expect(roleOf({ kind: 'change_review', validator: 'code_review' })).toBe('code_review');
  expect(roleOf({ kind: 'gates', validator: null })).toBeNull();
  expect(roleOf({ kind: 'steward' as any, validator: null })).toBeNull();
});

test('tabla de verdad de §2.3', () => {
  const r = (p: any, ws: string, role: any, ov?: string) => resolveRole(p, role, ws, ov);
  const v1 = { ...defaultProfile(), harness: 'claude', model: 'x' };
  expect(r(v1, 'claude', 'implement')).toMatchObject({ adapter: 'claude', model: null });
  const base = v2({ model: 'm0' });
  expect(r(base, 'claude', 'implement')).toEqual({ adapter: 'claude', model: 'm0', source: 'workstream' });
  expect(r(base, 'codex', 'implement')).toMatchObject({ adapter: 'codex', model: null });
  expect(r(v2({ model: 'm0', roles: { implement: { model: 'm1' } } }), 'claude', 'implement')).toMatchObject({ adapter: 'claude', model: 'm1' });
  const cr = v2({ model: 'm0', roles: { code_review: { harness: 'codex', model: 'g' } } });
  expect(r(cr, 'claude', 'code_review')).toEqual({ adapter: 'codex', model: 'g', source: 'role' });
  expect(r(cr, 'claude', 'qa')).toMatchObject({ adapter: 'claude', model: 'm0' });
  expect(r(cr, 'claude', 'code_review', 'fake')).toEqual({ adapter: 'fake', model: null, source: 'override' });
  expect(r(v2({ model: 'm0', roles: { qa: { harness: 'codex' } } }), 'claude', 'qa')).toMatchObject({ adapter: 'codex', model: null });
  expect(r(cr, 'claude', null)).toMatchObject({ adapter: 'claude', model: 'm0' });
});

test('save/load v2 roundtrip y digest distinto por rol (I6, A3)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fab-roles-'));
  try {
    const a = v2({ roles: { qa: { model: 'm1' } } }), b = v2({ roles: { qa: { model: 'm2' } } });
    const { digest } = saveProfile(dir, a);
    expect(loadProfile(dir, digest)).toEqual(a);
    expect(profileDigest(loadProfile(dir, digest))).toBe(digest);
    expect(profileDigest(b)).not.toBe(digest);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
