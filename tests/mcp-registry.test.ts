import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcpRegistry, mcpListMain } from '../src/mcp-registry.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fab-mcp-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const write = (servers: unknown, extra: object = {}) => writeFileSync(join(dir, 'mcp-servers.json'), JSON.stringify({ servers, ...extra }));
const reject = (servers: unknown, field: string, extra: object = {}) => {
  write(servers, extra);
  expect(() => loadMcpRegistry(dir)).toThrow(field);
};

test('sin fichero: registro vacío y sin error', () => {
  expect(loadMcpRegistry(dir)).toEqual({});
});

test('carga servidores válidos con sus nombres requeridos', () => {
  write({
    tracker: { url: 'https://mcp.ejemplo.dev/sse', headers: { Authorization: 'Bearer ${TRACKER_TOKEN}', 'X-Key': '${K}' } },
    local: { url: 'http://127.0.0.1:9000/mcp' },
    docs: { command: ['/usr/bin/docs-mcp', '--stdio'], env: { DOCS_TOKEN: '${DOCS_TOKEN}' } },
  });
  const r = loadMcpRegistry(dir);
  expect(Object.keys(r)).toEqual(['tracker', 'local', 'docs']);
  expect(r.tracker).toMatchObject({ kind: 'url', required: ['K', 'TRACKER_TOKEN'] });
  expect(r.local).toMatchObject({ kind: 'url', required: [] });
  expect(r.docs).toMatchObject({ kind: 'command', required: ['DOCS_TOKEN'] });
});

test('B6: rechaza valores literales y nombra el campo', () => {
  reject({ t: { url: 'https://a.dev/x', headers: { Authorization: 'Bearer abc123' } } }, 'servers.t.headers.Authorization');
  reject({ t: { url: 'https://a.dev/x', headers: { A: 'prefijo ${X}' } } }, 'servers.t.headers.A');
  reject({ t: { command: ['/bin/x'], env: { TOKEN: 'literal' } } }, 'servers.t.env.TOKEN');
  reject({ t: { command: ['/bin/x'], env: { TOKEN: 'Bearer ${X}' } } }, 'servers.t.env.TOKEN');
  reject({ t: { url: 'https://a.dev/x?token=abc' } }, 'servers.t.url');
  reject({ t: { url: 'https://a.dev/x?' } }, 'servers.t.url');
  reject({ t: { url: 'https://a.dev/x#tok' } }, 'servers.t.url');
  reject({ t: { url: 'https://user:pass@a.dev/x' } }, 'servers.t.url');
  reject({ t: { url: 'https://user@a.dev/x' } }, 'servers.t.url');
  reject({ t: { url: 'http://mcp.remoto.dev/x' } }, 'servers.t.url');
  reject({ t: { url: 'ftp://127.0.0.1/x' } }, 'servers.t.url');
  reject({ t: { url: 'no es url' } }, 'servers.t.url');
});

test('rechaza forma inválida: tipo doble, claves extra, command relativo', () => {
  reject({ t: { url: 'https://a.dev/x', command: ['/bin/x'] } }, 'servers.t');
  reject({ t: {} }, 'servers.t');
  reject({ t: { url: 'https://a.dev/x', extra: 1 } }, 'servers.t.extra');
  reject({ t: { url: 'https://a.dev/x', env: {} } }, 'servers.t.env');
  reject({ t: { command: ['/bin/x'], headers: {} } }, 'servers.t.headers');
  reject({ t: { command: ['bin/x'] } }, 'servers.t.command');
  reject({ t: { command: [] } }, 'servers.t.command');
  reject({ t: { command: ['/bin/x', 3] } }, 'servers.t.command');
  reject({ t: { url: 'https://a.dev/x', headers: { 'Bad Header': '${X}' } } }, 'servers.t.headers');
  reject({ fab: { url: 'https://a.dev/x' } }, 'servers.fab');
  reject({ 'Mal Nombre': { url: 'https://a.dev/x' } }, 'servers.Mal Nombre');
  reject([], 'servers');
  reject({}, 'mcp-servers.json', { otra: 1 });
});

test('rechaza referencias a variables prohibidas (B10)', () => {
  for (const n of ['LD_PRELOAD', 'NODE_OPTIONS', 'FAB_ACTOR', 'GIT_CONFIG_GLOBAL', 'PATH', 'HOME', 'BUN_X', 'FABRICA_HOME'])
    reject({ t: { command: ['/bin/x'], env: { A: `\${${n}}` } } }, 'servers.t.env.A');
});

test('JSON roto: error con el nombre del fichero', () => {
  writeFileSync(join(dir, 'mcp-servers.json'), '{');
  expect(() => loadMcpRegistry(dir)).toThrow('mcp-servers.json');
});

test('fab mcp list: nombres y estado, nunca valores', () => {
  write({ tracker: { url: 'https://a.dev/x', headers: { Authorization: 'Bearer ${TRK_TOKEN}' } } });
  const out: string[] = [];
  const log = console.log; console.log = (m: string) => { out.push(m); };
  process.env.TRK_TOKEN = 'canario-secreto-123';
  try { expect(mcpListMain(dir)).toBe(0); } finally { console.log = log; delete process.env.TRK_TOKEN; }
  const text = out.join('\n');
  expect(text).toContain('tracker');
  expect(text).toContain('url');
  expect(text).toContain('TRK_TOKEN');
  expect(text).toContain('definida');
  expect(text).not.toContain('canario-secreto-123');
  expect(text).not.toContain('a.dev');
});

test('fab mcp list: sin fichero y con fichero inválido', () => {
  const out: string[] = []; const err: string[] = [];
  const log = console.log, e = console.error;
  console.log = (m: string) => { out.push(m); }; console.error = (m: string) => { err.push(m); };
  try {
    expect(mcpListMain(dir)).toBe(0);
    write({ t: { url: 'http://x.dev/' } });
    expect(mcpListMain(dir)).toBe(1);
  } finally { console.log = log; console.error = e; }
  expect(out[0]).toContain('Sin servidores');
  expect(err[0]).toContain('servers.t.url');
});
