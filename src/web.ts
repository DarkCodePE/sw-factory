// Superficie local de lectura. Las decisiones del ciclo pertenecen al Store.
import { join, dirname } from 'node:path';
import { existsSync, unlinkSync, chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { parseArgs } from 'node:util';
import { Store, StoreError, type Activity } from './store.ts';
import { ChangeStatus } from './enums.ts';
import { activityMetadata, changeCost, evidencePath, readEvidence } from './evidence.ts';
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
import { WebAuth, assertLoopback, RateLimiter, csrfToken } from './web-auth.ts';
import { GithubConnector, identityRoutes } from './web-identity.ts';
import { cliRoutes } from './web-cli.ts';
import { isBootstrapped } from './users.ts';
import { recoveryRoutes } from './web-recovery.ts';
import { PUBLIC_PATHS, authorizeRead, serverConfigPage, serverWebhooksPage, structuredActivityPage, structuredChangePage, structuredSignalsPage, structuredWorkstreamsPage, visiblePaths } from './web-views.ts';
import { attemptSection } from './web-attempts.ts';
import { changeTurnSections, notesSection, turnEvidenceRoute } from './web-turns.ts';
import { activityLogSection, transcriptSection } from './web-transcript.ts';
import { signalsView } from './web-signals.ts';
import { AUTOMATION_EDIT_ROUTE, AUTOMATION_EDITOR_JS, AUTOMATION_EDITOR_STYLE, automationEditor, automationsView } from './web-automations.ts';
import { workstreamsBody, wizardPage } from './web-ws.ts';
import { changeStages } from './flow.ts';
import { actionForms, actionNotice, serverWebAction, webAction } from './web-actions.ts';
import { WEB_ACTION_STYLE } from './web-actions-style.ts';
import { API_KEYS_PATH, ApiKeyUsage, apiKeysPage } from './web-api-keys.ts';
import { handleApi, handleServerApi, isApiPath } from './web-api.ts';
import { FLOW_STYLE, flowPage } from './web-flow.ts';
import { webhooksPage } from './web-webhooks.ts';
import { jiraImportAction } from './web-entrada.ts';
import type { TicketGateway } from './connectors/types.ts';
import { definitionPage } from './web-definition.ts';
import {
  validateServerConfig,
  isAuthorizedHost,
  isAuthorizedOrigin,
  SERVER_SECURITY_HEADERS,
  type ServerTlsConfig,
} from './web-server.ts';

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
const STYLE_CSS = WEB_STYLE + WEB_ACTION_STYLE + FLOW_STYLE + THEME_STYLE + SIDEBAR_STYLE + AUTOMATION_EDITOR_STYLE + '.count{font-size:13px;margin-left:6px}.bulk{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.links{margin:8px 0}';
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
      ? (store.noteRunnerIsRemote(c.id) ? 'El runner asignado es remoto.' : store.noteAttachmentWait(id))
      : undefined;
    return { title: c.title, body: `<p><a href="/changes?ws=${enc(store.getWorkstream(c.workstreamId).slug)}">Volver a changes</a></p><div class="summary">${badge(c.status)}<span>Coste total: <strong>${money(cost)}</strong></span><span>Rama: ${escape(c.branch ?? 'No asignada')}</span><span>PR: ${changePrLink(store, id)}</span>${copyButton(ui, c.id)}</div>${linksBlock(ui, { source: store.changeLinks(c.id).source })}<p class="description">${escape(c.description)}</p>${actionForms(store, url, csrf)}<h2>Activities</h2>${tree(activities, store.getWorkstream(c.workstreamId).slug)}${changeTurnSections(store.db, id, ui, activities, events)}${notesSection(notes, c.status, ui, attachmentWait)}<h2>Timeline</h2>${omitted ? `<p class="notice">Se omiten ${omitted} eventos anteriores.</p>` : ''}${events.length ? `<ol class="timeline">${events.map(e => `<li><time>${escape(e.created_at)}</time><div><strong>${escape(e.severity)}</strong> · ${escape(e.actor ?? 'fab')}<p>${escape(e.message)}</p></div></li>`).join('')}</ol>` : empty('No hay eventos para este change.')}` };
  }
  const a = store.getActivity(id);
  const c = store.getChange(a.changeId);
  let meta: Record<string, unknown> | null = null;
  try { meta = activityMetadata(stateDir, a); } catch { /* La sección de metadata informa del fallo. */ }
  return { title: `Activity · ${a.validator ?? a.kind}`, body: `<p><a href="/changes/${enc(c.id)}">${escape(c.title)}</a></p><div class="summary">${badge(a.status)} ${a.reviewStatus ? badge(a.reviewStatus) : ''}<span>${escape(a.id)}</span>${copyButton(ui, a.id)}${roleLink(ui, a, store.getWorkstream(c.workstreamId).slug, 'Ver el rol en Perfiles')}</div>${actionForms(store, url, csrf)}${activityScores(store, stateDir, a, csrf)}${attemptSection(a, meta, ui)}<h2>Veredicto y resultado</h2><p>Validador: ${escape(a.validator ?? (a.kind === 'gates' ? 'gate' : 'No aplica'))} · Revisión: ${escape(labels[a.reviewStatus ?? ''] ?? a.reviewStatus ?? 'Sin veredicto')}</p><pre tabindex="0">${escape([a.reviewComment, a.result, a.error].filter(Boolean).join('\n') || 'Sin resultado registrado.')}</pre>${activityLogSection(stateDir, c.id, a.id, url, ui)}${evidence(stateDir, c.id, `${a.id}.json`, 'Metadata de ejecución')}${evidence(stateDir, c.id, 'run.json', 'run.json')}${evidence(stateDir, c.id, 'diff.patch', 'Diff')}` };
}

