// T72e: el pool entrega a cada rol `declarado por el perfil ∩ permitido por el workstream` y nunca deja un valor en disco ni en argv (D-K).
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdmissionDb } from '../src/admission/db.ts';
import { ThreadLinks } from '../src/admission/links.ts';
import { activityLog, runDirectory } from '../src/manifest.ts';
import { runPool, type PoolOptions } from '../src/pool.ts';
import { defaultProfile, saveProfile, type Profile } from '../src/profile.ts';
import { scrubValues } from '../src/sandbox/env.ts';
import { Store } from '../src/store.ts';

const CANARY = 'canario-secreto-4242';
let dir: string, repo: string, store: Store, out: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-poolenv-'));
  out = mkdtempSync(join(tmpdir(), 'fab-poolenv-out-')); // lo que escribe el `claude` falso: fuera de stateDir
  repo = join(dir, 'repo');
  for (const argv of [['init', '-q', '-b', 'main', repo], ['-C', repo, '-c', 'user.name=test', '-c', 'user.email=t@local', 'commit', '-qm', 'init', '--allow-empty']])
    expect(Bun.spawnSync(['git', ...argv]).exitCode).toBe(0);
  store = new Store(join(dir, 'fabrica.db'));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); });

const v2 = (roles: Profile['roles'], harness = 'fake'): Profile => ({ ...defaultProfile(), schemaVersion: 2, harness, roles });
function setup(profile: Profile, allow: { env?: string[] | null; mcp?: string[] | null } = {}, agent = 'fake') {
  const { digest } = saveProfile(dir, profile);
  const ws = store.createWorkstream({ slug: 'penv', goal: 'test', repo, agent, profile: digest, requireChangeApproval: false, requireApproval: false });
  if (allow.env !== undefined) store.setWorkstreamEnvAllow(ws.id, allow.env);
  if (allow.mcp !== undefined) store.setWorkstreamMcpAllow(ws.id, allow.mcp);
  store.setWorkstreamState(ws.id, 'active');
  const change = store.createChange(ws.id, 'Cambio sintético', 'Prueba local');
  const pool = (extra: Partial<PoolOptions> = {}) => runPool(store, { workstream: ws.id, stateDir: dir, untilIdle: true, log: () => {}, ...extra });
  const first = () => store.listActivities({ changeId: change.id })[0]!;
  const meta = (id: string) => JSON.parse(readFileSync(join(runDirectory(dir, change.id), `${id}.json`), 'utf8'));
  return { ws, change, pool, first, meta };
}

async function withEnv(values: Record<string, string>, run: () => void | Promise<void>) {
  const previous = Object.keys(values).map(k => [k, process.env[k]] as const);
  Object.assign(process.env, values);
  try { await run(); } finally { for (const [k, v] of previous) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

/** Todos los ficheros de stateDir (la base incluida) y el volcado de la base, concatenados. */
function everything(): string {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'repo' && e.name !== 'worktrees') walk(p); } else out.push(readFileSync(p).toString('latin1'));
  } };
  walk(dir);
  return out.join('\n');
}

/** `claude` falso: vuelca argv, el contenido de su `--mcp-config` y el valor de TRACKER_TOKEN a ficheros del directorio de la prueba. */
function stubClaude(exit = 0) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), `#!/bin/sh
if [ ! -e "${out}/argv.txt" ]; then # solo el primer lanzamiento (la investigación)
printf '%s\\n' "$@" > "${out}/argv.txt"
prev=""; for a in "$@"; do if [ "$prev" = "--mcp-config" ]; then echo "$a" > "${out}/cfgpath.txt"; cat "$a" > "${out}/cfg.json" 2>/dev/null; fi; prev="$a"; done
printenv TRACKER_TOKEN > "${out}/token.txt"
fi
printf 'STATUS: done\\n'
case "$PWD" in */worktrees/*) git -c user.name=test -c user.email=t@local commit -qm sintetico --allow-empty || true;; esac
exit ${exit}
`, { mode: 0o755 });
  return bin;
}
const registry = (servers: unknown) => writeFileSync(join(dir, 'mcp-servers.json'), JSON.stringify({ servers }));
const TRACKER = { tracker: { url: 'https://mcp.ejemplo.dev/sse', headers: { Authorization: 'Bearer ${TRACKER_TOKEN}' } } };

