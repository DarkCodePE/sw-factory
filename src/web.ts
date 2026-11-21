// Superficie local de lectura. Las decisiones del ciclo pertenecen al Store.
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Store, StoreError, type Activity } from './store.ts';
import { ChangeStatus } from './enums.ts';
import { activityCosts, activityMetadata, changeCost, evidencePath, readEvidence } from './evidence.ts';
import { redact } from './manifest.ts';
import { WEB_STYLE } from './web-style.ts';
import { benchmarksPage } from './web-bench.ts';
import { autoImprovePage } from './web-improve-auto.ts';
import { experimentsPage } from './web-experiments.ts';
import { NOTIFY, NOTIFY_ID, inboxCounts } from './web-notify.ts';
import { configPage } from './web-config.ts';
import { runnersPage } from './web-runners.ts';
import { runnerCheckAction, type RunnerCheckOptions } from './web-runner-check.ts';
import { PROFILE_BODY_LIMIT, profilesPage } from './web-profile.ts';

import { INBOX_JS, changePrLink, changesView, copyButton, inboxView, linksBlock, parseQuery, roleLink, type Ui } from './web-changes.ts';
import { THEME_JS, THEME_STYLE, themeControl } from './web-theme.ts';
import { SIDEBAR_JS, SIDEBAR_STYLE, sidebarNav } from './web-sidebar.ts';
import { activityScores } from './web-scorers.ts';
import { metricsPage, METRICS_STYLE } from './web-metrics.ts';
import { WebAuth, assertLoopback } from './web-auth.ts';
import { turnsSection, notesSection, turnLogRoute } from './web-turns.ts';
import { signalsView } from './web-signals.ts';
import { AUTOMATION_EDIT_ROUTE, AUTOMATION_EDITOR_JS, AUTOMATION_EDITOR_STYLE, automationEditor, automationsView } from './web-automations.ts';
import { workstreamsBody, wizardPage } from './web-ws.ts';
import { changeStages } from './flow.ts';
import { actionForms, actionNotice, webAction } from './web-actions.ts';
import { WEB_ACTION_STYLE } from './web-actions-style.ts';
import { API_KEYS_PATH, ApiKeyUsage, apiKeysPage } from './web-api-keys.ts';
import { handleApi, isApiPath } from './web-api.ts';
import { FLOW_STYLE, flowPage } from './web-flow.ts';
import { webhooksPage } from './web-webhooks.ts';
import { definitionPage } from './web-definition.ts';

const escape = (value: unknown): string => redact(String(value ?? '')).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const enc = encodeURIComponent;
const labels: Record<string, string> = { pending: 'Pendiente', in_progress: 'En curso', in_review: 'En revisión', implemented: 'Implementado', completed: 'Completado', failed: 'Fallido', canceled: 'Cancelado', declined: 'Rechazado', blocked: 'Bloqueado', quarantined: 'En cuarentena', waiting_reply: 'Espera respuesta', awaiting: 'Espera revisión', approved: 'Aprobado', commented: 'Con comentarios', draft: 'Borrador', active: 'Activo', paused: 'Pausado', archived: 'Archivado' };
const badge = (status: string) => `<span class="status ${['failed','blocked','quarantined','completed','in_progress','awaiting','waiting_reply'].includes(status) ? status : ''}">${escape(labels[status] ?? status)}</span>`;
const money = (cost: number | null) => cost === null ? 'No medido' : `${cost.toFixed(2)} USD`;
const empty = (text: string) => `<p class="empty">${escape(text)}</p>`;
const ui: Ui = { escape, badge, labels };
const TIMELINE_LIMIT = 200;
const POLL = `document.addEventListener('input',e=>{const f=e.target.closest('form[method=post]');if(f)f.setAttribute('data-dirty','');});setInterval(async()=>{if(document.querySelector('form[data-dirty]'))return;try{const r=await fetch(location.href,{cache:'no-store'});if(!r.ok)return;const doc=new DOMParser().parseFromString(await r.text(),'text/html');window.fabNotify?.(doc);const oc=document.querySelector('nav a[href="/"]'),nc=doc.querySelector('nav a[href="/"]');if(oc&&nc&&oc.innerHTML!==nc.innerHTML)oc.innerHTML=nc.innerHTML;if(document.querySelector('form[data-dirty]')||document.hidden||document.activeElement?.matches('input:not([data-sel]),select,textarea')||window.getSelection()?.toString()||document.querySelector('details[open]'))return;const old=document.querySelector('main'),next=doc.querySelector('main');if(next)window.fabPrepare?.(next);if(old&&next&&old.innerHTML!==next.innerHTML){old.replaceWith(next);}}catch{}},2000);`;
const READ_ASSETS = new Map([
  ['/automation-editor.js', { body: AUTOMATION_EDITOR_JS, type: 'text/javascript; charset=utf-8' }],
  ['/metrics.css', { body: METRICS_STYLE, type: 'text/css; charset=utf-8' }],
  ['/inbox.js', { body: INBOX_JS, type: 'text/javascript; charset=utf-8' }],
  ['/theme.js', { body: THEME_JS, type: 'text/javascript; charset=utf-8' }],
  ['/sidebar.js', { body: SIDEBAR_JS, type: 'text/javascript; charset=utf-8' }],
  ['/notify.js', { body: NOTIFY, type: 'text/javascript; charset=utf-8' }],
]);
const HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
};

