import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentEnv } from '../src/sandbox/env.ts';
import { confineAgent } from '../src/sandbox/confine.ts';
import { runAgent } from '../src/agents.ts';

const host = { PATH: '/usr/bin', HOME: '/h', LANG: 'C', LC_ALL: 'C', XDG_X: 'x', ANTHROPIC_API_KEY: 'canario-api', ANTHROPIC_MODEL: 'm', OPENAI_API_KEY: 'o', DB_URL: 'canario-db', CANARIO: 'canario-valor', FABRICA_FAKE_STATUS: 's' };
const base = { adapter: 'claude', confined: false, channel: false, wsAllow: null as string[] | null, roleEnv: [] as string[], mcpRequired: [] as string[], host };
const canConfine = Bun.which('bwrap') !== null && Bun.spawnSync(['bwrap', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--', '/bin/true']).exitCode === 0;

test('§5.1 wsAllow null sin confinar: todo host, como hoy (S4)', () => {
  expect(agentEnv(base)).toEqual({ env: host, delivered: [], missing: [], denied: [] });
});

test('§5.1 wsAllow null confinado: solo la lista fija del adaptador, como hoy', () => {
  expect(Object.keys(agentEnv({ ...base, confined: true }).env).sort()).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']);
  expect(Object.keys(agentEnv({ ...base, confined: true, model: 'x' }).env)).toEqual(['ANTHROPIC_API_KEY']);
  expect(Object.keys(agentEnv({ ...base, adapter: 'codex', confined: true }).env)).toEqual(['OPENAI_API_KEY']);
  expect(Object.keys(agentEnv({ ...base, adapter: 'fake', confined: true }).env)).toEqual(['FABRICA_FAKE_STATUS']);
});

test('§5.1 modo declarado: base + adaptador + declaradas; B1 la no declarada no llega', () => {
  for (const confined of [false, true]) {
    const r = agentEnv({ ...base, confined, wsAllow: [], roleEnv: [], mcpRequired: [] });
    expect(r.env.CANARIO).toBeUndefined();
    expect(r.env.DB_URL).toBeUndefined();
    expect(r.env.ANTHROPIC_API_KEY).toBe('canario-api');
  }
  const open = agentEnv({ ...base, wsAllow: [] });
  expect(Object.keys(open.env).sort()).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'XDG_X']);
  const r = agentEnv({ ...base, wsAllow: ['DB_URL', 'MCP_TOKEN', 'OTRA'], roleEnv: ['DB_URL'], mcpRequired: ['MCP_TOKEN'] });
  expect(r.env.DB_URL).toBe('canario-db');
  expect(r.delivered).toEqual(['DB_URL']);
  expect(r.missing).toEqual(['MCP_TOKEN']);
  expect(r.denied).toEqual([]);
});

test('§5.1 denied: lo declarado fuera de wsAllow no se entrega (S2)', () => {
  const r = agentEnv({ ...base, wsAllow: [], roleEnv: ['DB_URL'], mcpRequired: ['CANARIO'] });
  expect(r.denied).toEqual(['DB_URL', 'CANARIO']);
  expect(r.env.DB_URL).toBeUndefined();
  expect(r.delivered).toEqual([]);
});

test('§5.1 canal: sin roleEnv ni mcpRequired (S3), sin denied', () => {
  const r = agentEnv({ ...base, confined: true, channel: true, wsAllow: ['DB_URL'], roleEnv: ['DB_URL'], mcpRequired: ['CANARIO'] });
  expect(r.env.DB_URL).toBeUndefined();
  expect(r).toMatchObject({ delivered: [], denied: [], missing: [] });
});