test('S4: sin listas el entorno es el de hoy y la metadata no gana campos', async () => {
  const { pool, first, meta } = setup(v2({ investigate: {} }));
  await withEnv({ FABRICA_FAKE_ECHO: 'CANARIO', CANARIO: CANARY }, async () => { await pool(); });
  const a = first();
  expect(a.result).toContain(CANARY);
  expect(Object.keys(meta(a.id))).not.toContain('env');
  expect(Object.keys(meta(a.id))).not.toContain('mcp');
});

test('B1/B5: lo declarado llega al agente y su valor no queda en base, runs/ ni logs; solo [REDACTED:NOMBRE]', async () => {
  const { pool, first, meta, change } = setup(v2({ investigate: { env: ['CANARIO'] }, implement: { env: ['CANARIO'] } }), { env: ['CANARIO'] });
  await withEnv({ FABRICA_FAKE_ECHO: 'CANARIO', CANARIO: CANARY }, async () => { await pool(); });
  const a = first();
  expect(a.status).toBe('completed');
  expect(a.result).toContain('[REDACTED:CANARIO]');
  expect(meta(a.id)).toMatchObject({ env: ['CANARIO'], mcp: [], missing: [] });
  expect(everything()).not.toContain(CANARY);
  expect(readFileSync(activityLog(dir, change.id, a.id), 'utf8')).toContain('[REDACTED:CANARIO]');
});

test('B1: una variable no declarada no llega al agente sin confinar', async () => {
  const { pool, first } = setup(v2({ investigate: {} }), { env: [] });
  await withEnv({ FABRICA_FAKE_ECHO: 'CANARIO', CANARIO: CANARY }, async () => { await pool(); });
  expect(first().result).not.toContain(CANARY);
  expect(everything()).not.toContain(CANARY);
});

test('B1: con confinamiento real, la declarada llega y la no declarada no', async () => {
  if (!Bun.which('bwrap')) return;
  const { pool, first } = setup(v2({ investigate: { env: ['CANARIO'] } }), { env: ['CANARIO'] });
  await withEnv({ FABRICA_FAKE_ECHO: 'CANARIO', CANARIO: CANARY, OTRA: 'otro-valor-9999' }, async () => { await pool({ confine: true }); });
  expect(first().result).toContain('[REDACTED:CANARIO]');
  expect(everything()).not.toContain(CANARY);
});

test('B3: el perfil pide lo que el workstream no permite: ENV_NOT_ALLOWED y no se lanza nada', async () => {
  const touch = join(dir, 'lanzado');
  const { pool, first } = setup(v2({ investigate: { env: ['DB_URL'] } }), { env: [] });
  await withEnv({ FABRICA_FAKE_TOUCH: touch }, async () => { await pool(); });
  expect(first()).toMatchObject({ status: 'blocked', error: 'ENV_NOT_ALLOWED: DB_URL' });
  expect(readdirSync(dir).filter(f => f.startsWith('lanzado'))).toEqual([]);
});

test('modo declarado con solo mcp_allow: env_allow ausente cuenta como lista vacía', async () => {
  const { pool, first } = setup(v2({ investigate: { env: ['DB_URL'] } }), { mcp: [] });
  await pool();
  expect(first()).toMatchObject({ status: 'blocked', error: 'ENV_NOT_ALLOWED: DB_URL' });
});

