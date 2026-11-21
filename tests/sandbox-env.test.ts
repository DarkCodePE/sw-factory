import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentEnv, NATIVE_VARS } from '../src/sandbox/env.ts';
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

test.skipIf(!canConfine)('T98: el lanzador retiene el argv, cwd y entorno iniciales y solo acepta stdin', async () => {
  const root = mkdtempSync('/tmp/fab-env-');
  const names = ['DB_URL', 'CANARIO_T98'];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  try {
    expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0);
    process.env.DB_URL = 'marcador-inicial';
    process.env.CANARIO_T98 = 'marcador-excluido';
    const extra = { FABRICA_FAKE_STATUS: 'original' };
    const argv = ['sh', '-ec', 'test "$PWD" = "$1"; test "$#" = 1; test -z "${CANARIO_T98+x}"; test "$DB_URL" = marcador-inicial; test "$FABRICA_FAKE_STATUS" = original; read -r input; test "$input" = entrada; printf confirmado; printf diagnostico >&2', 'prueba', root];
    const c = confineAgent('fake', argv, root, extra, undefined, undefined, undefined, { wsAllow: ['DB_URL'], roleEnv: ['DB_URL'] });
    try {
      expect(Object.keys(c).sort()).toEqual(['cleanup', 'inspection', 'spawn']);
      expect(Object.isFrozen(c.inspection)).toBe(true);
      expect(Object.isFrozen(c.inspection.envNames)).toBe(true);
      expect(c.inspection.envNames).toContain('DB_URL');
      expect(c.inspection.envNames).not.toContain('CANARIO_T98');
      expect(c.inspection.newSession).toBe(true);

      process.env.DB_URL = 'marcador-tardio';
      argv[2] = 'exit 77';
      extra.FABRICA_FAKE_STATUS = 'tardio';
      const spawn = c.spawn as (input: unknown, opts?: unknown) => ReturnType<typeof c.spawn>;
      const options = { env: { CANARIO_T98: 'inyectado' }, cwd: '/', stdout: 'ignore', stderr: 'ignore', detached: false };
      expect(() => spawn(options)).toThrow(/entrada/);
      const child = spawn(new TextEncoder().encode('entrada\n'), options);
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code).toBe(0);
      expect(stdout).toBe('confirmado');
      expect(stderr).toBe('diagnostico');
    } finally { c.cleanup(); }
  } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!canConfine)('bwrap real: cmdline sin valores y el hijo ve lo permitido y no lo demás', async () => {
  const root = mkdtempSync('/tmp/fab-env-real-');
  const names = ['ANTHROPIC_API_KEY', 'DB_URL', 'CANARIO'];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  try {
    expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0);
    process.env.ANTHROPIC_API_KEY = 'canario-api'; process.env.DB_URL = 'canario-db'; process.env.CANARIO = 'canario-no';
    const script = `import os
cmdline = open('/proc/self/cmdline', 'rb').read().split(b'\\0')
assert 'CANARIO' not in os.environ
for name in ['DB_URL', 'ANTHROPIC_API_KEY']:
    assert os.environ[name].startswith('canario' + '-')
    assert not any(os.environ[name].encode() in arg for arg in cmdline)
print('STATUS: done')
`;
    const adapter = { name: 'claude', command: () => ['python3', '-c', script] };
    let cmdline: string | undefined;
    let ownGroup = false;
    const run = await runAgent(adapter, '', root, 10_000, {
      confine: true,
      envDecl: { wsAllow: ['DB_URL'], roleEnv: ['DB_URL'] },
      onSpawn: pid => {
        cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        ownGroup = process.kill(-pid, 0);
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.ok).toBe(true);
    expect(ownGroup).toBe(true);
    expect(cmdline).toContain('--chdir');
    expect(cmdline).not.toMatch(/canario-(api|db|no)|--setenv/);
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
    const keys = (a: string) => { const c = confineAgent(a, ['sh', '-c', 'true'], root); try { return c.inspection.envNames; } finally { c.cleanup(); } };
    expect(keys('claude')).toEqual([...fixed, 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'].sort());
    expect(keys('codex')).toEqual([...fixed, 'OPENAI_API_KEY'].sort());
    expect(keys('fake')).toEqual([...fixed].sort());
  } finally { for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; } rmSync(root, { recursive: true, force: true }); }
});

test('una variable declarada no pisa la base del sandbox (HOME, PATH)', async () => {
  if (!canConfine) return;
  const root = mkdtempSync('/tmp/fab-env-base-');
  try {
    Bun.spawnSync(['git', 'init', '-q', root]);
    const c = confineAgent('fake', ['sh', '-ec', 'test "$HOME" = /home/agent; case "$PATH" in /opt/fab-runtime:*) exit 0;; *) exit 1;; esac'], root, { HOME: '/host', PATH: '/host/bin' }, undefined, undefined, undefined, { wsAllow: ['HOME', 'PATH'], roleEnv: ['HOME', 'PATH'] });
    try { expect(await c.spawn('ignore').exited).toBe(0); } finally { c.cleanup(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T72e-H1: en modo declarado native y agy conservan FABRICA_LLM_* y FABRICA_HOME; el resto de FABRICA_ no', () => {
  const h = { ...host, FABRICA_LLM_API_KEY: 'k', FABRICA_LLM_BASE_URL: 'u', FABRICA_LLM_MODEL: 'm', FABRICA_HOME: '/estado', FABRICA_OTRA: 'x' };
  for (const adapter of ['native', 'agy'])
    for (const confined of [false, true])
      expect(Object.keys(agentEnv({ ...base, adapter, confined, wsAllow: [], host: h }).env).filter(k => k.startsWith('FABRICA_')).sort())
        .toEqual(['FABRICA_HOME', 'FABRICA_LLM_API_KEY', 'FABRICA_LLM_BASE_URL', 'FABRICA_LLM_MODEL']);
});

test('T72e-H1: la lista cubre las FABRICA_* que lee src/agent/ (salvo las que no son del agente)', () => {
  const leen = new Set<string>();
  for (const f of new Bun.Glob('**/*.ts').scanSync('src/agent')) for (const m of readFileSync(join('src/agent', f), 'utf8').matchAll(/process\.env\.(FABRICA_[A-Z_]+)/g)) leen.add(m[1]!);
  // Opcionales (búsqueda, red, tiempos): hoy no se pasan; si hace falta alguna, se añade a NATIVE_VARS.
  const opcionales = new Set(['FABRICA_SEARCH_URL', 'FABRICA_SEARCH_API_KEY', 'FABRICA_SEARCH_PROVIDER', 'FABRICA_FETCH_ALLOW_PRIVATE', 'FABRICA_STREAM_IDLE_MS', 'FABRICA_EGRESS_PROBE_FILE']);
  expect([...leen].filter(n => !opcionales.has(n) && !NATIVE_VARS.includes(n))).toEqual([]);
});

// T98-H4(c): la aserción de la base, recuperada: ningún proceso de la máquina que mencione el repo lleva un valor en su cmdline, no solo bwrap y el agente.
test.skipIf(!canConfine)('bwrap real: ningún proceso en marcha lleva valores del entorno en su cmdline', async () => {
  const root = mkdtempSync('/tmp/fab-env-all-');
  const names = ['ANTHROPIC_API_KEY', 'DB_URL', 'CANARIO'];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  try {
    expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0);
    process.env.ANTHROPIC_API_KEY = 'canario-api'; process.env.DB_URL = 'canario-db'; process.env.CANARIO = 'canario-no';
    const out = join(root, 'out');
    const script = `printf '%s|%s|%s' "$DB_URL" "\${CANARIO-unset}" "$ANTHROPIC_API_KEY" > ${out}; while [ ! -e ${root}/go ]; do sleep 0.05; done`;
    const adapter = { name: 'claude', command: () => ['sh', '-c', script], env: () => ({}) };
    const run = runAgent(adapter, '', root, 10_000, { confine: true, envDecl: { wsAllow: ['DB_URL'], roleEnv: ['DB_URL'] } });
    for (let i = 0; i < 100 && !Bun.file(out).size; i++) await Bun.sleep(50);
    // cmdline de todos los procesos (bwrap, sus hijos y el resto de la máquina)
    const all = Bun.spawnSync(['sh', '-c', 'for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline 2>/dev/null; echo; done']).stdout.toString();
    writeFileSync(join(root, 'go'), '');
    await run;
    expect(readFileSync(out, 'utf8')).toBe('canario-db|unset|canario-api');
    const mentioning = all.split('\n').filter(l => l.includes(root));
    expect(mentioning).not.toEqual([]); // la comprobación no es vacía: el agente y bwrap estaban en marcha
    expect(mentioning.join('\n')).not.toContain('canario');
  } finally { for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; } rmSync(root, { recursive: true, force: true }); }
});
