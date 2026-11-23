// E2E de la plataforma web de fab (T76): `bun run e2e`. Siembra un stateDir temporal, arranca `fab web --write`,
// recorre los flujos del dueño con agent-browser y comprueba cada efecto en el Store (solo lectura), no solo en el HTML.
// Nunca usa ~/.fabrica ni red externa; el pool corre con el agente `fake`. Sin esperas fijas: se espera a condiciones.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../../src/store.ts';
import { runPool } from '../../src/pool.ts';
import { ACTIONS } from '../../src/web-actions.ts';
import { crearRepo, sembrar, type Semilla } from './sembrar.ts';

const ROOT = resolve(import.meta.dir, '../..');
// Fuera de git por defecto (.e2e/ está en .gitignore); E2E_CAPTURAS lleva las capturas a otra carpeta, p. ej. la de docs.
const CAPTURAS = process.env.E2E_CAPTURAS ? resolve(process.env.E2E_CAPTURAS) : join(ROOT, '.e2e/capturas');
// Sufijo por proceso: dos ejecuciones a la vez (dos worktrees) no comparten navegador.
const SESSION = `fab-e2e-${process.pid}`;
const TOPE_MS = 20_000;

type Estado = 'ok' | 'fallo' | 'conocido';
interface Resultado { flujo: string; estado: Estado; detalle: string; ms: number }
const resultados: Resultado[] = [];
const tmp = mkdtempSync(join(tmpdir(), 'fab-e2e-'));
let semilla: Semilla;
let base = '';
let captura = 0;

// ---- utilidades ------------------------------------------------------------------------------------------------
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function eq<T>(actual: T, esperado: T, msg: string) { assert(actual === esperado, `${msg}: esperaba ${JSON.stringify(esperado)}, obtuve ${JSON.stringify(actual)}`); }

/** Ejecuta un flujo y anota el resultado. `conocido` marca un fallo de producto ya diagnosticado (no rompe la salida). */
async function flujo(nombre: string, fn: () => Promise<void> | void, conocido?: string) {
  const t0 = Date.now();
  try { await fn(); resultados.push({ flujo: nombre, estado: 'ok', detalle: '', ms: Date.now() - t0 }); console.log(`  ok      ${nombre}`); }
  catch (e) {
    const detalle = e instanceof Error ? e.message : String(e);
    resultados.push({ flujo: nombre, estado: conocido ? 'conocido' : 'fallo', detalle: conocido ? `${conocido} | ${detalle}` : detalle, ms: Date.now() - t0 });
    console.log(`  ${conocido ? 'conocido' : 'FALLO  '} ${nombre}: ${detalle.split('\n')[0]}`);
    try { ab('screenshot', join(CAPTURAS, `fallo-${nombre.replace(/\W+/g, '-')}.png`)); } catch { /* sin navegador */ }
  }
}

function ab(...args: string[]): string {
  const r = Bun.spawnSync(['agent-browser', '--session', SESSION, '--args', '--no-sandbox', ...args], { timeout: 45_000, env: { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: String(TOPE_MS) } });
  if (r.exitCode !== 0) throw new Error(`agent-browser ${args.join(' ')}: ${r.stderr.toString().trim() || r.stdout.toString().trim()}`);
  return r.stdout.toString().trim();
}
const abrir = (ruta: string) => { ab('open', base + ruta); ab('wait', '--load', 'domcontentloaded'); };
const texto = (sel: string) => ab('get', 'text', sel);
const click = (sel: string) => { ab('scrollintoview', sel); return ab('click', sel); };
const rellenar = (sel: string, v: string) => ab('fill', sel, v);
const esperarTexto = (t: string) => ab('wait', '--text', t);
const foto = (nombre: string) => ab('screenshot', '--full', join(CAPTURAS, `${String(++captura).padStart(2, '0')}-${nombre}.png`));
const paginaTexto = () => texto('body');
const form = (accion: string) => `form[action="${accion}"]`;
/** Tras un POST la web redirige con un aviso de un solo uso: se lee enseguida (el sondeo lo repinta a los 2 s). */
function aviso(): string { ab('wait', 'p.notice[role=status]'); return texto('p.notice[role=status]'); }
const registrada = (donde: string) => { const t = aviso(); assert(t.includes('Acción registrada'), `${donde}: aviso «${t}»`); };

