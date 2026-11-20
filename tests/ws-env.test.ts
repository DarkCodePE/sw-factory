import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, StoreError } from '../src/store.ts';

const entry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
let dir: string;
let db: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-ws-env-'));
  db = join(dir, 'fabrica.db');
  store = new Store(db);
  store.createWorkstream({ slug: 'w', goal: 'g', repo: dir });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

async function cli(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, '--no-env-file', entry, ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: dir, FABRICA_HOME: dir, ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
}
const rejects = (fn: () => unknown, code: StoreError['code'] = 'invalid_input') => {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(StoreError); expect((e as StoreError).code).toBe(code); return; }
  throw new Error('no lanzó');
};

test('base antigua sin las columnas: se abre y los workstreams quedan en modo anterior', () => {
  store.close();
  const raw = new Database(db);
  raw.exec('ALTER TABLE workstreams DROP COLUMN env_allow; ALTER TABLE workstreams DROP COLUMN mcp_allow;');
  raw.close();
  store = new Store(db);
  const ws = store.getWorkstream('w');
  expect(ws.envAllow).toBeNull();
  expect(ws.mcpAllow).toBeNull();
});

test('fija, vacía y restablece la lista; cada cambio deja un evento con la anterior y la nueva', () => {
  expect(store.setWorkstreamEnvAllow('w', ['B_VAR', 'A_VAR']).envAllow).toEqual(['B_VAR', 'A_VAR']);
  expect(store.setWorkstreamEnvAllow('w', []).envAllow).toEqual([]);
  expect(store.setWorkstreamEnvAllow('w', null).envAllow).toBeNull();
  expect(store.setWorkstreamMcpAllow('w', ['tracker']).mcpAllow).toEqual(['tracker']);
  const msgs = store.listEvents('w').map(e => String(e.message));
  expect(msgs).toContain('env_allow: legacy -> ["B_VAR","A_VAR"]');
  expect(msgs).toContain('env_allow: ["B_VAR","A_VAR"] -> []');
  expect(msgs).toContain('env_allow: [] -> legacy');
  expect(msgs).toContain('mcp_allow: legacy -> ["tracker"]');
});

test('rechaza nombres inválidos, prohibidos (B10), repetidos y excesivos nombrando el campo', () => {
  for (const bad of ['PATH', 'HOME', 'TMPDIR', 'NODE_OPTIONS', 'LD_PRELOAD', 'BUN_X', 'GIT_CONFIG_GLOBAL', 'FAB_ACTOR', 'FABRICA_HOME', 'minuscula', '1ABC', 'A-B', 'A=1', '']) {
    rejects(() => store.setWorkstreamEnvAllow('w', [bad]));
  }
  rejects(() => store.setWorkstreamEnvAllow('w', ['A', 'A']));
  rejects(() => store.setWorkstreamEnvAllow('w', Array.from({ length: 17 }, (_, i) => `V${i}`)));
  expect(store.setWorkstreamEnvAllow('w', Array.from({ length: 16 }, (_, i) => `V${i}`)).envAllow).toHaveLength(16);
  for (const bad of ['fab', 'Mayus', '-x', 'a b', 'a'.repeat(42)]) rejects(() => store.setWorkstreamMcpAllow('w', [bad]));
  rejects(() => store.setWorkstreamMcpAllow('w', Array.from({ length: 9 }, (_, i) => `s${i}`)));
  try { store.setWorkstreamEnvAllow('w', ['PATH']); } catch (e) { expect((e as Error).message).toContain('env_allow'); }
  expect(store.getWorkstream('w').mcpAllow).toBeNull();
  rejects(() => store.setWorkstreamEnvAllow('nada', ['A']), 'not_found');
});

