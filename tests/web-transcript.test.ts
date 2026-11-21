import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdmissionDb } from '../src/admission/db.ts';
import { EVIDENCE_LIMIT } from '../src/evidence.ts';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';

const realStream = () => Buffer.from(Bun.gunzipSync(readFileSync(join(import.meta.dir, 'fixtures/transcript/claude-haiku.ndjson.gz')))).toString();
const toolValue = 'credencial-de-prueba';
const token = 'ghp_' + 'x'.repeat(36);
const stream = [
  { type: 'system', subtype: 'init', cwd: '/metadato-no-es-un-paso' },
  { type: 'assistant', message: { content: [
    { type: 'text', text: `Mensaje del agente <script>alert(1)</script> ${token}` },
    { type: 'thinking', thinking: 'Pensamiento único' },
    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: '<archivo>', password: { nested: toolValue } } },
  ] } },
  { type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'Resultado único' }] },
  ] } },
  { type: 'result', result: 'Resumen duplicado' },
].map(row => JSON.stringify(row).replace(token, '\\u0067' + token.slice(1))).join('\n') + '\n\n[stderr]\nAviso del ejecutable\n';

let dir: string, store: Store, server: ReturnType<typeof startWeb>, change: string, activity: string, ws: string, run: string;
const get = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`);
const activityPage = (query = '') => get(`/activities/${activity}${query}`);
const onlyTranscript = (html: string) => html.match(/<section class="transcript">[\s\S]*?<\/section>/)?.[0] ?? '';
const turnPage = (id = change) => `/changes/${id}/turns/turno/transcript`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-transcript-'));
  store = new Store(join(dir, 'fabrica.db'));
  ws = store.createWorkstream({ slug: 'uno', goal: 'g', repo: '/r' }).id;
  change = store.createChange(ws, 'Cambio', 'd').id;
  activity = store.listActivities({ changeId: change })[0]!.id;
  run = join(dir, 'runs', change);
  mkdirSync(run, { recursive: true });
  new AdmissionDb(store);
  store.db.query(`INSERT INTO adm_sessions(change_id, kind, generation, session_id, backend, cwd, status, created_at)
    VALUES (?, 'implementation', 1, 'sesion', 'claude', '/r', 'open', '2026-11-21T10:00:00.000Z')`).run(change);
  store.db.query(`INSERT INTO adm_turns(attempt_id, activity_id, change_id, session_id, generation, plan, started_at, log)
    VALUES ('turno', ?, ?, 'sesion', 1, 'fresh', '2026-11-21T10:00:00.000Z', 'ignorar-esta-ruta.log')`).run(activity, change);
  server = startWeb(dir, 0);
});
afterEach(() => { server.stop(true); store.close(); rmSync(dir, { recursive: true, force: true }); });

test('T99: pasos de Claude plegables y filtros independientes sin JavaScript', async () => {
  writeFileSync(join(run, `${activity}.log`), stream);
  const base = onlyTranscript(await (await activityPage()).text());
  expect(base).toContain('<h2>Transcript</h2>');
  expect(base).toContain('name="pensamiento"');
  expect(base).toContain('name="herramientas"');
  expect(base).toMatch(/<details[^>]*><summary>Mensaje del agente<\/summary>/);
  expect(base).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  for (const text of ['Pensamiento único', 'Resultado único', 'Llamada a herramienta']) expect(base).not.toContain(text);
  const thoughts = onlyTranscript(await (await activityPage('?pensamiento=1')).text());
  expect(thoughts).toContain('Pensamiento único');
  expect(thoughts).not.toContain('Resultado único');
  const tools = onlyTranscript(await (await activityPage('?herramientas=1')).text());
  expect(tools).toContain('Llamada a herramienta');
  expect(tools).toContain('Resultado único');
  expect(tools).not.toContain('Pensamiento único');
  const all = await (await activityPage('?pensamiento=1&herramientas=1')).text();
  expect(all).toContain('Pensamiento único');
  expect(all).toContain('Resultado único');
  expect(all).toContain('&lt;archivo&gt;');
  expect(all).toContain('[REDACTED]');
  for (const summary of ['metadato-no-es-un-paso', 'Resumen duplicado']) expect(onlyTranscript(all)).not.toContain(summary);
  for (const unsafe of ['<script>alert', token, toolValue])
    expect(all).not.toContain(unsafe);
});

test('T99: transcript por intento, enlace desde el change y log de texto redactado', async () => {
  writeFileSync(join(run, `${activity}.t-turno.log`), stream);
  expect(await (await get(`/changes/${change}`)).text()).toContain(`href="${turnPage()}"`);
  const result = await get(turnPage() + '?herramientas=1');
  expect(result.status).toBe(200);
  expect(await result.text()).toContain('Resultado único');
  const log = await get(`/changes/${change}/turns/turno/log`);
  expect(log.headers.get('content-type')).toStartWith('text/plain');
  const raw = await log.text();
  expect(raw).toContain('Aviso del ejecutable');
  expect(raw).not.toContain(toolValue);
  expect(raw).not.toContain(token);
  expect(raw).not.toContain('\\u0067hp_');
  const another = store.createChange(ws, 'Otro change', 'd').id;
  expect((await get(turnPage(another))).status).toBe(404);
});

test('T99: un stream sin pasos válidos y un symlink mantienen la página', async () => {
  const log = join(run, `${activity}.log`);
  for (const bad of [
    '{"type":"assistant","message":{"content":12}}',
  ]) {
    writeFileSync(log, bad);
    const response = await activityPage();
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/<h2>Transcript<\/h2><p[^>]*>No medido<\/p>/);
  }
  const target = join(dir, 'fuera.log');
  writeFileSync(target, stream);
  symlinkSync(target, join(run, `${activity}.t-turno.log`));
  const response = await get(turnPage());
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('No medido');
  expect(body).not.toContain('Mensaje del agente');
});

test('T99: el log histórico de texto sigue legible', async () => {
  writeFileSync(join(run, `${activity}.log`), 'Log histórico & seguro');
  const body = await (await activityPage()).text();
  expect(body).toMatch(/<h2>Transcript<\/h2><p[^>]*>No medido<\/p>/);
  expect(body).toContain('Log histórico &amp; seguro');
});

test('T99-H1: un stream real de más de 256 KiB conserva pasos completos y log', async () => {
  const real = realStream();
  expect(Buffer.byteLength(real)).toBeGreaterThan(EVIDENCE_LIMIT);
  writeFileSync(join(run, `${activity}.log`), real);
  writeFileSync(join(run, `${activity}.t-turno.log`), real);
  const page = await (await activityPage('?herramientas=1')).text();
  expect(page).toContain('<summary>Llamada a herramienta · Read</summary>');
  expect(page).toContain('Transcript incompleto');
  expect(page).toContain('<h2>Log</h2>');
  expect(page).toContain('Archivo truncado');
  const raw = await (await get(`/changes/${change}/turns/turno/log`)).text();
  expect(raw).toContain('CONTENIDO SINTÉTICO DE PRUEBA');
  expect(raw).toContain('[log recortado a 256 KiB]');
  expect(raw).not.toContain('LECTURA_SINTETICA_COMPLETA');
});

test.each(['línea final cortada', 'aviso entre frames', 'mensaje con forma inválida'])(
  'T99-H2: %s mantiene pasos completos, aviso y texto de diagnóstico', async (scenario) => {
    const lines = realStream().split('\n');
    const firstResult = lines.findIndex(line => line.includes('"type":"tool_result"'));
    const kept = lines.slice(0, firstResult + 1).join('\n') + '\n';
    const nextResult = lines.findIndex((line, i) => i > firstResult && line.includes('"type":"tool_result"'));
    const bad = scenario === 'línea final cortada' ? lines[nextResult]!.slice(0, 200)
      : scenario === 'aviso entre frames' ? 'Advertencia del wrapper\n' + lines[firstResult + 1]
      : '{"type":"assistant","message":{"content":12}}';
    const input = kept + bad + '\n[stderr]\nDiagnóstico después del fallo\n';
    expect(Buffer.byteLength(input)).toBeLessThan(EVIDENCE_LIMIT);
    writeFileSync(join(run, `${activity}.log`), input);
    writeFileSync(join(run, `${activity}.t-turno.log`), input);
    for (const response of [await activityPage('?herramientas=1'), await get(turnPage() + '?herramientas=1')]) {
      expect(response.status).toBe(200);
      const page = await response.text();
      expect(page).toContain('<summary>Resultado de herramienta</summary>');
      expect(page).toContain('Transcript incompleto');
      expect(page).toContain('<h2>Log</h2>');
      expect(page).toContain('Diagnóstico después del fallo');
    }
    const raw = await (await get(`/changes/${change}/turns/turno/log`)).text();
    expect(raw).toContain(bad.split('\n')[0]!);
    expect(raw).toContain('Diagnóstico después del fallo');
  },
);

test('T99-H3: el log plegado conserva stderr y el transcript incluye los turnos posteriores', async () => {
  const turn = (label: string) => [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'text', text: label }] } },
    { type: 'result', result: label },
  ].map(row => JSON.stringify(row)).join('\n');
  writeFileSync(join(run, `${activity}.log`), turn('Turno uno') + '\n[stderr]\nMotivo en stderr\n' + turn('Turno dos'));
  const page = await (await activityPage()).text();
  expect(onlyTranscript(page)).toContain('Turno uno');
  expect(onlyTranscript(page)).toContain('Turno dos');
  expect(onlyTranscript(page)).not.toContain('Transcript incompleto');
  expect(page).toMatch(/<h2>Log<\/h2><details><summary>Ver log de texto<\/summary>[\s\S]*Motivo en stderr/);
});

test('T99-H5: un prefijo de frame no retira el texto de un log de otro agente', async () => {
  const plain = '{"type":"assistant"} y después salió el diagnóstico del otro agente\n';
  writeFileSync(join(run, `${activity}.log`), plain);
  writeFileSync(join(run, `${activity}.t-turno.log`), plain);
  const page = await (await activityPage()).text();
  expect(page).toMatch(/<h2>Transcript<\/h2><p[^>]*>No medido<\/p>/);
  expect(page).toContain('salió el diagnóstico del otro agente');
  const raw = await (await get(`/changes/${change}/turns/turno/log`)).text();
  expect(raw).toBe(plain);
});

test('T99-H6: el JSON de herramienta anidado no amplifica la página por sangría', async () => {
  const input = '['.repeat(58) + '1,'.repeat(30_000) + '1' + ']'.repeat(58);
  const log = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"X","input":' + input + '}]}}\n';
  writeFileSync(join(run, `${activity}.log`), log);
  const page = await (await activityPage('?herramientas=1')).text();
  const transcript = onlyTranscript(page);
  expect(transcript).toContain(input);
  expect(Buffer.byteLength(transcript)).toBeLessThan(Buffer.byteLength(log) * 2);
});

test('T99-H8: el título de herramienta se escapa antes de entrar en summary', async () => {
  const name = '<img src=x data-caso=titulo>';
  const frame = { type: 'assistant', message: { content: [{ type: 'tool_use', name, input: {} }] } };
  writeFileSync(join(run, `${activity}.log`), JSON.stringify(frame));
  const html = onlyTranscript(await (await activityPage('?herramientas=1')).text());
  expect(html).toContain('<summary>Llamada a herramienta · &lt;img src=x data-caso=titulo&gt;</summary>');
  expect(html).not.toContain(name);
});

test('T99-H8: el log plano redacta stderr y nombres de claves decodificadas', async () => {
  const stderrSecret = 'ghp_' + 'z'.repeat(36);
  const frame = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'X', input: { [token]: 'valor visible' } }] } };
  const log = JSON.stringify(frame).replace(token, '\\u0067' + token.slice(1)) + '\n[stderr]\nAviso: ' + stderrSecret + '\n';
  writeFileSync(join(run, `${activity}.t-turno.log`), log);
  const raw = await (await get(`/changes/${change}/turns/turno/log`)).text();
  expect(raw).toContain('"[REDACTED]":"valor visible"');
  expect(raw).toContain('Aviso: [REDACTED]');
  expect(raw).not.toContain(stderrSecret);
  expect(raw).not.toContain(token);
});

test('T99-H8: ws se escapa en el atributo del filtro por turno', async () => {
  writeFileSync(join(run, `${activity}.t-turno.log`), stream);
  const hostile = '"><img src=x data-caso=ws>';
  const html = await (await get(turnPage() + '?ws=' + encodeURIComponent(hostile))).text();
  expect(html).toContain('name="ws" value="&quot;&gt;&lt;img src=x data-caso=ws&gt;"');
  expect(html).not.toContain('<img src=x data-caso=ws>');
});

test('T99-H8: el valor a profundidad excesiva queda redactado', async () => {
  const depth = 100;
  const input = '['.repeat(depth) + '"contenido profundo"' + ']'.repeat(depth);
  const frame = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"X","input":' + input + '}]}}';
  writeFileSync(join(run, `${activity}.t-turno.log`), frame);
  const raw = await (await get(`/changes/${change}/turns/turno/log`)).text();
  expect(raw).toContain('[REDACTED]');
  expect(raw).not.toContain('contenido profundo');
});

test.each(['recorte a 256 KiB', 'línea inválida', 'JSON sin tipo', 'JSON en stderr'])(
  'T99-H9: %s redacta el contenido decodificado antes de mostrarlo', async (scenario) => {
    const secrets = ['ghp_' + 'aB12'.repeat(9), 'sk-ant-' + 'z9'.repeat(18),
      'canario-json', 'canario-env', 'canario-yaml'];
    const content = ['Texto visible <img src=x>', secrets[0], secrets[1],
      '{"password": "' + secrets[2] + '"}', 'DB_PASSWORD="' + secrets[3] + '"',
      'client_secret: "' + secrets[4] + '"', 'Final visible'].join('\n');
    const frame = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content }] } })
      .replace('ghp_', '\\u0067hp_');
    const init = '{"type":"system","subtype":"init"}\n';
    const log = scenario === 'recorte a 256 KiB' ? init + frame.slice(0, -5) + (' relleno').repeat(EVIDENCE_LIMIT / 2)
      : scenario === 'línea inválida' ? init + frame.slice(0, -5) + '\n'
      : scenario === 'JSON sin tipo' ? init + frame.replace('"type":"user",', '') + '\n'
      : init + '[stderr]\n' + frame + '\n';
    writeFileSync(join(run, activity + '.log'), log);
    writeFileSync(join(run, activity + '.t-turno.log'), log);
    for (const response of [await activityPage(), await get(turnPage()), await get('/changes/' + change + '/turns/turno/log')]) {
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(secrets.filter(secret => body.includes(secret) || body.includes(secret.replace('ghp_', '\\u0067hp_')))).toEqual([]);
      expect(body).toContain('Final visible');
      expect(body).toContain('[REDACTED]');
      if (response.headers.get('content-type')?.includes('text/html')) {
        expect(body).toContain('Texto visible &lt;img src=x&gt;');
        expect(body).not.toContain('<img src=x>');
      }
    }
  },
);

test('T99-H12: un turno sin init tras stderr avisa y deja abierto el log', async () => {
  const first = '{"type":"assistant","message":{"content":"Primer turno"}}';
  const next = [
    { type: 'assistant', message: { content: 'Segundo turno sin init' } },
    { type: 'user', message: { content: 'Segundo turno sin init' } },
    { type: 'result', result: 'Segundo turno sin init' },
  ];
  for (const frame of next) {
    writeFileSync(join(run, activity + '.log'), first + '\n[stderr]\nDiagnóstico\n' + JSON.stringify(frame));
    const body = await (await activityPage()).text();
    expect(onlyTranscript(body)).toContain('Transcript incompleto.');
    expect(onlyTranscript(body)).toContain('Primer turno');
    expect(body).toMatch(/<h2>Log<\/h2><pre[^>]*>[\s\S]*Diagnóstico[\s\S]*Segundo turno sin init/);
  }
});
