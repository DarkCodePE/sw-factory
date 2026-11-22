import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { configPage, type ConfigView } from '../src/web-config.ts';

// T119d · §4.2: la configuración del servidor omite rutas absolutas y deja los indicadores de credenciales del host solo al owner.
let dir: string; let store: Store;
const saved = new Map<string, string | undefined>();
const env = (k: string, v?: string) => { if (!saved.has(k)) saved.set(k, process.env[k]); if (v === undefined) delete process.env[k]; else process.env[k] = v; };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-cfgview-'));
  store = new Store(join(dir, 'f.db'));
  store.createWorkstream({ slug: 'uno', goal: 'g', repo: '/r' });
  env('GH_TOKEN', 'canario-gh'); env('JIRA_HOSTNAME', 'j.invalid'); env('ANTHROPIC_API_KEY', 'canario-anthropic'); env('TRK_TOKEN', 'canario-trk');
  writeFileSync(join(dir, 'mcp-servers.json'), JSON.stringify({ servers: { tracker: { url: 'https://api.tracker.invalid/sse', headers: { Authorization: 'Bearer ${TRK_TOKEN}' } } } }));
});
afterEach(() => { store.close(); for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } saved.clear(); rmSync(dir, { recursive: true, force: true }); });

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const render = async (view?: ConfigView) => (await configPage(store, dir, new URL('http://x/config'), esc, undefined, view)).body;

test('local (sin vista) conserva columnas y filas de credenciales y la ruta', async () => {
  const html = await render();
  expect(html).toContain('Credencial local'); expect(html).toContain('>Ruta<');
  expect(html).toContain('Jira (entorno)'); expect(html).toContain('GitHub (entorno)'); expect(html).toContain('TRK_TOKEN (definida en fab web)');
});

test('servidor, owner: ve los indicadores de credenciales pero no rutas absolutas', async () => {
  const html = await render({ credentials: true });
  expect(html).toContain('Credencial local'); expect(html).toContain('Jira (entorno)'); expect(html).toContain('TRK_TOKEN (definida en fab web)');
  expect(html).not.toContain('>Ruta<');
});

test('servidor, admin: sin indicadores de credenciales del host ni rutas, y sin valores', async () => {
  const html = await render({ credentials: false });
  for (const t of ['Credencial local', 'Detectada', 'No detectada', 'Jira (entorno)', 'GitHub (entorno)', 'definida en fab web', '>Ruta<', 'canario-']) expect(html, t).not.toContain(t);
  expect(html).toContain('TRK_TOKEN'); // el nombre sí: la config es por nombre (D-K)
});

test('la tabla de adaptadores mantiene tantas celdas como cabeceras en cada vista', async () => {
  for (const view of [undefined, { credentials: true }, { credentials: false }]) {
    const t = (await render(view)).match(/<table class="config-adapters">(.*?)<\/table>/s)![1]!;
    const heads = (t.match(/<th /g) ?? []).length;
    const row = t.match(/<tr[^>]*>(?:(?!<\/tr>).)*<td>(?:(?!<\/tr>).)*<\/tr>/s)![0];
    expect((row.match(/<td>/g) ?? []).length).toBe(heads);
  }
});