function tree(activities: Activity[], slug: string): string {
  const byId = new Map(activities.map(a => [a.id, a]));
  const seen = new Set<string>();
  const row = (a: Activity): string => {
    if (seen.has(a.id)) return '';
    seen.add(a.id);
    const children = activities.filter(c => c.parentActivityId === a.id && !seen.has(c.id));
    return `<li><div class="activity"><a href="/activities/${enc(a.id)}">${escape(a.validator ?? a.kind)}</a> ${roleLink(ui, a, slug, 'Rol')} ${badge(a.status)} ${a.reviewStatus ? badge(a.reviewStatus) : ''}<small>${escape(a.id.slice(0, 8))}</small></div>${children.length ? `<ul>${children.map(row).join('')}</ul>` : ''}</li>`;
  };
  const roots = activities.filter(a => !a.parentActivityId || !byId.has(a.parentActivityId));
  // Datos antiguos o corruptos pueden contener ciclos: se muestran una sola vez, sin recursión infinita.
  return activities.length ? `<ul class="tree">${roots.map(row).join('')}${activities.filter(a => !seen.has(a.id)).map(row).join('')}</ul>` : empty('Este change todavía no tiene activities.');
}

function evidence(stateDir: string, changeId: string, file: string, title: string): string {
  try {
    const value = readEvidence(stateDir, evidencePath(changeId, file));
    return `<section><h2>${escape(title)}</h2>${value ? `${value.truncated ? '<p class="notice">Archivo truncado: se muestran los primeros 256 KiB.</p>' : ''}<pre tabindex="0">${escape(value.text)}</pre>` : empty('No hay evidencia guardada.')}</section>`;
  } catch { return `<section><h2>${escape(title)}</h2>${empty('Evidencia no disponible: ruta insegura o fichero ilegible.')}</section>`; }
}

