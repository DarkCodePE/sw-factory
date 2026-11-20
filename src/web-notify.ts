// Aviso del navegador (T55). El script solo ve recuentos por estado que pone el servidor
// desde un mapa fijo de etiquetas: ningún título ni cuerpo de issue llega a la notificación.
export const NOTIFY_ID = 'fab-notify';

/** Atributo data-inbox: {"Etiqueta": n}. Estados desconocidos se agrupan como «Otros». */
export function inboxCounts(statuses: string[], labels: Record<string, string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of statuses) { const l = labels[s] ?? 'Otros'; counts[l] = (counts[l] ?? 0) + 1; }
  return counts;
}

export const NOTIFY = `(()=>{if(typeof Notification==='undefined')return;const K='fab.notify',b=document.getElementById('${NOTIFY_ID}');
const rd=d=>{try{return JSON.parse(d.querySelector('main')?.dataset.inbox||'')}catch{return null}};
const tot=o=>Object.values(o||{}).reduce((a,n)=>a+n,0);
const get=()=>{try{return localStorage.getItem(K)}catch{return null}};
const set=v=>{try{localStorage.setItem(K,v)}catch{}};
const on=()=>get()==='1'&&Notification.permission==='granted';
let prev=tot(rd(document));
const paint=()=>{if(!b)return;b.hidden=false;b.textContent=Notification.permission==='denied'?'Avisos bloqueados por el navegador':on()?'Avisos: sí':'Avisos: no'};
if(b)b.onclick=async()=>{if(on())set('0');else{if(Notification.permission==='default')await Notification.requestPermission();if(Notification.permission==='granted')set('1')}paint()};
paint();
window.fabNotify=doc=>{const o=rd(doc);if(!o)return;const n=tot(o);if(n>prev&&on())new Notification('fab',{body:n+' en la bandeja: '+Object.entries(o).map(([k,v])=>v+' '+k).join(', ')});prev=n};
})();`;