function flagsOf(url: URL) {
  const isMetrics = url.pathname === '/metricas';
  const isConfig = url.pathname === '/config';
  const isRunners = url.pathname === '/config/runners';
  const isFlow = url.pathname === '/flujo';
  const isApiKeys = url.pathname === API_KEYS_PATH;
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
  return { isMetrics, isConfig, isRunners, isFlow, isApiKeys, isProfiles, isDefinition, isAutoImprove, automationEdit, automationCreate, isAutomationEditor, manual, isExperiments, isBenchmarks, isWebhooks, readAsset, readOnlyRoute };
}
type Flags = ReturnType<typeof flagsOf>;

function shellHtml(store: Store, content: { title: string; body: string }, nav: URL, still: boolean, f: Flags, label: string): string {
  const { isMetrics, isConfig, isRunners, isFlow, isApiKeys, isProfiles, isDefinition, isAutoImprove, isAutomationEditor, isExperiments, isBenchmarks, isWebhooks } = f;
    const workstreams = store.listWorkstreams();
    const inboxStatuses = store.inbox().map(a => a.reviewStatus === 'awaiting' ? 'awaiting' : a.status);
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(content.title)} · fab</title><link rel="stylesheet" href="/style.css"><script src="/theme.js"></script><script src="/sidebar.js" defer></script>${isMetrics ? '<link rel="stylesheet" href="/metrics.css">' : isAutomationEditor ? '<script src="/automation-editor.js" defer></script>' : still ? '' : '<script src="/poll.js" defer></script><script src="/inbox.js" defer></script><script src="/notify.js" defer></script>'}</head><body><a class="skip" href="#contenido">Saltar al contenido</a><aside><a class="brand" href="/">fab<span>Fábrica local</span></a><nav aria-label="Navegación principal"><a href="/"${nav.pathname === '/' ? ' aria-current="page"' : ''}>Bandeja${inboxStatuses.length ? ` <strong class="count" aria-label="${inboxStatuses.length} en la bandeja">${inboxStatuses.length}</strong>` : ''}</a><a href="/changes"${nav.pathname.startsWith('/changes') ? ' aria-current="page"' : ''}>Changes</a><a href="/signals"${nav.pathname === '/signals' ? ' aria-current="page"' : ''}>Señales</a><a href="/automations"${(nav.pathname === '/automations' || isAutomationEditor) ? ' aria-current="page"' : ''}>Automations</a><a href="/workstreams"${nav.pathname === '/workstreams' ? ' aria-current="page"' : ''}>Workstreams</a><a href="/flujo"${isFlow ? ' aria-current="page"' : ''}>Flujo</a><a href="/metricas"${isMetrics ? ' aria-current="page"' : ''}>Métricas</a><a href="/config"${isConfig || isApiKeys || isRunners ? ' aria-current="page"' : ''}>Configuración</a><a href="/definicion"${isDefinition ? ' aria-current="page"' : ''}>Definición</a><a href="/perfiles"${isProfiles ? ' aria-current="page"' : ''}>Perfiles</a><a href="/experimentos"${isExperiments ? ' aria-current="page"' : ''}>Experimentos</a><a href="/webhooks"${isWebhooks ? ' aria-current="page"' : ''}>Webhooks</a><a href="/benchmarks"${isBenchmarks ? ' aria-current="page"' : ''}>Benchmarks</a><a href="/automejora"${isAutoImprove ? ' aria-current="page"' : ''}>Automejora</a></nav>${sidebarNav(workstreams, escape)}<p class="local">${label}${isMetrics ? '<br>Actualización manual' : still ? '' : '<br>Actualización cada 2 s'}</p>${themeControl}${isMetrics || still ? '' : `<button type="button" id="${NOTIFY_ID}" hidden>Avisos: no</button>`}</aside><main id="contenido" data-inbox="${isRunners ? '' : escape(JSON.stringify(inboxCounts(inboxStatuses, labels)))}"><header><h1>${escape(content.title)}</h1></header>${content.body}</main></body></html>`;
  }

/** IP del cliente según el proxy autenticado (Caddy la emite en `X-Fab-Client-IP` y descarta `X-Forwarded-*`). Sin ella, un único cubo compartido. */
const clientIp = (req: Request): string => { const v = req.headers.get('x-fab-client-ip')?.trim() ?? ''; return isIP(v) ? v : 'desconocida'; };

/** Avisos de formulario por sesión, con caducidad y tope (§3.1): un POST deja su resultado para el siguiente GET de esa ruta. */
class Notices {
  private map = new Map<string, { path: string; result: string; at: number }>();
  constructor(private now: () => number, private ttlMs = 5 * 60_000, private max = 1000) {}
  put(session: string, path: string, result: string): void {
    this.map.delete(session);
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
    this.map.set(session, { path, result, at: this.now() });
  }
  take(session: string, path: string): string | undefined {
    const n = this.map.get(session);
    if (!n || n.path !== path) return;
    this.map.delete(session);
    return this.now() - n.at <= this.ttlMs ? n.result : undefined;
  }
}

/** Quita del menú los enlaces que darían 403 (`visiblePaths`). */
const filterNav = (html: string, allowed: (path: string) => boolean): string => {
  const out = html.replace(/<nav aria-label="Navegación principal">.*?<\/nav>/s, nav => nav.replace(/<a href="(\/[^"]*)"[^>]*>.*?<\/a>/gs, (a, path) => allowed(path) ? a : ''));
  // La barra de workstreams enlaza a /changes?ws=…: sin acceso a /changes (viewer) no se ofrece.
  return allowed('/changes') ? out : out.replace(/<nav aria-label="Workstreams" class="ws-nav">.*?<\/nav>/s, '');
};

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

export function startWeb(stateDir: string, port = 4310, options: {
  write?: boolean;
  clock?: () => Date;
  runnerCheck?: RunnerCheckOptions;
  jira?: TicketGateway;
  server?: boolean;
  publicOrigin?: string;
  socketPath?: string;
  tls?: ServerTlsConfig;
  fixtureTestOrigin?: boolean;
  /** Servidor: conector de identidad (T119b). Sin él no hay login y toda ruta de negocio da 401. */
  github?: GithubConnector;
  /** Servidor: secreto de servicio del CSRF y del prelogin; por defecto aleatorio por arranque. */
  secret?: string;
} = {}) {
  const auth = options.write && !options.server ? new WebAuth() : undefined;
  const keyUsage = new ApiKeyUsage(options.clock);
  const runnerCheck = runnerCheckAction(stateDir, options.runnerCheck);
  const jiraImport = jiraImportAction(stateDir, options.jira);
  const openStore = () => new Store(join(stateDir, 'fabrica.db'), { readonly: true });
  const initial = openStore();
  try { initial.listWorkstreams(); } finally { initial.close(); }

  const validated = options.server ? validateServerConfig(options) : undefined;
  const canonicalHost = validated?.canonicalHost;

  if (options.server) {
    const hasSocket = Boolean(options.socketPath);
    const hasTls = Boolean(options.tls?.cert && options.tls?.key && options.tls?.ca);
    if (!hasSocket && !hasTls) {
      throw new Error('El modo servidor requiere socket Unix (socketPath) o mTLS completo (cert, key, ca). No se permite TCP en claro.');
    }
  }

  let serveOptions: Record<string, unknown>;
  let prevUmask: number | undefined;
  if (options.server && options.socketPath) {
    const socketDir = dirname(options.socketPath);
    if (!existsSync(socketDir)) {
      mkdirSync(socketDir, { recursive: true, mode: 0o770 });
      try { chmodSync(socketDir, 0o770); } catch { /* ignore */ }
    }
    const dirStat = statSync(socketDir);
    const dirMode = dirStat.mode & 0o777;
    if (typeof process.getuid === 'function' && dirStat.uid !== process.getuid() && dirStat.uid !== 0) {
      throw new Error(`Directorio de socket con propietario no confiable (${socketDir}): UID ${dirStat.uid} no coincide con el proceso actual (${process.getuid()}) ni con root.`);
    }
    if ((dirMode & 0o002) !== 0) {
      throw new Error(`Directorio de socket inseguro (${socketDir}): permisos 0${dirMode.toString(8)} (escribible por otros). Debe ser 0770 o 0750.`);
    }

    if (existsSync(options.socketPath)) {
      const sockStat = statSync(options.socketPath);
      if (!sockStat.isSocket()) {
        throw new Error(`Ruta de socket inválida (${options.socketPath}): ya existe un archivo regular o directorio.`);
      }
      const probe = spawnSync(process.execPath, [
        '-e',
        'import net from "node:net"; const s = net.connect(process.argv[1]); s.on("connect", () => { s.destroy(); process.exit(0); }); s.on("error", () => process.exit(1)); setTimeout(() => process.exit(1), 300);',
        options.socketPath,
      ], { encoding: 'utf8' });
      if (probe.status === 0) {
        throw new Error(`Socket Unix en uso: ya existe una instancia activa escuchando en ${options.socketPath}`);
      }
      if (probe.status === null || (probe.status !== 1 && probe.error)) {
        throw new Error(`No se pudo verificar el estado del socket en ${options.socketPath}: ${probe.error?.message ?? 'error desconocido'}`);
      }
      try { unlinkSync(options.socketPath); } catch { /* ignore */ }
    }
    prevUmask = process.umask(0o007);
    serveOptions = { unix: options.socketPath, ...(auth || options.server ? { maxRequestBodySize: PROFILE_BODY_LIMIT } : {}) };
  } else if (options.server && options.tls) {
    serveOptions = {
      port,
      tls: {
        cert: Bun.file(options.tls.cert),
        key: Bun.file(options.tls.key),
        ca: options.tls.ca ? Bun.file(options.tls.ca) : undefined,
        requestCert: true,
        rejectUnauthorized: true,
      },
      ...(auth || options.server ? { maxRequestBodySize: PROFILE_BODY_LIMIT } : {})
    };
  } else {
    serveOptions = { hostname: '127.0.0.1', port, ...(auth || options.server ? { maxRequestBodySize: PROFILE_BODY_LIMIT } : {}) };
  }

  // ---- modo servidor: un único punto de despacho (T119e) ----
  const secret = options.secret ?? randomBytes(32).toString('hex');
  const clockMs = () => (options.clock ?? (() => new Date()))().getTime();
  const notices = new Notices(clockMs);
  const keyStore = options.server && options.github ? new Store(join(stateDir, 'fabrica.db'), { clock: options.clock }) : undefined;
  const limiter = new RateLimiter(clockMs);
  const identity = keyStore && options.github ? identityRoutes({ store: keyStore, github: options.github, publicOrigin: validated!.publicOrigin, write: !!options.write, secret, limiter }) : undefined;
  const cli = options.server ? cliRoutes({ stateDir, publicOrigin: validated!.publicOrigin, write: !!options.write, secret, clock: clockMs, limiter,
    resolveLogin: options.github ? login => options.github!.resolveLogin(login) : undefined, runnerCheck, jiraImport }) : undefined;
  const recovery = keyStore ? recoveryRoutes({ store: keyStore, publicOrigin: validated!.publicOrigin, secret }) : undefined;
  const MENU = ['/', '/changes', '/signals', '/automations', '/workstreams', '/flujo', '/metricas', '/config', '/definicion', '/perfiles', '/experimentos', '/webhooks', '/benchmarks', '/automejora'];

  /**
   * Orden (§3.1/§7): identidad, API de usuario, CLI remota, activos públicos, `principalOf`, recuperación restringida, POST de negocio
   * (`serverWebAction`, que autoriza con `runAs`) y, para los GET, `authorizeRead` antes de abrir el Store.
   */
  async function serverFetch(req: Request, url: URL, ip: string, respHeaders: Record<string, string>,
    respond: (body: string, status?: number, type?: string) => Response): Promise<Response> {
    const stamp = (r: Response): Response => { for (const [k, v] of Object.entries(respHeaders)) if (!r.headers.has(k)) r.headers.set(k, v); return r; };
    const deny = (status: number, text: string) => respond(text, status, 'text/plain; charset=utf-8');
    const path = url.pathname;
    const identified = identity ? await identity.handle(req, ip) : null;
    if (identified) return stamp(identified);
    if (isApiPath(path)) return stamp(await handleServerApi(req, url, stateDir, !!options.write, keyUsage));
    const remote = cli ? await cli.handle(req, ip) : null;
    if (remote) return stamp(remote);

    if (PUBLIC_PATHS.includes(path)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'Método no permitido');
      if (path === '/style.css') return respond(STYLE_CSS, 200, 'text/css; charset=utf-8');
      if (path === '/poll.js') return respond(POLL, 200, 'text/javascript; charset=utf-8');
      if (path === '/definition') return stamp(new Response(null, { status: 301, headers: { Location: `/definicion${url.search}` } }));
      const asset = READ_ASSETS.get(path);
      if (asset) return respond(asset.body, 200, asset.type);
    }

    const principal = identity?.principalOf(req) ?? undefined;
    if (!principal) {
      if ((req.method === 'GET' || req.method === 'HEAD') && /\btext\/html\b/.test(req.headers.get('accept') ?? '')) return stamp(new Response(null, { status: 303, headers: { Location: '/login' } }));
      return deny(401, 'Se requiere sesión autenticada en modo servidor.');
    }
    if (principal.recovery) {
      const screen = await recovery!.handle(req, principal);
      if (screen) return stamp(screen);
      if ((req.method === 'GET' || req.method === 'HEAD') && /\btext\/html\b/.test(req.headers.get('accept') ?? '')) return stamp(new Response(null, { status: 303, headers: { Location: '/recuperacion' } }));
      return deny(403, 'Recuperación en curso: solo el owner designado confirma la lista en /recuperacion.');
    }

    // Con `no-referrer` el navegador manda `Origin: null` en un POST de formulario del mismo origen y `originOk` lo rechazaría (T119b-H1):
    // una página con formulario sale con `same-origin`.
    const sendHtml = (body: string): Response => { const r = respond(body); if (body.includes('<form')) r.headers.set('Referrer-Policy', 'same-origin'); return r; };
    const f = flagsOf(url);
    const label = options.write && principal.role !== 'viewer' ? 'Escritura habilitada' : 'Solo lectura';
    const visible = new Set(visiblePaths(principal, MENU)), allowed = (p: string) => visible.has(p);
    const shell = (store: Store, content: { title: string; body: string }, nav: URL = url, still = f.manual) =>
      filterNav(shellHtml(store, content, nav, still, f, label), allowed);

    if (req.method === 'POST') {
      let response: Response;
      try {
        response = await serverWebAction(req, stateDir, { principal, write: !!options.write, publicOrigin: validated!.publicOrigin, secret,
          remember: (p, r) => notices.put(principal.sessionId!, p, r) }, runnerCheck, () => server.timeout(req, 35), jiraImport);
      } catch { return deny(500, 'No se pudo registrar la acción.'); }
      stamp(response);
      if (response.status >= 400 && !response.headers.get('Content-Type')?.startsWith('text/html')) return actionErrorPage(response, req, url, openStore, shell);
      return response;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'Método no permitido');

    if (principal.role === 'viewer' && path === '/') return stamp(new Response(null, { status: 303, headers: { Location: '/workstreams' } }));
    const decision = authorizeRead(principal, url);
    if (!decision.ok) return deny(decision.status, decision.status === 404 ? 'Página no encontrada' : 'No autorizado');
    if (f.isApiKeys) return stamp(new Response(null, { status: 303, headers: { Location: '/cuenta' } })); // las claves de usuario se gestionan en /cuenta
    const structured = decision.projection === 'structured';
    const csrf = options.write && principal.role !== 'viewer' ? csrfToken(secret, principal.sessionId!) : undefined;
    if ((f.isAutomationEditor || f.isRunners) && !csrf) return deny(403, 'El servidor está en solo lectura.');

    let store: Store | undefined;
    try {
      store = openStore();
      const turn = turnEvidenceRoute(store.db, stateDir, path);
      if (turn?.kind === 'log') {
        const log = turn.log;
        return respond(log ? log.text + (log.truncated ? '\n[log recortado a 256 KiB]' : '') : 'Log no disponible', log ? 200 : 404, 'text/plain; charset=utf-8');
      }
      if (turn) {
        if (!turn.found) return deny(404, 'Registro no encontrado');
        return sendHtml(shell(store, { title: 'Turno', body: `<p><a href="/changes/${enc(turn.changeId)}">Volver al change</a></p>` + transcriptSection(turn.log, url, ui) }));
      }
      const id = /^\/(changes|activities)\/([^/]+)$/.exec(path);
      const content = f.isAutomationEditor ? automationEditor(store, csrf!, {
        automation: f.automationEdit ? store.getAutomation(f.automationEdit[1]!) : undefined,
        values: f.automationCreate ? { ws: url.searchParams.get('ws') ?? undefined } : undefined,
      }) : f.isMetrics ? metricsPage(store, stateDir, url, csrf) : f.isConfig ? await serverConfigPage(principal, store, stateDir, url, escape, csrf)
        : f.isRunners ? runnersPage(store, csrf!, url.searchParams.get('editar')) : f.isProfiles ? profilesPage(store, stateDir, url, escape, csrf)
        : f.isAutoImprove ? autoImprovePage(store, stateDir, url, escape, csrf) : f.isExperiments ? experimentsPage(store.db, path)
        : f.isBenchmarks ? benchmarksPage(store, url, escape, csrf) : f.isFlow ? flowPage(store, url, escape)
        : f.isWebhooks ? serverWebhooksPage(principal, store, url, escape) : f.isDefinition ? definitionPage(store, stateDir, url, escape, csrf)
        : path === '/signals' ? (structured ? structuredSignalsPage(store, ui) : signalsView(store, escape, csrf))
        : path === '/workstreams' ? (structured ? structuredWorkstreamsPage(store, ui) : { title: 'Workstreams', body: workstreamsBody(store, ui, csrf, true) })
        : id && structured ? (id[1] === 'changes' ? structuredChangePage(store, ui, decodeURIComponent(id[2]!)) : structuredActivityPage(store, ui, decodeURIComponent(id[2]!)))
        : page(store, stateDir, url, csrf);
      if (!content) return deny(404, 'Página no encontrada');
      content.body = actionNotice(notices.take(principal.sessionId!, path)) + content.body;
      return sendHtml(shell(store, content));
    } catch (error) {
      if (error instanceof StoreError && error.code === 'not_found') return deny(404, 'Registro no encontrado');
      if (error instanceof URIError) return deny(400, 'Ruta inválida');
      return deny(500, 'No se pudo leer el estado de la fábrica.');
    } finally { store?.close(); }
  }

  let server: ReturnType<typeof Bun.serve>;
  try {
    // Verifica la base antes de escuchar y vuelve a abrirla en cada petición.
    server = Bun.serve({
    ...serveOptions,
    async fetch(req) {
      const respHeaders = options.server ? SERVER_SECURITY_HEADERS : HEADERS;
      const respond = (body: string, status = 200, type = 'text/html; charset=utf-8') => new Response(req.method === 'HEAD' ? null : body, { status, headers: { ...respHeaders, ...(auth?.sessionCsrf(req) ? { 'Referrer-Policy': 'same-origin' } : {}), 'Content-Type': type, ...(status === 405 ? { Allow: 'GET, HEAD' } : {}) } });
      const url = new URL(req.url);

      if (options.server) {
        if (!isAuthorizedHost(req.headers.get('host'), canonicalHost!)) return respond('Acceso denegado: Host no autorizado', 403, 'text/plain; charset=utf-8');
        // Origin protege los POST con cookie; la API de usuario y la CLI remota autentican con bearer (sin cookies, sin Origin de navegador).
        if (req.method === 'POST' && !isApiPath(url.pathname) && !/^\/cli\/v1\//.test(url.pathname) && !isAuthorizedOrigin(req.headers.get('origin'), validated!.publicOrigin)) {
          return respond('Acceso denegado: Origin ausente o ajeno', 403, 'text/plain; charset=utf-8');
        }
      } else {
        const hosts = auth ? [`${auth.host}:${server.port}`, ...(isApiPath(url.pathname) ? loopback(server.port!) : [])] : loopback(server.port!);
        if (!hosts.includes(req.headers.get('host') ?? '')) return respond('Acceso denegado', 403, 'text/plain; charset=utf-8');
      }

      if (options.server && url.pathname === '/healthz') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return respond('Método no permitido', 405, 'text/plain; charset=utf-8');
        return respond('ok', 200, 'text/plain; charset=utf-8');
      }

      if (options.fixtureTestOrigin && url.pathname === '/_test/origin') {
        if (req.method !== 'POST') return respond('Método no permitido', 405, 'text/plain; charset=utf-8');
        return new Response(null, { status: 204, headers: { ...respHeaders } });
      }

      if (options.server) return serverFetch(req, url, clientIp(req), respHeaders, respond);

      if (isApiPath(url.pathname)) return handleApi(req, url, openStore, auth ? { stateDir } : undefined, keyUsage);
      const f = flagsOf(url);
      const { isMetrics, isConfig, isRunners, isFlow, isApiKeys, isProfiles, isDefinition, isAutoImprove, automationEdit, automationCreate, isAutomationEditor, manual, isExperiments, isBenchmarks, isWebhooks, readAsset, readOnlyRoute } = f;
      const csrf = auth?.sessionCsrf(req);
      const keysCsrf = isApiKeys ? auth?.sessionCsrf(req) : undefined;

      const shell = (store: Store, content: { title: string; body: string }, nav: URL = url, still = manual) =>
        shellHtml(store, content, nav, still, f, auth ? (auth.sessionCsrf(req) ? 'Escritura habilitada' : 'Escritura: abre el enlace de la terminal') : 'Solo lectura');
      if (req.method === 'POST' && auth && !readOnlyRoute) {
        let response: Response;
        try { response = await webAction(req, stateDir, server.port ?? 0, auth, keyUsage, runnerCheck, () => server.timeout(req, 35), jiraImport, { server: options.server }); }
        catch { return respond('No se pudo registrar la acción.', 500, 'text/plain; charset=utf-8'); }
        for (const [key, value] of Object.entries(respHeaders)) if (!response.headers.has(key)) response.headers.set(key, value);
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
          for (const [key, value] of Object.entries(respHeaders)) response.headers.set(key, value);
          return response;
        }
        if (url.pathname === '/style.css') return respond(STYLE_CSS, 200, 'text/css; charset=utf-8');
        if (url.pathname === '/definition') return new Response(null, { status: 301, headers: { Location: `/definicion${url.search}`, ...respHeaders } });
        if (url.pathname === '/poll.js') return respond(POLL, 200, 'text/javascript; charset=utf-8');
        if (readAsset) return respond(readAsset.body, 200, readAsset.type);
        const csrf = auth?.sessionCsrf(req);
        if (isAutomationEditor && !csrf) return respond('Se necesita una sesión local.', 401, 'text/plain; charset=utf-8');
        store = openStore();
        const turn = turnEvidenceRoute(store.db, stateDir, url.pathname);
        if (turn?.kind === 'log') {
          const log = turn.log;
          return respond(log ? log.text + (log.truncated ? '\n[log recortado a 256 KiB]' : '') : 'Log no disponible', log ? 200 : 404, 'text/plain; charset=utf-8');
        }
        if (turn) {
          if (!turn.found) return respond('Registro no encontrado', 404, 'text/plain; charset=utf-8');
          const back = `<p><a href="/changes/${enc(turn.changeId)}">Volver al change</a></p>`;
          return respond(shell(store, { title: 'Turno', body: back + transcriptSection(turn.log, url, ui) }));
        }
        const content = isAutomationEditor ? automationEditor(store, csrf!, {
          automation: automationEdit ? store.getAutomation(automationEdit[1]!) : undefined,
          values: automationCreate ? { ws: url.searchParams.get('ws') ?? undefined } : undefined,
        }) : keysCsrf ? apiKeysPage(store, escape, keysCsrf, keyUsage) : isMetrics ? metricsPage(store, stateDir, url, auth?.sessionCsrf(req)) : isConfig ? await configPage(store, stateDir, url, escape, csrf) : isRunners ? runnersPage(store, csrf!, url.searchParams.get('editar')) : isProfiles ? profilesPage(store, stateDir, url, escape, auth?.sessionCsrf(req)) : isAutoImprove ? autoImprovePage(store, stateDir, url, escape, auth?.sessionCsrf(req)) : isExperiments ? experimentsPage(store.db, url.pathname) : isBenchmarks ? benchmarksPage(store, url, escape, auth?.sessionCsrf(req)) : isFlow ? flowPage(store, url, escape) : isWebhooks ? webhooksPage(store, url, escape) : isDefinition ? definitionPage(store, stateDir, url, escape, csrf) : page(store, stateDir, url, auth?.sessionCsrf(req));
        if (!content) return respond('Página no encontrada', 404, 'text/plain; charset=utf-8');
        content.body = actionNotice(req.method === 'GET' ? auth?.takeNotice(req, url.pathname) : undefined) + content.body;
        return respond(shell(store, content));
      } catch (error) {
        if (error instanceof StoreError && error.code === 'not_found') return respond('Registro no encontrado', 404, 'text/plain; charset=utf-8');
        if (error instanceof URIError) return respond('Ruta inválida', 400, 'text/plain; charset=utf-8');
        return respond('No se pudo leer el estado de la fábrica.', 500, 'text/plain; charset=utf-8');
      } finally { store?.close(); }
    }
  });
  } finally {
    if (prevUmask !== undefined) {
      process.umask(prevUmask);
    }
  }

  if (options.server && options.socketPath) {
    try {
      chmodSync(options.socketPath, 0o660);
    } catch (err) {
      server.stop(true);
      throw new Error(`Error al aplicar permisos 0660 al socket: ${err instanceof Error ? err.message : String(err)}`);
    }
    const finalMode = statSync(options.socketPath).mode & 0o777;
    if (finalMode !== 0o660) {
      server.stop(true);
      throw new Error(`Permisos de socket Unix inválidos: se esperaba 0660 pero se obtuvo 0${finalMode.toString(8)}`);
    }
  }

  return {
    port: server.port ?? 0,
    host: auth?.host,
    canonicalHost,
    publicOrigin: validated?.publicOrigin,
    socketPath: options.socketPath,
    loginUrl: options.server ? undefined : auth?.loginUrl(server.port ?? 0),
    stop(force = false) {
      server.stop(force);
      if (options.socketPath && existsSync(options.socketPath)) {
        try { unlinkSync(options.socketPath); } catch { /* ignore */ }
      }
    }
  };
}

const WRITE_WARNING = 'La sesión de escritura solo se sirve en el host fab-<aleatorio>.localhost de este arranque: abre el enlace tal cual, no sustituyas el host.';

export async function webMain(args: string[], stateDir: string, resolve?: Parameters<typeof assertLoopback>[1]): Promise<number> {
  try {
    const { values } = parseArgs({
      args,
      options: {
        port: { type: 'string' },
        write: { type: 'boolean' },
        server: { type: 'boolean' },
        'public-origin': { type: 'string' },
        socket: { type: 'string' },
        'tls-cert': { type: 'string' },
        'tls-key': { type: 'string' },
        'tls-ca': { type: 'string' },
        help: { type: 'boolean', short: 'h' }
      }
    });
    if (values.help) {
      console.log('fab web [--port 4310] [--write] [--server] [--public-origin <url>] [--socket <path>] · web local o servidor seguro; estado en FABRICA_HOME');
      console.log(WRITE_WARNING);
      return 0;
    }
    const port = values.port === undefined ? 4310 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Puerto inválido (0–65535)');

    if (values.server) {
      const publicOrigin = values['public-origin'] ?? process.env.FAB_PUBLIC_ORIGIN;
      if (!publicOrigin) {
        console.error('fab web: el modo servidor requiere --public-origin https://<host> (o variable FAB_PUBLIC_ORIGIN).');
        return 1;
      }
      if (!publicOrigin.startsWith('https://')) {
        console.error('fab web: el modo servidor requiere publicOrigin con HTTPS (ej. https://fab.ejemplo.com).');
        return 1;
      }
      const tlsCert = values['tls-cert'] ?? process.env.FAB_TLS_CERT;
      const tlsKey = values['tls-key'] ?? process.env.FAB_TLS_KEY;
      const tlsCa = values['tls-ca'] ?? process.env.FAB_TLS_CA;

      if (tlsCert || tlsKey || tlsCa) {
        if (!tlsCert || !tlsKey || !tlsCa) {
          console.error('fab web: mTLS requiere --tls-cert, --tls-key y --tls-ca completos.');
          return 1;
        }
      }

      const socketPath = values.socket ?? process.env.FAB_SOCKET ?? (!tlsCert ? '/run/fab/fab.sock' : undefined);
      const tls = tlsCert && tlsKey && tlsCa ? { cert: tlsCert, key: tlsKey, ca: tlsCa } : undefined;

      if (!socketPath && !tls) {
        console.error('fab web: el modo servidor requiere socket Unix (--socket) o mTLS completo (--tls-cert, --tls-key, --tls-ca).');
        return 1;
      }

      // Credenciales por referencia (D-K): el secreto de la aplicación de GitHub y el secreto de servicio se leen de ficheros
      // (credenciales de systemd o secretos de Docker), nunca de argv ni de la base.
      const credDir = process.env.CREDENTIALS_DIRECTORY;
      const clientId = process.env.FAB_GITHUB_CLIENT_ID;
      const clientSecretFile = process.env.FAB_GITHUB_CLIENT_SECRET_FILE ?? (credDir ? join(credDir, 'github-client-secret') : undefined);
      const serviceSecretFile = process.env.FAB_SERVICE_SECRET_FILE ?? (credDir && existsSync(join(credDir, 'service-secret')) ? join(credDir, 'service-secret') : undefined);
      if (!clientId || !clientSecretFile || !existsSync(clientSecretFile) || !readFileSync(clientSecretFile, 'utf8').trim()) {
        console.error('fab web: el modo servidor requiere FAB_GITHUB_CLIENT_ID y el secreto de la aplicación en FAB_GITHUB_CLIENT_SECRET_FILE (o la credencial github-client-secret).');
        return 1;
      }
      // Un secreto de servicio vacío o corto haría calculable el CSRF y la firma del prelogin: se rechaza (T119e-H2).
      if (serviceSecretFile && !existsSync(serviceSecretFile)) { console.error(`fab web: no existe el fichero del secreto de servicio (FAB_SERVICE_SECRET_FILE=${serviceSecretFile}).`); return 1; }
      const serviceSecret = serviceSecretFile ? readFileSync(serviceSecretFile, 'utf8').trim() : undefined;
      if (serviceSecret !== undefined && serviceSecret.length < 32) {
        console.error('fab web: el secreto de servicio (FAB_SERVICE_SECRET_FILE o la credencial service-secret) debe tener al menos 32 caracteres.');
        return 1;
      }
      // Solo lectura: el control no crea ni migra la base (T119e-H7). Sin base o con una anterior, no hay bootstrap.
      let bootstrapped = false;
      try { const boot = new Store(join(stateDir, 'fabrica.db'), { readonly: true }); try { bootstrapped = isBootstrapped(boot); } finally { boot.close(); } } catch { /* sin base legible */ }
      if (!bootstrapped) { console.error('fab web: el modo servidor exige el bootstrap del primer owner por consola (§2).'); return 1; }
      const server = startWeb(stateDir, port, {
        write: values.write,
        server: true,
        publicOrigin,
        socketPath,
        tls,
        github: new GithubConnector({ clientId, clientSecret: () => readFileSync(clientSecretFile, 'utf8').trim(), publicOrigin }),
        secret: serviceSecret,
      });

      console.log(`fab web --server · ${publicOrigin} · transporte: ${socketPath ? `socket unix ${socketPath}` : 'mTLS'} · ${values.write ? 'escritura habilitada' : 'solo lectura'}`);
      await new Promise<void>(res => {
        const done = () => { process.off('SIGINT', done); process.off('SIGTERM', done); server.stop(true); res(); };
        process.once('SIGINT', done); process.once('SIGTERM', done);
      });
      return 0;
    }

    const server = startWeb(stateDir, port, { write: values.write });
    if (server.host) try { await assertLoopback(server.host, resolve); } catch (e) { server.stop(true); throw e; }
    console.log(`fab web · ${server.loginUrl ?? `http://127.0.0.1:${server.port}`} · ${values.write ? 'escritura habilitada; enlace de un solo uso' : 'solo lectura'}`);
    if (values.write) console.log(WRITE_WARNING);
    await new Promise<void>(res => {
      const done = () => { process.off('SIGINT', done); process.off('SIGTERM', done); server.stop(true); res(); };
      process.once('SIGINT', done); process.once('SIGTERM', done);
    });
    return 0;
  } catch (e) {
    if (e instanceof Error && e.message.includes('no resuelve a loopback')) { console.error(`fab web: ${e.message}`); return 1; }
    if (e instanceof Error && (e.message.includes('publicOrigin') || e.message.includes('modo servidor') || e.message.includes('TLS'))) {
      console.error(`fab web: ${e.message}`);
      return 1;
    }
    console.error('fab web: no se pudo abrir la web. Comprueba el puerto y que FABRICA_HOME contenga una base fab existente.');
    return 1;
  }
}
