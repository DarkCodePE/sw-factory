// Jueces en la web (T65): pestaña de /metricas y bloque en el detalle de la activity. Los jueces son un aviso (D-G):
// nada de aquí cambia estados ni bloquea. Lo que escribe va por ACTIONS (web-actions.ts) con --write, sesión y CSRF.
import type { Store } from './store.ts';
import { SCORER_SCOPES, resolveProfile, saveProfile, type ScorerDef } from './profile.ts';
import { redact } from './manifest.ts';
import { passByDay, previewBackfill, scoreRows, scorerRoles, scorersFor, scorerSummary, type ScoreFilter } from './scorers.ts';
import type { Activity } from './store.ts';
import { card } from './web-cards.ts';
import { StoreError } from './store.ts';
import { CONFINABLE_AGENTS } from './sandbox/confine.ts';

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

/** Rol de activity que juzga un ámbito (mismos nombres que los runs de Productividad). */
const roleOfScope = (scope: string) => scope === 'investigate' ? 'investigation' : scope === 'implement' || scope === 'change' ? 'implementation' : `validador:${scope}`;
const MAX_CHIPS = 3;
const chips = (roles: string[]) => [...roles.slice(0, MAX_CHIPS).map(r => `<span class="chip">${esc(r)}</span>`), ...(roles.length > MAX_CHIPS ? [`<span class="chip">y ${roles.length - MAX_CHIPS} más</span>`] : [])].join('');

/** Jueces definidos en los perfiles de los workstreams a la vista; un perfil ilegible se omite (la tarjeta sale por sus puntuaciones). */
function definedScorers(store: Store, stateDir: string, wsSlug?: string): Map<string, ScorerDef> {
  const out = new Map<string, ScorerDef>();
  for (const w of store.listWorkstreams().filter(w => wsSlug ? w.slug === wsSlug || w.id === wsSlug : w.state !== 'archived')) {
    try { for (const [n, d] of Object.entries(resolveProfile(stateDir, w.profile).profile.scorers ?? {})) if (!out.has(n)) out.set(n, d); } catch { /* perfil no disponible */ }
  }
  return out;
}

/** Tarjeta «Añadir juez» (solo con sesión de escritura): crea un perfil nuevo con el juez; asignarlo sigue siendo del dueño (D-H). */
function addScorerCard(store: Store, r: RangeSel, csrf: string): string {
  const wss = store.listWorkstreams().filter(w => w.state !== 'archived');
  if (!wss.length) return '';
  return `<section class="card add" aria-label="Añadir juez"><details><summary>+ Añadir juez</summary>
<form action="/scorers/nuevo" method="post" class="web-action"><input type="hidden" name="csrf" value="${esc(csrf)}">
<label>Workstream<select name="ws">${wss.map(w => `<option value="${esc(w.slug)}"${r.ws === w.slug || r.ws === w.id ? ' selected' : ''}>${esc(w.slug)}</option>`).join('')}</select></label>
<label>Nombre<input name="name" required maxlength="41" pattern="[a-z0-9][a-z0-9-]{0,40}" placeholder="claridad"></label>
<label>Ámbito<select name="scope">${SCORER_SCOPES.map(s => `<option>${s}</option>`).join('')}</select></label>
<label>Rúbrica<textarea name="rubric" rows="4" required maxlength="4000"></textarea></label>
<label>Clases (una por línea, «etiqueta: puntuación de 0 a 1»)<textarea name="classes" rows="3" required maxlength="500">ok: 1\nmal: 0</textarea></label>
<label>Adaptador del juez<select name="harness"><option value="">Hereda el del perfil</option>${CONFINABLE_AGENTS.map(a => `<option>${esc(a)}</option>`).join('')}</select></label>
<label>Aprobado desde<input name="passing" type="number" min="0" max="1" step="any" value="0.5" required></label>
<label>Muestreo (0 a 1)<input name="sampling" type="number" min="0" max="1" step="any" value="0.1" required></label>
<button>Guardar como perfil nuevo</button><p class="muted">Crea una copia del perfil con el juez; para usarlo, asígnala en Perfiles. Cada juez nuevo parte del perfil vigente: para tener varios en un perfil, asigna la copia antes de añadir el siguiente. Es un aviso: no bloquea nada.</p></form></details></section>`;
}

