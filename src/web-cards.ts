// Tarjetas de métricas (T111): componente reutilizable para /metricas. Gráfico de área SVG hecho en el servidor, sin JS;
// las casillas de serie son CSS puro (input:checked + hermano). La tabla de datos queda plegada debajo, por accesibilidad.
// Un valor null es un hueco («Sin datos» o «No medido»), nunca un cero: el trazo se corta, no cae a la línea base.
// T112 y T113 solo construyen `series` y llaman a `card`.
import { redact } from './evidence.ts';

export const esc = (v: unknown) => redact(String(v ?? '')).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function table(caption: string, headers: string[], rows: string[][]) {
  return `<div class="table-wrap"><table><caption>${esc(caption)}</caption><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(r => `<tr>${r.map((v, i) => i === 0 ? `<th scope="row">${v}</th>` : `<td>${v}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}">Sin datos para estos filtros.</td></tr>`}</tbody></table></div>`;
}

export interface CardSeries { label: string; values: Array<number | null>; /** Texto de la tabla en un hueco; por defecto «Sin datos». */ missing?: (i: number) => string }
export interface CardOpts {
  id: string; title: string; help: string; /** Cifra destacada ya formateada («No medido» si no hay). */ figure: string; sub?: string;
  days: string[]; series: CardSeries[]; stacked?: boolean; fmt: (n: number) => string; integer?: boolean; tableCaption: string;
}

const MAX_SERIES = 4;
const W = 460, H = 210, TOP = 12, BOTTOM = 28, RIGHT = 14;
const DASH = ['', '7 4', '2 4', '8 3 2 3']; // la forma del trazo también distingue la serie, no solo el color
const safeId = (s: string) => s.replace(/[^a-z0-9-]/gi, '-');
const nice = (v: number) => { if (!(v > 0)) return 1; const e = 10 ** Math.floor(Math.log10(v)), f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e; };

/** Tramos de índices consecutivos con dato. */
function runs(present: boolean[]): number[][] {
  const out: number[][] = []; let cur: number[] = [];
  present.forEach((p, i) => { if (p) cur.push(i); else if (cur.length) { out.push(cur); cur = []; } });
  if (cur.length) out.push(cur);
  return out;
}

function plot(o: CardOpts): string {
  const n = o.days.length, ss = o.series;
  const val = (j: number, i: number) => ss[j]!.values[i] ?? null;
  const present = o.days.map((_, i) => ss.some((_s, j) => val(j, i) !== null));
  // Apilado: cada serie se dibuja sobre la suma de las anteriores; un hueco cuenta 0 en la pila solo si otra serie tiene dato ese día.
  const upper = ss.map((_s, j) => o.days.map((_d, i) => o.stacked ? ss.slice(0, j + 1).reduce((a, _x, k) => a + (val(k, i) ?? 0), 0) : val(j, i)));
  const top = Math.max(0, ...upper.flatMap(u => u.filter((v): v is number => v !== null)));
  const max = o.integer ? Math.max(4, Math.ceil(nice(top))) : nice(top);
  const ticks = [0, 1, 2, 3, 4].map(k => max * k / 4).filter(t => !o.integer || Number.isInteger(t));
  const left = 14 + 7 * Math.max(...ticks.map(t => o.fmt(t).length));
  const pw = W - left - RIGHT, ph = H - TOP - BOTTOM;
  const x = (i: number) => n === 1 ? left + pw / 2 : left + i * pw / (n - 1);
  const y = (v: number) => TOP + ph - v / max * ph;
  const grid = ticks.map(t => `<line x1="${left}" x2="${W - RIGHT}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="var(--line)"/><text x="${left - 6}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">${esc(o.fmt(t))}</text>`).join('');
  const step = Math.ceil(n / 6);
  const xl = o.days.map((d, i) => i % step === 0 || i === n - 1 ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}" font-size="11" fill="var(--muted)">${esc(d.slice(5))}</text>` : '').join('');
  const groups = ss.map((s, j) => {
    const ok = o.days.map((_, i) => o.stacked ? present[i]! : val(j, i) !== null);
    const base = (i: number) => o.stacked && j ? upper[j - 1]![i]! : 0;
    const body = runs(ok).map(r => {
      if (r.length === 1) return `<circle cx="${x(r[0]!).toFixed(1)}" cy="${y(upper[j]![r[0]!]!).toFixed(1)}" r="3.5" fill="var(--s${j})"/>`;
      const line = r.map(i => `${x(i).toFixed(1)},${y(upper[j]![i]!).toFixed(1)}`);
      const back = [...r].reverse().map(i => `${x(i).toFixed(1)},${y(base(i)).toFixed(1)}`);
      return `<polygon points="${[...line, ...back].join(' ')}" fill="var(--s${j})" fill-opacity=".2"/><polyline points="${line.join(' ')}" fill="none" stroke="var(--s${j})" stroke-width="2"${DASH[j] ? ` stroke-dasharray="${DASH[j]}"` : ''}/>`;
    }).join('');
    const tips = o.days.map((d, i) => val(j, i) === null ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(upper[j]![i]!).toFixed(1)}" r="7" fill="transparent"><title>${esc(d)} · ${esc(s.label)}: ${esc(o.fmt(val(j, i)!))}</title></circle>`).join('');
    return `<g class="a${j}">${body}${tips}</g>`;
  }).join('');
  return `<svg class="plot" role="img" aria-label="${esc(o.title)}; los valores están en la tabla de datos plegada debajo" viewBox="0 0 ${W} ${H}">${grid}${xl}${groups}</svg>`;
}

const head = (id: string, title: string, help: string) => `<header><h2 id="t-${id}">${esc(title)}</h2><details class="help"><summary aria-label="Qué mide ${esc(title)}">?</summary><p>${esc(help)}</p></details></header>`;
const folded = (caption: string, inner: string) => `<details class="data"><summary>Tabla de datos · ${esc(caption)}</summary>${inner}</details>`;

export function card(o: CardOpts): string {
  const id = safeId(o.id), ss = o.series.slice(0, MAX_SERIES);
  const has = ss.some(s => s.values.some(v => v !== null));
  const legend = ss.length > 1 || o.stacked ? ss.map((s, j) => `<input type="checkbox" id="c-${id}-${j}" class="sc sc${j}" checked><label for="c-${id}-${j}"><span class="sw sw${j}" aria-hidden="true"></span>${esc(s.label)}</label>`).join('') : '';
  const rows = o.days.map((d, i) => [esc(d), ...ss.map(s => { const v = s.values[i] ?? null; return v === null ? esc(s.missing?.(i) ?? 'Sin datos') : esc(o.fmt(v)); })]);
  return `<section class="card" aria-labelledby="t-${id}">${head(id, o.title, o.help)}<p class="fig">${esc(o.figure)}</p>${o.sub ? `<p class="sub">${esc(o.sub)}</p>` : ''}<div class="chart">${has ? `${legend}${plot({ ...o, series: ss })}` : '<p class="empty">No medido: no hay datos en este rango.</p>'}</div>${folded(o.tableCaption, table(o.tableCaption, ['Fecha', ...ss.map(s => s.label)], rows))}</section>`;
}

/** Tarjeta de cifras (p. ej. tiempos de ciclo): una cifra grande por celda, «No medido» si falta. */
export function statCard(o: { id: string; title: string; help: string; cells: Array<{ label: string; value: string; sub?: string }>; tableCaption: string; tableHtml: string }): string {
  const id = safeId(o.id);
  return `<section class="card" aria-labelledby="t-${id}">${head(id, o.title, o.help)}<div class="cells">${o.cells.map(c => `<div class="cell"><p class="lbl">${esc(c.label)}</p><p class="fig">${esc(c.value)}</p>${c.sub ? `<p class="sub">${esc(c.sub)}</p>` : ''}</div>`).join('')}</div>${folded(o.tableCaption, o.tableHtml)}</section>`;
}

// Colores de serie con contraste ≥ 3:1 contra el fondo (objetos gráficos, WCAG 1.4.11); lo prueba tests/web-cards.test.ts.
export const SERIES_LIGHT = ['#1f6b4f', '#a14a00', '#3949ab', '#8e2c6a'];
export const SERIES_DARK = ['#9fd5b6', '#f4bc6c', '#9fb4ff', '#f2a1d1'];
const vars = (c: string[]) => c.map((v, i) => `--s${i}:${v}`).join(';');
export const CARD_STYLE = `
:root{${vars(SERIES_LIGHT)}}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){${vars(SERIES_DARK)}}}
:root[data-theme=dark]{${vars(SERIES_DARK)}}
nav.tabs{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 24px}nav.tabs a{display:inline-block;margin:0;padding:8px 18px;border:1px solid var(--line);border-radius:999px;color:var(--text);font-weight:600;min-height:44px;line-height:26px}nav.tabs a:hover{background:var(--panel)}nav.tabs a[aria-current],nav.tabs a[aria-current]:hover{background:var(--accent);border-color:var(--accent);color:var(--bg)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:20px;margin:24px 0}
.cards section.card{margin-top:0}.card{border:1px solid var(--line);border-radius:8px;padding:16px 18px;background:var(--bg);min-width:0}.card header{display:flex;align-items:center;gap:8px}.card h2{margin:0;font-size:15px;font-weight:600}
.card .fig{margin:4px 0 0;font-size:32px;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums}.card .sub{margin:0;color:var(--muted);font-size:14px}.card .lbl{margin:0;color:var(--muted);font-size:13px;font-weight:600}
.card .chart{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;margin-top:8px}.card .chart svg{flex-basis:100%;margin-top:4px}.card .chart .empty{padding:36px 0}.card .plot{max-width:560px}
.card .chart label{min-height:24px;display:inline-flex;align-items:center;gap:6px;font-size:14px;cursor:pointer}.card .chart input{min-height:auto;width:18px;height:18px;accent-color:var(--accent)}
.sw{display:inline-block;width:14px;height:4px;border-radius:2px}.sw0{background:var(--s0)}.sw1{background:var(--s1)}.sw2{background:var(--s2)}.sw3{background:var(--s3)}
.sc0:not(:checked)~.plot .a0,.sc1:not(:checked)~.plot .a1,.sc2:not(:checked)~.plot .a2,.sc3:not(:checked)~.plot .a3{display:none}
.cells{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-top:8px}.cell{padding:14px 12px;border-top:1px solid var(--line)}
.card details{margin:12px 0 0}.card details.help{margin:0;position:relative}.help summary{padding:0;min-width:24px;min-height:24px;width:24px;height:24px;line-height:22px;text-align:center;border:1px solid var(--muted);border-radius:50%;color:var(--muted);font-size:13px;list-style:none}.help summary::-webkit-details-marker{display:none}.help p{position:absolute;z-index:3;left:0;top:28px;width:min(280px,70vw);margin:0;padding:10px 12px;background:var(--panel);border:1px solid var(--line);border-radius:6px;font-size:13px;color:var(--text)}
.card .data summary{padding:4px 0;font-size:14px}.card .table-wrap{max-height:320px}.card caption{padding-top:8px}`;
