// Lista de changes y bandeja con filtros, orden y agrupación. Solo presenta datos del Store (changeIndex, inbox).
import type { Activity, ChangeLinks, ChangeSource, ChangeSummary } from './store.ts';

export interface Ui { escape(v: unknown): string; badge(status: string): string; labels: Record<string, string> }
export interface Query { status: string; q: string; sort: 'updated' | 'created' | 'title'; from: string; to: string; source: string; actor: string; agent: string; role: string; cfrom: string; cto: string; dir: '' | 'asc' | 'desc' }

export const SOURCES: Record<ChangeSource, string> = { cli: 'CLI', channel: 'Canal', jira: 'Jira', automation: 'Automation (segundo plano)' };
export const SORTS = { updated: 'Actualizado', created: 'Creado', title: 'Título' } as const;
const UNKNOWN = 'unknown'; // valor de `source` y `actor` para «No medido»
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const enc = encodeURIComponent;

export function parseQuery(p: URLSearchParams): Query {
  const sort = p.get('sort') ?? '';
  const day = (k: string) => { const v = p.get(k) ?? ''; return DAY.test(v) ? v : ''; };
  return { status: p.get('status') ?? '', q: p.get('q') ?? '', sort: Object.hasOwn(SORTS, sort) ? sort as Query['sort'] : 'updated', from: day('from'), to: day('to'), source: p.get('source') ?? '', actor: p.get('actor') ?? '', agent: p.get('agent') ?? '', role: p.get('role') ?? '', cfrom: day('cfrom'), cto: day('cto'), dir: p.get('dir') === 'asc' || p.get('dir') === 'desc' ? p.get('dir') as 'asc' | 'desc' : '' };
}

/** `from`/`to` y `cfrom`/`cto` son días UTC inclusivos sobre la fecha de actualización y la de creación. `dir` vacío = el natural de cada orden (título asc, fechas desc). */
export function applyQuery(all: ChangeSummary[], f: Query): ChangeSummary[] {
  const q = f.q.toLocaleLowerCase();
  const rows = all.filter(c => (!f.status || c.status === f.status) && c.title.toLocaleLowerCase().includes(q)
    && (!f.from || c.updatedAt.slice(0, 10) >= f.from) && (!f.to || c.updatedAt.slice(0, 10) <= f.to)
    && (!f.source || (f.source === UNKNOWN ? c.source === null : c.source === f.source))
    && (!f.actor || (f.actor === UNKNOWN ? c.creator === null : c.creator === f.actor))
    && (!f.cfrom || c.createdAt.slice(0, 10) >= f.cfrom) && (!f.cto || c.createdAt.slice(0, 10) <= f.cto)
    && (!f.agent || (f.agent === UNKNOWN ? !c.agents.length : c.agents.includes(f.agent)))
    && (!f.role || (f.role === UNKNOWN ? !c.roles.length : c.roles.includes(f.role))));
  // Desempate por id: el orden es estable aunque coincidan las fechas.
  const asc = (f.dir || (f.sort === 'title' ? 'asc' : 'desc')) === 'asc' ? 1 : -1;
  const key = (c: ChangeSummary) => f.sort === 'title' ? c.title : f.sort === 'created' ? c.createdAt : c.updatedAt;
  return rows.sort((a, b) => asc * key(a).localeCompare(key(b)) || a.id.localeCompare(b.id));
}