function page(store: Store, stateDir: string, url: URL, csrf?: string): { title: string; body: string } | null {
  const ws = url.searchParams.get('ws') || undefined;
  if (ws) store.getWorkstream(ws);
  if (url.pathname === '/') {
    const inbox = store.inbox(ws);
    const counts = new Map<string, number>();
    for (const a of inbox) { const status = a.reviewStatus === 'awaiting' ? 'awaiting' : a.status; counts.set(status, (counts.get(status) ?? 0) + 1); }
    const slugs = new Map(store.listWorkstreams().map(w => [w.id, w.slug]));
    const items = inbox.map(a => ({ a, title: store.getChange(a.changeId).title, slug: slugs.get(a.workstreamId) ?? '' }));
    return { title: 'Bandeja', body: `<p class="intro">Lo que necesita tu atención en la fábrica.</p><div class="counts">${counts.size ? [...counts].map(([s,n]) => `<span>${badge(s)} <strong>${n}</strong></span>`).join('') : '<span>0 pendientes de atención</span>'}</div>${inboxView(ui, items, url.searchParams.get('q') ?? '')}<p>Para decidir, abre el detalle de la activity; la escritura requiere fab web --write y el enlace de acceso de la terminal.</p>` };
  }
  if (url.pathname === '/signals') return signalsView(store, escape, csrf);
  if (url.pathname === '/automations') return automationsView(store, escape, csrf, ws);
  if (url.pathname === '/workstreams') return { title: 'Workstreams', body: workstreamsBody(store, ui, csrf) };
  if (url.pathname === '/workstreams/nuevo') return wizardPage(store, stateDir, url, csrf);
  if (url.pathname === '/changes') {
    const f = parseQuery(url.searchParams);
    const stage = url.searchParams.get('stage');
    const stages = stage && ws ? changeStages(store, store.getWorkstream(ws).id) : null;
    const all = store.changeIndex(ws).filter(c => !stages || stages.get(c.id) === stage);
    const statuses = [...new Set([...Object.values(ChangeStatus), 'blocked', 'quarantined', ...all.map(c => c.status)])];
    return { title: 'Changes', body: changesView(ui, all, f, ws ?? '', store.listWorkstreams(), statuses) };
  }
  const match = /^\/(changes|activities)\/([^/]+)$/.exec(url.pathname);
  if (!match) return null;
  const id = decodeURIComponent(match[2]!);
  if (!/^[\w-]+$/.test(id)) throw new URIError('Identificador inválido');
  if (match[1] === 'changes') {
    const c = store.getChange(id);
    const activities = store.listActivities({ changeId: id });
    let cost: number | null = null;
    try { cost = changeCost(store, stateDir, id); } catch { /* Evidencia inaccesible: coste desconocido. */ }
    const events = store.listEvents(c.workstreamId, TIMELINE_LIMIT, id);
    const omitted = Math.max(0, store.countEvents(c.workstreamId, id) - events.length);
    const notes = store.listChangeNotes(id);
    const attachmentWait = notes.some(note => note.attachment && !note.deliveredAt)
      ? (store.noteRunnerIsRemote(c.workstreamId) ? 'El runner asignado es remoto.' : store.noteAttachmentWait(id))
      : undefined;
    return { title: c.title, body: `<p><a href="/changes?ws=${enc(store.getWorkstream(c.workstreamId).slug)}">Volver a changes</a></p><div class="summary">${badge(c.status)}<span>Coste total: <strong>${money(cost)}</strong></span><span>Rama: ${escape(c.branch ?? 'No asignada')}</span><span>PR: ${changePrLink(store, id)}</span>${copyButton(ui, c.id)}</div>${linksBlock(ui, { source: store.changeLinks(c.id).source })}<p class="description">${escape(c.description)}</p>${actionForms(store, url, csrf)}<h2>Activities</h2>${tree(activities, store.getWorkstream(c.workstreamId).slug)}${turnsSection(store.db, id, ui)}${notesSection(notes, c.status, ui, attachmentWait)}<h2>Timeline</h2>${omitted ? `<p class="notice">Se omiten ${omitted} eventos anteriores.</p>` : ''}${events.length ? `<ol class="timeline">${events.map(e => `<li><time>${escape(e.created_at)}</time><div><strong>${escape(e.severity)}</strong> · ${escape(e.actor ?? 'fab')}<p>${escape(e.message)}</p></div></li>`).join('')}</ol>` : empty('No hay eventos para este change.')}` };
  }
  const a = store.getActivity(id);
  const c = store.getChange(a.changeId);
  let meta: Record<string, unknown> | null = null;
  try { meta = activityMetadata(stateDir, a); } catch { /* La sección de metadata informa del fallo. */ }
  const costs = activityCosts(a, meta);
  const count = Math.max(costs?.length ?? 0, a.retryCount + (a.status === 'failed' ? 0 : 1), 1);
  const duration = typeof meta?.durationMs === 'number' && Number.isFinite(meta.durationMs) ? meta.durationMs : null;
  return { title: `Activity · ${a.validator ?? a.kind}`, body: `<p><a href="/changes/${enc(c.id)}">${escape(c.title)}</a></p><div class="summary">${badge(a.status)} ${a.reviewStatus ? badge(a.reviewStatus) : ''}<span>${escape(a.id)}</span>${copyButton(ui, a.id)}${roleLink(ui, a, store.getWorkstream(c.workstreamId).slug, 'Ver el rol en Perfiles')}</div>${actionForms(store, url, csrf)}${activityScores(store, stateDir, a, csrf)}<h2>Intentos</h2><div class="table-wrap"><table><thead><tr><th>Intento</th><th>Coste</th><th>Duración</th></tr></thead><tbody>${Array.from({ length: count }, (_, i) => `<tr><td>${i + 1}</td><td>${money(costs?.[i] ?? null)}</td><td>${i === count - 1 && duration !== null ? `${duration} ms` : 'No medida'}</td></tr>`).join('')}</tbody></table></div><p class="muted">La evidencia histórica solo conserva la duración del último intento.</p><h2>Veredicto y resultado</h2><p>Validador: ${escape(a.validator ?? (a.kind === 'gates' ? 'gate' : 'No aplica'))} · Revisión: ${escape(labels[a.reviewStatus ?? ''] ?? a.reviewStatus ?? 'Sin veredicto')}</p><pre tabindex="0">${escape([a.reviewComment, a.result, a.error].filter(Boolean).join('\n') || 'Sin resultado registrado.')}</pre>${evidence(stateDir, c.id, `${a.id}.log`, 'Log')}${evidence(stateDir, c.id, `${a.id}.json`, 'Metadata de ejecución')}${evidence(stateDir, c.id, 'run.json', 'run.json')}${evidence(stateDir, c.id, 'diff.patch', 'Diff')}` };
}

