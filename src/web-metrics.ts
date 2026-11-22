import type { Store } from './store.ts';
import { resolveProfile } from './profile.ts';
import { calculateMetrics, validateDay, type MetricsRange, type SpendGroup, SOURCES_LABELS } from './metrics.ts';
import { scorersPanel, sinceOf, type RangeSel } from './web-scorers.ts';
import { CARD_STYLE, card, esc, statCard, table, type CardSeries } from './web-cards.ts';
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
/** «Puesta en marcha» (T114): pasos del alta que se comprueban en el Store, sin estado propio; cada pendiente enlaza a donde se resuelve. */
function setup(store: Store, stateDir: string): string {
  const wss = store.listWorkstreams().filter(w => w.state !== 'archived');
  const scorers = wss.some(w => { try { return Object.keys(resolveProfile(stateDir, w.profile).profile.scorers ?? {}).length > 0; } catch { return false; } });
  const steps: Array<[string, boolean, string]> = [
    ['Crear un workstream', wss.length > 0, '/workstreams/nuevo'], ['Activar un workstream', wss.some(w => w.state === 'active'), '/workstreams'],
    ['Asignar un perfil', wss.some(w => w.profile !== null), '/perfiles'], ['Definir un juez', scorers, '/metricas?tab=jueces'],
    ['Crear el primer change', store.db.query('SELECT 1 FROM changes LIMIT 1').get() !== null, '/changes'],
  ];
  const done = steps.filter(x => x[1]).length;
  return `<details class="setup"><summary>Puesta en marcha · ${done} de ${steps.length}</summary><div><ol>${steps.map(([label, ok, href]) => `<li>${ok ? `${label}: Hecho` : `<a href="${href}">${label}</a>: Pendiente`}</li>`).join('')}</ol></div></details>`;
}
const tabs = (active: string, r: RangeSel) => `<nav aria-label="Secciones de métricas" class="tabs">${TABS.map(([id, label]) => `<a href="/metricas${esc(query(r, id))}"${active === id ? ' aria-current="page"' : ''}>${label}</a>`).join(' ')}</nav>`;
const filters = (store: Store, tab: string, r: RangeSel, what: string, scorer?: string, extra = '') => `<form action="/metricas" method="get" class="filters"><input type="hidden" name="tab" value="${tab}">${scorer ? `<input type="hidden" name="scorer" value="${esc(scorer)}">` : ''}<label>Workstream<select name="ws"><option value="">Todos</option>${store.listWorkstreams().map(w => `<option value="${esc(w.slug)}"${r.ws === w.id || r.ws === w.slug ? ' selected' : ''}>${esc(w.slug)}</option>`).join('')}</select></label><label>${what}<select name="range">${RANGES.map(([v, l]) => `<option value="${v}"${r.range === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label><label>Desde<input name="from" type="date" value="${esc(r.from ?? '')}"></label><label>Hasta<input name="to" type="date" value="${esc(r.to ?? '')}"></label>${extra}<button type="submit">Actualizar</button></form>`;

// Runs por rol del worker o por raíz frente a subagentes (T112). Valor inválido: 400, como el rango.
const RUNS_BY = [['rol', 'Rol']] as const; // la partición raíz/subagentes vuelve con T110 (verif T112-H1)
const runsMode = (url: URL) => { const v = url.searchParams.get('runs') ?? 'rol'; if (!RUNS_BY.some(([id]) => id === v)) throw new URIError('Agrupación de runs inválida'); return v as 'rol'; };
const runsSelect = (mode: string) => `<label>Runs por<select name="runs">${RUNS_BY.map(([v, l]) => `<option value="${v}"${mode === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;

export function metricsPage(store: Store, stateDir: string, url: URL, csrf?: string): { title: string; body: string } {
  const r = selection(url), t = url.searchParams.get('tab');
  const bar = (tab: string) => `<div class="topbar">${tabs(tab, r)}${setup(store, stateDir)}</div>`;
  if (t === 'jueces') return { title: 'Métricas · Jueces', body: bar('jueces') + filters(store, 'jueces', r, 'Puntuaciones creadas en', url.searchParams.get('scorer') || undefined) + scorersPanel(store, stateDir, url, r, csrf) };
  const gasto = t === 'gasto';
  const m = calculateMetrics(store, stateDir, { ws: r.ws, range: r.range as MetricsRange, from: r.from, to: r.to });
  const lead = `<p class="muted">${m.count} changes · Calculado: <time>${esc(m.until)}</time>. El rango selecciona changes por fecha de creación; sus métricas incluyen todo su recorrido registrado hasta esta consulta.</p>${m.omitted ? `<p class="notice">Cálculo limitado a los 1000 changes más recientes. Se omiten ${m.omitted} changes; todos los resultados corresponden a la selección limitada.</p>` : ''}${r.range === 'all' ? '<p class="notice">Las series temporales diarias de «Todo el historial» muestran como máximo los últimos 90 días.</p>' : ''}`;
  const mode = runsMode(url);
  const head = bar(gasto ? 'gasto' : 'productividad') + filters(store, gasto ? 'gasto' : 'productividad', r, 'Changes creados en', undefined, gasto ? '' : runsSelect(mode)) + lead;
  return gasto ? { title: 'Métricas · Gasto', body: head + spending(m) } : { title: 'Métricas', body: head + productivity(m, r.range, mode) };
}
type M = ReturnType<typeof calculateMetrics>;
const num = (v: number | null) => v === null ? 'No medido' : String(v);
const sum = (v: Array<number | null>) => v.some(x => x !== null) ? v.reduce<number>((a, x) => a + (x ?? 0), 0) : null;
const link = (c: { id: string; title: string }) => `<a href="/changes/${encodeURIComponent(c.id)}">${esc(c.title)}</a>`;

function productivity(m: M, range: string, runsBy: 'rol'): string {
  const scope = range === 'all' ? 'en los últimos 90 días' : 'en el rango';
  const d = m.daily, ch = sum(d.changes), op = sum(d.prs.map(p => p.opened)), mg = sum(d.prs.map(p => p.merged)), iv = sum(d.interventions);
  const int = (n: number) => String(n);
  const cycleRow = (c: M['cycles'][number]) => [esc(c.name), duration(c.median), duration(c.p90), String(c.samples), String(m.count - c.samples)];
  const cells = m.prCycles.map(c => ({ label: c.name, value: duration(c.median), sub: c.samples ? `p90 ${duration(c.p90)} · ${c.samples} muestras` : 'Sin muestras' }));
  const dec = (n: number) => n.toLocaleString('es', { maximumFractionDigits: 2 });
  const ipp = m.interactionsPerPr, runs = m.runs;
  // Con más de cuatro roles, los tres mayores y «Otros» (la tarjeta admite cuatro series); la suma por día se conserva.
  const roleSeries = runs.roles.length <= 4 ? runs.roles : [...runs.roles.slice(0, 3), { name: 'Otros', daily: runs.roles[0]!.daily.map((_, i) => { const xs = runs.roles.slice(3).map(r => r.daily[i] ?? 0); const t = xs.reduce((a, x) => a + x, 0); return t || null; }) }];
  const runSeries = roleSeries.map(r => ({ label: r.name, values: r.daily }));
  const cycleHead = ['Hito', 'Mediana', 'p90', 'Muestras', 'No medido'];
  const cards = [
    statCard({ id: 'pr-cycles', title: 'Tiempo de ciclo con PR (mediana)', help: 'Mediana del tiempo entre hitos de un change con PR. «No medido» si ningún change llegó al segundo hito; nunca se sustituye por 0.', cells,
      tableCaption: 'Tramos del ciclo con PR', tableHtml: table('Tramos del ciclo con PR', cycleHead.map((h, i) => i === 0 ? 'Tramo' : h), m.prCycles.map(cycleRow)) }),
    card({ id: 'interacciones', title: 'Interacciones humanas por PR', help: 'Media de decisiones de revisión, respuestas y reintentos humanos de los changes que abrieron PR; la serie agrupa por el día en que se abrió el PR. Sin PR abierto es «No medido», no 0.', figure: ipp.mean === null ? 'No medido' : dec(ipp.mean),
      sub: `${ipp.prs} PR${ipp.prs === 1 ? '' : 's'} ${scope}`, days: d.days, series: [{ label: 'Interacciones por PR', values: ipp.daily }], fmt: dec, tableCaption: 'Interacciones humanas por PR y día' }),
    card({ id: 'prs', title: 'Pull requests', help: 'PRs abiertos y fusionados por día, según los eventos pr_opened y merge_completed. Un día sin eventos es un hueco, no un cero.', figure: num(op), sub: `${mg ?? 0} fusionados ${scope}`, days: d.days,
      series: [{ label: 'Abiertos', values: d.prs.map(p => p.opened) }, { label: 'Fusionados', values: d.prs.map(p => p.merged) }], fmt: int, integer: true, tableCaption: 'PRs abiertos y fusionados por día' }),
    card({ id: 'runs', title: 'Runs totales', help: 'Activities creadas cada día (workers y validadores), apiladas por rol. Se cuentan las de los changes de la selección; un día sin runs es un hueco.',
      figure: runs.total ? String(runs.total) : 'No medido', sub: runs.total ? scope : undefined, days: d.days, series: runSeries, stacked: true, fmt: int, integer: true,
      tableCaption: 'Runs por día · rol' }),
    card({ id: 'changes', title: 'Changes creados', help: 'Changes creados por día dentro del rango. Un día sin changes es un hueco.', figure: m.count ? String(m.count) : 'No medido', sub: 'en el rango', days: d.days, series: [{ label: 'Changes', values: d.changes }], fmt: int, integer: true, tableCaption: 'Changes creados por día' }),
    card({ id: 'humans', title: 'Intervenciones humanas', help: 'Decisiones de revisión, respuestas y reintentos explícitos observados en events, por día. Cero no garantiza que el registro histórico esté completo.', figure: num(iv), sub: scope, days: d.days, series: [{ label: 'Intervenciones', values: d.interventions }], fmt: int, integer: true, tableCaption: 'Intervenciones humanas por día' }),
  ];
  return `<section aria-labelledby="series"><h2 id="series">Series temporales</h2><div class="cards">${cards.join('')}</div></section>
  <section aria-labelledby="ciclo"><h2 id="ciclo">Tiempo de ciclo</h2><p>Tiempo desde la creación del change hasta cada hito. Solo se incluyen fechas válidas registradas. p90: rango más próximo.</p>${table('Duraciones acumuladas desde la creación', cycleHead, m.cycles.map(cycleRow))}<details><summary>Fuentes y límites de los tramos</summary><p>Primera activity: activities.created_at (incluye change_review, que puede nacer junto al change). Revisión pedida: creación de change_review o evento investigation awaiting spec review. Decisión humana: eventos de revisión approved, commented o declined de change_review e investigation; excluye validadores. Estado terminal: primer evento explícito de cierre, rechazo, bloqueo, cuarentena o fallo permanente. Kickoff a PR: creación a evento pr_opened. PR a merge: evento pr_opened a merge_completed. Primera revisión humana queda no medida hasta conexión de solo lectura con la API SDLC. No se sustituye una fecha ausente por updated_at.</p></details></section>
  <section aria-labelledby="volumen"><h2 id="volumen">Volumen de trabajo</h2><div class="metrics-columns"><div>${bars('Changes por estado actual', m.states)}${table('Changes por estado actual', ['Estado', 'Changes'], m.states.map(([s, n]) => [esc(s), String(n)]))}</div><div>${bars('Activities por tipo', m.kinds)}${table('Activities de la cohorte por tipo', ['Tipo', 'Activities'], m.kinds.map(([s, n]) => [esc(s), String(n)]))}</div></div></section>
  <section aria-labelledby="humano"><h2 id="humano">Intervenciones humanas por change</h2><p>Acciones observadas en events: decisiones de revisión, respuestas recibidas y reintentos explícitos. No incluye los reintentos automáticos. Cero significa que no hay eventos de esas acciones; no garantiza que el registro histórico esté completo.</p>${table('Acciones humanas registradas', ['Change', 'Decisiones', 'Respuestas', 'Reintentos', 'Total'], m.humans.map(h => [link(h), String(h.reviews), String(h.answers), String(h.retries), String(h.total)]))}</section>`;
}

function spending(m: M): string {
  const s = m.spending, d = m.daily;
  const groupsTable = (caption: string, groups: SpendGroup[], field: 'total' | 'inference' = 'total', labelFmt: (name: string) => string = x => x) =>
    table(caption, ['Grupo', 'Coste total', 'Subtotal medido', 'Intentos sin coste medido'], groups.map(g => [
      esc(labelFmt(g.name)),
      g[field].total !== null ? money(g[field].total! / 1_000_000) : 'No medido',
      g[field].measured !== null ? money(g[field].measured! / 1_000_000) : 'No medido',
      String(g[field].unknown),
    ]));

  const totalKnown = s.total.total !== null ? s.total.total / 1_000_000 : null;
  const totalFig = totalKnown !== null ? money(totalKnown) : 'No medido';
  const measuredUsd = s.total.measured !== null ? s.total.measured / 1_000_000 : null;
  const unknownCount = s.total.unknown;
  const subTotal = measuredUsd !== null ? money(measuredUsd) : null;
  const countText = unknownCount === 1 ? '1 intento sin coste completo medido' : `${unknownCount} intentos sin coste completo medido`;
  const subText = measuredUsd !== null
    ? `Subtotal medido ${money(measuredUsd)} · ${countText}`
    : `${unknownCount === 1 ? '1 intento' : `${unknownCount} intentos`} sin coste medido`;

  const distinctRates = [...new Set(s.attempts.map(a => a.rateVersion).filter((v): v is string => Boolean(v)))].sort();
  const rateNote = distinctRates.length ? `Tarifas aplicadas: ${distinctRates.join(', ')}` : undefined;

  const costCard = card({
    id: 'cost',
    title: 'Coste por día',
    help: 'Suma del coste medido de los changes creados cada día. Un día con algún intento sin coste medido es «No medido»; un día sin changes es «Sin datos». Nunca se suma como 0.',
    figure: totalFig,
    sub: subText,
    days: d.days,
    series: [{ label: 'Coste', values: s.daily.total, missing: i => s.daily.hasAttempts[i] ? 'No medido' : 'Sin datos' }],
    fmt: money,
    tableCaption: 'Coste por día',
    tableNote: rateNote,
  });

  const dimCard = (opts: {
    id: string;
    title: string;
    help: string;
    dimName: string;
    groups: SpendGroup[];
    field: 'total' | 'inference';
    labelFmt?: (name: string) => string;
    unitLabel: string;
    tableCaption: string;
  }) => {
    const { id, title, help, dimName, groups, field, labelFmt = (x: string) => x, unitLabel, tableCaption } = opts;
    const sorted = [...groups].sort((a, b) => {
      const ma = a[field].measured ?? -1;
      const mb = b[field].measured ?? -1;
      return mb - ma || a.name.localeCompare(b.name);
    });
    const count = sorted.filter(g => g.key !== null).length;
    const fig = field === 'inference'
      ? (s.inference.total !== null ? money(s.inference.total / 1_000_000) : (s.inference.unknown > 0 ? 'No medido' : totalFig))
      : totalFig;
    const sub = `por ${dimName} · ${count} ${unitLabel}`;

    const series: CardSeries[] = [];
    if (sorted.length <= 4) {
      for (const g of sorted) {
        series.push({
          label: labelFmt(g.name),
          values: g.daily ?? d.days.map(() => null),
        });
      }
    } else {
      for (const g of sorted.slice(0, 3)) {
        series.push({
          label: labelFmt(g.name),
          values: g.daily ?? d.days.map(() => null),
        });
      }
      const otrosGroups = sorted.slice(3);
      const otrosDaily: Array<number | null> = d.days.map((_, i) => {
        if (otrosGroups.some(g => g.dailyHasAttempts?.[i] && g.daily?.[i] === null)) return null;
        const vals = otrosGroups.map(g => g.daily?.[i]).filter((v): v is number => v !== null && v !== undefined);
        if (!vals.length) return null;
        return vals.reduce((sum, v) => sum + v, 0);
      });
      series.push({
        label: 'Otros',
        values: otrosDaily,
        missing: i => otrosGroups.some(g => g.dailyHasAttempts?.[i]) ? 'No medido' : 'Sin datos',
      });
    }

    const chips = sorted.map(g => {
      const tot = g[field].total !== null
        ? money(g[field].total! / 1_000_000)
        : (g[field].measured !== null ? `subtotal ${money(g[field].measured! / 1_000_000)}` : 'No medido');
      return `<span class="chip">${esc(labelFmt(g.name))}: ${tot}</span>`;
    }).join('');

    return card({
      id,
      title,
      help,
      figure: fig,
      sub,
      days: d.days,
      series,
      stacked: true,
      fmt: money,
      tableCaption,
      footer: chips,
    });
  };

  const workerCard = dimCard({
    id: 'spending-worker',
    title: 'Gasto por worker',
    help: 'Gasto en USD de cada rol de worker (investigate, implement, etc.) según los intentos ejecutados. Apilado por día; un intento sin medir cuenta como «No medido».',
    dimName: 'worker',
    groups: s.by.worker,
    field: 'total',
    unitLabel: s.by.worker.filter(g => g.key !== null).length === 1 ? 'worker' : 'workers',
    tableCaption: 'Gasto por worker',
  });

  const modelCard = dimCard({
    id: 'spending-model',
    title: 'Gasto por modelo',
    help: 'Gasto en inferencia agrupado por el modelo efectivo que atendió cada intento. La evidencia anterior a T108 sale como «No medido».',
    dimName: 'modelo',
    groups: s.models,
    field: 'inference',
    unitLabel: s.models.filter(g => g.key !== null).length === 1 ? 'modelo' : 'modelos',
    tableCaption: 'Gasto por modelo registrado',
  });

  const userCard = dimCard({
    id: 'spending-user',
    title: 'Gasto por usuario',
    help: 'Gasto atribuido al usuario que originó el change. Si no se registró usuario, se agrupa en «Sin dato». El actor va escapado.',
    dimName: 'usuario',
    groups: s.by.user,
    field: 'total',
    unitLabel: s.by.user.filter(g => g.key !== null).length === 1 ? 'usuario' : 'usuarios',
    tableCaption: 'Gasto por usuario',
  });

  const sourceCard = dimCard({
    id: 'spending-source',
    title: 'Gasto por fuente',
    help: 'Gasto imputado según el canal de origen del change (CLI, canal, Jira, web, automatización, residente).',
    dimName: 'fuente',
    groups: s.by.source,
    field: 'total',
    labelFmt: name => SOURCES_LABELS[name] ?? name,
    unitLabel: s.by.source.filter(g => g.key !== null).length === 1 ? 'fuente' : 'fuentes',
    tableCaption: 'Gasto por fuente',
  });

  const top20Rows = s.top.map(p => {
    const prCell = p.prUrl ? `<a href="${esc(p.prUrl)}">${esc(p.prUrl)}</a>` : 'Sin PR';
    const changeCell = `<a href="/changes/${encodeURIComponent(p.changeId)}">${esc(p.title)}</a>`;
    const costCell = money(p.cost);
    const breakdownCell = `${money(p.inference)} · ${money(p.compute)} · ${money(p.platform)}`;
    return [prCell, changeCell, costCell, breakdownCell];
  });

  const cards = [costCard, workerCard, modelCard, userCard, sourceCard];

  return `<section aria-labelledby="coste"><h2 id="coste">Coste</h2><div class="cards">${cards.join('')}</div><div class="summary"><span>Total: <strong>${totalFig}</strong></span><span>Subtotal medido: <strong>${subTotal ?? 'No medido'}</strong></span><span>${countText}</span></div><p>Un intento desconocido deja el total como «No medido». El subtotal incluye solo changes con coste completo. La atribución por adaptador o modelo exige evidencia de ejecución; la configuración actual del workstream no prueba la histórica.</p>${table('Los 20 PR más caros', ['Pull Request', 'Change', 'Coste', 'Desglose (Inferencia · Cómputo · Plataforma)'], top20Rows)}${groupsTable('Coste por adaptador registrado', s.adapters)}${groupsTable('Coste por modelo registrado', s.models, 'inference')}${groupsTable('Coste por fuente del change', s.by.source, 'total', name => SOURCES_LABELS[name] ?? name)}${groupsTable('Coste por actor del primer evento', s.by.user, 'total')}<p class="muted">La evidencia anterior a T108 no registra el modelo efectivo y sale como «No medido». Con varios intentos no se atribuye su coste al último adaptador o modelo. En las agrupaciones, el subtotal suma solo activities con coste completo y puede diferir del subtotal por change.</p></section>`;
}
export const METRICS_STYLE = `
caption{text-align:left;color:var(--text);font-weight:600;padding:24px 0 8px}td{font-variant-numeric:tabular-nums}tbody th{color:var(--text);font-size:inherit;font-weight:400;overflow-wrap:anywhere;min-width:180px}svg{display:block;max-width:100%;height:auto;color:var(--accent);margin-top:20px}.metrics-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:32px}.metrics-columns>div{min-width:0}details{margin:24px 0;color:var(--muted)}summary{cursor:pointer;color:var(--accent);padding:8px 0}summary:focus-visible{outline:3px solid var(--focus)}section{margin-top:40px}::selection{background:var(--accent);color:var(--bg)}@media(max-width:1000px){.metrics-columns{grid-template-columns:1fr}}${CARD_STYLE}`;
