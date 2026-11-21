// Lista lateral de workstreams: búsqueda y fijado (T93). Fijar y buscar viven solo en el navegador (localStorage):
// sin script o sin almacenamiento la lista sale en el orden de creación, con los archivados al final.
import type { Workstream } from './store.ts';

export function sidebarNav(workstreams: Workstream[], escape: (v: unknown) => string): string {
  const live = workstreams.filter(w => w.state !== 'archived'), archived = workstreams.filter(w => w.state === 'archived');
  const li = (w: Workstream, i: number) => `<li data-ws="${escape(w.slug)}" data-i="${i}"${w.state === 'archived' ? ' data-archived' : ''}><a href="/changes?ws=${encodeURIComponent(w.slug)}">${escape(w.slug)}</a><button type="button" data-ws-pin aria-pressed="false" aria-label="Fijar ${escape(w.slug)}" hidden>Fijar</button></li>`;
  const rows = [...live.map((w, i) => li(w, i)), ...(archived.length ? ['<li data-sep data-archived data-i="-1">Archivados</li>'] : []), ...archived.map((w, i) => li(w, live.length + i))].join('');
  return `<nav aria-label="Workstreams" class="ws-nav"><h2>Workstreams</h2>${workstreams.length ? `<input type="search" data-ws-search aria-label="Buscar workstream" placeholder="Buscar" hidden><ul>${rows}</ul>` : '<p>Sin workstreams</p>'}</nav>`;
}

export const SIDEBAR_JS = `(()=>{const K='fab.ws.pins',nav=document.querySelector('.ws-nav');if(!nav)return;
const read=()=>{try{return new Set(JSON.parse(localStorage.getItem(K)||'[]'))}catch{return new Set()}};let pins=read();
const write=()=>{try{localStorage.setItem(K,JSON.stringify([...pins]))}catch{}};
const ul=nav.querySelector('ul'),search=nav.querySelector('[data-ws-search]');
const paint=()=>{const q=(search?.value||'').trim().toLocaleLowerCase();const items=[...ul.children];
items.sort((a,b)=>(a.hasAttribute('data-archived')-b.hasAttribute('data-archived'))||(b.hasAttribute('data-sep')-a.hasAttribute('data-sep'))||(pins.has(b.dataset.ws)-pins.has(a.dataset.ws))||(a.dataset.i-b.dataset.i)).forEach(x=>ul.appendChild(x));
let arch=false;items.forEach(x=>{if(x.hasAttribute('data-sep'))return;const on=pins.has(x.dataset.ws);const hide=q&&!x.dataset.ws.toLocaleLowerCase().includes(q);x.hidden=!!hide;if(!hide&&x.hasAttribute('data-archived'))arch=true;const b=x.querySelector('[data-ws-pin]');b.hidden=false;b.setAttribute('aria-pressed',String(on));b.textContent=on?'Fijado':'Fijar'});
const sep=ul.querySelector('[data-sep]');if(sep)sep.hidden=!arch};
if(search){search.hidden=false;search.addEventListener('input',paint)}
nav.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('[data-ws-pin]');if(!b)return;const s=b.closest('[data-ws]').dataset.ws;pins.has(s)?pins.delete(s):pins.add(s);write();paint()});
paint()})();`;

export const SIDEBAR_STYLE = '.ws-nav ul{list-style:none;margin:0;padding:0}.ws-nav li{display:flex;align-items:center;justify-content:space-between;gap:6px}.ws-nav li[hidden]{display:none}.ws-nav li a{flex:1}.ws-nav li[data-sep]{font-size:13px;color:var(--muted);margin-top:12px}.ws-nav input{width:100%;margin-bottom:8px}';
