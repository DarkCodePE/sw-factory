// Tema claro, oscuro o del sistema (T92). La elección vive solo en el navegador (localStorage); sin ella manda el sistema.
// Un script externo: la CSP no admite scripts en línea. Se carga síncrono en <head> para fijar `data-theme` antes de pintar.
export const THEME_JS = `(()=>{const K='fab.theme',R=document.documentElement;
const get=()=>{try{return localStorage.getItem(K)}catch{return null}};const set=v=>{try{localStorage.setItem(K,v)}catch{}};
const apply=v=>{if(v==='light'||v==='dark')R.setAttribute('data-theme',v);else R.removeAttribute('data-theme')};
const paint=()=>{const v=R.getAttribute('data-theme')||'system';document.querySelectorAll('[data-theme-set]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.themeSet===v)));document.querySelectorAll('.theme').forEach(g=>{g.hidden=false})};
apply(get());document.addEventListener('DOMContentLoaded',paint);
document.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('[data-theme-set]');if(!b)return;apply(b.dataset.themeSet);set(b.dataset.themeSet);paint()});})();`;

/** Oculto hasta que el script lo muestra: sin script no hay un control que no haga nada. */
export const themeControl = '<div class="theme" role="group" aria-label="Tema" hidden><span>Tema</span><button type="button" data-theme-set="system" aria-pressed="true">Sistema</button><button type="button" data-theme-set="light" aria-pressed="false">Claro</button><button type="button" data-theme-set="dark" aria-pressed="false">Oscuro</button></div>';

export const THEME_STYLE = '.theme[hidden]{display:none}.theme{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:16px;font-size:13px;color:var(--muted)}.theme button,.ws-nav button{background:var(--bg);color:var(--text);border-color:var(--line);font-weight:400;padding:4px 10px;min-height:32px}.theme button[aria-pressed=true],.ws-nav button[aria-pressed=true]{border-color:var(--accent);background:var(--panel);font-weight:700}';
