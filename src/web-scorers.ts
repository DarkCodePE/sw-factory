// Jueces en la web (T65): pestaña de /metricas y bloque en el detalle de la activity. Los jueces son un aviso (D-G):
// nada de aquí cambia estados ni bloquea. Lo que escribe va por ACTIONS (web-actions.ts) con --write, sesión y CSRF.
import type { Store } from './store.ts';
import { resolveProfile } from './profile.ts';
import { redact } from './manifest.ts';
import { passByDay, previewBackfill, scoreRows, scorersFor, scorerSummary, type ScoreFilter } from './scorers.ts';
import type { Activity } from './store.ts';
import { card } from './web-cards.ts';

const esc = (v: unknown) => redact(String(v ?? '')).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const enc = encodeURIComponent;
// Una fila rara (coste no numérico) es «No medido», no un 500 (T65-H1).
const usd = (v: unknown) => typeof v !== 'number' || !Number.isFinite(v) ? 'No medido' : `${v.toFixed(4)} USD`;
const pct = (p: number, n: number) => n === 0 ? 'No medido' : `${Math.round(p / n * 100)} % (${p}/${n})`;
const table = (caption: string, headers: string[], rows: string[][]) => `<div class="table-wrap"><table><caption>${esc(caption)}</caption><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((v, i) => i === 0 ? `<th scope="row">${v}</th>` : `<td>${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const STATUS: Record<string, string> = { pending: 'En cola', running: 'En curso', done: 'Hecha', failed: 'Fallida', skipped: 'Omitida' };
const ORIGIN: Record<string, string> = { sample: 'Muestreo', manual: 'A mano', backfill: 'Rango pasado' };
export const NO_SCORES = 'No hay puntuaciones en este rango.';

const historyRows = (rows: ReturnType<typeof scoreRows>) => rows.map(r => [
  `<time>${esc(r.createdAt)}</time>`,
  `<a href="/changes/${enc(r.changeId)}">${esc(r.changeTitle ?? r.changeId)}</a> · <a href="/activities/${enc(r.subjectActivityId)}">${esc(r.subjectActivityId.slice(0, 8))}</a>`,
  `<a href="?tab=jueces&amp;scorer=${enc(r.scorer)}">${esc(r.scorer)}</a>`, esc(r.round), esc(ORIGIN[r.origin] ?? r.origin), esc(STATUS[r.status] ?? r.status),
  // NULL es «sin puntuar», nunca 0 (I3).
  r.label === null ? 'Sin puntuar' : `${esc(r.label)} (${esc(r.score)})`,
  r.passed === null ? 'No medido' : r.passed ? 'Sí' : 'No', usd(r.costUsd)]);
const HISTORY_HEAD = ['Fecha', 'Change · activity', 'Juez', 'Ronda', 'Origen', 'Estado', 'Clase', 'Aprobada', 'Coste'];

/** Rango y workstream compartidos por las tres pestañas de /metricas. */
export interface RangeSel { ws?: string; range: string; from?: string; to?: string; since?: string; until?: string }
const qsOf = (r: RangeSel) => `ws=${enc(r.ws ?? '')}&amp;range=${enc(r.range)}${r.from ? `&amp;from=${enc(r.from)}` : ''}${r.to ? `&amp;to=${enc(r.to)}` : ''}`;

/** Cuántos días atrás empieza el rango; null es «todo el historial». */
export const sinceOf = (range: string): string | undefined => range === 'all' ? undefined : new Date(Date.now() - Number(range) * 86_400_000).toISOString();

function definition(stateDir: string, digest: string, name: string): string {
  try {
    const d = resolveProfile(stateDir, digest).profile.scorers?.[name];
    if (!d) return '<p class="muted">Este perfil ya no define el juez.</p>';
    return `<dl><dt>Ámbito</dt><dd>${esc(d.scope)}</dd><dt>Aprobado desde</dt><dd>${d.passing}</dd><dt>Muestreo</dt><dd>${d.sampling}</dd><dt>Clases</dt><dd>${d.classes.map(c => `${esc(c.label)} (${c.score})`).join(', ')}</dd><dt>Rúbrica</dt><dd><pre tabindex="0">${esc(d.rubric)}</pre></dd></dl>`;
  } catch { return '<p class="muted">Perfil no disponible.</p>'; }
}

function backfillPanel(store: Store, stateDir: string, url: URL, r: RangeSel, wsSlug: string | undefined, since: string | undefined, csrf?: string): string {
  const q = url.searchParams, scorer = q.get('scorer') ?? '', skip = q.get('skip') !== '0';
  if (!wsSlug) return '<section aria-labelledby="pasadas"><h2 id="pasadas">Puntuar ejecuciones pasadas</h2><p class="muted">Elige un workstream para ver la vista previa.</p></section>';
  const opts = { since, scorer: scorer || undefined, rescore: !skip };
  const names = [...new Set(scorerSummary(store.db).map(s => s.scorer))];
  const form = `<form action="/metricas" method="get" class="filters"><input type="hidden" name="tab" value="jueces"><input type="hidden" name="ws" value="${esc(wsSlug)}"><input type="hidden" name="range" value="${esc(r.range)}">${r.from ? `<input type="hidden" name="from" value="${esc(r.from)}">` : ''}${r.to ? `<input type="hidden" name="to" value="${esc(r.to)}">` : ''}<input type="hidden" name="preview" value="1">
<label>Juez<input name="scorer" value="${esc(scorer)}" list="jueces-dl" maxlength="41" placeholder="todos"></label><datalist id="jueces-dl">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
<label><input type="checkbox" name="skip" value="1"${skip ? ' checked' : ''}> Saltar las ya puntuadas</label><button type="submit">Vista previa</button></form>`;
  if (q.get('preview') !== '1') return `<section aria-labelledby="pasadas"><h2 id="pasadas">Puntuar ejecuciones pasadas</h2><p>Antes de encolar nada se muestra cuántas ejecuciones se puntuarían y cuánto costaría. Usa el workstream y la fecha de inicio del rango de arriba; la fecha final no se aplica.</p>${form}</section>`;
  const p = previewBackfill(store, stateDir, wsSlug, opts);
  const preview = `<p class="summary"><span>Ejecuciones a puntuar: <strong>${p.runs}</strong></span><span>Coste estimado: <strong>${usd(p.estimatedUsd)}</strong></span></p>${p.byScorer.length ? table('Por juez', ['Juez', 'Ejecuciones', 'Coste medio medido'], p.byScorer.map(b => [esc(b.scorer), String(b.runs), usd(b.avgCostUsd)])) : ''}<p class="muted">El coste sale del coste medio de las puntuaciones ya hechas de cada juez; sin historial, No medido.</p>`;
  const confirm = !csrf ? '<p class="muted">Para encolar, arranca la web con fab web --write e inicia sesión.</p>'
    : p.runs ? `<form action="/scorers/backfill" method="post" class="web-action"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="ws" value="${esc(wsSlug)}"><input type="hidden" name="since" value="${esc(since ?? '')}"><input type="hidden" name="scorer" value="${esc(scorer)}"><input type="hidden" name="skip" value="${skip ? 'yes' : ''}"><input type="hidden" name="expected" value="${p.runs}"><button>Encolar ${p.runs} puntuaciones</button><p class="muted">Solo las encola; se ejecutan con fab score run. Si el número cambia antes de confirmar, no se encola nada.</p></form>`
    : '<p class="empty">No hay ejecuciones pendientes de puntuar en este rango.</p>';
  return `<section aria-labelledby="pasadas"><h2 id="pasadas">Puntuar ejecuciones pasadas</h2>${form}${preview}${confirm}</section>`;
}

/** Un día por tarjeta, desde el inicio del rango (o el primer dato) hasta su fin, con tope de 90 días. */
function scorerDays(r: RangeSel, rows: { day: string }[]): string[] {
  const end = (r.until ?? new Date().toISOString()).slice(0, 10);
  const start = (r.since ?? rows.map(x => x.day).sort()[0] ?? end).slice(0, 10);
  const days: string[] = [];
  for (let t = Math.max(Date.parse(`${start}T00:00:00Z`), Date.parse(`${end}T00:00:00Z`) - 89 * 86_400_000); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

/** Una tarjeta por juez: tasa de aprobado por día. Sin puntuaciones hechas es «No medido», nunca 0 %. */
function scorerCards(summary: ReturnType<typeof scorerSummary>, byDay: ReturnType<typeof passByDay>, r: RangeSel): string {
  const days = scorerDays(r, byDay);
  return `<div class="cards">${[...new Set(summary.map(s => s.scorer))].map(name => {
    const mine = summary.filter(s => s.scorer === name), done = mine.reduce((a, s) => a + s.done, 0), passed = mine.reduce((a, s) => a + s.passed, 0);
    const rate = days.map(d => { const x = byDay.find(y => y.day === d && y.scorer === name); return x && x.done ? x.passed / x.done * 100 : null; });
    return card({ id: `juez-${name}`, title: name, help: 'Porcentaje de ejecuciones aprobadas por el juez cada día, sobre las puntuaciones hechas con veredicto. Un día sin puntuaciones es un hueco. Es un aviso: no bloquea nada.',
      figure: done ? `${Math.round(passed / done * 100)} %` : 'No medido', sub: pct(passed, done), days, series: [{ label: 'Aprobadas', values: rate }], fmt: n => `${Math.round(n)} %`, tableCaption: `Tasa de aprobado por día · ${name}` });
  }).join('')}</div>`;
}

/** Cuerpo de la pestaña «Jueces» de /metricas. Solo lectura sobre el Store `readonly`: sin tabla `scores`, no la crea. */
export function scorersPanel(store: Store, stateDir: string, url: URL, r: RangeSel, csrf?: string): string {
  const q = url.searchParams, wsParam = r.ws;
  const ws = wsParam ? store.getWorkstream(wsParam) : undefined;
  const scorer = q.get('scorer') || undefined, since = r.since;
  const f: ScoreFilter = { wsId: ws?.id, since, until: r.until, scorer };
  const summary = scorerSummary(store.db, f), rows = scoreRows(store.db, f);
  const intro = '<p class="intro">Los jueces clasifican una ejecución terminada contra una rúbrica. Su resultado es un aviso: no bloquea ni cambia el estado de ningún change.</p>';
  const list = summary.length ? table('Jueces', ['Juez', 'Ámbito', 'Aprobadas', 'Hechas', 'Fallidas', 'En cola', 'Coste acumulado'], summary.map(s => [
    `<a href="?tab=jueces&amp;scorer=${enc(s.scorer)}&amp;${qsOf(r)}">${esc(s.scorer)}</a> <small>${esc(s.profileDigest.slice(0, 8))}</small>`, esc(s.scope), pct(s.passed, s.done), String(s.done), String(s.failed), String(s.pending),
    s.costUsd === null ? 'No medido' : `${usd(s.costUsd)}${s.unmeasured ? ` (${s.unmeasured} sin coste medido)` : ''}`])) : `<p class="empty">${NO_SCORES}</p>`;
  const days = passByDay(store.db, f);
  const cards = summary.length ? scorerCards(summary, days, r) : '';
  const trend = days.length ? table('Tasa de aprobado por día', ['Día', 'Juez', 'Aprobadas', 'Hechas'], days.map(d => [esc(d.day), esc(d.scorer), pct(d.passed, d.done), String(d.done)])) : '';
  const detail = scorer && summary.length ? `<section aria-labelledby="detalle"><h2 id="detalle">Detalle · ${esc(scorer)}</h2>${[...new Set(summary.map(s => s.profileDigest))].map(d => `<h3>Perfil <code>${esc(d.slice(0, 8))}</code></h3>${definition(stateDir, d, scorer)}`).join('')}<p><a href="?tab=jueces&amp;${qsOf(r)}">Ver todos los jueces</a></p></section>` : '';
  const history = rows.length ? table(`Historial (${rows.length}${rows.length === 200 ? ', los más recientes' : ''})`, HISTORY_HEAD, historyRows(rows)) : `<p class="empty">${NO_SCORES}</p>`;
  return `${intro}${cards}<section aria-labelledby="lista"><h2 id="lista">Jueces</h2>${list}${trend}</section>${detail}<section aria-labelledby="historial"><h2 id="historial">Historial de puntuaciones</h2>${history}</section>${backfillPanel(store, stateDir, url, r, ws?.slug, since, csrf)}`;
}

/** Bloque del detalle de una activity: sus puntuaciones y, con sesión de escritura, el formulario para puntuarla a mano. */
export function activityScores(store: Store, stateDir: string, a: Activity, csrf?: string): string {
  const rows = scoreRows(store.db, { activityId: a.id });
  const names = scorersFor(stateDir, a);
  if (!rows.length && !names.length) return '';
  const form = csrf && names.length ? `<form action="/activities/${enc(a.id)}/score" method="post" class="web-action"><input type="hidden" name="csrf" value="${esc(csrf)}"><fieldset><legend>Puntuar esta ejecución</legend><label for="score-scorer">Juez</label><select id="score-scorer" name="scorer">${names.map(n => `<option>${esc(n)}</option>`).join('')}</select><button>Encolar puntuación</button><p class="muted">Solo la encola; se ejecuta con fab score run. Es un aviso: no cambia el estado del change.</p></fieldset></form>` : '';
  return `<section aria-labelledby="puntuaciones"><h2 id="puntuaciones">Puntuaciones</h2>${rows.length ? table('Puntuaciones de esta activity', HISTORY_HEAD, historyRows(rows)) : '<p class="empty">Esta ejecución no tiene puntuaciones.</p>'}${form}</section>`;
}