test('MCP_NOT_ALLOWED, MCP_UNKNOWN y MCP_NOT_CONFINABLE bloquean sin lanzar', async () => {
  registry({ ...TRACKER, local: { command: ['/usr/bin/true'] } });
  const bin = stubClaude(97);
  const cases: Array<[string[], { env?: string[]; mcp?: string[] }, string, boolean]> = [
    [['tracker'], { env: ['TRACKER_TOKEN'], mcp: [] }, 'MCP_NOT_ALLOWED: tracker', false],
    [['nada'], { env: [], mcp: ['nada'] }, 'MCP_UNKNOWN: nada', false],
    [['local'], { env: [], mcp: ['local'] }, 'MCP_NOT_CONFINABLE: local', true],
  ];
  for (const [mcp, allow, error, confine] of cases) {
    const { pool, first } = setup(v2({ investigate: { harness: 'claude', mcp } }, 'claude'), allow, 'claude');
    await withEnv({ PATH: `${bin}:${process.env.PATH}`, FABRICA_HOME: dir }, async () => { await pool({ confine, acceptAgentBinaries: true }); });
    expect(first()).toMatchObject({ status: 'blocked', error });
    expect(existsSync(join(out, 'argv.txt'))).toBe(false);
    store.close(); rmSync(join(dir, 'fabrica.db'), { force: true }); store = new Store(join(dir, 'fabrica.db'));
  }
});

test('B7/B8: argv con ruta de config y sin valores; la config lleva referencias sin resolver; el valor va por el entorno y el fichero se borra', async () => {
  registry(TRACKER);
  const bin = stubClaude();
  const { pool, first, meta } = setup(v2({ investigate: { harness: 'claude', env: ['TRACKER_TOKEN'], mcp: ['tracker'] } }, 'claude'), { env: ['TRACKER_TOKEN'], mcp: ['tracker'] }, 'claude');
  await withEnv({ PATH: `${bin}:${process.env.PATH}`, FABRICA_HOME: dir, TRACKER_TOKEN: CANARY }, async () => { await pool({ acceptAgentBinaries: true }); });
  const argv = readFileSync(join(out, 'argv.txt'), 'utf8');
  expect(argv).toContain('--strict-mcp-config');
  expect(argv).not.toContain(CANARY);
  const cfg = readFileSync(join(out, 'cfg.json'), 'utf8');
  expect(cfg).not.toContain(CANARY);
  expect(JSON.parse(cfg).mcpServers.tracker).toMatchObject({ url: 'https://mcp.ejemplo.dev/sse', headers: { Authorization: 'Bearer ${TRACKER_TOKEN}' } });
  expect(readFileSync(join(out, 'token.txt'), 'utf8').trim()).toBe(CANARY);
  expect(existsSync(readFileSync(join(out, 'cfgpath.txt'), 'utf8').trim())).toBe(false);
  expect(meta(first().id)).toMatchObject({ env: ['TRACKER_TOKEN'], mcp: ['tracker'] });
  expect(everything()).not.toContain(CANARY);
});

test('B8: modo declarado y rol sin mcp: --strict-mcp-config con una configuración sin servidores', async () => {
  const bin = stubClaude();
  const { pool } = setup(v2({ investigate: { harness: 'claude' } }, 'claude'), { env: [] }, 'claude');
  await withEnv({ PATH: `${bin}:${process.env.PATH}`, FABRICA_HOME: dir }, async () => { await pool({ acceptAgentBinaries: true }); });
  expect(readFileSync(join(out, 'argv.txt'), 'utf8')).toContain('--strict-mcp-config');
  expect(JSON.parse(readFileSync(join(out, 'cfg.json'), 'utf8'))).toEqual({ mcpServers: {} });
});

test('S4: sin listas no se pasa ninguna configuración MCP', async () => {
  const bin = stubClaude();
  const { pool } = setup(v2({ investigate: { harness: 'claude' } }, 'claude'), {}, 'claude');
  await withEnv({ PATH: `${bin}:${process.env.PATH}`, FABRICA_HOME: dir }, async () => { await pool({ acceptAgentBinaries: true }); });
  expect(readFileSync(join(out, 'argv.txt'), 'utf8')).not.toContain('--mcp-config');
});

test('el fichero de configuración MCP no existe al acabar un turno que falla', async () => {
  registry(TRACKER);
  const bin = stubClaude(3);
  const { pool } = setup(v2({ investigate: { harness: 'claude', env: ['TRACKER_TOKEN'], mcp: ['tracker'] } }, 'claude'), { env: ['TRACKER_TOKEN'], mcp: ['tracker'] }, 'claude');
  await withEnv({ PATH: `${bin}:${process.env.PATH}`, FABRICA_HOME: dir, TRACKER_TOKEN: CANARY }, async () => { await pool({ acceptAgentBinaries: true }); });
  expect(existsSync(readFileSync(join(out, 'cfgpath.txt'), 'utf8').trim())).toBe(false);
  expect(everything()).not.toContain(CANARY);
});