/** Campos del formulario «Añadir juez» → definición. Un dato inválido es un StoreError invalid_input con texto fijo (sin eco de lo escrito). */
export function scorerFromForm(raw: Record<string, string | undefined>): { ws: string; name: string; def: ScorerDef } {
  const bad = (m: string) => new StoreError('invalid_input', m);
  const name = raw.name ?? '', scope = raw.scope ?? '', rubric = (raw.rubric ?? '').replace(/\r\n?/g, '\n').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw bad('El nombre del juez debe ser minúsculas, números y guiones (máximo 41).');
  if (!(SCORER_SCOPES as readonly string[]).includes(scope)) throw bad('Elige un ámbito válido.');
  if (!rubric) throw bad('La rúbrica no puede estar vacía.');
  const classes = (raw.classes ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => { const m = /^([a-z0-9_-]{1,24})\s*[:=]\s*(\d*\.?\d+)$/.exec(l); if (!m) throw bad('Cada clase se escribe «etiqueta: puntuación».'); return { label: m[1]!, score: Number(m[2]) }; });
  const unit = (v?: string) => { const n = Number(v); if (!v?.trim() || !Number.isFinite(n) || n < 0 || n > 1) throw bad('Aprobado y muestreo son números de 0 a 1.'); return n; };
  const harness = raw.harness ?? '';
  if (harness && !CONFINABLE_AGENTS.includes(harness)) throw bad('Elige un adaptador confinable.');
  return { ws: raw.ws ?? '', name, def: { scope: scope as ScorerDef['scope'], rubric, classes, passing: unit(raw.passing), sampling: unit(raw.sampling), ...(harness && { harness }) } };
}

/** Guarda una copia del perfil vigente del workstream con el juez nuevo y devuelve su digest. No la asigna (D-H) y deja un evento con el actor. */
export function createScorer(store: Store, stateDir: string, input: ReturnType<typeof scorerFromForm>): { slug: string; digest: string; created: boolean } {
  const ws = store.getWorkstream(input.ws);
  const profile = structuredClone(resolveProfile(stateDir, ws.profile).profile);
  if (profile.scorers?.[input.name]) throw new StoreError('conflict', 'ya existe un juez con ese nombre');
  profile.schemaVersion = 2; // los jueces solo existen en perfiles v2
  profile.scorers = { ...profile.scorers, [input.name]: input.def };
  let saved: ReturnType<typeof saveProfile>;
  try { saved = saveProfile(stateDir, profile); }
  catch (e) { throw new StoreError('invalid_input', redact((e as Error).message).slice(0, 300)); }
  // Reenviar el mismo formulario reutiliza el perfil ya guardado: no hay nada creado y no se emite un segundo evento.
  if (saved.created) store.event(ws.id, 'info', `juez creado: ${input.name} (ámbito ${input.def.scope}) en el perfil ${saved.digest.slice(0, 8)}, sin asignar`);
  return { slug: ws.slug, digest: saved.digest, created: saved.created };
}

/** Una tarjeta por juez (definido o con puntuaciones): tasa de aprobado por día. Sin puntuaciones hechas es «No medido», nunca 0 %. */
function scorerCards(store: Store, stateDir: string, summary: ReturnType<typeof scorerSummary>, byDay: ReturnType<typeof passByDay>, f: ScoreFilter, r: RangeSel, csrf?: string): string {
  const days = scorerDays(r, byDay), defined = definedScorers(store, stateDir, r.ws), scored = scorerRoles(store.db, f);
  const names = [...new Set([...defined.keys(), ...summary.map(s => s.scorer)])].sort();
  const cards = names.map(name => {
    const mine = summary.filter(s => s.scorer === name), done = mine.reduce((a, s) => a + s.done, 0), passed = mine.reduce((a, s) => a + s.passed, 0);
    const rate = days.map(d => { const x = byDay.find(y => y.day === d && y.scorer === name); return x && x.done ? x.passed / x.done * 100 : null; });
    const scope = defined.get(name)?.scope ?? mine[0]?.scope;
    const roles = [...new Set([...(scope ? [roleOfScope(scope)] : []), ...(scored.get(name) ?? [])])];
    return card({ id: `juez-${name}`, title: name, help: 'Porcentaje de ejecuciones aprobadas por el juez cada día, sobre las puntuaciones hechas con veredicto. Un día sin puntuaciones es un hueco. Es un aviso: no bloquea nada.',
      figure: done ? `${Math.round(passed / done * 100)} %` : 'No medido', sub: pct(passed, done), days, series: [{ label: 'Aprobadas', values: rate }], fmt: n => `${Math.round(n)} %`, tableCaption: `Tasa de aprobado por día · ${name}`, footer: chips(roles) });
  });
  const add = csrf ? addScorerCard(store, r, csrf) : '';
  return cards.length || add ? `<div class="cards">${cards.join('')}${add}</div>${cards.length ? '' : '<p class="empty">No hay jueces definidos en los perfiles de estos workstreams.</p>'}` : '<p class="empty">No hay jueces definidos en los perfiles de estos workstreams.</p>';
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
  const cards = scorerCards(store, stateDir, summary, days, f, r, csrf);
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
