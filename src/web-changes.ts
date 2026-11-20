// Lista de changes y bandeja con filtros, orden y agrupación. Solo presenta datos del Store (changeIndex, inbox).
import type { Activity, ChangeSource, ChangeSummary, Store } from './store.ts';

export interface Ui { escape(v: unknown): string; badge(status: string): string; labels: Record<string, string> }
export interface Query { status: string; q: string; sort: 'updated' | 'created' | 'title'; from: string; to: string; source: string; actor: string }

export const SOURCES: Record<ChangeSource, string> = { cli: 'CLI', channel: 'Canal', jira: 'Jira' };
export const SORTS = { updated: 'Actualizado', created: 'Creado', title: 'Título' } as const;
const UNKNOWN = 'unknown'; // valor de `source` y `actor` para «No medido»
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const enc = encodeURIComponent;

export function parseQuery(p: URLSearchParams): Query {
  const sort = p.get('sort') ?? '';
  const day = (k: string) => { const v = p.get(k) ?? ''; return DAY.test(v) ? v : ''; };
  return { status: p.get('status') ?? '', q: p.get('q') ?? '', sort: Object.hasOwn(SORTS, sort) ? sort as Query['sort'] : 'updated', from: day('from'), to: day('to'), source: p.get('source') ?? '', actor: p.get('actor') ?? '' };
}

/** `from`/`to` son días UTC inclusivos y se comparan con la fecha de actualización. */
export function applyQuery(all: ChangeSummary[], f: Query): ChangeSummary[] {
  const q = f.q.toLocaleLowerCase();
  const rows = all.filter(c => (!f.status || c.status === f.status) && c.title.toLocaleLowerCase().includes(q)
    && (!f.from || c.updatedAt.slice(0, 10) >= f.from) && (!f.to || c.updatedAt.slice(0, 10) <= f.to)
    && (!f.source || (f.source === UNKNOWN ? c.source === null : c.source === f.source))
    && (!f.actor || (f.actor === UNKNOWN ? c.creator === null : c.creator === f.actor)));
  // Desempate por id: el orden es estable aunque coincidan las fechas.
  const cmp = f.sort === 'title' ? (a: ChangeSummary, b: ChangeSummary) => a.title.localeCompare(b.title)
    : f.sort === 'created' ? (a: ChangeSummary, b: ChangeSummary) => b.createdAt.localeCompare(a.createdAt)
    : (a: ChangeSummary, b: ChangeSummary) => b.updatedAt.localeCompare(a.updatedAt);
  return rows.sort((a, b) => cmp(a, b) || a.id.localeCompare(b.id));
}

const link = (params: Record<string, string>) => { const s = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${enc(v)}`).join('&'); return `/changes${s ? `?${s}` : ''}`; };

export function changesView(ui: Ui, all: ChangeSummary[], f: Query, ws: string, workstreams: { id: string; slug: string }[], statuses: string[]): string {
  const { escape: e } = ui;
  const slug = new Map(workstreams.map(w => [w.id, w.slug]));
  const rows = applyQuery(all, f);
  const sel = (cond: boolean) => cond ? ' selected' : '';
  const actors = [...new Set(all.map(c => c.creator).filter((a): a is string => a !== null))].sort();
  const base = { ws, q: f.q, sort: f.sort, from: f.from, to: f.to, source: f.source, actor: f.actor };
  // Los contadores cuentan lo que el enlace mostrará: el resto de filtros se conserva, el estado no.
  const scoped = applyQuery(all, { ...f, status: '' });
  const counts = new Map<string, number>(); for (const c of scoped) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
  const quick = [['', 'Todos', scoped.length] as const, ...statuses.filter(s => counts.has(s)).map(s => [s, ui.labels[s] ?? s, counts.get(s)!] as const)]
    .map(([s, label, n]) => `<a href="${e(link({ ...base, status: s }))}"${f.status === s ? ' aria-current="true"' : ''}>${e(label)} <strong>${n}</strong></a>`).join('');
  const form = `<form action="/changes" method="get" class="filters"><label>Workstream<select name="ws"><option value="">Todos</option>${workstreams.map(w => `<option value="${e(w.slug)}"${sel(ws === w.id || ws === w.slug)}>${e(w.slug)}</option>`).join('')}</select></label>`
    + `<label>Estado<select name="status"><option value="">Todos</option>${statuses.map(s => `<option value="${e(s)}"${sel(f.status === s)}>${e(ui.labels[s] ?? s)}</option>`).join('')}</select></label>`
    + `<label>Fuente<select name="source"><option value="">Todas</option>${Object.entries(SOURCES).map(([k, v]) => `<option value="${k}"${sel(f.source === k)}>${v}</option>`).join('')}<option value="${UNKNOWN}"${sel(f.source === UNKNOWN)}>No medido</option></select></label>`
    + `<label>Creador<select name="actor"><option value="">Todos</option>${actors.map(a => `<option value="${e(a)}"${sel(f.actor === a)}>${e(a)}</option>`).join('')}<option value="${UNKNOWN}"${sel(f.actor === UNKNOWN)}>No medido</option></select></label>`
    + `<label>Actualizado desde<input name="from" type="date" value="${e(f.from)}"></label><label>hasta<input name="to" type="date" value="${e(f.to)}"></label>`
    + `<label>Ordenar por<select name="sort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}"${sel(f.sort === k)}>${v}</option>`).join('')}</select></label>`
    + `<label class="search">Buscar por título<input name="q" type="search" value="${e(f.q)}" placeholder="Título del change"></label><button>Filtrar</button></form>`;
  const table = !rows.length ? '<p class="empty">No hay changes para estos filtros.</p>'
    : `<div class="table-wrap"><table><thead><tr><th>Change</th><th>Estado</th><th>Workstream</th><th>Fuente</th><th>Creador</th><th>Actualizado</th></tr></thead><tbody>${rows.map(c => `<tr><td><a href="/changes/${enc(c.id)}">${e(c.title)}</a><small>${e(c.id.slice(0, 8))}</small></td><td>${ui.badge(c.status)}</td><td>${e(slug.get(c.workstreamId) ?? '')}</td><td>${c.source ? SOURCES[c.source] : 'No medido'}</td><td>${c.creator === null ? 'No medido' : e(c.creator)}</td><td><time>${e(c.updatedAt)}</time></td></tr>`).join('')}</tbody></table></div>`;
  return `${form}<nav class="quick" aria-label="Filtros rápidos por estado">${quick}</nav><p class="muted">${rows.length} changes</p>${table}`;
}