/** Un error de acción se muestra en la plantilla normal, con menú y enlace de vuelta a la página de origen (T78). */
async function actionErrorPage(response: Response, req: Request, url: URL, openStore: () => Store, shell: (s: Store, c: { title: string; body: string }, nav: URL, still: boolean) => string): Promise<Response> {
  const message = await response.text();
  const plain = () => new Response(message, { status: response.status, headers: response.headers });
  // Origen: el Referer si es de este mismo host y una ruta local (ni `//host` ni `\\`); si no, la ruta de la acción sin su último tramo
  // cuando es una página conocida, y `/` en otro caso (`/questions/x/answer` → `/questions/x` no existe).
  let back = url.pathname.replace(/\/[^/]*$/, '') || '/';
  if (!KNOWN_BACK.test(back)) back = '/';
  try { const r = new URL(req.headers.get('referer') ?? ''); if (r.host === url.host && /^\/(?![/\\])/.test(r.pathname) && !r.pathname.includes('\\')) back = r.pathname + r.search; } catch { /* sin Referer */ }
  let store: Store | undefined;
  try {
    store = openStore();
    const html = shell(store, { title: 'No se pudo completar la acción', body: `<p role="alert">${escape(message)}</p><p><a href="${escape(back)}">Volver a la página de origen</a></p>` }, new URL(back, url), true);
    const headers = new Headers(response.headers); headers.set('Content-Type', 'text/html; charset=utf-8'); headers.delete('Content-Length');
    return new Response(html, { status: response.status, headers });
  } catch { return plain(); } // la base no abre (escritor activo): el error en texto, con su estado y cabeceras
  finally { store?.close(); }
}

const KNOWN_BACK = /^\/(?:activities\/[\w-]+|changes(?:\/[\w-]+)?|workstreams|automations|signals|perfiles|config|experimentos|flujo|metricas)?$/;

const loopback = (port: number) => [`127.0.0.1:${port}`, `localhost:${port}`];