test('CLI: --allow, --none, --legacy y listado con definida / no definida sin valores', async () => {
  let r = await cli(['ws', 'env', 'w', '--allow', 'DEFINIDA_X', '--allow', 'AUSENTE_X']);
  expect(r.code).toBe(0);
  r = await cli(['ws', 'env', 'w'], { DEFINIDA_X: 'canario-secreto-123' });
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/DEFINIDA_X\s+definida/);
  expect(r.out).toMatch(/AUSENTE_X\s+no definida/);
  expect(r.out + r.err).not.toContain('canario-secreto-123');
  expect((await cli(['ws', 'env', 'w', '--none'])).code).toBe(0);
  expect(new Store(db).getWorkstream('w').envAllow).toEqual([]);
  expect((await cli(['ws', 'env', 'w', '--legacy'])).code).toBe(0);
  expect(new Store(db).getWorkstream('w').envAllow).toBeNull();
  r = await cli(['ws', 'env', 'w', '--allow', 'LD_PRELOAD']);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain('LD_PRELOAD');
});

test('--import con una línea que es un valor suelto no la repite en el error', async () => {
  const f = join(dir, 'v.txt');
  writeFileSync(f, 'ghp_valorsuelto123\n');
  const r = await cli(['ws', 'env', 'w', '--import', f]);
  expect(r.code).not.toBe(0);
  expect(r.out + r.err).not.toContain('ghp_valorsuelto123');
});

test('CLI: --import lee nombres con comentarios; una línea con = falla sin cambiar la lista ni imprimir el valor (B11)', async () => {
  const ok = join(dir, 'ok.txt');
  writeFileSync(ok, '# comentario\nUNO_X\n\nDOS_X  # otro\n');
  expect((await cli(['ws', 'env', 'w', '--import', ok])).code).toBe(0);
  expect(new Store(db).getWorkstream('w').envAllow).toEqual(['UNO_X', 'DOS_X']);
  const bad = join(dir, 'bad.txt');
  writeFileSync(bad, 'TRES_X\nA=valor-canario-9\n');
  const r = await cli(['ws', 'env', 'w', '--import', bad]);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain('el fichero parece contener valores; pasa solo nombres');
  expect(r.out + r.err).not.toContain('valor-canario-9');
  expect(new Store(db).getWorkstream('w').envAllow).toEqual(['UNO_X', 'DOS_X']);
});

const registry = (...names: string[]) => writeFileSync(join(dir, 'mcp-servers.json'), JSON.stringify({ servers: Object.fromEntries(names.map(n => [n, { url: `https://${n}.example.com/mcp`, headers: {} }])) }));

test('CLI: ws mcp --allow comprueba que el nombre existe en el registro (T72b-H3)', async () => {
  registry('tracker');
  const bad = await cli(['ws', 'mcp', 'w', '--allow', 'tracker', '--allow', 'traker']);
  expect(bad.code).not.toBe(0);
  expect(bad.err).toContain('traker');
  expect(new Store(db).getWorkstream('w').mcpAllow).toBeNull();
  expect((await cli(['ws', 'mcp', 'w', '--allow', 'tracker'])).code).toBe(0);
  expect((await cli(['ws', 'mcp', 'w', '--none'])).code).toBe(0); // vaciar no pide registro
});

test('CLI: ws env --help documenta que un valor de menos de 8 caracteres no se limpia (T72e-H3)', async () => {
  expect((await cli(['--help'])).out).toContain('menos de 8 caracteres');
});

test('CLI: ws mcp --allow, --none, --legacy y rechazo de nombres inválidos', async () => {
  registry('tracker', 'docs');
  expect((await cli(['ws', 'mcp', 'w', '--allow', 'tracker', '--allow', 'docs'])).code).toBe(0);
  expect(new Store(db).getWorkstream('w').mcpAllow).toEqual(['tracker', 'docs']);
  expect((await cli(['ws', 'mcp', 'w', '--none'])).code).toBe(0);
  expect(new Store(db).getWorkstream('w').mcpAllow).toEqual([]);
  expect((await cli(['ws', 'mcp', 'w', '--legacy'])).code).toBe(0);
  expect(new Store(db).getWorkstream('w').mcpAllow).toBeNull();
  expect((await cli(['ws', 'mcp', 'w', '--allow', 'fab'])).code).not.toBe(0);
  expect((await cli(['ws', 'mcp', 'w'])).code).toBe(0);
});

test('CLI: combinar --allow con --none o --legacy es un error', async () => {
  expect((await cli(['ws', 'env', 'w', '--allow', 'A_X', '--none'])).code).not.toBe(0);
  expect((await cli(['ws', 'env', 'w', '--none', '--legacy'])).code).not.toBe(0);
});
