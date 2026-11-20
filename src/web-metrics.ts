import type { Store } from './store.ts';
import { calculateMetrics, type MetricsRange } from './metrics.ts';
import { redact } from './evidence.ts';
import { scorersPanel } from './web-scorers.ts';
const esc = (v: unknown) => redact(String(v ?? '')).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (v: number | null) => v === null ? 'No medido' : `${v.toFixed(2)} USD`;
const duration = (v: number | null) => v === null ? 'No medido' : `${(v / 3600000).toLocaleString('es', { maximumFractionDigits: 2 })} h`;
function table(caption: string, headers: string[], rows: string[][]) {
  return `<div class="table-wrap"><table><caption>${esc(caption)}</caption><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(r => `<tr>${r.map((v, i) => i === 0 ? `<th scope="row">${v}</th>` : `<td>${v}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}">Sin datos para estos filtros.</td></tr>`}</tbody></table></div>`;
}
function bars(name: string, rows: [string, number][]) {
  const max = Math.max(1, ...rows.map(r => r[1]));
  return `<svg role="img" aria-label="${esc(name)}; valores en la tabla siguiente" viewBox="0 0 350 ${Math.max(1, rows.length) * 36}" width="350" height="${Math.max(1, rows.length) * 36}">${rows.map(([label, v], i) => `<text x="0" y="${i * 36 + 21}" fill="currentColor" font-size="14">${esc(label)}</text><rect x="145" y="${i * 36 + 7}" width="${v / max * 155}" height="20" fill="currentColor"/><text x="315" y="${i * 36 + 21}" fill="currentColor" font-size="14">${v}</text>`).join('')}</svg>`;
}
function timeSeriesChart(title: string, days: string[], values: Array<number | null>, unit: string, isMoney = false) {
  if (!days.length) return `<p class="empty">Sin datos para estos filtros.</p>`;
  const measured = values.filter((v): v is number => v !== null);
  const max = Math.max(1, ...measured);
  const colWidth = 56;
  const height = 150;
  const plotH = 90;
  const top = 25;
  const left = 30;
  const width = Math.max(350, left + days.length * colWidth + 20);

  const cols = days.map((day, i) => {
    const x = left + i * colWidth;
    const v = values[i] ?? null;
    const dayLabel = day.slice(5);
    const labelX = x + colWidth / 2;
    const baselineY = top + plotH;
    let content = '';
    if (v === null) {
      content = `<text x="${labelX}" y="${baselineY - 12}" text-anchor="middle" font-size="11" fill="var(--muted, #888)">hueco</text>`;
    } else {
      const barH = Math.max(3, (v / max) * plotH);
      const barY = baselineY - barH;
      const valStr = isMoney ? v.toFixed(2) : String(v);
      content = `<rect x="${x + 8}" y="${barY}" width="${colWidth - 16}" height="${barH}" fill="currentColor" rx="2"/><text x="${labelX}" y="${barY - 5}" text-anchor="middle" font-size="11" fill="currentColor">${valStr}</text>`;
    }
    return `${content}<text x="${labelX}" y="${baselineY + 16}" text-anchor="middle" font-size="10" fill="currentColor">${esc(dayLabel)}</text>`;
  }).join('');

  return `<svg role="img" aria-label="${esc(title)}; valores en la tabla siguiente" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${cols}</svg>`;
}
function dailyTable(title: string, colHeader: string, days: string[], values: Array<number | null>, formatVal: (v: number) => string) {
  if (!days.length) return '';
  const rows = days.map((day, i) => {
    const v = values[i] ?? null;
    const cell = v !== null ? esc(formatVal(v)) : (colHeader === 'Coste' ? 'No medido' : 'Sin datos');
    return [esc(day), cell];
  });
  return table(title, ['Fecha', colHeader], rows);
}
function timeSeriesPrChart(title: string, days: string[], prs: Array<{ opened: number | null; merged: number | null }>) {
  if (!days.length) return `<p class="empty">Sin datos para estos filtros.</p>`;
  const measured = prs.flatMap(p => [p.opened, p.merged]).filter((v): v is number => v !== null);
  const max = Math.max(1, ...measured);
  const colWidth = 56;
  const height = 150;
  const plotH = 90;
  const top = 25;
  const left = 30;
  const width = Math.max(350, left + days.length * colWidth + 20);

  const cols = days.map((day, i) => {
    const x = left + i * colWidth;
    const p = prs[i];
    const dayLabel = day.slice(5);
    const labelX = x + colWidth / 2;
    const baselineY = top + plotH;
    let content = '';
    if (!p || (p.opened === null && p.merged === null)) {
      content = `<text x="${labelX}" y="${baselineY - 12}" text-anchor="middle" font-size="11" fill="var(--muted, #888)">hueco</text>`;
    } else {
      if (p.opened !== null) {
        const barH = Math.max(3, (p.opened / max) * plotH);
        const barY = baselineY - barH;
        content += `<rect x="${x + 6}" y="${barY}" width="20" height="${barH}" fill="currentColor" rx="2"/><text x="${x + 16}" y="${barY - 5}" text-anchor="middle" font-size="10" fill="currentColor">${p.opened}</text>`;
      }
      if (p.merged !== null) {
        const barH = Math.max(3, (p.merged / max) * plotH);
        const barY = baselineY - barH;
        content += `<rect x="${x + 30}" y="${barY}" width="20" height="${barH}" fill="currentColor" opacity="0.6" rx="2"/><text x="${x + 40}" y="${barY - 5}" text-anchor="middle" font-size="10" fill="currentColor">${p.merged}</text>`;
      }
    }
    return `${content}<text x="${labelX}" y="${baselineY + 16}" text-anchor="middle" font-size="10" fill="currentColor">${esc(dayLabel)}</text>`;
  }).join('');

  return `<svg role="img" aria-label="${esc(title)}; valores en la tabla siguiente" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${cols}</svg>`;
}
function dailyPrTable(title: string, days: string[], prs: Array<{ opened: number | null; merged: number | null }>) {
  if (!days.length) return '';
  const rows = days.map((day, i) => {
    const p = prs[i];
    const op = p?.opened !== null && p?.opened !== undefined ? String(p.opened) : 'Sin datos';
    const mg = p?.merged !== null && p?.merged !== undefined ? String(p.merged) : 'Sin datos';
    return [esc(day), op, mg];
  });
  return table(title, ['Fecha', 'PRs abiertos', 'PRs fusionados'], rows);
}
const tabs = (active: string, q: string) => `<nav aria-label="Secciones de métricas" class="tabs"><a href="/metricas${q}"${active === 'resumen' ? ' aria-current="page"' : ''}>Resumen</a> <a href="/metricas?tab=jueces${q ? '&amp;' + q.slice(1) : ''}"${active === 'jueces' ? ' aria-current="page"' : ''}>Jueces</a></nav>`;
export function metricsPage(store: Store, stateDir: string, url: URL, csrf?: string): { title: string; body: string } {
  if (url.searchParams.get('tab') === 'jueces') {
    if (!['7', '30', 'all', 'custom'].includes(url.searchParams.get('range') ?? '7')) throw new URIError('Rango inválido');
    return { title: 'Métricas · Jueces', body: tabs('jueces', '') + scorersPanel(store, stateDir, url, csrf) };
  }
  const page = metricsSummary(store, stateDir, url);
  return { title: page.title, body: tabs('resumen', '') + page.body };
}
function metricsSummary(store: Store, stateDir: string, url: URL): { title: string; body: string } {
  const ws = url.searchParams.get('ws') || undefined;
  const rangeParam = url.searchParams.get('range');
  const from = url.searchParams.get('from')?.trim() || undefined;
  const to = url.searchParams.get('to')?.trim() || undefined;
  const range = rangeParam ?? (from || to ? 'custom' : '7');
  if (!['7', '30', 'all', 'custom'].includes(range)) throw new URIError('Rango inválido');
  const m = calculateMetrics(store, stateDir, { ws, range: range as MetricsRange, from, to });
  const link = (c: { id: string; title: string }) => `<a href="/changes/${encodeURIComponent(c.id)}">${esc(c.title)}</a>`;
  const groups = (name: string, rows: typeof m.cost.adapters, unit = 'Activities') => table(name, ['Grupo', 'Coste total', 'Subtotal medido', `${unit} sin coste medido`], rows.map(g => [esc(g.name), money(g.total), money(g.measured), String(g.unknown)]));
  return { title: 'Métricas', body: `<p class="intro">Tiempo e intervención humana. Coste con su cobertura de medición.</p><form action="/metricas" method="get" class="filters"><label>Workstream<select name="ws"><option value="">Todos</option>${store.listWorkstreams().map(w => `<option value="${esc(w.slug)}"${ws === w.id || ws === w.slug ? ' selected' : ''}>${esc(w.slug)}</option>`).join('')}</select></label><label>Changes creados en<select name="range">${[['7','Últimos 7 días'],['30','Últimos 30 días'],['all','Todo el historial'],['custom','Rango personalizado']].map(([v,l]) => `<option value="${v}"${range === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label><label>Desde<input name="from" type="date" value="${esc(from ?? '')}"></label><label>Hasta<input name="to" type="date" value="${esc(to ?? '')}"></label><button type="submit">Actualizar</button></form>
  <p class="muted">${m.count} changes · Calculado: <time>${esc(m.until)}</time>. El rango selecciona changes por fecha de creación; sus métricas incluyen todo su recorrido registrado hasta esta consulta.</p>
  ${m.omitted ? `<p class="notice">Cálculo limitado a los 1000 changes más recientes. Se omiten ${m.omitted} changes; todos los resultados corresponden a la selección limitada.</p>` : ''}
  <section aria-labelledby="ciclo"><h2 id="ciclo">Tiempo de ciclo</h2><p>Tiempo desde la creación del change hasta cada hito. Solo se incluyen fechas válidas registradas. p90: rango más próximo.</p>${table('Duraciones acumuladas desde la creación', ['Hito', 'Mediana', 'p90', 'Muestras', 'No medido'], m.cycles.map(c => [esc(c.name), duration(c.median), duration(c.p90), String(c.samples), String(m.count - c.samples)]))}${table('Tramos del ciclo con PR', ['Tramo', 'Mediana', 'p90', 'Muestras', 'No medido'], m.prCycles.map(c => [esc(c.name), duration(c.median), duration(c.p90), String(c.samples), String(m.count - c.samples)]))}<details><summary>Fuentes y límites de los tramos</summary><p>Primera activity: activities.created_at (incluye change_review, que puede nacer junto al change). Revisión pedida: creación de change_review o evento investigation awaiting spec review. Decisión humana: eventos de revisión approved, commented o declined de change_review e investigation; excluye validadores. Estado terminal: primer evento explícito de cierre, rechazo, bloqueo, cuarentena o fallo permanente. Kickoff a PR: creación a evento pr_opened. PR a merge: evento pr_opened a merge_completed. Primera revisión humana queda no medida hasta conexión de solo lectura con la API SDLC. No se sustituye una fecha ausente por updated_at.</p></details></section>
  <section aria-labelledby="series"><h2 id="series">Series temporales</h2><div class="metrics-columns"><div>${timeSeriesChart('Changes creados por día', m.daily.days, m.daily.changes, 'changes')}${dailyTable('Changes creados por día', 'Changes', m.daily.days, m.daily.changes, v => String(v))}</div><div>${timeSeriesChart('Coste por día', m.daily.days, m.daily.costs, 'USD', true)}${dailyTable('Coste por día', 'Coste', m.daily.days, m.daily.costs, v => money(v))}</div></div><div class="metrics-columns" style="margin-top:24px"><div>${timeSeriesChart('Intervenciones humanas por día', m.daily.days, m.daily.interventions, 'intervenciones')}${dailyTable('Intervenciones humanas por día', 'Intervenciones', m.daily.days, m.daily.interventions, v => String(v))}</div><div>${timeSeriesPrChart('PRs abiertos y fusionados por día', m.daily.days, m.daily.prs)}${dailyPrTable('PRs abiertos y fusionados por día', m.daily.days, m.daily.prs)}</div></div></section>
  <section aria-labelledby="volumen"><h2 id="volumen">Volumen de trabajo</h2><div class="metrics-columns"><div>${bars('Changes por estado actual', m.states)}${table('Changes por estado actual', ['Estado', 'Changes'], m.states.map(([s,n]) => [esc(s), String(n)]))}</div><div>${bars('Activities por tipo', m.kinds)}${table('Activities de la cohorte por tipo', ['Tipo', 'Activities'], m.kinds.map(([s,n]) => [esc(s), String(n)]))}</div></div></section>
  <section aria-labelledby="coste"><h2 id="coste">Coste</h2><div class="summary"><span>Total: <strong>${money(m.cost.total)}</strong></span><span>Subtotal medido: <strong>${money(m.cost.measured)}</strong></span><span>${m.cost.unknownChanges} changes sin coste completo medido</span></div><p>Un intento desconocido deja el total como «No medido». El subtotal incluye solo changes con coste completo. La atribución por adaptador o modelo exige evidencia de ejecución; la configuración actual del workstream no prueba la histórica.</p>${table('Top 10 de changes con coste completo medido', ['Change', 'Coste'], m.cost.top.map(c => [link(c), money(c.cost)]))}${groups('Coste por adaptador registrado', m.cost.adapters, 'Activities')}${groups('Coste por modelo registrado', m.cost.models, 'Activities')}${groups('Coste por fuente del change', m.cost.sources, 'Changes')}${groups('Coste por actor del primer evento', m.cost.actors, 'Changes')}<p class="muted">La evidencia habitual no registra el modelo. Con varios intentos no se atribuye su coste al último adaptador o modelo. En las agrupaciones, el subtotal suma solo activities con coste completo y puede diferir del subtotal por change.</p></section>
  <section aria-labelledby="humano"><h2 id="humano">Intervenciones humanas por change</h2><p>Acciones observadas en events: decisiones de revisión, respuestas recibidas y reintentos explícitos. No incluye los reintentos automáticos. Cero significa que no hay eventos de esas acciones; no garantiza que el registro histórico esté completo.</p>${table('Acciones humanas registradas', ['Change', 'Decisiones', 'Respuestas', 'Reintentos', 'Total'], m.humans.map(h => [link(h), String(h.reviews), String(h.answers), String(h.retries), String(h.total)]))}</section>` };
}
export const METRICS_STYLE = `
caption{text-align:left;color:var(--text);font-weight:600;padding:24px 0 8px}td{font-variant-numeric:tabular-nums}tbody th{color:var(--text);font-size:inherit;font-weight:400;overflow-wrap:anywhere;min-width:180px}svg{display:block;max-width:100%;height:auto;color:var(--accent);margin-top:20px}.metrics-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:32px}.metrics-columns>div{min-width:0}details{margin:24px 0;color:var(--muted)}summary{cursor:pointer;color:var(--accent);padding:8px 0}summary:focus-visible{outline:3px solid var(--focus)}section{margin-top:40px}::selection{background:var(--accent);color:var(--bg)}@media(max-width:1000px){.metrics-columns{grid-template-columns:1fr}}`;