/** Store de solo lectura, abierto en cada consulta como hace la web. */
function leer<T>(fn: (s: Store) => T): T {
  const s = new Store(join(semilla.stateDir, 'fabrica.db'), { readonly: true });
  try { return fn(s); } finally { s.close(); }
}
const ultimoEvento = () => leer(s => (s.db.query('SELECT COALESCE(MAX(id),0) n FROM events').get() as { n: number }).n);
const eventosDesde = (marca: number) => leer(s => s.db.query('SELECT actor, message FROM events WHERE id > ? ORDER BY id').all(marca) as { actor: string | null; message: string }[]);
/** Toda acción de la web deja al menos un evento y todos llevan el actor esperado. */
function eventosDe(marca: number, actor = 'web') {
  const ev = eventosDesde(marca);
  assert(ev.length > 0, 'la acción no dejó ningún evento');
  const otros = ev.filter(e => e.actor !== actor);
  assert(otros.length === 0, `eventos con actor distinto de ${actor}: ${JSON.stringify(otros)}`);
  return ev;
}
const turnos = () => leer(s => (s.db.query("SELECT count(*) n FROM sqlite_master WHERE name='adm_turns'").get() as { n: number }).n ? (s.db.query('SELECT count(*) n FROM adm_turns').get() as { n: number }).n : 0);
const enCurso = () => leer(s => (s.db.query("SELECT count(*) n FROM activities WHERE status='in_progress'").get() as { n: number }).n);
const cambio = (id: string) => leer(s => s.getChange(id));
const actividad = (id: string) => leer(s => s.getActivity(id));
const id = (k: string) => semilla.changes[k]!;

// ---- servidor --------------------------------------------------------------------------------------------------
async function arrancarWeb(write: boolean): Promise<{ url: string; login?: string; parar: () => void }> {
  const proc = Bun.spawn(['bun', join(ROOT, 'src/cli.ts'), 'web', '--port', '0', ...(write ? ['--write'] : [])], {
    cwd: ROOT, env: { ...process.env, FABRICA_HOME: semilla.stateDir }, stdout: 'pipe', stderr: 'pipe',
  });
  const reader = proc.stdout.getReader();
  let salida = '';
  const limite = Date.now() + TOPE_MS;
  for (;;) {
    // Con --write el enlace va al host único fab-<hex>.localhost (T75); sin él, a 127.0.0.1.
    const m = /(http:\/\/([\w.-]+):(\d+)\S*)/.exec(salida);
    if (m && (!write || m[1]!.includes('/auth?token='))) return { url: `http://${m[2]}:${m[3]}`, login: write ? m[1] : undefined, parar: () => proc.kill() };
    if (Date.now() > limite) { proc.kill(); throw new Error(`fab web no arrancó: ${salida}`); }
    const { value, done } = await Promise.race([reader.read(), Bun.sleep(200).then(() => ({ value: undefined, done: false }))]);
    if (value) salida += new TextDecoder().decode(value);
    if (done) throw new Error(`fab web terminó: ${salida}`);
  }
}

async function http(url: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  const r = await fetch(url, { redirect: 'manual', ...init });
  return { status: r.status, text: await r.text(), headers: r.headers };
}
/** Petición HTTP/1.1 cruda: fetch no deja falsear `Host`. */
async function crudo(port: number, peticion: string): Promise<number> {
  return await new Promise<number>((res, rej) => {
    let buf = '';
    Bun.connect({ hostname: '127.0.0.1', port, socket: {
      open(s) { s.write(peticion); },
      data(s, d) { buf += new TextDecoder().decode(d); if (buf.includes('\r\n')) { s.end(); res(Number(/^HTTP\/1\.1 (\d+)/.exec(buf)?.[1])); } },
      error(_s, e) { rej(e); }, close() { if (!buf) rej(new Error('conexión cerrada sin respuesta')); },
    } }).catch(rej);
  });
}

// ---- recorrido -------------------------------------------------------------------------------------------------
async function main() {
  rmSync(CAPTURAS, { recursive: true, force: true });
  mkdirSync(CAPTURAS, { recursive: true });
  semilla = sembrar(tmp);
  process.env.FABRICA_HOME = semilla.stateDir; // nada de lo que se ejecute aquí puede caer en ~/.fabrica
  const web = await arrancarWeb(true);
  base = web.url;
  console.log(`e2e · web ${base} · estado ${semilla.stateDir}`);
  try {
    await recorrido(web.login!);
    await api();
    await seguridad();
  } finally {
    try { ab('close'); } catch { /* ya cerrado */ }
    web.parar();
  }
}

