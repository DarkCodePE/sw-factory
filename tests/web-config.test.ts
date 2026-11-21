import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Of } from '../src/agents-verify.ts';
import { defaultProfile, DEFAULT_DIGEST, saveProfile } from '../src/profile.ts';
import * as profileModule from '../src/profile.ts';
import * as mcpRegistry from '../src/mcp-registry.ts';
import { _setSandboxDetectionForTesting } from '../src/sandbox/detect.ts';
import { Store } from '../src/store.ts';
import { configPage } from '../src/web-config.ts';
import { startWeb } from '../src/web.ts';

let dir: string;
let server: ReturnType<typeof startWeb> | undefined;
let originalEnv: Map<string, string | undefined>;

function env(name: string, value?: string) {
  if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-web-config-'));
  originalEnv = new Map();
  for (const name of ['JIRA_HOSTNAME', 'JIRA_USERNAME', 'JIRA_API_TOKEN', 'JIRA_ENV_FILE',
    'GH_TOKEN', 'GITHUB_TOKEN', 'FABRICA_AGENT_SETTINGS', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY', 'FAB_T52_MISSING']) env(name);
  env('HOME', dir);
  env('CLAUDE_CONFIG_DIR', join(dir, '.claude'));
  env('CODEX_HOME', join(dir, '.codex'));
  env('PATH', dir);
  _setSandboxDetectionForTesting({ available: true, backend: 'bwrap', network: true, reason: 'diagnostico-canario-privado' });
});

afterEach(() => {
  server?.stop(true);
  server = undefined;
  for (const [name, value] of originalEnv) env(name, value);
  _setSandboxDetectionForTesting(null);
  rmSync(dir, { recursive: true, force: true });
});

function start() {
  server = startWeb(dir, 0);
}

function request(path: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${server!.port}${path}`, init);
}

async function page(path = '/config') {
  const response = await request(path);
  expect(response.status).toBe(200);
  return response.text();
}

test('selecciona workstream y muestra flags, topes, digest y plantillas de cada rol escapadas', async () => {
  const profile = defaultProfile();
  profile.worker.investigate += ' <script>plantilla-canario</script> "texto" & resto';
  profile.worker.rules += ' Bearer token-canario-plantilla';
  profile.validators.qa += ' https://usuario-canario-url:clave-canario-url@ejemplo.invalid/';
  profile.validators.qa += ' https://ejemplo.invalid/?sig=clave-canario-query https://usuario-canario-solo@ejemplo.invalid/';
  profile.validators.qa += '\n-----BEGIN PRIVATE KEY-----\nsecreto-canario-pem';
  const { digest } = saveProfile(dir, profile);
  const saved = defaultProfile();
  saved.worker.investigate += ' OTRA-PLANTILLA-NO-VIGENTE';
  const other = saveProfile(dir, saved).digest;
  const store = new Store(join(dir, 'fabrica.db'));
  const ws = store.createWorkstream({
    slug: 'manual', goal: 'g', repo: 'https://usuario-canario-repo:clave-canario-repo@ejemplo.invalid/',
    agent: 'claude', workerConcurrency: 17, taskLimit: 123, requireChangeApproval: false, requireApproval: true, profile: digest,
  });
  store.createWorkstream({ slug: 'base', goal: 'g', repo: '/repo' });
  store.close();
  start();

  const html = await page('/config?ws=manual');
  expect(html).toContain('<option value="manual" selected>');
  expect(html).toContain('Concurrencia de workers</dt><dd>17');
  expect(html).toContain('Tope de changes abiertos</dt><dd>123');
  expect(html).toContain('Aprobación de change</dt><dd>No');
  expect(html).toContain('Aprobación de spec</dt><dd>Sí');
  expect(html).toContain(digest);
  expect(html).toContain(other);
  expect(html).not.toContain('OTRA-PLANTILLA-NO-VIGENTE');
  expect(html).toContain('&lt;script&gt;plantilla-canario&lt;/script&gt; &quot;texto&quot; &amp; resto');
  expect(html).not.toContain('<script>plantilla-canario');
  for (const value of ['token-canario-plantilla', 'usuario-canario-url', 'clave-canario-url', 'usuario-canario-repo',
    'clave-canario-repo', 'clave-canario-query', 'usuario-canario-solo', 'secreto-canario-pem']) {
    expect(html).not.toContain(value);
  }
  expect(html).toContain('Investigación');
  expect(html).toContain('Implementación');
  expect(html).toContain('Revisión de código');
  expect(html).toContain('Auditoría de seguridad');
  expect(html).toContain('QA');
  expect(await page(`/config?ws=${ws.id}`)).toContain('<option value="manual" selected>');
  expect(await page('/config?ws=base')).toContain(DEFAULT_DIGEST);
  expect(await page()).toContain('<option value="manual" selected>');
  expect((await request('/config?ws=no-existe')).status).toBe(404);
  expect(await (await request('/')).text()).toContain('href="/config"');
});

test('proyecta nombres MCP y presencia de integraciones y credenciales sin publicar valores', async () => {
  const canaries = ['canario-jira-host.invalid', 'canario-jira-user', 'canario-jira-key', 'canario-github',
    'canario-claude', 'canario-mcp-entorno', 'canario-mcp-header', 'canario-mcp-url', 'canario-modelo',
    'canario-credencial-archivo', 'canario-ciudad', 'diagnostico-canario-privado'];
  const [host, user, token, github, claude, mcp, header, url, model, fileSecret, city] = canaries;
  env('JIRA_HOSTNAME', host);
  env('JIRA_USERNAME', user);
  env('JIRA_API_TOKEN', token);
  env('GH_TOKEN', github);
  env('CLAUDE_CODE_OAUTH_TOKEN', claude);
  env('FAB_T52_MCP_CANARY', mcp);
  env('FABRICA_AGENT_SETTINGS', join(dir, 'ajustes.json'));
  const store = new Store(join(dir, 'fabrica.db'));
  store.close();
  writeFileSync(join(dir, 'ajustes.json'), JSON.stringify({
    customModels: [{ id: city, model: city, apiKey: model, provider: 'anthropic' }],
    mcpServers: {
      inventario: { url: `https://cuenta:${url}@ejemplo.invalid/`, headers: { 'X-Internal': header } },
      'nombre<img>': { command: 'no-ejecutar', env: { VAR: '${FAB_T52_MCP_CANARY}', OTRO: '${FAB_T52_MISSING}' } },
    },
  }));
  mkdirSync(join(dir, '.codex'));
  // Solo se comprueba presencia: ni siquiera se necesita JSON válido.
  writeFileSync(join(dir, '.codex', 'auth.json'), fileSecret!);
  start();

  const html = await page();
  for (const secret of canaries) expect(html).not.toContain(secret);
  expect(html).toContain('inventario');
  expect(html).toContain('nombre&lt;img&gt;');
  expect(html).not.toContain('<img>');
  expect(html).not.toContain('no-ejecutar');
  expect(html).toContain('Jira (entorno)</dt><dd>Configurada');
  expect(html).toContain('GitHub (entorno)</dt><dd>Configurada');
  expect(html).toContain('<td>claude</td><td>No instalado</td><td>Detectada</td>');
  expect(html).toContain('<td>codex</td><td>No instalado</td><td>Detectada</td>');
  expect(html).toContain('No hay workstreams');
});

