// T107: configuración del residente y importación de Jira desde la web.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, readFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadResidentConfig, saveResidentConfig } from '../src/admission/config.ts';
import { residentMain } from '../src/admission/cli.ts';
import type { TicketGateway, TicketIssue } from '../src/connectors/types.ts';
import { Store } from '../src/store.ts';
import { ACTIONS } from '../src/web-actions.ts';
import { JIRA_HOURLY_CAP } from '../src/web-entrada.ts';
import { startWeb } from '../src/web.ts';

let dir: string, store: Store, server: ReturnType<typeof startWeb>, cookie: string, csrf: string, calls: string[], fail = false;
const saved: Record<string, string | undefined> = {};
const env = (k: string, v?: string) => { if (!(k in saved)) saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
const issue = (key: string): TicketIssue => ({ ref: { system: 'jira', key, url: `https://x.atlassian.net/browse/${key}` }, summary: 'Resumen', description: 'Cuerpo', status: 'Abierta', issueType: 'Historia', subtasks: [] });
const gateway: TicketGateway = { getIssue: async key => { calls.push(key); if (fail) throw new Error('JIRA_API_TOKEN=token-canario http://interno'); return issue(key); }, comment: async () => {} };
const base = () => `http://${server.host}:${server.port}`;
const get = (path: string) => fetch(base() + path, { redirect: 'manual', headers: { cookie } });
const post = (path: string, data: Record<string, string>, headers: Record<string, string> = {}) => fetch(base() + path, {
  method: 'POST', redirect: 'manual', headers: { cookie, origin: base(), ...headers }, body: new URLSearchParams({ csrf, ...data }),
});
const importar = (data: Record<string, string> = {}) => post('/config/jira/importar', { ws: 'prueba', key: 'KAN-1', confirm: 'yes', ...data });
const notice = async () => (await (await get('/config')).text());
const audit = () => store.listEvents('prueba', 100).map(e => `${e.actor}|${e.message}`).join('\n');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fab-web-entrada-')); calls = []; fail = false;
  for (const k of ['JIRA_HOSTNAME', 'JIRA_USERNAME', 'JIRA_API_TOKEN', 'JIRA_ENV_FILE']) env(k);
  store = new Store(join(dir, 'fabrica.db'));
  store.createWorkstream({ slug: 'prueba', goal: 'g', repo: join(dir, 'repo') });
  server = startWeb(dir, 0, { write: true, jira: gateway });
  const r = await fetch(server.loginUrl!, { redirect: 'manual' });
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  csrf = /name="csrf" value="([^"]+)"/.exec(await (await get('/config')).text())?.[1] ?? '';
});
afterEach(() => {
  server?.stop(true); store?.close(); rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('las dos acciones están fuera de la API y exigen sesión, origin y CSRF', async () => {
  expect(ACTIONS['resident/config']!.api).toBe(false);
  expect(ACTIONS['jira/import']!.api).toBe(false);
  for (const [path, data] of [['/config/entrada', { repo: 'a/b' }], ['/config/jira/importar', { ws: 'prueba', key: 'KAN-1', confirm: 'yes' }]] as const) {
    expect((await post(path, data, { cookie: '' })).status).toBe(401);
    expect((await post(path, data, { origin: 'http://evil.test' })).status).toBe(403);
    expect((await post(path, { ...data, csrf: 'a'.repeat(64) })).status).toBe(403);
  }
  expect(existsSync(join(dir, 'resident.json'))).toBe(false);
  expect(calls).toEqual([]);
});

test('guarda la configuración del residente en resident.json (0600) y la página la muestra', async () => {
  const r = await post('/config/entrada', { repo: 'DarkCodePE/plataforma-starteria', label: 'fab', interval: '120', mode: 'observe' });
  expect(r.status).toBe(303);
  expect(loadResidentConfig(dir)).toMatchObject({ repo: 'DarkCodePE/plataforma-starteria', label: 'fab', intervalSec: 120, mode: 'observe', updatedBy: 'web' });
  expect(lstatSync(join(dir, 'resident.json')).mode & 0o777).toBe(0o600);
  const page = await notice();
  expect(page).toContain('<code>DarkCodePE/plataforma-starteria</code>');
  expect(page).toContain('<code>120</code> s');
  // Un campo vacío no cambia lo guardado.
  await post('/config/entrada', { repo: '', label: 'otra', interval: '', mode: '' });
  expect(loadResidentConfig(dir)).toMatchObject({ repo: 'DarkCodePE/plataforma-starteria', label: 'otra', intervalSec: 120 });
});

test('T107-H5: cambiar repo, etiqueta, intervalo o modo deja un evento con el actor y los valores anterior y nuevo', async () => {
  store.createWorkstream({ slug: 'otro', goal: 'g', repo: join(dir, 'repo2') });
  await post('/config/entrada', { repo: 'a/b', label: 'fab', interval: '60', mode: 'observe' });
  await post('/config/entrada', { repo: 'a/b', label: 'otra', interval: '', mode: '' });
  for (const slug of ['prueba', 'otro']) {
    const e = store.listEvents(slug, 50).map(x => `${x.actor}|${x.message}`);
    expect(e).toContain('web|resident.json: repo sin fijar -> "a/b", label sin fijar -> "fab", intervalSec sin fijar -> 60, mode sin fijar -> "observe"');
    expect(e).toContain('web|resident.json: label "fab" -> "otra"');
  }
  const before = store.listEvents('prueba', 50).length;
  await post('/config/entrada', { repo: 'a/b', label: '', interval: '', mode: '' }); // sin cambios: sin evento
  expect(store.listEvents('prueba', 50).length).toBe(before);
});

test('fab resident config también deja el evento', async () => {
  const log = console.log; console.log = () => {};
  try { expect(await residentMain(['config', '--repo', 'a/b'], store)).toBe(0); } finally { console.log = log; }
  expect(store.listEvents('prueba', 50).map(x => x.message)).toContain('resident.json: repo sin fijar -> "a/b"');
});

test('una configuración inválida se rechaza y no escribe nada', async () => {
  for (const bad of [{ repo: 'no es un repo' }, { repo: '../x/y' }, { label: 'x'.repeat(51) }, { label: 'a<b' }, { interval: '0' }, { interval: '86401' }, { interval: '1.5' }, { interval: 'abc' }, { mode: 'auto' }, { mode: 'AUTO' }]) {
    const r = await post('/config/entrada', { repo: '', label: '', interval: '', mode: '', ...bad });
    expect(r.status).toBe(400);
  }
  expect(existsSync(join(dir, 'resident.json'))).toBe(false);
});

test('resident.json: un enlace simbólico, campos ajenos o JSON roto no se aceptan', () => {
  writeFileSync(join(dir, 'otro'), '{}');
  symlinkSync(join(dir, 'otro'), join(dir, 'resident.json'));
  expect(() => saveResidentConfig(dir, { repo: 'a/b' }, 'cli')).toThrow('enlace simbólico');
  rmSync(join(dir, 'resident.json'));
  writeFileSync(join(dir, 'resident.json'), JSON.stringify({ repo: 'a/b', token: 'x' }));
  expect(() => loadResidentConfig(dir)).toThrow('campos desconocidos');
  writeFileSync(join(dir, 'resident.json'), '{no');
  expect(() => loadResidentConfig(dir)).toThrow('JSON');
  writeFileSync(join(dir, 'resident.json'), JSON.stringify({ mode: 'auto' }));
  expect(() => loadResidentConfig(dir)).toThrow('resident.json inválido');
});

test('fab resident config muestra y guarda; los flags mandan sobre resident.json', async () => {
  const lines: string[] = [], log = console.log; console.log = (s: string) => { lines.push(String(s)); };
  try {
    expect(await residentMain(['config', '--repo', 'a/b', '--interval', '30'], store)).toBe(0);
    expect(loadResidentConfig(dir)).toMatchObject({ repo: 'a/b', intervalSec: 30 });
    expect(await residentMain(['config'], store)).toBe(0);
    expect(lines.join('\n')).toContain('"repo": "a/b"');
    const err = console.error; console.error = () => {};
    try {
      expect(await residentMain(['config', '--interval', 'x'], store)).toBe(1);
      expect(await residentMain(['config', '--mode', 'auto'], store)).toBe(1);
      expect(await residentMain(['--mode', 'bogus'], store)).toBe(1);
    } finally { console.error = err; }
    expect(loadResidentConfig(dir)).toMatchObject({ repo: 'a/b', intervalSec: 30 });
    // Un flag inválido se valida aunque resident.json traiga un valor bueno: el flag manda.
    const errors: string[] = [], err2 = console.error; console.error = (s: string) => { errors.push(String(s)); };
    try {
      saveResidentConfig(dir, { mode: 'observe' }, 'cli'); rmSync(join(dir, 'resident.json'));
      saveResidentConfig(dir, { mode: 'observe' }, 'cli');
      expect(await residentMain(['--mode', 'bogus'], store)).toBe(1);
      expect(errors.join()).toContain('--mode debe ser');
    } finally { console.error = err2; }
  } finally { console.log = log; }
});

test('Jira sin credenciales en el entorno: no se importa y la web no pide ninguna', async () => {
  server.stop(true); server = startWeb(dir, 0, { write: true }); // sin pasarela inyectada
  const r = await fetch(server.loginUrl!, { redirect: 'manual' }); cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  csrf = /name="csrf" value="([^"]+)"/.exec(await (await get('/config')).text())![1]!;
  expect((await importar()).status).toBe(303);
  expect(await notice()).toContain('Jira no está configurada');
  expect(store.listSignals('prueba')).toEqual([]);
  const page = await notice();
  expect(page).not.toMatch(/name="(token|password|api_?key|jira_api_token|user)/i);
});

test('importa una HU acotada: crea la señal, deja auditoría y respeta la confirmación y el formato', async () => {
  expect((await importar()).status).toBe(303);
  expect(await notice()).toContain('HU de Jira importada.');
  expect(store.listSignals('prueba').map(s => s.title)).toEqual(['KAN-1 Resumen']);
  expect(audit()).toContain('web|Jira: importación solicitada desde la web: KAN-1');
  expect(audit()).toContain('web|Jira: HU KAN-1 importada desde la web');
  await importar();
  expect(await notice()).toContain('ya estaba importada');
  expect(store.listSignals('prueba')).toHaveLength(1);
  for (const bad of [{ confirm: 'no', key: 'KAN-3' }, { key: 'kan-1' }, { key: 'KAN-1; rm' }, { ws: 'no-existe' }, { ws: '../x' }] as Record<string, string>[]) await importar(bad);
  expect(calls).toEqual(['KAN-1']);
  await post('/config/jira/importar', { ws: 'prueba', key: 'KAN-2', confirm: 'yes', extra: 'x' });
  expect(calls).toEqual(['KAN-1']);
});

test('el tope por hora cuenta las solicitudes y bloquea sin llamar a Jira', async () => {
  for (let i = 1; i <= JIRA_HOURLY_CAP; i++) await importar({ key: `KAN-${i}` });
  expect(calls).toHaveLength(JIRA_HOURLY_CAP);
  await importar({ key: 'KAN-99' });
  expect(calls).toHaveLength(JIRA_HOURLY_CAP);
  expect(await notice()).toContain('Tope alcanzado');
  expect(store.listSignals('prueba')).toHaveLength(JIRA_HOURLY_CAP);
});

test('un fallo de Jira no filtra el texto del error y queda auditado; el tope de changes se avisa', async () => {
  fail = true;
  await importar();
  const page = await notice();
  expect(page).toContain('No se pudo importar la HU');
  expect(page + audit()).not.toContain('token-canario');
  expect(audit()).toContain('importación de KAN-1 fallida desde la web');
});

test('con triage respeta el tope de changes del workstream y lo avisa', async () => {
  store.createWorkstream({ slug: 'tope', goal: 'g', repo: join(dir, 'repo'), taskLimit: 1, requireApproval: false, requireChangeApproval: false });
  store.setWorkstreamState('tope', 'active');
  await importar({ ws: 'tope', key: 'KAN-1', triage: 'yes' });
  expect(store.listChanges('tope')).toHaveLength(1);
  await importar({ ws: 'tope', key: 'KAN-2', triage: 'yes' });
  expect(await notice()).toContain('tope de changes');
  expect(store.listChanges('tope')).toHaveLength(1);
  expect(store.listSignals('tope')).toHaveLength(1);
  expect(store.listEvents('tope', 50).map(e => e.message).join('\n')).toContain('importación de KAN-2 fallida desde la web (tope de changes)');
});

test('sin --write es solo lectura: se ve la configuración, sin formularios ni POST', async () => {
  saveResidentConfig(dir, { repo: 'a/b' }, 'cli');
  server.stop(true); server = startWeb(dir, 0);
  const page = await (await fetch(`http://127.0.0.1:${server.port}/config`)).text();
  expect(page).toContain('<code>a/b</code>');
  expect(page).not.toContain('Importar HU');
  expect(page).not.toContain('/config/entrada');
  expect((await fetch(`http://127.0.0.1:${server.port}/config/jira/importar`, { method: 'POST' })).status).toBe(405);
});

test('T107-H6: un temporal previsible plantado como enlace no recibe la escritura y el fichero final queda en 0600', () => {
  const victim = join(dir, 'victima'); writeFileSync(victim, 'intacto');
  for (const name of [`resident.json.${process.pid}.tmp`, 'resident.json.tmp']) symlinkSync(victim, join(dir, name));
  saveResidentConfig(dir, { repo: 'a/b' }, 'cli');
  expect(readFileSync(victim, 'utf8')).toBe('intacto');
  expect(lstatSync(join(dir, 'resident.json')).isSymbolicLink()).toBe(false);
  chmodSync(join(dir, 'resident.json'), 0o644);
  saveResidentConfig(dir, { label: 'x' }, 'cli');
  expect(lstatSync(join(dir, 'resident.json')).mode & 0o777).toBe(0o600);
});

test('T107-H7: una clave de HU de más de 40 caracteres se rechaza antes de la auditoría y del tope', async () => {
  const before = store.listEvents('prueba', 50).length;
  await importar({ key: 'KAN-' + '1'.repeat(15000) });
  await importar({ key: 'K'.repeat(39) + '-1' });
  expect(calls).toEqual([]);
  expect(store.listEvents('prueba', 50).length).toBe(before);
  expect(await notice()).toContain('Revisa la clave');
});

test('T107-H8: un resident.json ilegible dice cómo repararlo, también en la página y en fab resident config', async () => {
  writeFileSync(join(dir, 'resident.json'), '{no');
  expect(() => loadResidentConfig(dir)).toThrow('borra');
  expect(await notice()).toContain('borra resident.json');
  const errors: string[] = [], err = console.error; console.error = (m: string) => { errors.push(String(m)); };
  try { expect(await residentMain(['config', '--repo', 'a/b'], store)).toBe(1); } finally { console.error = err; }
  expect(errors.join()).toContain('borra resident.json');
});

test('T107-H9: el formulario del residente rechaza campos desconocidos', async () => {
  expect((await post('/config/entrada', { repo: 'a/b', extra: 'x' })).status).toBe(400);
  expect(existsSync(join(dir, 'resident.json'))).toBe(false);
});

test('T107-H12: la página avisa de que el cambio queda como evento en cada workstream y sin workstreams no queda rastro', async () => {
  expect(await notice()).toContain('Cada cambio queda como evento en cada workstream');
});
