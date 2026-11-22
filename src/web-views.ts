// Lecturas web por rol en modo servidor (T119d, diseño T118–T119 §4.2). Pura: sin Store ni red salvo en las proyecciones.
// Cada GET se clasifica en una capacidad de `policy.ts`; web y CLI comparten esa política (D-F), así que la web nunca da más que la CLI.
// T119e llama a `authorizeRead` en el único punto de despacho GET y, según la `projection`, a las vistas estructuradas de abajo.
import { authorize } from './policy.ts';
import type { Principal } from './users.ts';
import type { Store, Activity } from './store.ts';
import type { Ui } from './web-changes.ts';
import type { ConfigView } from './web-config.ts';
import { API_KEYS_PATH } from './web-api-keys.ts';

/** `full`: el rol ve evidencia (O A M). `structured`: solo campos estructurados, sin texto libre de workers (V, §4.2). */
export type ReadProjection = 'full' | 'structured';
export type ReadDecision =
  | { ok: true; capability: string; projection: ReadProjection }
  | { ok: false; status: 401 | 403 | 404; reason: string };

type Cap = string | ((url: URL) => string);
/** Inventario de GET de `src/web.ts` (la página, el editor, la evidencia). Sin entrada = 404: falla cerrado ante una ruta nueva. */
const ROUTES: [RegExp, Cap][] = [
  [/^\/$/, 'ops/read'],
  [/^\/(signals|automations|workstreams|changes|flujo|benchmarks|experimentos)$/, 'ops/read'],
  [/^\/(benchmarks|experimentos)\/[^/]+$/, 'ops/read'],
  [/^\/(changes|activities)\/[^/]+$/, 'ops/read'], // el rol decide la proyección, no la ruta
  [/^\/changes\/[^/]+\/turns\/[^/]+\/(log|transcript)$/, 'evidence/read'],
  [/^\/metricas$/, 'ops/metrics'],
  [/^\/(config|perfiles|definicion|automejora|webhooks)$/, 'config/read'],
  [/^\/config\/runners$/, url => url.searchParams.has('editar') ? 'runners/update' : 'config/read'],
  [new RegExp(`^${API_KEYS_PATH}$`), 'api-key/list'],
  [/^\/workstreams\/nuevo$/, 'workstreams/create'],
  [/^\/automations\/nueva$/, 'automations/create'],
  [/^\/automations\/[^/]+\/editar$/, 'automations/update'],
];

/** Capacidad que exige un GET, o null si la ruta no está en el inventario. */
export function readCapability(url: URL): string | null {
  for (const [re, cap] of ROUTES) if (re.test(url.pathname)) return typeof cap === 'function' ? cap(url) : cap;
  return null;
}

/** Autoriza una lectura web. Sin principal 401; ruta desconocida 404; política que deniega 403. Se evalúa en cada lectura. */
export function authorizeRead(principal: Principal | undefined, url: URL): ReadDecision {
  if (!principal) return { ok: false, status: 401, reason: 'unauthorized' };
  if (principal.via !== 'web') return { ok: false, status: 403, reason: 'surface' }; // una clave o sesión CLI no abre páginas
  const capability = readCapability(url);
  if (!capability) return { ok: false, status: 404, reason: 'unknown_route' };
  // `write:true`: los editores son GET de mutaciones; que el servidor corra con `--write` lo decide T119e y el POST vuelve a autorizar.
  const d = authorize(principal, capability, { via: 'web', write: true });
  if (!d.ok) return { ok: false, status: 403, reason: d.reason };
  const evidence = authorize(principal, 'evidence/read', { via: 'web', write: false }).ok;
  return { ok: true, capability, projection: evidence ? 'full' : 'structured' };
}

/** Rutas de la lista que este principal puede abrir: el menú no ofrece lo que daría 403. */
export const visiblePaths = (principal: Principal | undefined, paths: string[]): string[] =>
  paths.filter(p => authorizeRead(principal, new URL(p, 'http://x')).ok);

/** Vista de `/config` para este principal: los indicadores de credenciales del host solo los ve el owner (§4.2). */
export const configViewFor = (principal: Principal): ConfigView =>
  ({ credentials: authorize(principal, 'config/credentials', { via: 'web', write: false }).ok });

const when = (v: string | null) => v ?? '—';

function activityRow(ui: Ui, a: Activity): string {
  const e = ui.escape;
  return `<li><a href="/activities/${encodeURIComponent(a.id)}">${e(a.validator ?? a.kind)}</a> ${ui.badge(a.status)} ${a.reviewStatus ? ui.badge(a.reviewStatus) : ''}<small>${e(a.id.slice(0, 8))}</small></li>`;
}

/** Change para viewer: estado y actividades, sin notas, eventos, coste ni resultado. Los textos de worker nunca entran. */
export function structuredChangePage(store: Store, ui: Ui, id: string): { title: string; body: string } {
  const c = store.getChange(id), e = ui.escape;
  const activities = store.listActivities({ changeId: id });
  return { title: c.title, body: `<p><a href="/changes?ws=${encodeURIComponent(store.getWorkstream(c.workstreamId).slug)}">Volver a changes</a></p><div class="summary">${ui.badge(c.status)}<span>Rama: ${e(c.branch ?? 'No asignada')}</span></div><h2>Activities</h2>${activities.length ? `<ul>${activities.map(a => activityRow(ui, a)).join('')}</ul>` : '<p class="empty">Este change todavía no tiene activities.</p>'}` };
}

/** Activity para viewer: veredicto (estado) y fechas; ni comentario, ni resultado, ni error, ni logs, ni diff. */
export function structuredActivityPage(store: Store, ui: Ui, id: string): { title: string; body: string } {
  const a = store.getActivity(id), c = store.getChange(a.changeId), e = ui.escape;
  return { title: `Activity · ${a.validator ?? a.kind}`, body: `<p><a href="/changes/${encodeURIComponent(c.id)}">${e(c.title)}</a></p><div class="summary">${ui.badge(a.status)} ${a.reviewStatus ? ui.badge(a.reviewStatus) : ''}<span>${e(a.id)}</span></div><dl><dt>Validador</dt><dd>${e(a.validator ?? 'No aplica')}</dd><dt>Reintentos</dt><dd>${a.retryCount}</dd><dt>Creada</dt><dd>${e(a.createdAt)}</dd><dt>Iniciada</dt><dd>${e(when(a.startedAt))}</dd><dt>Completada</dt><dd>${e(when(a.completedAt))}</dd></dl><p class="muted">Tu rol ve el estado, no el texto, los logs ni el diff.</p>` };
}