async function recorrido(login: string) {
  await flujo('acceso: canjear el enlace de un solo uso', async () => {
    ab('open', login); ab('wait', '--load', 'domcontentloaded');
    await esperarTexto('Escritura habilitada');
    eq(ab('get', 'url'), `${base}/`, 'redirección tras el canje');
    foto('bandeja');
    const reuso = await http(login);
    eq(reuso.status, 401, 'reutilizar el enlace');
  });

  await flujo('bandeja y filtros de changes', async () => {
    abrir('/');
    const bandeja = paginaTexto();
    assert(bandeja.includes('Revisión para aprobar'), 'la bandeja no lista la revisión pendiente');
    rellenar('input[name=q]', 'aprobar'); click('form[action="/"] button');
    ab('wait', '--url', '**/?q=aprobar');
    assert(!paginaTexto().includes('Revisión para pedir cambios'), 'el buscador de la bandeja no filtra');
    abrir('/changes');
    const todos = paginaTexto();
    for (const t of ['Revisión para aprobar', 'Change completado de ejemplo', 'Change bloqueado de ejemplo']) assert(todos.includes(t), `falta «${t}» en /changes`);
    ab('select', 'form.filters select[name=status]', 'failed'); click('form.filters button');
    ab('wait', '--url', '**status=failed*');
    assert(!paginaTexto().includes('Change completado de ejemplo'), 'el filtro por estado no filtra');
    abrir('/changes?ws=canal&q=renombrar');
    assert(paginaTexto().includes('Change para renombrar') && !paginaTexto().includes('Revisión para aprobar'), 'filtro por workstream y texto');
    foto('changes-filtrados');
  });

  let senalPool = '', cambioPool = '';
  await flujo('crear una señal y triarla sin crear turnos', async () => {
    const t0 = turnos(), run0 = enCurso(), marca = ultimoEvento();
    abrir('/signals');
    ab('select', '#signal-ws', 'pool'); rellenar('#signal-title', 'Señal del e2e'); rellenar('#signal-body', 'Cuerpo de la señal del e2e.');
    click('form[action="/signals"] button'); registrada('aviso de creación');
    const s = leer(st => st.listSignals(st.getWorkstream('pool').id, 'new').find(x => x.title === 'Señal del e2e'));
    assert(s, 'la señal no está en el Store'); senalPool = s.id;
    eq(s.status, 'new', 'estado de la señal'); eq(turnos(), t0, 'turnos tras crear'); eq(enCurso(), run0, 'activities en curso tras crear');
    eventosDe(marca);
    foto('senal-creada');
    const m2 = ultimoEvento();
    abrir('/signals');
    click(`${form(`/signals/${senalPool}/triage`)} button`); registrada('aviso de triaje');
    const sig = leer(st => st.listSignals(st.getWorkstream('pool').id).find(x => x.id === senalPool))!;
    eq(sig.status, 'triaged', 'estado de la señal tras triar');
    assert(sig.changeId, 'la señal triada no apunta a un change'); cambioPool = sig.changeId;
    eq(cambio(cambioPool).status, 'pending', 'estado del change triado');
    eq(turnos(), t0, 'turnos tras triar'); eq(enCurso(), run0, 'activities en curso tras triar');
    assert(!leer(s2 => s2.listActivities({ changeId: cambioPool }).some(a => a.status !== 'pending')), 'el triaje lanzó trabajo');
    eventosDe(m2);
    foto('senal-triada');
  });

  await flujo('ignorar una señal', async () => {
    const marca = ultimoEvento();
    abrir('/signals');
    click(`${form(`/signals/${semilla.signal}/ignore`)} button`); registrada('aviso');
    eq(leer(s => s.listSignals(s.getWorkstream('canal').id).find(x => x.id === semilla.signal)!.status), 'ignored', 'estado de la señal');
    eventosDe(marca);
  });

  await flujo('aprobar una revisión', async () => {
    const marca = ultimoEvento(), a = semilla.activities.aprobar!;
    abrir(`/activities/${a}`); foto('revision-detalle');
    click(`${form(`/activities/${a}/review`)} button[value=approve]`); registrada('aviso');
    eq(actividad(a).reviewStatus, 'approved', 'review_status');
    eventosDe(marca);
  });

  await flujo('pedir cambios con un comentario', async () => {
    const marca = ultimoEvento(), a = semilla.activities.cambios!;
    abrir(`/activities/${a}`);
    // Sin comentario, pedir cambios se rechaza y no cambia nada.
    click(`${form(`/activities/${a}/review`)} button[value=comment]`);
    await esperarTexto('Elige una decisión'); // el servidor responde 400 con el motivo
    eq(actividad(a).reviewStatus, 'awaiting', 'review_status sin comentario');
    abrir(`/activities/${a}`);
    rellenar('#review-comment', 'Falta cubrir el caso vacío.');
    click(`${form(`/activities/${a}/review`)} button[value=comment]`); registrada('aviso');
    const act = actividad(a);
    eq(act.reviewStatus, 'commented', 'review_status');
    assert((act.reviewComment ?? '').includes('caso vacío'), 'el comentario no se guardó');
    eventosDe(marca);
  });

  await flujo('responder la pregunta abierta', async () => {
    const marca = ultimoEvento(), a = semilla.activities.pregunta!;
    abrir(`/activities/${a}`); foto('pregunta');
    rellenar('#question-answer', 'Treinta días.');
    click(`${form('/questions/pregunta-e2e/answer')} button`); registrada('aviso');
    const q = leer(s => s.db.query("SELECT status, answer, answered_by FROM adm_questions WHERE id='pregunta-e2e'").get() as { status: string; answer: string; answered_by: string });
    eq(q.status, 'answered', 'estado de la pregunta'); eq(q.answer, 'Treinta días.', 'respuesta'); eq(q.answered_by, 'web', 'quién respondió');
    eq(actividad(a).status, 'pending', 'la activity vuelve a la cola');
    eventosDe(marca);
  });

  await flujo('dejar una nota', async () => {
    const marca = ultimoEvento(), c = id('nota');
    abrir(`/changes/${c}`);
    rellenar('#note-body', 'Prefiere la opción corta.');
    click(`${form(`/changes/${c}/note`)} button`); registrada('aviso');
    const notas = leer(s => s.listChangeNotes(c));
    eq(notas.length, 1, 'notas del change'); assert(notas[0]!.body.includes('opción corta'), 'cuerpo de la nota'); eq(notas[0]!.deliveredAt ?? null, null, 'entrega de la nota');
    eq(turnos(), 0, 'turnos tras la nota');
    eventosDe(marca);
    abrir(`/changes/${c}`); assert(paginaTexto().includes('Prefiere la opción corta.'), 'la nota no se muestra');
    foto('nota');
  });

  await flujo('reintentar un change', async () => {
    const marca = ultimoEvento(), c = id('reintentar');
    abrir(`/changes/${c}`); foto('change-fallido');
    click(`${form(`/changes/${c}/retry`)} button`); registrada('aviso');
    eq(cambio(c).status, 'pending', 'estado tras reintentar');
    assert(leer(s => s.listActivities({ changeId: c }).some(a => a.status === 'pending')), 'no hay activity reencolada');
    eventosDe(marca);
  });

  await flujo('cancelar un change con confirmación', async () => {
    const c = id('cancelar');
    abrir(`/changes/${c}`);
    // Sin marcar la confirmación el navegador no envía el formulario: el estado no cambia.
    click(`${form(`/changes/${c}/cancel`)} button`);
    eq(cambio(c).status, 'in_progress', 'estado sin confirmar');
    const marca = ultimoEvento();
    abrir(`/changes/${c}`);
    ab('check', `${form(`/changes/${c}/cancel`)} input[name=confirm]`);
    click(`${form(`/changes/${c}/cancel`)} button`); registrada('aviso');
    eq(cambio(c).status, 'canceled', 'estado tras cancelar');
    eventosDe(marca);
    foto('change-cancelado');
  });

  await flujo('renombrar un change', async () => {
    const marca = ultimoEvento(), c = id('renombrar');
    abrir(`/changes/${c}`);
    rellenar('#rename-title', 'Título renombrado por el e2e');
    click(`${form(`/changes/${c}/rename`)} button`); registrada('aviso');
    eq(cambio(c).title, 'Título renombrado por el e2e', 'título');
    eventosDe(marca);
  });

  await flujo('automation: ejecutar, pausar y activar', async () => {
    const a = semilla.automation, t0 = turnos(), run0 = enCurso();
    const cambiosTotal = () => leer(s => (s.db.query('SELECT count(*) n FROM changes').get() as { n: number }).n);
    const changes0 = cambiosTotal();
    const senales = () => leer(s => (s.db.query("SELECT count(*) n FROM signals WHERE source=?").get(`automation:${a}`) as { n: number }).n);
    eq(senales(), 0, 'señales de la automation antes');
    let marca = ultimoEvento();
    abrir('/automations'); foto('automations');
    click(`${form(`/automations/${a}/run`)} button`); registrada('aviso de ejecutar');
    eq(senales(), 1, 'señales de la automation tras ejecutar'); eq(turnos(), t0, 'turnos'); eq(enCurso(), run0, 'activities en curso'); eq(cambiosTotal(), changes0, 'ejecutar no tria: ningún change nuevo (D-D)');
    eq(leer(s => s.listAutomations().find(x => x.id === a)!.lastResult), 'created', 'último resultado');
    eventosDe(marca);
    marca = ultimoEvento();
    abrir('/automations'); click(`${form(`/automations/${a}/disable`)} button`); registrada('aviso de pausar');
    eq(leer(s => s.listAutomations().find(x => x.id === a)!.enabled), false, 'pausada');
    eventosDe(marca);
    marca = ultimoEvento();
    abrir('/automations'); click(`${form(`/automations/${a}/enable`)} button`); registrada('aviso de activar');
    eq(leer(s => s.listAutomations().find(x => x.id === a)!.enabled), true, 'activa');
    eventosDe(marca);
  });

  await flujo('perfil: guardar uno nuevo y asignarlo', async () => {
    const marca = ultimoEvento();
    // T84: asignar se rechaza con trabajo vivo; `archivo` (en pausa, sin changes) es el workstream que sí admite la asignación.
    abrir('/perfiles?ws=archivo');
    const antes = leer(s => s.getWorkstream('archivo').profile);
    click('form[action="/perfiles/guardar"] details summary'); // T84: las plantillas van en un desplegable
    const campo = '[id="f-worker.investigate"]'; // se añade una línea: sustituir la plantilla entera pierde líneas obligatorias
    rellenar(campo, `${ab('get', 'value', campo)}\nLínea añadida por el e2e.`);
    click('form[action="/perfiles/guardar"] button'); await esperarTexto('Perfil guardado');
    const digest = /([0-9a-f]{64}) · Nuevo/.exec(paginaTexto())?.[1];
    assert(digest, 'la página no muestra el digest nuevo');
    eq(leer(s => s.getWorkstream('archivo').profile), antes, 'guardar no asigna');
    foto('perfil-guardado');
    ab('check', 'form[action="/perfiles/asignar"] input[name=confirm]');
    click('form[action="/perfiles/asignar"] button');
    ab('wait', '--url', '**ws=archivo'); // la redirección de asignar
    eq(leer(s => s.getWorkstream('archivo').profile), digest, 'el perfil quedó asignado');
    eventosDe(marca); // asignar deja su evento con actor web
    // Con trabajo vivo (`plataforma`) la misma acción se rechaza y no cambia nada.
    abrir('/perfiles?ws=plataforma');
    const vivo = leer(s => s.getWorkstream('plataforma').profile);
    eq(vivo, semilla.profiles.v2, 'perfil inicial de plataforma (v2 con roles)');
    ab('check', 'form[action="/perfiles/asignar"] input[name=confirm]');
    click('form[action="/perfiles/asignar"] button');
    ab('wait', '--url', '**ws=plataforma');
    await esperarTexto('El workstream tiene trabajo vivo');
    eq(leer(s => s.getWorkstream('plataforma').profile), vivo, 'asignar con trabajo vivo no cambia el perfil');
  });

  await flujo('workstream: guardar ajustes', async () => {
    const marca = ultimoEvento();
    abrir('/workstreams');
    rellenar('#c-canal', '3'); rellenar('#t-canal', '15');
    click('form[action="/workstreams/canal/settings"] button'); registrada('aviso');
    const w = leer(s => s.getWorkstream('canal'));
    eq(w.workerConcurrency, 3, 'concurrencia'); eq(w.taskLimit, 15, 'tope de tareas');
    eventosDe(marca);
  });

  await flujo('workstream: archivar con confirmación', async () => {
    const marca = ultimoEvento();
    abrir('/workstreams'); foto('workstreams');
    click('details:has(form[action="/workstreams/archivo/archive"]) summary');
    rellenar('#a-archivo', 'otro'); click('form[action="/workstreams/archivo/archive"] button');
    assert(aviso().includes('invalid_input'), 'un slug distinto debe rechazarse');
    eq(leer(s => s.getWorkstream('archivo').state), 'paused', 'un slug distinto no archiva');
    abrir('/workstreams');
    click('details:has(form[action="/workstreams/archivo/archive"]) summary');
    rellenar('#a-archivo', 'archivo'); click('form[action="/workstreams/archivo/archive"] button'); registrada('aviso');
    eq(leer(s => s.getWorkstream('archivo').state), 'archived', 'estado');
    eventosDe(marca);
  });

  await flujo('asistente de alta de workstream', async () => {
    const marca = ultimoEvento();
    abrir('/workstreams/nuevo');
    rellenar('#f-repo', semilla.repos.nuevo!); click('form button'); await esperarTexto('Paso 2 de 5');
    rellenar('#f-goal', 'Objetivo del workstream de alta.'); rellenar('#f-slug', 'alta-e2e'); click('form button'); await esperarTexto('Paso 3 de 5');
    click('form button'); await esperarTexto('Paso 4 de 5');
    click('form button'); await esperarTexto('Paso 5 de 5');
    foto('alta-revision');
    click('form[method=post] button'); registrada('aviso');
    const w = leer(s => s.getWorkstream('alta-e2e'));
    eq(w.state, 'draft', 'el alta crea el workstream en borrador'); eq(w.repo, semilla.repos.nuevo!, 'repo');
    eventosDe(marca);
    // Un repo inexistente se rechaza en el primer paso.
    abrir('/workstreams/nuevo'); rellenar('#f-repo', '/no/existe'); click('form button'); await esperarTexto('no existe');
  });

  await flujo('páginas de solo lectura: métricas, configuración, flujo, experimentos y turnos', async () => {
    abrir('/metricas'); assert(paginaTexto().includes('Tiempo de ciclo'), 'métricas'); foto('metricas');
    abrir('/metricas?tab=gasto&range=all&ws=plataforma'); assert(paginaTexto().includes('Coste'), 'métricas filtradas');
    // T111: una captura por pestaña, con el mismo rango y workstream; cada una con sus tarjetas y sin JS de página.
    for (const [tab, texto] of [['productividad', 'Runs totales'], ['gasto', 'Coste por día'], ['jueces', 'Los jueces clasifican']]) {
      abrir(`/metricas?tab=${tab}&range=30&ws=plataforma`); assert(paginaTexto().includes(texto), `pestaña ${tab}`);
      assert(Number(ab('get', 'count', 'nav.tabs a')) === 3, `tres pestañas en ${tab}`); assert(paginaTexto().includes('Puesta en marcha'), `botón de puesta en marcha en ${tab}`);
      if (tab === 'gasto') assert(paginaTexto().includes('modelo-semilla-efectivo'), 'gasto incluye modelo efectivo sembrado (IE2O1-H3)');
      foto(`metricas-${tab}`);
    }
    abrir('/config'); assert(paginaTexto().includes('Configuración'), 'configuración'); foto('config');
    abrir('/flujo?ws=plataforma'); assert(paginaTexto().includes('Flujo'), 'flujo'); eq(ab('get', 'count', 'svg.flow'), '1', 'diagrama del flujo'); foto('flujo');
    abrir('/experimentos'); assert(paginaTexto().includes('perfil-e2e'), 'lista de experimentos'); foto('experimentos');
    abrir('/experimentos/perfil-e2e'); assert(paginaTexto().includes('Resumen por brazo'), 'detalle del experimento'); foto('experimento-detalle');
    abrir(`/changes/${id('completado')}`); await esperarTexto('Turnos'); assert(paginaTexto().includes('Sin turnos vivos'), 'sección de turnos'); foto('turnos');
    abrir('/changes/no-existe'); assert(paginaTexto().includes('Registro no encontrado'), '404 de un change inexistente');
  });

  await flujo('páginas de la ronda T77–T98 (solo lectura): webhooks, definición, benchmarks, automejora, claves API, automations, runners, roles y adjuntos', async () => {
    const visita = (ruta: string, texto: string, nombre: string) => { abrir(ruta); assert(paginaTexto().includes(texto), `${nombre}: falta «${texto}»`); foto(nombre); };
    visita('/webhooks', 'Webhooks', 'webhooks');
    visita('/definicion', 'Definición', 'definicion');
    visita('/benchmarks', 'No hay benchmarks', 'benchmarks');
    visita('/automejora?ws=plataforma', 'Automejora', 'automejora');
    visita('/config/claves-api', 'Claves API', 'claves-api');
    visita('/automations/nueva', 'Crear automation', 'automation-nueva');
    visita('/config/runners', 'Runners', 'runners');
    visita('/perfiles?ws=plataforma', 'Resolución sin override de CLI', 'roles-perfil');
    abrir(`/changes/${id('nota')}`); const selector = ab('get', 'count', 'input[type=file]') === '1';
    eq(selector, true, 'el formulario de nota ofrece el selector de adjunto (estado 0700)'); foto('adjunto-formulario');
  });

  await flujo('páginas de la etapa 1 (T99–T107, solo lectura): transcript, timeline por minuto, alta de runners, secretos y MCP por nombre, entrada, importar, registro MCP y pines', async () => {
    const visita = (ruta: string, textos: string[], nombre: string) => {
      abrir(ruta); const t = paginaTexto();
      for (const x of textos) assert(t.includes(x), `${nombre}: falta «${x}»`);
      foto(nombre);
    };
    // T99–T100: una activity con log estructurado (stream-json) se pinta como transcript, no como texto crudo.
    const marco = (o: unknown) => JSON.stringify(o);
    writeFileSync(join(semilla.stateDir, 'runs', id('completado'), `${semilla.activities.completado}.log`), [
      marco({ type: 'assistant', message: { content: [{ type: 'text', text: 'Paso estructurado del e2e' }, { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.txt' } }] } }),
      marco({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Resultado del e2e' }] } }),
    ].join('\n') + '\n');
    visita(`/activities/${semilla.activities.completado}?herramientas=1`, ['Transcript', 'Mostrar llamadas y resultados', 'Aplicar filtros'], 'etapa1-transcript');
    visita(`/changes/${id('completado')}`, ['Timeline por minuto'], 'etapa1-timeline-minuto');
    visita('/config/runners', ['Dar de alta un runner'], 'etapa1-runners-alta');
    visita('/config?ws=plataforma', ['Secretos y MCP del workstream', 'Entrada: etiqueta de GitHub y Jira', 'Servidores MCP', 'Variables requeridas', 'E2E_TRACKER_TOKEN (no definida en fab web)', 'Adaptadores', 'Pin guardado'], 'etapa1-config-acceso-entrada-mcp');
    visita('/perfiles?ws=plataforma', ['Importar perfil'], 'etapa1-importar-perfil');
    visita('/definicion', ['Importar definición'], 'etapa1-importar-definicion');
  });

  await flujo('pool fake: el change triado avanza y la web lo refleja', async () => {
    assert(cambioPool, 'depende del flujo de triaje');
    const s = new Store(join(semilla.stateDir, 'fabrica.db'));
    try { await runPool(s, { workstream: 'pool', stateDir: semilla.stateDir, untilIdle: true, log: () => {} }); } finally { s.close(); }
    const c = cambio(cambioPool);
    eq(c.status, 'in_review', 'estado tras el pool');
    const acts = leer(st => st.listActivities({ changeId: cambioPool }));
    assert(acts.some(a => a.kind === 'investigation' && a.status === 'completed'), 'la investigación no se completó');
    abrir(`/changes/${cambioPool}`);
    assert(paginaTexto().includes('En revisión'), 'la web no muestra el estado nuevo'); foto('pool-change-avanzado');
    abrir('/'); assert(paginaTexto().includes('Señal del e2e'), 'la bandeja no refleja el change');
  });
}

// ---- API con clave ---------------------------------------------------------------------------------------------
async function api() {
  await flujo('API: clave, lectura, escritura y rutas que no existen', async () => {
    // El Store no se abre en solo lectura aquí: crear la clave es un comando del dueño (no hay `fab api-key` en esta rama).
    const w = new Store(join(semilla.stateDir, 'fabrica.db'));
    const lectura = w.createApiKey('e2e-lectura', 'read').key, decide = w.createApiKey('e2e-decide', 'decide').key;
    w.close();
    const auth = (k: string): Record<string, string> => ({ authorization: `Bearer ${k}` });
    const get = (ruta: string, k?: string) => http(`${base}/api/v1${ruta}`, { headers: k ? auth(k) : {} });
    eq((await get('/workstreams')).status, 401, 'GET sin clave');
    eq((await get('/workstreams', 'fabk_incorrecta')).status, 401, 'GET con clave inválida');
    const lista = await get('/workstreams', lectura);
    eq(lista.status, 200, 'GET con clave'); assert(JSON.parse(lista.text).data.some((x: { slug: string }) => x.slug === 'plataforma'), 'workstreams en la API');
    eq((await get('/changes?limit=5', lectura)).status, 200, 'GET changes');
    const c = id('nota');
    const post = (ruta: string, k?: string, cuerpo: unknown = { body: 'Nota desde la API.' }) => http(`${base}/api/v1${ruta}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(k ? auth(k) : {}) }, body: JSON.stringify(cuerpo) });
    eq((await post(`/changes/${c}/note`)).status, 401, 'POST sin clave');
    eq((await post(`/changes/${c}/note`, lectura)).status, 403, 'POST con clave de lectura');
    const marca = ultimoEvento();
    const antes = leer(s => s.listChangeNotes(c).length);
    eq((await post(`/changes/${c}/note`, decide)).status, 200, 'POST con clave decide');
    eq(leer(s => s.listChangeNotes(c).length), antes + 1, 'la nota de la API no llegó al Store');
    eventosDe(marca, 'api:e2e-decide');
    // merge y gate no existen: ni como acción registrada ni como ruta.
    assert(!Object.keys(ACTIONS).some(n => /merge|gate/.test(n)), 'ACTIONS contiene merge o gate');
    for (const ruta of [`/changes/${c}/merge`, `/changes/${c}/gate`, '/gate/allow', '/merge']) {
      eq((await post(ruta, decide)).status, 404, `POST ${ruta}`);
      eq((await get(ruta, decide)).status, 404, `GET ${ruta}`);
    }
  });
}

// ---- seguridad de punta a punta --------------------------------------------------------------------------------
async function seguridad() {
  await flujo('seguridad: sesión, Origin y Host', async () => {
    const c = id('nota'), cuerpo = (csrf: string) => `csrf=${encodeURIComponent(csrf)}&body=x`;
    const w = await arrancarWeb(true);
    try {
      const form = { 'content-type': 'application/x-www-form-urlencoded' };
      eq((await http(`${w.url}/changes/${c}/note`, { method: 'POST', headers: { ...form, origin: w.url }, body: cuerpo('x') })).status, 401, 'POST sin sesión');
      const login = await http(w.login!);
      eq(login.status, 303, 'canje del enlace');
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
      assert(cookie.startsWith('fab_session='), 'sin cookie de sesión');
      const html = (await http(`${w.url}/changes/${c}`, { headers: { cookie } })).text;
      const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(html)?.[1];
      assert(csrf, 'la página no trae el token CSRF');
      const notas0 = leer(s => s.listChangeNotes(c).length);
      eq((await http(`${w.url}/changes/${c}/note`, { method: 'POST', headers: { ...form, cookie, origin: 'http://evil.example' }, body: cuerpo(csrf) })).status, 403, 'POST con Origin ajeno');
      eq((await http(`${w.url}/changes/${c}/note`, { method: 'POST', headers: { ...form, cookie }, body: cuerpo(csrf) })).status, 403, 'POST sin Origin');
      eq((await http(`${w.url}/changes/${c}/note`, { method: 'POST', headers: { ...form, cookie, origin: w.url }, body: cuerpo('malo') })).status, 403, 'POST con CSRF inválido');
      eq((await http(`${w.url}/changes/${c}/cancel`, { method: 'POST', headers: { ...form, cookie, origin: w.url }, body: `csrf=${encodeURIComponent(csrf)}` })).status, 400, 'cancelar sin confirmación en el servidor');
      eq(cambio(c).status === 'canceled', false, 'el change no se canceló sin confirmar');
      eq(leer(s => s.listChangeNotes(c).length), notas0, 'una petición rechazada escribió en el Store');
      const port = Number(new URL(w.url).port);
      eq(await crudo(port, `GET / HTTP/1.1\r\nHost: evil.example:${port}\r\nConnection: close\r\n\r\n`), 403, 'GET con Host ajeno');
      eq(await crudo(port, `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`), 403, 'GET por loopback con la sesión de escritura (T75)');
      eq(await crudo(port, `POST /changes/${c}/note HTTP/1.1\r\nHost: evil.example\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`), 403, 'POST con Host ajeno');
    } finally { w.parar(); }

    const ro = await arrancarWeb(false);
    try {
      eq((await http(`${ro.url}/`)).status, 200, 'GET en solo lectura');
      for (const ruta of ['/signals', `/changes/${c}/note`, `/changes/${c}/cancel`, '/perfiles/guardar', '/workstreams/nuevo', '/auth'])
        eq((await http(`${ro.url}${ruta}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ro.url }, body: 'a=b' })).status, 405, `POST ${ruta} sin --write`);
      const k = (() => { const s = new Store(join(semilla.stateDir, 'fabrica.db')); try { return s.createApiKey('e2e-ro', 'decide').key; } finally { s.close(); } })();
      eq((await http(`${ro.url}/api/v1/changes/${c}/note`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` }, body: '{"body":"x"}' })).status, 405, 'POST de la API sin --write');
    } finally { ro.parar(); }
  });
}

try { await main(); }
catch (e) { resultados.push({ flujo: 'preparación', estado: 'fallo', detalle: e instanceof Error ? e.stack ?? e.message : String(e), ms: 0 }); }
finally { rmSync(tmp, { recursive: true, force: true }); }

const resumen = { fecha: new Date().toISOString(), total: resultados.length, ok: resultados.filter(r => r.estado === 'ok').length, conocidos: resultados.filter(r => r.estado === 'conocido').length, fallos: resultados.filter(r => r.estado === 'fallo').length, resultados };
mkdirSync(CAPTURAS, { recursive: true });
writeFileSync(join(CAPTURAS, 'resumen.json'), JSON.stringify(resumen, null, 2) + '\n');
console.log(`\ne2e: ${resumen.ok} ok · ${resumen.conocidos} fallos conocidos · ${resumen.fallos} fallos · ${CAPTURAS}/resumen.json`);
for (const r of resultados.filter(r => r.estado === 'fallo')) console.log(`FALLO ${r.flujo}: ${r.detalle.split('\n').slice(0, 3).join(' | ')}`);
process.exit(resumen.fallos ? 1 : 0);
