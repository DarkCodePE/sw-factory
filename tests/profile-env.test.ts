import { expect, test } from 'bun:test';
import { getAgent, MCP_AGENTS } from '../src/agents.ts';
import { defaultProfile, DEFAULT_DIGEST, profileDigest, validateProfile } from '../src/profile.ts';

const v2 = (extra: Record<string, unknown> = {}) => ({ ...defaultProfile(), schemaVersion: 2, harness: 'claude', ...extra }) as any;
const role = (cfg: Record<string, unknown>, extra: Record<string, unknown> = {}) => v2({ roles: { implement: cfg }, ...extra });
const bad = (raw: unknown, msg: RegExp) => expect(() => validateProfile(raw)).toThrow(msg);

test('env y mcp válidos: solo nombres', () => {
  const p = validateProfile(role({ env: ['DATABASE_URL', '_X', 'A1'], mcp: ['tracker', '0docs-1'] }));
  expect(p.roles!.implement).toEqual({ env: ['DATABASE_URL', '_X', 'A1'], mcp: ['tracker', '0docs-1'] });
  expect(() => validateProfile(role({ env: [], mcp: [] }))).not.toThrow();
  expect(() => validateProfile(role({ env: Array.from({ length: 16 }, (_, i) => `V${i}`), mcp: Array.from({ length: 8 }, (_, i) => `s${i}`) }))).not.toThrow();
});

test('env: rechazos nombran roles.<rol>.env', () => {
  const E = /roles\.implement\.env/;
  bad(role({ env: 'A' }), E);
  bad(role({ env: [1] }), E);
  bad(role({ env: Array.from({ length: 17 }, (_, i) => `V${i}`) }), E);
  bad(role({ env: ['A', 'A'] }), E);
  for (const n of ['a', '1A', 'A-B', 'A=1', 'A B', '', 'A'.repeat(65), 'a\nB']) bad(role({ env: [n] }), E);
  expect(() => validateProfile(role({ env: ['A'.repeat(64)] }))).not.toThrow();
});

test('B10: nombres prohibidos en env', () => {
  for (const n of ['PATH', 'HOME', 'TMPDIR', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BUN_INSTALL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG', 'FAB_ACTOR', 'FABRICA_HOME', 'FAB_', 'LD_'])
    bad(role({ env: ['OK', n] }), /roles\.implement\.env.*prohibid/);
  expect(() => validateProfile(role({ env: ['GIT_TOKEN', 'HOMEDIR', 'PATHS', 'MYFAB_X'] }))).not.toThrow();
});

test('mcp: rechazos nombran roles.<rol>.mcp', () => {
  const M = /roles\.implement\.mcp/;
  bad(role({ mcp: 'a' }), M);
  bad(role({ mcp: [1] }), M);
  bad(role({ mcp: Array.from({ length: 9 }, (_, i) => `s${i}`) }), M);
  bad(role({ mcp: ['a', 'a'] }), M);
  for (const n of ['A', '-a', 'a_b', 'a b', '', 'a'.repeat(42), 'fab']) bad(role({ mcp: [n] }), M);
  expect(() => validateProfile(role({ mcp: ['a'.repeat(41)] }))).not.toThrow();
});

test('mcp solo con adaptador que lo admite (roles.<rol>.harness ?? harness)', () => {
  expect(MCP_AGENTS).toEqual(['claude']);
  bad(role({ mcp: ['t'] }, { harness: 'codex' }), /roles\.implement\.mcp.*codex/);
  bad(role({ harness: 'codex', mcp: ['t'] }), /roles\.implement\.mcp.*codex/);
  expect(() => validateProfile(role({ harness: 'claude', mcp: ['t'] }, { harness: 'codex' }))).not.toThrow();
  // env no depende del adaptador
  expect(() => validateProfile(role({ env: ['A'] }, { harness: 'codex' }))).not.toThrow();
  // mcp vacío tampoco exige adaptador MCP
  expect(() => validateProfile(role({ mcp: [] }, { harness: 'codex' }))).not.toThrow();
});

test('v1 no admite roles ni env/mcp; digests dorados intactos', () => {
  bad({ ...defaultProfile(), roles: { implement: { env: ['A'] } } }, /clave desconocida roles/);
  expect(DEFAULT_DIGEST).toBe('2dff534e629bba57f035f8c59aa154664a6f1b8e7dd149d585fab524af7bb1b6');
  expect(profileDigest({ ...defaultProfile(), harness: 'claude', model: 'claude-sonnet-5-5', repo: '/r' })).toBe('289ab61eb9e15a36de26a3566272d3fc648e13d1ba48f3d4ea27aebbf0242924');
  // v2 sin env ni mcp: mismos bytes que sin las claves
  const a = v2({ roles: { qa: { model: 'm' } } }), b = JSON.parse(JSON.stringify(a));
  expect(profileDigest(validateProfile(a))).toBe(profileDigest(b));
});

test('claude: mcpConfig añade --strict-mcp-config --mcp-config; sin él, el argv no cambia', () => {
  const c = getAgent('claude');
  const base = c.command('p', { promptStdin: true });
  const withCfg = c.command('p', { promptStdin: true, mcpConfig: '/s/mcp.json' });
  expect(withCfg.slice(-3)).toEqual(['--strict-mcp-config', '--mcp-config', '/s/mcp.json']);
  expect(withCfg.slice(0, base.length)).toEqual(base);
  expect(base).not.toContain('--mcp-config');
  expect(getAgent('codex').command('p', { mcpConfig: '/s/mcp.json' } as any)).not.toContain('--mcp-config');
});
