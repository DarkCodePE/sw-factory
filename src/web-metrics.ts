import type { Store } from './store.ts';
import { calculateMetrics, validateDay, type MetricsRange } from './metrics.ts';
import { scorersPanel, sinceOf, type RangeSel } from './web-scorers.ts';
import { CARD_STYLE, card, esc, statCard, table } from './web-cards.ts';
const money = (v: number | null) => v === null ? 'No medido' : `${v.toFixed(2)} USD`;
const duration = (v: number | null) => v === null ? 'No medido' : `${(v / 3600000).toLocaleString('es', { maximumFractionDigits: 2 })} h`;
function bars(name: string, rows: [string, number][]) {
  const max = Math.max(1, ...rows.map(r => r[1]));
  return `<svg role="img" aria-label="${esc(name)}; valores en la tabla siguiente" viewBox="0 0 350 ${Math.max(1, rows.length) * 36}" width="350" height="${Math.max(1, rows.length) * 36}">${rows.map(([label, v], i) => `<text x="0" y="${i * 36 + 21}" fill="currentColor" font-size="14">${esc(label)}</text><rect x="145" y="${i * 36 + 7}" width="${v / max * 155}" height="20" fill="currentColor"/><text x="315" y="${i * 36 + 21}" fill="currentColor" font-size="14">${v}</text>`).join('')}</svg>`;
}
const TABS = [['productividad', 'Productividad'], ['gasto', 'Gasto'], ['jueces', 'Jueces']] as const;
const RANGES = [['7', 'Últimos 7 días'], ['30', 'Últimos 30 días'], ['90', 'Últimos 90 días'], ['all', 'Todo el historial'], ['custom', 'Rango personalizado']];