export function startWeb(stateDir: string, port = 4310, options: { write?: boolean; clock?: () => Date; runnerCheck?: RunnerCheckOptions } = {}) {
  const auth = options.write ? new WebAuth() : undefined;
  const keyUsage = new ApiKeyUsage(options.clock);
  const runnerCheck = runnerCheckAction(stateDir, options.runnerCheck);
  const openStore = () => new Store(join(stateDir, 'fabrica.db'), { readonly: true });
  const initial = openStore();
  try { initial.listWorkstreams(); } finally { initial.close(); }
  let server: ReturnType<typeof Bun.serve>;
  // Verifica la base antes de escuchar y vuelve a abrirla en cada petición.
  server = Bun.serve({ hostname: '127.0.0.1', port, ...(auth ? { maxRequestBodySize: PROFILE_BODY_LIMIT } : {}), async fetch(req) {
      const respond = (body: string, status = 200, type = 'text/html; charset=utf-8') => new Response(req.method === 'HEAD' ? null : body, { status, headers: { ...HEADERS, ...(auth?.sessionCsrf(req) ? { 'Referrer-Policy': 'same-origin' } : {}), 'Content-Type': type, ...(status === 405 ? { Allow: 'GET, HEAD' } : {}) } });
      const url = new URL(req.url);
      // Con escritura, las rutas con sesión solo se sirven en el host único; la API con clave no usa cookie y conserva loopback.
      const hosts = auth ? [`${auth.host}:${server.port}`, ...(isApiPath(url.pathname) ? loopback(server.port!) : [])] : loopback(server.port!);
      if (!hosts.includes(req.headers.get('host') ?? '')) return respond('Acceso denegado', 403, 'text/plain; charset=utf-8');
      if (isApiPath(url.pathname)) return handleApi(req, url, openStore, auth ? { stateDir } : undefined, keyUsage);
      const isMetrics = url.pathname === '/metricas';
      const isConfig = url.pathname === '/config';
      const isRunners = url.pathname === '/config/runners';
      const csrf = auth?.sessionCsrf(req);
      const isFlow = url.pathname === '/flujo';
      const isApiKeys = url.pathname === API_KEYS_PATH;
      const keysCsrf = isApiKeys ? auth?.sessionCsrf(req) : undefined;
      const isProfiles = url.pathname === '/perfiles';
      const isDefinition = url.pathname === '/definicion';
      const isAutoImprove = url.pathname === '/automejora';
      const automationEdit = AUTOMATION_EDIT_ROUTE.exec(url.pathname);
      const automationCreate = url.pathname === '/automations/nueva';
      const isAutomationEditor = automationCreate || !!automationEdit;
      const manual = isConfig || isProfiles || isDefinition || isAutoImprove || isApiKeys || isAutomationEditor || isRunners; // sin sondeo: no pisar lo que se escribe
      const isExperiments = url.pathname === '/experimentos' || url.pathname.startsWith('/experimentos/');
      const isBenchmarks = url.pathname === '/benchmarks' || url.pathname.startsWith('/benchmarks/');
      const isWebhooks = url.pathname === '/webhooks';
      const readAsset = READ_ASSETS.get(url.pathname);
      const readOnlyRoute = isFlow || isMetrics || isConfig || isApiKeys || isExperiments || isAutomationEditor || isRunners || isWebhooks || isDefinition || readAsset !== undefined;
      const shell = (store: Store, content: { title: string; body: string }, nav: URL = url, still = manual) => {
        const workstreams = store.listWorkstreams();
        const inboxStatuses = store.inbox().map(a => a.reviewStatus === 'awaiting' ? 'awaiting' : a.status);
        return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(content.title)} · fab</title><link rel="stylesheet" href="/style.css"><script src="/theme.js"></script><script src="/sidebar.js" defer></script>${isMetrics ? '<link rel="stylesheet" href="/metrics.css">' : isAutomationEditor ? '<script src="/automation-editor.js" defer></script>' : still ? '' : '<script src="/poll.js" defer></script><script src="/inbox.js" defer></script><script src="/notify.js" defer></script>'}</head><body><a class="skip" href="#contenido">Saltar al contenido</a><aside><a class="brand" href="/">fab<span>Fábrica local</span></a><nav aria-label="Navegación principal"><a href="/"${nav.pathname === '/' ? ' aria-current="page"' : ''}>Bandeja${inboxStatuses.length ? ` <strong class="count" aria-label="${inboxStatuses.length} en la bandeja">${inboxStatuses.length}</strong>` : ''}</a><a href="/changes"${nav.pathname.startsWith('/changes') ? ' aria-current="page"' : ''}>Changes</a><a href="/signals"${nav.pathname === '/signals' ? ' aria-current="page"' : ''}>Señales</a><a href="/automations"${(nav.pathname === '/automations' || isAutomationEditor) ? ' aria-current="page"' : ''}>Automations</a><a href="/workstreams"${nav.pathname === '/workstreams' ? ' aria-current="page"' : ''}>Workstreams</a><a href="/flujo"${isFlow ? ' aria-current="page"' : ''}>Flujo</a><a href="/metricas"${isMetrics ? ' aria-current="page"' : ''}>Métricas</a><a href="/config"${isConfig || isApiKeys || isRunners ? ' aria-current="page"' : ''}>Configuración</a><a href="/definicion"${isDefinition ? ' aria-current="page"' : ''}>Definición</a><a href="/perfiles"${isProfiles ? ' aria-current="page"' : ''}>Perfiles</a><a href="/experimentos"${isExperiments ? ' aria-current="page"' : ''}>Experimentos</a><a href="/webhooks"${isWebhooks ? ' aria-current="page"' : ''}>Webhooks</a><a href="/benchmarks"${isBenchmarks ? ' aria-current="page"' : ''}>Benchmarks</a><a href="/automejora"${isAutoImprove ? ' aria-current="page"' : ''}>Automejora</a></nav>${sidebarNav(workstreams, escape)}<p class="local">${auth ? (auth.sessionCsrf(req) ? 'Escritura habilitada' : 'Escritura: abre el enlace de la terminal') : 'Solo lectura'}${isMetrics ? '<br>Actualización manual' : still ? '' : '<br>Actualización cada 2 s'}</p>${themeControl}${isMetrics || still ? '' : `<button type="button" id="${NOTIFY_ID}" hidden>Avisos: no</button>`}</aside><main id="contenido" data-inbox="${isRunners ? '' : escape(JSON.stringify(inboxCounts(inboxStatuses, labels)))}"><header><h1>${escape(content.title)}</h1></header>${content.body}</main></body></html>`;
      };
      if (req.method === 'POST' && auth && !readOnlyRoute) {
        let response: Response;
        try { response = await webAction(req, stateDir, server.port!, auth, keyUsage, runnerCheck, () => server.timeout(req, 35)); }
        catch { return respond('No se pudo registrar la acción.', 500, 'text/plain; charset=utf-8'); }
        for (const [key, value] of Object.entries(HEADERS)) if (!response.headers.has(key)) response.headers.set(key, value);
        // El editor de automations ya devuelve su propia página HTML de error (T86): no se envuelve de nuevo.
        if (response.status >= 400 && !response.headers.get('Content-Type')?.startsWith('text/html')) return actionErrorPage(response, req, url, openStore, shell);
        return response;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return respond('Método no permitido', 405, 'text/plain; charset=utf-8');
      if (isApiKeys && !keysCsrf) return respond('Abre el enlace de acceso de fab web --write para administrar las claves API.', 401, 'text/plain; charset=utf-8');
      if (isRunners && !csrf) return respond('Se necesita una sesión local.', 401, 'text/plain; charset=utf-8');
      let store: Store | undefined;
      try {
        if (url.pathname === '/auth' && auth) {
          if (req.method !== 'GET') return respond('Método no permitido', 405);
          const response = auth.exchange(url.searchParams.get('token') ?? '');
          for (const [key, value] of Object.entries(HEADERS)) response.headers.set(key, value);
          return response;
        }
        if (url.pathname === '/style.css') return respond(WEB_STYLE + WEB_ACTION_STYLE + FLOW_STYLE + THEME_STYLE + SIDEBAR_STYLE + AUTOMATION_EDITOR_STYLE + '.count{font-size:13px;margin-left:6px}.bulk{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.links{margin:8px 0}', 200, 'text/css; charset=utf-8');
        if (url.pathname === '/definition') return new Response(null, { status: 301, headers: { Location: `/definicion${url.search}`, ...HEADERS } });
        if (url.pathname === '/poll.js') return respond(POLL, 200, 'text/javascript; charset=utf-8');
        if (readAsset) return respond(readAsset.body, 200, readAsset.type);
        const csrf = auth?.sessionCsrf(req);
        if (isAutomationEditor && !csrf) return respond('Se necesita una sesión local.', 401, 'text/plain; charset=utf-8');
        store = openStore();
        const log = turnLogRoute(store.db, stateDir, url.pathname);
        if (log) return respond(log.body, log.status, 'text/plain; charset=utf-8');
        const content = isAutomationEditor ? automationEditor(store, csrf!, {
          automation: automationEdit ? store.getAutomation(automationEdit[1]!) : undefined,
          values: automationCreate ? { ws: url.searchParams.get('ws') ?? undefined } : undefined,
        }) : keysCsrf ? apiKeysPage(store, escape, keysCsrf, keyUsage) : isMetrics ? metricsPage(store, stateDir, url, auth?.sessionCsrf(req)) : isConfig ? await configPage(store, stateDir, url, escape, csrf) : isRunners ? runnersPage(store, csrf!, url.searchParams.get('editar')) : isProfiles ? profilesPage(store, stateDir, url, escape, auth?.sessionCsrf(req)) : isAutoImprove ? autoImprovePage(store, stateDir, url, escape, auth?.sessionCsrf(req)) : isExperiments ? experimentsPage(store.db, url.pathname) : isBenchmarks ? benchmarksPage(store, url, escape, auth?.sessionCsrf(req)) : isFlow ? flowPage(store, url, escape) : isWebhooks ? webhooksPage(store, url, escape) : isDefinition ? definitionPage(store, stateDir, url, escape) : page(store, stateDir, url, auth?.sessionCsrf(req));
        if (!content) return respond('Página no encontrada', 404, 'text/plain; charset=utf-8');
        content.body = actionNotice(req.method === 'GET' ? auth?.takeNotice(req, url.pathname) : undefined) + content.body;
        return respond(shell(store, content));
      } catch (error) {
        if (error instanceof StoreError && error.code === 'not_found') return respond('Registro no encontrado', 404, 'text/plain; charset=utf-8');
        if (error instanceof URIError) return respond('Ruta inválida', 400, 'text/plain; charset=utf-8');
        return respond('No se pudo leer el estado de la fábrica.', 500, 'text/plain; charset=utf-8');
      } finally { store?.close(); }
    } });
  return { port: server.port!, host: auth?.host, loginUrl: auth?.loginUrl(server.port!), stop(force = false) { server.stop(force); } };
}

const WRITE_WARNING = 'La sesión de escritura solo se sirve en el host fab-<aleatorio>.localhost de este arranque: abre el enlace tal cual, no sustituyas el host.';

export async function webMain(args: string[], stateDir: string, resolve?: Parameters<typeof assertLoopback>[1]): Promise<number> {
  try {
    const { values } = parseArgs({ args, options: { port: { type: 'string' }, write: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
    if (values.help) { console.log('fab web [--port 4310] [--write] · web local, solo lectura por defecto; estado en FABRICA_HOME'); console.log(WRITE_WARNING); return 0; }
    const port = values.port === undefined ? 4310 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Puerto inválido (0–65535)');
    const server = startWeb(stateDir, port, { write: values.write });
    if (server.host) try { await assertLoopback(server.host, resolve); } catch (e) { server.stop(true); throw e; }
    console.log(`fab web · ${server.loginUrl ?? `http://127.0.0.1:${server.port}`} · ${values.write ? 'escritura habilitada; enlace de un solo uso' : 'solo lectura'}`);
    if (values.write) console.log(WRITE_WARNING);
    await new Promise<void>(resolve => {
      const done = () => { process.off('SIGINT', done); process.off('SIGTERM', done); server.stop(true); resolve(); };
      process.once('SIGINT', done); process.once('SIGTERM', done);
    });
    return 0;
  } catch (e) { if (e instanceof Error && e.message.includes('no resuelve a loopback')) { console.error(`fab web: ${e.message}`); return 1; } console.error('fab web: no se pudo abrir la web. Comprueba el puerto y que FABRICA_HOME contenga una base fab existente.'); return 1; }
}