test('un registro MCP inválido bloquea la activity nombrando el campo', async () => {
  registry({ tracker: { url: 'https://x.dev/sse', headers: { Authorization: 'literal' } } });
  const { pool, first } = setup(v2({ investigate: { harness: 'claude', mcp: ['tracker'] } }, 'claude'), { env: [], mcp: ['tracker'] }, 'claude');
  await pool({ acceptAgentBinaries: true });
  expect(first()).toMatchObject({ status: 'blocked', error: expect.stringMatching(/^MCP_REGISTRY_INVALID: .*headers/) });
});

test('variable permitida y no definida: corre, la metadata la lista en missing y hay un evento warning', async () => {
  const { pool, first, meta, ws } = setup(v2({ investigate: { env: ['NO_DEFINIDA'] } }), { env: ['NO_DEFINIDA'] });
  delete process.env.NO_DEFINIDA;
  await pool();
  expect(first().status).toBe('completed');
  expect(meta(first().id)).toMatchObject({ env: [], missing: ['NO_DEFINIDA'] });
  expect(store.listEvents(ws.id).filter(e => e.severity === 'warning').map(e => String(e.message))).toEqual([expect.stringContaining('NO_DEFINIDA')]);
});

test('B4: un change de canal no recibe lo declarado ni servidores MCP; uno local con el mismo perfil, sí', async () => {
  if (!Bun.which('bwrap')) return;
  const profile = v2({ investigate: { env: ['CANARIO'] }, implement: { env: ['CANARIO'] } });
  const run = async (channel: boolean) => {
    const { pool, first, meta, change } = setup(profile, { env: ['CANARIO'] });
    if (channel) {
      const adm = new AdmissionDb(store), thread = 'github:demo/t72#1';
      adm.db.query('INSERT INTO adm_threads(id, source, first_seen) VALUES (?,?,?)').run(thread, 'github:demo/t72', 'x');
      new ThreadLinks(adm).link(thread, change.id);
    }
    await withEnv({ FABRICA_FAKE_ECHO: 'CANARIO', CANARIO: CANARY }, async () => { await pool({ live: false, confine: false }); });
    return { a: first(), m: meta(first().id) };
  };
  const local = await run(false);
  expect(local.m.env).toEqual(['CANARIO']);
  store.close(); rmSync(join(dir, 'fabrica.db'), { force: true }); store = new Store(join(dir, 'fabrica.db'));
  const chan = await run(true);
  expect(chan.m).toMatchObject({ env: [], mcp: [] });
  expect(chan.a.result ?? '').not.toContain(CANARY);
  expect(chan.a.result ?? '').not.toContain('[REDACTED:CANARIO]');
});

test('scrubValues sustituye cada valor de 8 o más caracteres y deja el resto', () => {
  expect(scrubValues(`a ${CANARY} b ${CANARY}`, { TOKEN: CANARY })).toBe('a [REDACTED:TOKEN] b [REDACTED:TOKEN]');
  expect(scrubValues('corto 123', { N: '123' })).toBe('corto 123');
  expect(scrubValues('x', {})).toBe('x');
});

test('captura sin confinar: FABRICA_SCRUB_NAMES lee los valores de su entorno y la salida y el log salen limpios', async () => {
  const log = join(dir, 'cap.log');
  const p = Bun.spawn([process.execPath, '--no-env-file', 'src/manifest-capture.ts', log, 'sh', '-c', 'printf "%s" "$CAP_SECRETO"'], {
    env: { PATH: process.env.PATH ?? '', FABRICA_SCRUB_NAMES: 'CAP_SECRETO', CAP_SECRETO: CANARY }, stdout: 'pipe', stderr: 'pipe' });
  expect(await new Response(p.stdout).text()).toBe('[REDACTED:CAP_SECRETO]');
  expect(await p.exited).toBe(0);
  expect(readFileSync(log, 'utf8')).toBe('[REDACTED:CAP_SECRETO]');
});
