import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { card, CARD_STYLE, SERIES_DARK, SERIES_LIGHT, statCard } from '../src/web-cards.ts';
import { metricsPage } from '../src/web-metrics.ts';
import { DARK, WEB_STYLE } from '../src/web-style.ts';

// WCAG 2.x: luminancia relativa y razón de contraste.
const lum = (hex: string) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4); return .2126 * r! + .7152 * g! + .0722 * b!; };
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + .05) / (y! + .05); };
const light = (n: string) => new RegExp(`:root\\{[^}]*--${n}:(#[0-9a-f]{6})`).exec(WEB_STYLE)![1]!;
const dark = (n: string) => new RegExp(`--${n}:(#[0-9a-f]{6})`).exec(DARK)![1]!;

test('T111: contraste AA en tema claro y oscuro (texto 4.5:1, gráficos y trazos 3:1)', () => {
  for (const [theme, pick, series] of [['claro', light, SERIES_LIGHT], ['oscuro', dark, SERIES_DARK]] as const) {
    const bg = pick('bg'), panel = pick('panel');
    for (const t of ['text', 'muted', 'accent']) expect(ratio(pick(t), bg), `${theme}: ${t} sobre bg`).toBeGreaterThanOrEqual(4.5);
    for (const t of ['text', 'muted']) expect(ratio(pick(t), panel), `${theme}: ${t} sobre panel`).toBeGreaterThanOrEqual(4.5);
    expect(ratio(bg, pick('accent')), `${theme}: pestaña activa`).toBeGreaterThanOrEqual(4.5);
    series.forEach((c, i) => expect(ratio(c, bg), `${theme}: serie ${i}`).toBeGreaterThanOrEqual(3));
  }
  // Los dos temas llevan su paleta: el medio prefers-color-scheme y el atributo data-theme=dark.
  for (const c of SERIES_DARK) expect(CARD_STYLE.split(c).length - 1).toBe(2);
});