export function inboxView(ui: Ui, items: { a: Activity; title: string; slug: string }[], q: string): string {
  const { escape: e } = ui;
  const needle = q.toLocaleLowerCase();
  const shown = items.filter(i => `${i.title} ${i.a.validator ?? i.a.kind} ${i.slug}`.toLocaleLowerCase().includes(needle));
  const days = new Map<string, typeof shown>();
  for (const i of [...shown].sort((x, y) => y.a.createdAt.localeCompare(x.a.createdAt) || x.a.id.localeCompare(y.a.id))) {
    const day = i.a.createdAt.slice(0, 10); days.set(day, [...(days.get(day) ?? []), i]);
  }
  const search = `<form action="/" method="get" class="filters"><label class="search">Buscar en la bandeja<input name="q" type="search" value="${e(q)}" placeholder="Título, validador o workstream"></label><button>Buscar</button></form>`;
  if (!shown.length) return `${search}<p class="empty">${items.length ? 'Nada coincide con la búsqueda.' : 'La bandeja está al día. Puedes consultar los changes y su evidencia.'}</p>`;
  return `${search}${[...days].map(([day, list]) => `<section class="day"><h2><time>${e(day)}</time></h2><ul class="inbox">${list.map(({ a, title, slug }) => `<li data-seen-id="${e(a.id)}"><a href="/activities/${enc(a.id)}">${e(title)}</a><div>${e(a.validator ?? a.kind)} · ${e(slug)} ${ui.badge(a.reviewStatus === 'awaiting' ? 'awaiting' : a.status)} <button type="button" data-seen aria-pressed="false">Marcar como visto</button></div></li>`).join('')}</ul></section>`).join('')}`;
}

// «Visto» vive solo en el navegador (localStorage): no cambia el dominio. El sondeo llama a fabPrepare sobre el <main> recibido antes de compararlo, para que una marca local no cuente como cambio y no se pierda el foco.
export const INBOX_JS = `(()=>{const K='fab.inbox.seen';const read=()=>{try{return new Set(JSON.parse(localStorage.getItem(K)||'[]'))}catch{return new Set()}};const write=s=>{try{localStorage.setItem(K,JSON.stringify([...s]))}catch{}};
const apply=(root=document)=>{const s=read();root.querySelectorAll('[data-seen-id]').forEach(li=>{const on=s.has(li.dataset.seenId);li.classList.toggle('seen',on);const b=li.querySelector('[data-seen]');if(b){const t=on?'Visto · deshacer':'Marcar como visto';if(b.textContent!==t)b.textContent=t;b.setAttribute('aria-pressed',String(on))}})};
window.fabPrepare=apply;document.addEventListener('click',ev=>{const b=ev.target.closest&&ev.target.closest('[data-seen]');if(!b)return;const li=b.closest('[data-seen-id]');const s=read();const id=li.dataset.seenId;s.has(id)?s.delete(id):s.add(id);write(s);apply()});
new MutationObserver(()=>apply()).observe(document.body,{childList:true,subtree:true});apply()})();`;

/** Enlace al PR de un change; solo admite https:// y se escapa; 'No medido' si falta o no es https. */
export function changePrLink(store: Store, changeId: string): string {
  const url = store.getChangePrUrl(changeId);
  if (!url || !url.startsWith('https://')) return 'No medido';
  const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  return `<a href="${esc(url)}">${esc(url)}</a>`;
}