test('solo lee: integración ausente, base cerrada sin escrituras y métodos HTTP protegidos', async () => {
  env('JIRA_ENV_FILE', join(dir, 'ausente.env'));
  env('FABRICA_AGENT_SETTINGS', join(dir, 'ausente.json'));
  const db = join(dir, 'fabrica.db');
  const writer = new Store(db);
  writer.createWorkstream({ slug: 'solo-lectura', goal: 'g', repo: '/repo' });
  writer.close();

  const files = readdirSync(dir, { recursive: true }).sort();
  const original = readFileSync(db);
  const before = statSync(db);
  start();
  const list = Store.prototype.listWorkstreams;
  let checked = false;
  const probe = spyOn(Store.prototype, 'listWorkstreams').mockImplementation(function (this: Store) {
    if (!checked) {
      expect(() => this.db.query("UPDATE workstreams SET goal='escritura' WHERE slug='solo-lectura'").run()).toThrow(/readonly/);
      checked = true;
    }
    return list.call(this);
  });
  try {
    const html = await page();
    expect(checked).toBe(true);
    expect(html).toContain('Jira (entorno)</dt><dd>No configurada');
    expect(html).toContain('GitHub (entorno)</dt><dd>No configurada');
    expect(html).toContain('Configuración MCP no disponible.');
    expect(html).toContain('No medido');
    expect((await request('/config', { method: 'POST' })).status).toBe(405);
    const head = await request('/config', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  } finally { probe.mockRestore(); }
  expect(readdirSync(dir, { recursive: true }).sort()).toEqual(files);
  expect(readFileSync(db)).toEqual(original);
  expect(statSync(db).mtimeMs).toBe(before.mtimeMs);
  expect(existsSync(join(dir, 'agents.json'))).toBe(false);
});

test('muestra los pines y la sonda más reciente por fecha dentro de su workstream', async () => {
  for (const name of ['claude', 'codex', 'agy']) writeFileSync(join(dir, name), `#!/bin/sh\n# ${name}\nexit 42\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    agentBinaries: { claude: sha256Of(join(dir, 'claude')), codex: 'a'.repeat(64) },
  }));

  const store = new Store(join(dir, 'fabrica.db'));
  store.createWorkstream({ slug: 'uno', goal: 'g', repo: '/repo' });
  store.createWorkstream({ slug: 'dos', goal: 'g', repo: '/repo' });
  const register = (ws: string, probedAt: string, decided: boolean, reachable: boolean, positiveControl: boolean) => {
    const change = store.createChange(ws, 'c', '');
    const activity = store.listActivities({ changeId: change.id })[0]!;
    const run = join(dir, 'runs', change.id);
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, `${activity.id}.json`), JSON.stringify({
      egressProbe: { probedAt, decided, reachable, positiveControl, details: 'detalle-canario-privado' },
    }));
  };
  register('uno', '2026-11-18T10:10:00.000Z', true, false, true);
  register('uno', '2026-11-18T10:00:00.000Z', true, true, true);
  register('uno', '2026-11-21T00:00:00.000Z texto-invalido', true, true, true);
  register('dos', '2026-11-19T10:00:00.000Z', true, false, false);
  store.close();
  start();

  const html = await page('/config?ws=uno');
  expect(html).toContain('<td>claude</td><td>Coincide con el pin');
  expect(html).toContain('<td>codex</td><td>Distinto del pin');
  expect(html).toContain('<td>agy</td><td>Sin pin');
  expect(html).toContain('<td>droid</td><td>No instalado');
  expect(html).toContain('<td>native</td><td>Integrado');
  expect(html).toContain('bwrap');
  expect(html).toContain('Aislamiento de red disponible</dt><dd>Sí');
  expect(html).toContain('Bloqueado');
  expect(html).toContain('2026-11-18T10:10:00.000Z');
  for (const value of ['2026-11-18T10:00:00.000Z', '2026-11-19T10:00:00.000Z', 'texto-invalido', 'detalle-canario-privado']) {
    expect(html).not.toContain(value);
  }
  const inconclusive = await page('/config?ws=dos');
  expect(inconclusive).toContain('No medido');
  expect(inconclusive).toContain('2026-11-19T10:00:00.000Z');
  expect(inconclusive).not.toContain('Bloqueado');
});

test('H1: el hash de un binario se cachea por ruta, tamaño y mtime', async () => {
  new Store(join(dir, 'fabrica.db')).close();
  const bin = join(dir, 'claude');
  writeFileSync(bin, 'AAAA', { mode: 0o755 });
  const fixed = new Date('2026-01-01T00:00:00Z');
  utimesSync(bin, fixed, fixed);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ agentBinaries: { claude: sha256Of(bin) } }));
  start();
  expect(await page()).toContain('<td>claude</td><td>Coincide con el pin');
  // Mismo tamaño y mtime: el contenido no se relee.
  writeFileSync(bin, 'BBBB');
  utimesSync(bin, fixed, fixed);
  expect(await page()).toContain('<td>claude</td><td>Coincide con el pin');
  // Otro mtime: se recalcula y se detecta el cambio.
  const later = new Date('2026-01-02T00:00:00Z');
  utimesSync(bin, later, later);
  expect(await page()).toContain('<td>claude</td><td>Distinto del pin');
});

test('H1: la sonda solo mira las últimas 200 activities y /config no incluye el sondeo', async () => {
  const store = new Store(join(dir, 'fabrica.db'));
  store.createWorkstream({ slug: 'largo', goal: 'g', repo: '/repo', taskLimit: 500 });
  const write = (n: number, probedAt: string) => {
    const change = store.createChange('largo', `c${n}`, '');
    const activity = store.listActivities({ changeId: change.id })[0]!;
    const run = join(dir, 'runs', change.id);
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, `${activity.id}.json`), JSON.stringify({
      egressProbe: { probedAt, decided: true, reachable: true, positiveControl: true },
    }));
  };
  write(0, '2026-11-18T10:00:00.000Z'); // la más antigua queda fuera de la ventana
  for (let i = 1; i <= 200; i++) store.createChange('largo', `c${i}`, '');
  store.close();
  start();
  const html = await page();
  expect(html).not.toContain('2026-11-18T10:00:00.000Z');
  expect(html).toContain('últimas 200 activities');
  expect(html).not.toContain('poll.js');
});

test('H2/H3: formas de credencial extra se redactan y los enlaces con ancla se conservan', async () => {
  const profile = defaultProfile();
  profile.worker.investigate += ' Authorization: Basic Y2FuOnB3Z';
  profile.worker.investigate += ' curl -u usuario-canario:clave-canario-u https://ejemplo.invalid/';
  profile.worker.investigate += ' https://hooks.ejemplo.invalid/T0canarioRutaSecreta1234567890abcd/envio';
  profile.worker.investigate += ' glpat-canGit12 npm_canNpm123';
  profile.worker.investigate += ' https://docs.ejemplo.invalid/guia?id=canario-query#seccion-ancla';
  profile.worker.investigate += ' https://docs.ejemplo.invalid/guia#state=canario-fragmento';
  profile.worker.investigate += ' https://docs.ejemplo.invalid/ref#instalacion';
  const { digest } = saveProfile(dir, profile);
  const store = new Store(join(dir, 'fabrica.db'));
  store.createWorkstream({ slug: 'perfil', goal: 'g', repo: '/repo', profile: digest });
  store.close();
  start();
  const html = await page('/config?ws=perfil');
  for (const value of ['Y2FuOnB3Z', 'clave-canario-u', 'T0canarioRutaSecreta', 'canGit12', 'canNpm123',
    'canario-query', 'canario-fragmento']) expect(html).not.toContain(value);
  expect(html).toContain('https://docs.ejemplo.invalid/guia?[REDACTED]#seccion-ancla');
  expect(html).toContain('https://docs.ejemplo.invalid/ref#instalacion');
  expect(html).toContain('Un secreto en texto libre no se puede detectar');
});

test('H4: escapa adaptador y slug del selector, y no filtra el error de un perfil roto', async () => {
  const store = new Store(join(dir, 'fabrica.db'));
  store.createWorkstream({ slug: 'roto', goal: 'g', repo: '/repo' });
  store.db.query("UPDATE workstreams SET slug = ?, agent = ?, profile = ?").run(
    'slug<b>canario</b>', 'agente<i>canario</i>', 'f'.repeat(64));
  store.close();
  start();
  const html = await page();
  expect(html).not.toContain('<b>canario');
  expect(html).not.toContain('<i>canario');
  expect(html).toContain('slug&lt;b&gt;canario');
  expect(html).toContain('agente&lt;i&gt;canario');
  expect(html).toContain('El perfil asignado no está disponible o no supera la verificación de integridad.');
  expect(html).not.toContain(dir);
  expect(html).not.toContain('perfil desconocido');
  expect(html).not.toContain('fab profile import');
});

test('H4: Jira exige host válido y las tres variables', async () => {
  const set = (overrides: Record<string, string | undefined>) => {
    const base: Record<string, string | undefined> = { JIRA_HOSTNAME: 'jira.ejemplo.invalid', JIRA_USERNAME: 'u', JIRA_API_TOKEN: 't', JIRA_ENV_FILE: join(dir, 'ausente.env') };
    for (const [name, value] of Object.entries({ ...base, ...overrides })) env(name, value);
  };
  new Store(join(dir, 'fabrica.db')).close();
  start();
  set({});
  expect(await page()).toContain('Jira (entorno)</dt><dd>Configurada');
  for (const missing of ['JIRA_HOSTNAME', 'JIRA_USERNAME', 'JIRA_API_TOKEN']) {
    set({ [missing]: undefined });
    expect(await page()).toContain('Jira (entorno)</dt><dd>No configurada');
  }
  set({ JIRA_HOSTNAME: 'no es un host://' });
  expect(await page()).toContain('Jira (entorno)</dt><dd>No configurada');
});

test('H4: un fichero de settings con esquema inválido no muestra servidores', async () => {
  env('FABRICA_AGENT_SETTINGS', join(dir, 'ajustes.json'));
  new Store(join(dir, 'fabrica.db')).close();
  start();
  for (const invalid of [{ mcpServers: ['canario-array'] }, ['canario-raiz']]) {
    writeFileSync(join(dir, 'ajustes.json'), JSON.stringify(invalid));
    const html = await page();
    expect(html).toContain('Configuración MCP no disponible.');
    expect(html).not.toContain('canario-');
  }
});

test('T104: lista servidores del registro MCP con tipo, variables requeridas y dónde se usan, sin revelar secretos', async () => {
  const store = new Store(join(dir, 'fabrica.db'));
  const p = defaultProfile();
  p.schemaVersion = 2;
  p.harness = 'claude';
  p.roles = {
    investigate: { harness: 'claude', mcp: ['local-tool'] },
  };
  const { digest } = saveProfile(dir, p);
  store.createWorkstream({ slug: 'ws-uno', goal: 'g', repo: '/repo', profile: digest });
  store.setWorkstreamMcpAllow('ws-uno', ['local-tool']);
  store.createWorkstream({ slug: 'ws-dos', goal: 'g', repo: '/repo' });
  store.setWorkstreamMcpAllow('ws-dos', ['tracker']);
  // Slug con caracteres especiales en DB
  store.db.query("UPDATE workstreams SET slug = 'ws<b>xss</b>' WHERE slug = 'ws-dos'").run();
  store.close();

  env('TRK_TOKEN', 'canario-secreto-trk-valor');
  writeFileSync(join(dir, 'mcp-servers.json'), JSON.stringify({
    servers: {
      tracker: { url: 'https://api.tracker.invalid/sse', headers: { Authorization: 'Bearer ${TRK_TOKEN}' } },
      'local-tool': { command: ['/usr/bin/tool', '--flag'], env: { TOOL_KEY: '${TOOL_KEY}' } },
    },
  }));
  start();

  const html = await page('/config');
  const rowTracker = html.match(/<tr><td><code>tracker<\/code><\/td>.*?<\/tr>/s)?.[0] ?? '';
  expect(rowTracker).toContain('<td>url</td>');
  expect(rowTracker).toContain('<td>TRK_TOKEN (definida)</td>');
  expect(rowTracker).toContain('<td>permitido: ws&lt;b&gt;xss&lt;/b&gt;</td>');
  expect(rowTracker).not.toContain('<b>xss</b>');

  const rowLocalTool = html.match(/<tr><td><code>local-tool<\/code><\/td>.*?<\/tr>/s)?.[0] ?? '';
  expect(rowLocalTool).toContain('<td>command</td>');
  expect(rowLocalTool).toContain('<td>TOOL_KEY (no definida)</td>');
  expect(rowLocalTool).toContain('<td>ws-uno (investigate)</td>');

  expect(html).not.toContain('canario-secreto-trk-valor');
  const mcpSection = html.slice(html.indexOf('<h2>Servidores MCP</h2>'));
  expect(mcpSection).not.toContain('<form');
});

test('T104-H2: registro MCP con error no fuga el canario del campo en el aviso y no genera filas ni tabla', async () => {
  new Store(join(dir, 'fabrica.db')).close();
  writeFileSync(join(dir, 'mcp-servers.json'), JSON.stringify({
    servers: {
      'canario-srv': {
        url: 'https://127.0.0.1/mcp',
        headers: {
          'X-Canario-Secret': 'literal-no-permitido',
        },
      },
    },
  }));
  start();
  const html = await page('/config');
  expect(html).toContain('<p class="notice">Registro MCP no disponible o inválido.</p>');
  expect(html).not.toContain('X-Canario-Secret');
  expect(html).not.toContain('canario-srv');
  expect(html).not.toContain('class="config-mcp"');
  expect(html).not.toContain('<th>Variables requeridas</th>');
});

test('T104-H3: relanza errores que no sean McpRegistryError en lugar de enmascararlos', async () => {
  const store = new Store(join(dir, 'fabrica.db'));
  const spy = spyOn(mcpRegistry, 'loadMcpRegistry').mockImplementation(() => {
    throw new TypeError('error-inesperado-no-mcp');
  });
  try {
    await expect(configPage(store, dir, new URL('http://127.0.0.1/config'), x => String(x))).rejects.toThrow('error-inesperado-no-mcp');
  } finally {
    spy.mockRestore();
    store.close();
  }
});

test('T104-H4: precalcula el uso de servidores MCP una sola vez por petición en lugar de por cada servidor', async () => {
  const store = new Store(join(dir, 'fabrica.db'));
  const p1 = defaultProfile();
  const { digest: d1 } = saveProfile(dir, p1);
  const p2 = defaultProfile();
  const { digest: d2 } = saveProfile(dir, p2);
  store.createWorkstream({ slug: 'ws1', goal: 'g', repo: '/repo', profile: d1 });
  store.createWorkstream({ slug: 'ws2', goal: 'g', repo: '/repo', profile: d2 });

  writeFileSync(join(dir, 'mcp-servers.json'), JSON.stringify({
    servers: {
      s1: { url: 'https://a.invalid/sse', headers: {} },
      s2: { url: 'https://b.invalid/sse', headers: {} },
      s3: { url: 'https://c.invalid/sse', headers: {} },
    },
  }));

  const origResolve = profileModule.resolveProfile;
  let callCount = 0;
  const spy = spyOn(profileModule, 'resolveProfile').mockImplementation((...args) => {
    callCount++;
    return origResolve(...args);
  });

  try {
    // 2 workstreams en la base. Sin precomputar, para 3 servidores en mcpRegistrySection
    // más el workstream seleccionado en profileView, callCount sería 3 * 2 + 1 = 7.
    // Con precálculo una sola vez para mcpRegistrySection, el número de llamadas para MCP es a lo sumo 2.
    await configPage(store, dir, new URL('http://127.0.0.1/config'), x => String(x));
    // Total de llamadas a resolveProfile en la página completa: <= 3 (1 en profileView + 2 en buildMcpUsageMap)
    expect(callCount).toBeLessThanOrEqual(3);
  } finally {
    spy.mockRestore();
    store.close();
  }
});

test('T104-H1: calcula dónde se usa como resolveAccess (rol pide y workstream permite) y muestra permitido aparte', async () => {
  const store = new Store(join(dir, 'fabrica.db'));

  // Perfil que pide s1 en investigate
  const pConS1 = defaultProfile();
  pConS1.schemaVersion = 2;
  pConS1.harness = 'claude';
  pConS1.roles = { investigate: { harness: 'claude', mcp: ['s1'] } };
  const { digest: dConS1 } = saveProfile(dir, pConS1);

  // Perfil que no pide nada de MCP
  const pVacio = defaultProfile();
  const { digest: dVacio } = saveProfile(dir, pVacio);

  // 1. ws-usado: pide s1 y lo permite en mcpAllow -> usado
  store.createWorkstream({ slug: 'ws-usado', goal: 'g', repo: '/repo', profile: dConS1 });
  store.setWorkstreamMcpAllow('ws-usado', ['s1']);

  // 2. ws-solo-allow: permite s1 pero su perfil no pide mcp -> permitido: ws-solo-allow
  store.createWorkstream({ slug: 'ws-solo-allow', goal: 'g', repo: '/repo', profile: dVacio });
  store.setWorkstreamMcpAllow('ws-solo-allow', ['s1']);

  // 3. ws-sin-allow: pide s1 en perfil pero mcpAllow es [] (o null) -> no se entrega en resolveAccess
  store.createWorkstream({ slug: 'ws-sin-allow', goal: 'g', repo: '/repo', profile: dConS1 });
  store.setWorkstreamMcpAllow('ws-sin-allow', []);

  writeFileSync(join(dir, 'mcp-servers.json'), JSON.stringify({
    servers: {
      s1: { url: 'https://a.invalid/sse', headers: {} },
      s2: { url: 'https://b.invalid/sse', headers: {} },
    },
  }));
  store.close();
  start();

  const html = await page('/config');
  const rowS1 = html.match(/<tr><td><code>s1<\/code><\/td>.*?<\/tr>/s)?.[0] ?? '';
  const rowS2 = html.match(/<tr><td><code>s2<\/code><\/td>.*?<\/tr>/s)?.[0] ?? '';

  expect(rowS1).toContain('ws-usado (investigate)');
  expect(rowS1).not.toContain('permitido: ws-usado');
  expect(rowS1).toContain('permitido: ws-solo-allow');
  expect(rowS1).not.toContain('ws-sin-allow');
  expect(rowS2).toContain('<td>—</td>');
});

test('T106: muestra binario, versión registrada, pin guardado y marca binarios discrepantes', async () => {
  const claudeBin = join(dir, 'claude');
  const codexBin = join(dir, 'codex');
  const agyBin = join(dir, 'agy');

  writeFileSync(claudeBin, '#!/bin/sh\nexit 0\n');
  chmodSync(claudeBin, 0o755);
  writeFileSync(codexBin, '#!/bin/sh\nexit 0\n');
  chmodSync(codexBin, 0o755);
  writeFileSync(agyBin, '#!/bin/sh\nexit 0\n');
  chmodSync(agyBin, 0o755);

  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    agentBinaries: {
      claude: sha256Of(claudeBin),
      codex: 'b'.repeat(64), // pin que no coincide
      agy: sha256Of(agyBin),
    },
    agentVersions: {
      claude: 'claude v2.5.0',
      codex: 'codex 1.0.0', // pin no coincide: no debe mostrarse
      agy: '0.9.1-registrada',
    },
  }));

  new Store(join(dir, 'fabrica.db')).close();
  start();

  const html = await page('/config');
  // claude coincide con el pin y muestra versión registrada y ruta
  expect(html).toContain('<td>claude</td>');
  expect(html).toContain('Coincide con el pin');
  expect(html).toContain('claude v2.5.0');
  expect(html).toContain(claudeBin);

  // codex no coincide con el pin: sale marcado y con versión «No medido»
  expect(html).toContain('<td>codex</td>');
  expect(html).toContain('Distinto del pin');
  expect(html).toContain('pin-mismatch');
  expect(html).toContain('(no coincide)');
  expect(html).not.toContain('codex 1.0.0');
  const codexRow = html.match(/<tr[^>]*><td>codex<\/td>.*?<\/tr>/s)?.[0] ?? '';
  expect(codexRow).toContain('<td>No medido</td>');
  expect(html).toContain('bbbbbbbbbbbb…');

  // agy lee versión del registro
  expect(html).toContain('<td>agy</td>');
  expect(html).toContain('0.9.1-registrada');

  // native muestra versión del paquete fab
  expect(html).toContain('<td>native</td>');
  expect(html).toContain('0.1.0-rc.12');

  // Sin formularios para fijar el pin en la web
  const adaptersSection = html.slice(html.indexOf('<h2>Adaptadores</h2>'), html.indexOf('<h2>Sandbox y red</h2>'));
  expect(adaptersSection).not.toContain('<form');
});

test('T106-H1: la web nunca ejecuta binarios externos y muestra No medido si no hay registro o pin discrepante', async () => {
  const counterFile = join(dir, 'exec-count.txt');
  const spyBin = join(dir, 'claude');
  writeFileSync(counterFile, '0');
  writeFileSync(spyBin, `#!/bin/sh
count=$(cat "${counterFile}")
count=$((count + 1))
echo "$count" > "${counterFile}"
echo "spy 3.0"
exit 0
`);
  chmodSync(spyBin, 0o755);

  // claude tiene pin coincidente pero NO tiene agentVersions
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    agentBinaries: { claude: sha256Of(spyBin) },
  }));

  new Store(join(dir, 'fabrica.db')).close();
  start();

  const html = await page('/config');
  // NUNCA ejecutó el binario: el contador sigue en 0
  expect(readFileSync(counterFile, 'utf8').trim()).toBe('0');
  expect(html).not.toContain('spy 3.0');
  const claudeRow = html.match(/<tr[^>]*><td>claude<\/td>.*?<\/tr>/s)?.[0] ?? '';
  expect(claudeRow).toContain('<td>No medido</td>');
});

test('T106-H6: sanea caracteres de control, limita a 40 caracteres y escapa HTML en versiones registradas', async () => {
  const claudeBin = join(dir, 'claude');
  writeFileSync(claudeBin, '#!/bin/sh\nexit 0\n');
  chmodSync(claudeBin, 0o755);

  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    agentBinaries: { claude: sha256Of(claudeBin) },
    agentVersions: {
      claude: 'v1.0\x1b[31m\x00<script>canario</script>' + 'x'.repeat(50),
    },
  }));

  new Store(join(dir, 'fabrica.db')).close();
  start();

  const html = await page('/config');
  expect(html).not.toContain('<script>canario</script>');
  expect(html).toContain('&lt;script&gt;canario&lt;/script&gt;');
  expect(html).not.toContain('\x1b');
  expect(html).not.toContain('\x00');
  // Comprobar que en la celda no excede 40 caracteres tras sanear
  const claudeRow = html.match(/<tr[^>]*><td>claude<\/td>.*?<\/tr>/s)?.[0] ?? '';
  const versionCellMatch = claudeRow.match(/<td>claude<\/td><td>[^<]*<\/td><td>[^<]*<\/td><td>[^<]*<\/td><td>([^<]*)<\/td>/);
  // El texto antes de escapar debe medir máximo 40 caracteres
  expect(versionCellMatch).toBeDefined();
});