const link = (params: Record<string, string>) => { const s = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${enc(v)}`).join('&'); return `/changes${s ? `?${s}` : ''}`; };

export function changesView(ui: Ui, all: ChangeSummary[], f: Query, ws: string, workstreams: { id: string; slug: string }[], statuses: string[]): string {
  const { escape: e } = ui;
  const slug = new Map(workstreams.map(w => [w.id, w.slug]));
  const rows = applyQuery(all, f);
  const sel = (cond: boolean) => cond ? ' selected' : '';
  const actors = [...new Set(all.map(c => c.creator).filter((a): a is string => a !== null))].sort();
  const agents = [...new Set(all.flatMap(c => c.agents))].sort(); const roles = [...new Set(all.flatMap(c => c.roles))].sort();
  const pick = (name: string, label: string, values: string[], cur: string) => `<label>${label}<select name="${name}"><option value="">Todos</option>${values.map(v => `<option value="${e(v)}"${sel(cur === v)}>${e(v)}</option>`).join('')}<option value="${UNKNOWN}"${sel(cur === UNKNOWN)}>No medido</option></select></label>`;
  const base = { ws, q: f.q, sort: f.sort, dir: f.dir, from: f.from, to: f.to, cfrom: f.cfrom, cto: f.cto, source: f.source, actor: f.actor, agent: f.agent, role: f.role };
  // Los contadores cuentan lo que el enlace mostrará: el resto de filtros se conserva, el estado no.
  const scoped = applyQuery(all, { ...f, status: '' });
  const counts = new Map<string, number>(); for (const c of scoped) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
  const quick = [['', 'Todos', scoped.length] as const, ...statuses.filter(s => counts.has(s)).map(s => [s, ui.labels[s] ?? s, counts.get(s)!] as const)]
    .map(([s, label, n]) => `<a href="${e(link({ ...base, status: s }))}"${f.status === s ? ' aria-current="true"' : ''}>${e(label)} <strong>${n}</strong></a>`).join('');
  const form = `<form action="/changes" method="get" class="filters"><label>Workstream<select name="ws"><option value="">Todos</option>${workstreams.map(w => `<option value="${e(w.slug)}"${sel(ws === w.id || ws === w.slug)}>${e(w.slug)}</option>`).join('')}</select></label>`
    + `<label>Estado<select name="status"><option value="">Todos</option>${statuses.map(s => `<option value="${e(s)}"${sel(f.status === s)}>${e(ui.labels[s] ?? s)}</option>`).join('')}</select></label>`
    + `<label>Fuente<select name="source"><option value="">Todas</option>${Object.entries(SOURCES).map(([k, v]) => `<option value="${k}"${sel(f.source === k)}>${v}</option>`).join('')}<option value="${UNKNOWN}"${sel(f.source === UNKNOWN)}>No medido</option></select></label>`
    + `<label>Creador<select name="actor"><option value="">Todos</option>${actors.map(a => `<option value="${e(a)}"${sel(f.actor === a)}>${e(a)}</option>`).join('')}<option value="${UNKNOWN}"${sel(f.actor === UNKNOWN)}>No medido</option></select></label>`
    + pick('agent', 'Worker (adaptador)', agents, f.agent) + pick('role', 'Rol', roles, f.role)
    + `<label>Creado desde<input name="cfrom" type="date" value="${e(f.cfrom)}"></label><label>hasta<input name="cto" type="date" value="${e(f.cto)}"></label>`
    + `<label>Actualizado desde<input name="from" type="date" value="${e(f.from)}"></label><label>hasta<input name="to" type="date" value="${e(f.to)}"></label>`
    + `<label>Ordenar por<select name="sort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}"${sel(f.sort === k)}>${v}</option>`).join('')}</select></label>`
    + `<label>Sentido<select name="dir"><option value="">Natural</option><option value="asc"${sel(f.dir === 'asc')}>Ascendente</option><option value="desc"${sel(f.dir === 'desc')}>Descendente</option></select></label>`
    + `<label class="search">Buscar por título<input name="q" type="search" value="${e(f.q)}" placeholder="Título del change"></label><button>Filtrar</button></form>`;
  const table = !rows.length ? '<p class="empty">No hay changes para estos filtros.</p>'
    : `<div class="table-wrap"><table><thead><tr><th>Change</th><th>Estado</th><th>Workstream</th><th>Fuente</th><th>Creador</th><th>Activities</th><th>Actualizado</th></tr></thead><tbody>${rows.map(c => `<tr><td><a href="/changes/${enc(c.id)}">${e(c.title)}</a><small>${e(c.id.slice(0, 8))}</small></td><td>${ui.badge(c.status)}</td><td>${e(slug.get(c.workstreamId) ?? '')}</td><td>${c.source ? SOURCES[c.source] : 'No medido'}</td><td>${c.creator === null ? 'No medido' : e(c.creator)}</td><td>${c.activityCount}</td><td><time>${e(c.updatedAt)}</time></td></tr>`).join('')}</tbody></table></div>`;
  return `${form}<nav class="quick" aria-label="Filtros rápidos por estado">${quick}</nav><p class="muted">${rows.length} changes</p>${table}`;
}

const copyButton = (ui: Ui, id: string) => `<button type="button" data-copy="${ui.escape(id)}">Copiar id</button>`;
export { copyButton };

/** Plantilla de perfil que gobierna a una activity; null si ninguna (revisión de change, gates, steward). `roleLink` devuelve '' en ese caso. */
export function roleField(a: Pick<Activity, 'kind' | 'validator'>): string | null {
  if (a.validator) return `validators.${a.validator}`;
  return a.kind === 'investigation' ? 'worker.investigate' : a.kind === 'implementation' ? 'worker.implement' : null;
}
export function roleLink(ui: Ui, a: Pick<Activity, 'kind' | 'validator'>, slug: string, text: string): string {
  const field = roleField(a);
  return field ? `<a href="/perfiles?ws=${enc(slug)}#f-${field}">${ui.escape(text)}</a>` : '';
}