const base = { id: 'x', title: 'T', help: 'h', figure: '9', days: ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'], fmt: (n: number) => String(n), tableCaption: 'Tabla T' };
test('T111: sin datos, «No medido» y ningún gráfico', () => {
  const h = card({ ...base, figure: 'No medido', series: [{ label: 'A', values: [null, null, null, null] }] });
  expect(h).toContain('<p class="fig">No medido</p>'); expect(h).toContain('No medido: no hay datos');
  expect(h).not.toContain('<svg'); expect(h).toContain('<td>Sin datos</td>'); expect(h).not.toContain('<td>0</td>');
  expect(card({ ...base, days: [], series: [{ label: 'A', values: [] }] })).not.toContain('<svg');
});
test('T111: un hueco corta el trazo; un valor 0 real sí se dibuja', () => {
  const h = card({ ...base, series: [{ label: 'A', values: [1, null, 2, 3] }] });
  expect((h.match(/<polyline/g) ?? []).length).toBe(1); // 2 y 3 forman un tramo
  expect((h.match(/<circle[^>]*r="3.5"/g) ?? []).length).toBe(1); // el 1 aislado es un punto
  expect(h).not.toContain('2026-11-02 ·');
  const z = card({ ...base, series: [{ label: 'A', values: [0, 0, null, 0] }] });
  expect(z).toContain('<title>2026-11-01 · A: 0</title>'); expect(z).toContain('<svg');
});
test('T111-H5: área apilada suma las series; casillas de serie sin JS; tabla plegada', () => {
  // A=2 y B=1: sin apilar B quedaría por debajo de A; apilada, su borde superior está en 2+1=3, por encima del de A.
  const h = card({ ...base, stacked: true, series: [{ label: 'A', values: [2, 2, 2, 2] }, { label: 'B', values: [1, 1, 1, 1] }] });
  expect(h).toContain('<title>2026-11-01 · B: 1</title>'); // el valor propio en el tooltip, no la suma
  const pts = (g: string) => new RegExp(`<g class="${g}"><polygon points="([^"]*)"`).exec(h)![1]!.split(' ').map(p => Number(p.split(',')[1]));
  const a = pts('a0'), b = pts('a1');
  const topA = Math.min(...a), topB = Math.min(...b);
  expect(topB).toBeLessThan(topA); // 3 > 2
  // La base de B es el borde superior de A (misma y), no el eje.
  expect(Math.max(...b)).toBe(topA); expect(Math.max(...a)).toBeGreaterThan(topA);
  expect(h).toContain('id="c-x-0" class="sc sc0" checked'); expect(h).toContain('for="c-x-1"');
  expect(h).not.toContain('<script'); expect(h).toContain('<details class="data"><summary>Tabla de datos · Tabla T</summary>');
  expect(CARD_STYLE).toContain('.sc1:not(:checked)~.plot .a1');
});
test('T111: título, series y ayuda se escapan', () => {
  const h = card({ ...base, title: '<img src=x onerror=1>', help: '"><script>1</script>', series: [{ label: '<b>', values: [1, 2, 3, 4] }, { label: 'ok', values: [1, 2, 3, 4] }] });
  expect(h).not.toContain('<img'); expect(h).not.toContain('<script'); expect(h).not.toContain('<b>');
  expect(statCard({ id: 'y', title: '<i>', help: 'h', cells: [{ label: '<u>', value: 'No medido' }], tableCaption: 'c', tableHtml: '' })).not.toMatch(/<[iu]>/);
});

let dir: string, store: Store;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fab-cards-')); store = new Store(join(dir, 'fabrica.db')); store.createWorkstream({ slug: 'uno', goal: 'g', repo: '/synthetic', taskLimit: 2000 }); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
test('T111: las tres pestañas conservan el mismo rango y workstream', () => {
  const q = 'range=30&ws=uno';
  for (const tab of ['productividad', 'gasto', 'jueces']) {
    const { body } = metricsPage(store, dir, new URL(`http://x/metricas?tab=${tab}&${q}`));
    for (const t of ['productividad', 'gasto', 'jueces']) expect(body).toContain(`href="/metricas?tab=${t}&amp;ws=uno&amp;range=30"`);
    expect(body).toContain('<option value="30" selected>'); expect(body).toContain('<option value="uno" selected>');
    expect(body).toContain(`aria-current="page">${tab === 'jueces' ? 'Jueces' : tab === 'gasto' ? 'Gasto' : 'Productividad'}`);
  }
  const custom = metricsPage(store, dir, new URL('http://x/metricas?tab=gasto&from=2026-11-01&to=2026-11-03')).body;
  expect(custom).toContain('href="/metricas?tab=jueces&amp;range=custom&amp;from=2026-11-01&amp;to=2026-11-03"');
  expect(custom).toContain('<option value="90">'); // el rango de 90 días existe
});
test('T111: con cero datos las pestañas dicen «No medido» y no dibujan gráfico', () => {
  for (const tab of ['productividad', 'gasto']) {
    const { body } = metricsPage(store, dir, new URL(`http://x/metricas?tab=${tab}&range=7`));
    expect(body).toContain('<p class="fig">No medido</p>'); expect(body).not.toContain('<svg class="plot"'); expect(body).not.toContain('<script');
  }
});
test('T111-H2: la cifra de la tarjeta es la que pasa quien llama, aunque la serie esté vacía', () => {
  expect(card({ ...base, figure: '7', series: [{ label: 'A', values: [null, null, null, null] }] })).toContain('<p class="fig">7</p>');
});
test('T111-H3: el gráfico no crece sin tope (el texto de los ejes no supera al del título)', () => {
  expect(CARD_STYLE).toMatch(/\.card \.plot\{max-width:560px\}/);
});
test('T111-H9: el botón de ayuda y las etiquetas de serie miden al menos 24 px (WCAG 2.2, 2.5.8)', () => {
  expect(CARD_STYLE).toMatch(/\.help summary\{[^}]*min-width:24px;min-height:24px/);
  expect(CARD_STYLE).toMatch(/\.card \.chart label\{min-height:24px/);
});
test('T111-H6: una tarjeta admite como máximo 4 series', () => {
  const s = (l: string) => ({ label: l, values: [1, 2, 3, 4] });
  const h = card({ ...base, series: ['A', 'B', 'C', 'D', 'E'].map(s) });
  expect((h.match(/<input type="checkbox"/g) ?? []).length).toBe(4); expect(h).not.toContain('c-x-4'); expect(h).not.toContain('class="a4"');
});