/** Rango y workstream de la URL, el mismo para las tres pestañas. Un valor inválido es 400 (URIError). */
function selection(url: URL): RangeSel {
  const ws = url.searchParams.get('ws') || undefined, rangeParam = url.searchParams.get('range');
  let from = url.searchParams.get('from')?.trim() || undefined, to = url.searchParams.get('to')?.trim() || undefined;
  if (rangeParam && rangeParam !== 'custom') { from = undefined; to = undefined; }
  let range = rangeParam ?? (from || to ? 'custom' : '7');
  if (range === 'custom' && !from && !to) range = '7';
  if (!['7', '30', '90', 'all', 'custom'].includes(range)) throw new URIError('Rango inválido');
  if (from) validateDay(from);
  if (to) validateDay(to);
  if (from && to && from > to) throw new URIError('Rango inválido');
  if (from && to && (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 > 366) throw new URIError('Rango demasiado amplio');
  return { ws, range, from, to, since: from ? `${from}T00:00:00.000Z` : range === 'custom' || range === 'all' ? undefined : sinceOf(range), until: to ? `${to}T23:59:59.999Z` : undefined };
}
const query = (r: RangeSel, tab: string) => `?${new URLSearchParams({ tab, ...(r.ws && { ws: r.ws }), range: r.range, ...(r.from && { from: r.from }), ...(r.to && { to: r.to }) })}`;
const tabs = (active: string, r: RangeSel) => `<nav aria-label="Secciones de métricas" class="tabs">${TABS.map(([id, label]) => `<a href="/metricas${esc(query(r, id))}"${active === id ? ' aria-current="page"' : ''}>${label}</a>`).join(' ')}</nav>`;
const filters = (store: Store, tab: string, r: RangeSel, what: string, scorer?: string, extra = '') => `<form action="/metricas" method="get" class="filters"><input type="hidden" name="tab" value="${tab}">${scorer ? `<input type="hidden" name="scorer" value="${esc(scorer)}">` : ''}<label>Workstream<select name="ws"><option value="">Todos</option>${store.listWorkstreams().map(w => `<option value="${esc(w.slug)}"${r.ws === w.id || r.ws === w.slug ? ' selected' : ''}>${esc(w.slug)}</option>`).join('')}</select></label><label>${what}<select name="range">${RANGES.map(([v, l]) => `<option value="${v}"${r.range === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label><label>Desde<input name="from" type="date" value="${esc(r.from ?? '')}"></label><label>Hasta<input name="to" type="date" value="${esc(r.to ?? '')}"></label>${extra}<button type="submit">Actualizar</button></form>`;

// Runs por rol del worker o por raíz frente a subagentes (T112). Valor inválido: 400, como el rango.
const RUNS_BY = [['rol', 'Rol'], ['raiz', 'Raíz y subagentes']] as const;
const runsMode = (url: URL) => { const v = url.searchParams.get('runs') ?? 'rol'; if (!RUNS_BY.some(([id]) => id === v)) throw new URIError('Agrupación de runs inválida'); return v as 'rol' | 'raiz'; };
const runsSelect = (mode: string) => `<label>Runs por<select name="runs">${RUNS_BY.map(([v, l]) => `<option value="${v}"${mode === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;

export function metricsPage(store: Store, stateDir: string, url: URL, csrf?: string): { title: string; body: string } {
  const r = selection(url), t = url.searchParams.get('tab');
  if (t === 'jueces') return { title: 'Métricas · Jueces', body: tabs('jueces', r) + filters(store, 'jueces', r, 'Puntuaciones creadas en', url.searchParams.get('scorer') || undefined) + scorersPanel(store, stateDir, url, r, csrf) };
  const gasto = t === 'gasto';
  const m = calculateMetrics(store, stateDir, { ws: r.ws, range: r.range as MetricsRange, from: r.from, to: r.to });
  const lead = `<p class="muted">${m.count} changes · Calculado: <time>${esc(m.until)}</time>. El rango selecciona changes por fecha de creación; sus métricas incluyen todo su recorrido registrado hasta esta consulta.</p>${m.omitted ? `<p class="notice">Cálculo limitado a los 1000 changes más recientes. Se omiten ${m.omitted} changes; todos los resultados corresponden a la selección limitada.</p>` : ''}${r.range === 'all' ? '<p class="notice">Las series temporales diarias de «Todo el historial» muestran como máximo los últimos 90 días.</p>' : ''}`;
  const mode = runsMode(url);
  const head = tabs(gasto ? 'gasto' : 'productividad', r) + filters(store, gasto ? 'gasto' : 'productividad', r, 'Changes creados en', undefined, gasto ? '' : runsSelect(mode)) + lead;
  return gasto ? { title: 'Métricas · Gasto', body: head + spending(m) } : { title: 'Métricas', body: head + productivity(m, r.range, mode) };
}
type M = ReturnType<typeof calculateMetrics>;
const num = (v: number | null) => v === null ? 'No medido' : String(v);
const sum = (v: Array<number | null>) => v.some(x => x !== null) ? v.reduce<number>((a, x) => a + (x ?? 0), 0) : null;
const link = (c: { id: string; title: string }) => `<a href="/changes/${encodeURIComponent(c.id)}">${esc(c.title)}</a>`;

function productivity(m: M, range: string, runsBy: 'rol' | 'raiz'): string {
  const scope = range === 'all' ? 'en los últimos 90 días' : 'en el rango';
  const d = m.daily, ch = sum(d.changes), op = sum(d.prs.map(p => p.opened)), mg = sum(d.prs.map(p => p.merged)), iv = sum(d.interventions);
  const int = (n: number) => String(n);
  const cycleRow = (c: M['cycles'][number]) => [esc(c.name), duration(c.median), duration(c.p90), String(c.samples), String(m.count - c.samples)];
  const cells = m.prCycles.map(c => ({ label: c.name, value: duration(c.median), sub: c.samples ? `p90 ${duration(c.p90)} · ${c.samples} muestras` : 'Sin muestras' }));
  const dec = (n: number) => n.toLocaleString('es', { maximumFractionDigits: 2 });
  const ipp = m.interactionsPerPr, runs = m.runs;
  // Con más de cuatro roles, los tres mayores y «Otros» (la tarjeta admite cuatro series); la suma por día se conserva.
  const roleSeries = runs.roles.length <= 4 ? runs.roles : [...runs.roles.slice(0, 3), { name: 'Otros', daily: runs.roles[0]!.daily.map((_, i) => { const xs = runs.roles.slice(3).map(r => r.daily[i] ?? 0); const t = xs.reduce((a, x) => a + x, 0); return t || null; }) }];
  const runSeries = runsBy === 'rol' ? roleSeries.map(r => ({ label: r.name, values: r.daily })) : [{ label: 'Raíz', values: runs.rootDaily }, { label: 'Subagentes', values: runs.subDaily }];
  const cycleHead = ['Hito', 'Mediana', 'p90', 'Muestras', 'No medido'];
  const cards = [
    statCard({ id: 'pr-cycles', title: 'Tiempo de ciclo con PR (mediana)', help: 'Mediana del tiempo entre hitos de un change con PR. «No medido» si ningún change llegó al segundo hito; nunca se sustituye por 0.', cells,
      tableCaption: 'Tramos del ciclo con PR', tableHtml: table('Tramos del ciclo con PR', cycleHead.map((h, i) => i === 0 ? 'Tramo' : h), m.prCycles.map(cycleRow)) }),
    card({ id: 'interacciones', title: 'Interacciones humanas por PR', help: 'Media de decisiones de revisión, respuestas y reintentos humanos de los changes que abrieron PR; la serie agrupa por el día en que se abrió el PR. Sin PR abierto es «No medido», no 0.', figure: ipp.mean === null ? 'No medido' : dec(ipp.mean),
      sub: `${ipp.prs} PR${ipp.prs === 1 ? '' : 's'} ${scope}`, days: d.days, series: [{ label: 'Interacciones por PR', values: ipp.daily }], fmt: dec, tableCaption: 'Interacciones humanas por PR y día' }),
    card({ id: 'prs', title: 'Pull requests', help: 'PRs abiertos y fusionados por día, según los eventos pr_opened y merge_completed. Un día sin eventos es un hueco, no un cero.', figure: num(op), sub: `${mg ?? 0} fusionados ${scope}`, days: d.days,
      series: [{ label: 'Abiertos', values: d.prs.map(p => p.opened) }, { label: 'Fusionados', values: d.prs.map(p => p.merged) }], fmt: int, integer: true, tableCaption: 'PRs abiertos y fusionados por día' }),
    card({ id: 'runs', title: 'Runs totales', help: 'Activities creadas cada día (workers y validadores), apiladas por rol o por raíz frente a subagentes (las que tienen una activity padre). Se cuentan las de los changes de la selección; un día sin runs es un hueco.',
      figure: runs.total ? String(runs.total) : 'No medido', sub: `${runs.root} raíz · ${runs.sub} subagentes`, days: d.days, series: runSeries, stacked: true, fmt: int, integer: true,
      tableCaption: runsBy === 'rol' ? 'Runs por día · rol' : 'Runs por día · raíz y subagentes' }),
    card({ id: 'changes', title: 'Changes creados', help: 'Changes creados por día dentro del rango. Un día sin changes es un hueco.', figure: m.count ? String(m.count) : 'No medido', sub: 'en el rango', days: d.days, series: [{ label: 'Changes', values: d.changes }], fmt: int, integer: true, tableCaption: 'Changes creados por día' }),
    card({ id: 'humans', title: 'Intervenciones humanas', help: 'Decisiones de revisión, respuestas y reintentos explícitos observados en events, por día. Cero no garantiza que el registro histórico esté completo.', figure: num(iv), sub: scope, days: d.days, series: [{ label: 'Intervenciones', values: d.interventions }], fmt: int, integer: true, tableCaption: 'Intervenciones humanas por día' }),
  ];
  return `<section aria-labelledby="series"><h2 id="series">Series temporales</h2><div class="cards">${cards.join('')}</div></section>
  <section aria-labelledby="ciclo"><h2 id="ciclo">Tiempo de ciclo</h2><p>Tiempo desde la creación del change hasta cada hito. Solo se incluyen fechas válidas registradas. p90: rango más próximo.</p>${table('Duraciones acumuladas desde la creación', cycleHead, m.cycles.map(cycleRow))}<details><summary>Fuentes y límites de los tramos</summary><p>Primera activity: activities.created_at (incluye change_review, que puede nacer junto al change). Revisión pedida: creación de change_review o evento investigation awaiting spec review. Decisión humana: eventos de revisión approved, commented o declined de change_review e investigation; excluye validadores. Estado terminal: primer evento explícito de cierre, rechazo, bloqueo, cuarentena o fallo permanente. Kickoff a PR: creación a evento pr_opened. PR a merge: evento pr_opened a merge_completed. Primera revisión humana queda no medida hasta conexión de solo lectura con la API SDLC. No se sustituye una fecha ausente por updated_at.</p></details></section>
  <section aria-labelledby="volumen"><h2 id="volumen">Volumen de trabajo</h2><div class="metrics-columns"><div>${bars('Changes por estado actual', m.states)}${table('Changes por estado actual', ['Estado', 'Changes'], m.states.map(([s, n]) => [esc(s), String(n)]))}</div><div>${bars('Activities por tipo', m.kinds)}${table('Activities de la cohorte por tipo', ['Tipo', 'Activities'], m.kinds.map(([s, n]) => [esc(s), String(n)]))}</div></div></section>
  <section aria-labelledby="humano"><h2 id="humano">Intervenciones humanas por change</h2><p>Acciones observadas en events: decisiones de revisión, respuestas recibidas y reintentos explícitos. No incluye los reintentos automáticos. Cero significa que no hay eventos de esas acciones; no garantiza que el registro histórico esté completo.</p>${table('Acciones humanas registradas', ['Change', 'Decisiones', 'Respuestas', 'Reintentos', 'Total'], m.humans.map(h => [link(h), String(h.reviews), String(h.answers), String(h.retries), String(h.total)]))}</section>`;
}

function spending(m: M): string {
  const d = m.daily, groups = (name: string, rows: typeof m.cost.adapters, unit = 'Activities') => table(name, ['Grupo', 'Coste total', 'Subtotal medido', `${unit} sin coste medido`], rows.map(g => [esc(g.name), money(g.total), money(g.measured), String(g.unknown)]));
  const cost = card({ id: 'cost', title: 'Coste por día', help: 'Suma del coste medido de los changes creados cada día. Un día con algún intento sin coste medido es «No medido»; un día sin changes es «Sin datos». Nunca se suma como 0.', figure: m.count ? money(m.cost.total) : 'No medido',
    sub: `Subtotal medido ${money(m.cost.measured)} · ${m.cost.unknownChanges} changes sin coste completo medido`, days: d.days, series: [{ label: 'Coste', values: d.costs, missing: i => d.changes[i] !== null ? 'No medido' : 'Sin datos' }], fmt: money, tableCaption: 'Coste por día' });
  return `<section aria-labelledby="coste"><h2 id="coste">Coste</h2><div class="cards">${cost}</div><div class="summary"><span>Total: <strong>${money(m.cost.total)}</strong></span><span>Subtotal medido: <strong>${money(m.cost.measured)}</strong></span><span>${m.cost.unknownChanges} changes sin coste completo medido</span></div><p>Un intento desconocido deja el total como «No medido». El subtotal incluye solo changes con coste completo. La atribución por adaptador o modelo exige evidencia de ejecución; la configuración actual del workstream no prueba la histórica.</p>${table('Top 10 de changes con coste completo medido', ['Change', 'Coste'], m.cost.top.map(c => [link(c), money(c.cost)]))}${groups('Coste por adaptador registrado', m.cost.adapters, 'Activities')}${groups('Coste por modelo registrado', m.cost.models, 'Activities')}${groups('Coste por fuente del change', m.cost.sources, 'Changes')}${groups('Coste por actor del primer evento', m.cost.actors, 'Changes')}<p class="muted">La evidencia habitual no registra el modelo. Con varios intentos no se atribuye su coste al último adaptador o modelo. En las agrupaciones, el subtotal suma solo activities con coste completo y puede diferir del subtotal por change.</p></section>`;
}
export const METRICS_STYLE = `
caption{text-align:left;color:var(--text);font-weight:600;padding:24px 0 8px}td{font-variant-numeric:tabular-nums}tbody th{color:var(--text);font-size:inherit;font-weight:400;overflow-wrap:anywhere;min-width:180px}svg{display:block;max-width:100%;height:auto;color:var(--accent);margin-top:20px}.metrics-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:32px}.metrics-columns>div{min-width:0}details{margin:24px 0;color:var(--muted)}summary{cursor:pointer;color:var(--accent);padding:8px 0}summary:focus-visible{outline:3px solid var(--focus)}section{margin-top:40px}::selection{background:var(--accent);color:var(--bg)}@media(max-width:1000px){.metrics-columns{grid-template-columns:1fr}}${CARD_STYLE}`;