// Solo https a hosts conocidos (GitHub, Jira Cloud y el JIRA_HOSTNAME configurado); lo demás es texto.
export function safeUrl(raw: string, env: Record<string, string | undefined> = process.env): string | null {
  try {
    const u = new URL(raw);
    const jira = env.JIRA_HOSTNAME?.trim().toLowerCase();
    const ok = u.protocol === 'https:' && !u.username && !u.password && (u.hostname === 'github.com' || u.hostname.endsWith('.atlassian.net') || (!!jira && u.hostname === jira.replace(/^https?:\/\//, '').replace(/\/.*$/, '')));
    return ok ? u.href : null;
  } catch { return null; }
}

export function linksBlock(ui: Ui, links: ChangeLinks): string {
  const { escape: e } = ui;
  const a = (url: string, text: string) => { const h = safeUrl(url); return h ? `<a href="${e(h)}" rel="noopener noreferrer">${e(text)}</a>` : e(text); };
  const items = [links.source && `<span>Issue: ${a(links.source.url, links.source.key)}</span>`, links.pr && `<span>PR: ${a(links.pr.url, `${links.pr.repo}#${links.pr.number}`)}</span>`].filter(Boolean);
  return items.length ? `<p class="links">${items.join(' · ')}</p>` : '';
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
  const bulk = '<div class="bulk"><button type="button" data-sel-all>Seleccionar todo</button> <button type="button" data-seen-sel="1">Marcar los seleccionados como vistos</button> <button type="button" data-seen-sel="0">Quitar «visto» a los seleccionados</button></div>';
  return `${search}${bulk}${[...days].map(([day, list]) => `<section class="day"><h2><time>${e(day)}</time></h2><ul class="inbox">${list.map(({ a, title, slug }) => `<li data-seen-id="${e(a.id)}"><input type="checkbox" data-sel="${e(a.id)}" aria-label="Seleccionar ${e(title)}"> <a href="/activities/${enc(a.id)}">${e(title)}</a><div>${e(a.validator ?? a.kind)} · ${e(slug)} ${ui.badge(a.reviewStatus === 'awaiting' ? 'awaiting' : a.status)} <button type="button" data-seen aria-pressed="false">Marcar como visto</button></div></li>`).join('')}</ul></section>`).join('')}`;
}

// «Visto» vive solo en el navegador (localStorage): no cambia el dominio. El sondeo llama a fabPrepare sobre el <main> recibido antes de compararlo, para que una marca local no cuente como cambio y no se pierda el foco.
export const INBOX_JS = `(()=>{const K='fab.inbox.seen';const read=()=>{try{return new Set(JSON.parse(localStorage.getItem(K)||'[]'))}catch{return new Set()}};const write=s=>{try{localStorage.setItem(K,JSON.stringify([...s]))}catch{}};
const apply=(root=document)=>{const s=read();root.querySelectorAll('[data-seen-id]').forEach(li=>{const on=s.has(li.dataset.seenId);li.classList.toggle('seen',on);const b=li.querySelector('[data-seen]');if(b){const t=on?'Visto · deshacer':'Marcar como visto';if(b.textContent!==t)b.textContent=t;b.setAttribute('aria-pressed',String(on))}})};
const sel=()=>[...document.querySelectorAll('[data-sel]:checked')];
const keep=root=>{if(root===document)return;const on=new Set(sel().map(c=>c.dataset.sel));root.querySelectorAll('[data-seen-id]').forEach(li=>{const c=li.querySelector('[data-sel]');if(c)c.checked=on.has(li.dataset.seenId)})};
window.fabPrepare=root=>{apply(root);keep(root)};document.addEventListener('click',ev=>{const t=ev.target.closest&&ev.target.closest('[data-sel-all],[data-seen-sel],[data-copy]');if(!t)return;
if(t.matches('[data-sel-all]')){const all=[...document.querySelectorAll('[data-sel]')];const on=all.some(c=>!c.checked);all.forEach(c=>{c.checked=on})}
else if(t.matches('[data-seen-sel]')){const s=read();sel().forEach(c=>{const id=c.dataset.sel;t.dataset.seenSel==='1'?s.add(id):s.delete(id)});write(s);apply()}
else{const v=t.dataset.copy;Promise.resolve().then(()=>navigator.clipboard.writeText(v)).then(()=>{t.textContent='Copiado'},()=>{t.textContent='No se pudo copiar'})}});
document.addEventListener('click',ev=>{const b=ev.target.closest&&ev.target.closest('[data-seen]');if(!b)return;const li=b.closest('[data-seen-id]');const s=read();const id=li.dataset.seenId;s.has(id)?s.delete(id):s.add(id);write(s);apply()});
new MutationObserver(()=>apply()).observe(document.body,{childList:true,subtree:true});apply()})();`;