test('B2: el argv de confineAgent no lleva ningún valor; el entorno sí', () => {
  if (!canConfine) return;
  const root = mkdtempSync('/tmp/fab-env-');
  const saved = { ...process.env };
  try {
    Bun.spawnSync(['git', 'init', '-q', root]);
    process.env.ANTHROPIC_API_KEY = 'canario-api'; process.env.DB_URL = 'canario-db';
    const c = confineAgent('claude', ['sh', '-c', 'true'], root, {}, undefined, undefined, undefined, { wsAllow: ['DB_URL'], roleEnv: ['DB_URL'] });
    try {
      expect(c.argv.join('\0')).not.toContain('canario');
      expect(c.argv).not.toContain('--setenv');
      expect(c.env.ANTHROPIC_API_KEY).toBe('canario-api');
      expect(c.env.DB_URL).toBe('canario-db');
    } finally { c.cleanup(); }
  } finally { process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY; if (saved.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY; if (saved.DB_URL === undefined) delete process.env.DB_URL; else process.env.DB_URL = saved.DB_URL; rmSync(root, { recursive: true, force: true }); }
});

test('bwrap real: /proc/<pid>/cmdline sin valores y el hijo ve lo permitido y no lo demás', async () => {
  if (!canConfine) return;
  const root = mkdtempSync('/tmp/fab-env-real-');
  const names = ['ANTHROPIC_API_KEY', 'DB_URL', 'CANARIO'];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  try {
    Bun.spawnSync(['git', 'init', '-q', root]);
    process.env.ANTHROPIC_API_KEY = 'canario-api'; process.env.DB_URL = 'canario-db'; process.env.CANARIO = 'canario-no';
    const out = join(root, 'out');
    const script = `printf '%s|%s|%s' "$DB_URL" "\${CANARIO-unset}" "$ANTHROPIC_API_KEY" > ${out}; while [ ! -e ${root}/go ]; do sleep 0.05; done`;
    const adapter = { name: 'claude', command: () => ['sh', '-c', script], env: () => ({}) };
    let cmdlines = '';
    const run = runAgent(adapter, '', root, 10_000, { confine: true, envDecl: { wsAllow: ['DB_URL'], roleEnv: ['DB_URL'] }, onSpawn: pid => { cmdlines = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } });
    for (let i = 0; i < 100 && !Bun.file(out).size; i++) await Bun.sleep(50);
    // cmdline de bwrap y de sus hijos
    const kids = Bun.spawnSync(['sh', '-c', 'for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline 2>/dev/null; echo; done']).stdout.toString();
    writeFileSync(join(root, 'go'), '');
    await run;
    expect(readFileSync(out, 'utf8')).toBe('canario-db|unset|canario-api');
    expect(cmdlines).not.toContain('canario');
    expect(kids.split('\n').filter(l => l.includes(root))).not.toEqual([]);
    expect(kids.split('\n').filter(l => l.includes(root)).join('\n')).not.toContain('canario');
  } finally { for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; } rmSync(root, { recursive: true, force: true }); }
});

test('perfil sin env: el entorno confinado tiene las mismas claves que antes del cambio (lista literal)', () => {
  if (!canConfine) return;
  const root = mkdtempSync('/tmp/fab-env-legacy-');
  const names = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'OPENAI_API_KEY', 'DB_URL'];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  try {
    Bun.spawnSync(['git', 'init', '-q', root]);
    for (const n of names) process.env[n] = 'v';
    const fixed = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_VALUE_1', 'HOME', 'LANG', 'PATH', 'TMPDIR'];
    const keys = (a: string) => { const c = confineAgent(a, ['sh', '-c', 'true'], root); try { return Object.keys(c.env).sort(); } finally { c.cleanup(); } };
    expect(keys('claude')).toEqual([...fixed, 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'].sort());
    expect(keys('codex')).toEqual([...fixed, 'OPENAI_API_KEY'].sort());
    expect(keys('fake')).toEqual([...fixed].sort());
  } finally { for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; } rmSync(root, { recursive: true, force: true }); }
});

test('una variable declarada no pisa la base del sandbox (HOME, PATH)', () => {
  if (!canConfine) return;
  const root = mkdtempSync('/tmp/fab-env-base-');
  try {
    Bun.spawnSync(['git', 'init', '-q', root]);
    const c = confineAgent('fake', ['sh', '-c', 'true'], root, { HOME: '/host', PATH: '/host/bin' }, undefined, undefined, undefined, { wsAllow: ['HOME', 'PATH'], roleEnv: ['HOME', 'PATH'] });
    try { expect(c.env.HOME).toBe('/home/agent'); expect(c.env.PATH).toContain('/opt/fab-runtime'); } finally { c.cleanup(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
