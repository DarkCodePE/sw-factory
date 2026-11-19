// Visor de solo lectura del flujo: SVG de servidor + tabla equivalente. No contiene reglas: dibuja src/flow.ts.
import type { Store } from './store.ts';
import { flowGraph, stageCounts, type FlowNode } from './flow.ts';

type Esc = (v: unknown) => string;
const enc = encodeURIComponent;
const W = 220, H = 76, BOX = 140, TOP = 90; // paso entre columnas, alto de fila, ancho y margen superior del dibujo
/** Estado de change más cercano a cada etapa, para el enlace del nodo. */
const FILTER: Record<string, string> = { change_review: 'in_review', spec_review: 'in_review', investigation: 'pending', implementation: 'pending', gates: 'implemented', validators: 'implemented', merge: 'implemented', done: 'completed', stopped: 'blocked' };
const KIND_LABEL: Record<FlowNode['kind'], string> = { entrada: 'Entrada', agente: 'Agente', puerta_humana: 'Puerta humana', 'automático': 'Automático', final: 'Final' };

const gate = (n: FlowNode) => n.kind !== 'puerta_humana' ? '—' : n.open === undefined ? 'Humana (fab merge)' : n.open ? 'Abierta: sin revisión humana' : 'Cerrada: requiere revisión';

function svg(nodes: FlowNode[], edges: { from: string; to: string; label: string }[], counts: Record<string, number>, slug: string, esc: Esc): string {
  const main = nodes.filter(n => n.id !== 'stopped');
  const pos = new Map<string, { x: number; y: number }>(main.map((n, i) => [n.id, { x: i * W + BOX / 2 + 10, y: TOP }]));
  const stopAt = pos.get('merge') ?? { x: BOX / 2 + 10, y: TOP };
  if (nodes.some(n => n.id === 'stopped')) pos.set('stopped', { x: stopAt.x, y: TOP + H * 1.5 });
  const col = (id: string) => Math.round(((pos.get(id)?.x ?? 0) - BOX / 2 - 10) / W);
  const paths = edges.filter(e => pos.has(e.from) && pos.has(e.to)).map(e => {
    const a = pos.get(e.from)!, b = pos.get(e.to)!, span = Math.abs(col(e.to) - col(e.from));
    if (e.from === e.to) return `<path class="fl-edge" marker-end="url(#fl-arrow)" d="M${a.x - 20} ${a.y - 32} C${a.x - 20} ${a.y - 76} ${a.x + 20} ${a.y - 76} ${a.x + 20} ${a.y - 32}"/><text class="fl-label" x="${a.x}" y="${a.y - 66}" text-anchor="middle">${esc(e.label)}</text>`;
    const lift = b.y === a.y && span > 1 ? (e.label === 'rechazar' ? 1 : -1) * 28 * span : 0;
    const back = b.x < a.x && span === 1 ? 14 : 0; // la vuelta (comentar) baja un poco para no solaparse con la ida
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 + lift / 2 + back * 2.2;
    const dx = Math.sign(b.x - a.x) * BOX / 2, onRow = b.y === a.y;
    return `<path class="fl-edge${e.label === 'falla' || e.label === 'rechazar' ? ' fl-bad' : ''}" marker-end="url(#fl-arrow)" d="M${a.x + (onRow ? dx : 0)} ${a.y + back + (onRow ? 0 : 30)} Q${mx} ${a.y + back + lift} ${b.x - (onRow ? dx : 0)} ${b.y + back - (onRow ? 0 : 30)}"/><text class="fl-label" x="${mx}" y="${my - 6}" text-anchor="middle">${esc(e.label)}</text>`;
  }).join('');
  const boxes = nodes.map(n => {
    const p = pos.get(n.id)!;
    const f = n.id === 'signal' ? '' : FILTER[n.id];
    const href = `/changes?ws=${enc(slug)}${f ? `&amp;status=${f}` : ''}`;
    const count = n.id === 'signal' ? `${counts[n.id] ?? 0} nuevas` : `${counts[n.id] ?? 0} changes`;
    return `<a href="${href}"><g class="fl-node ${n.open ? 'fl-open' : ''}"><rect x="${p.x - BOX / 2}" y="${p.y - 30}" width="${BOX}" height="60" rx="6"/><text x="${p.x}" y="${p.y - 10}" text-anchor="middle" class="fl-name">${esc(n.label)}</text><text x="${p.x}" y="${p.y + 8}" text-anchor="middle">${esc(count)}</text>${n.open ? `<text x="${p.x}" y="${p.y + 24}" text-anchor="middle" class="fl-warn">Sin revisión humana</text>` : ''}</g></a>`;
  }).join('');
  const width = main.length * W + 10, height = TOP + H * 2;
  return `<div class="flow-wrap" tabindex="0"><svg class="flow" role="img" aria-labelledby="flujo-titulo" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><title id="flujo-titulo">Flujo de ${esc(slug)}: ${esc(nodes.map(n => n.label).join(' → '))}. La tabla siguiente tiene el mismo contenido.</title><defs><marker id="fl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="fl-head" d="M0 0 L10 5 L0 10 z"/></marker></defs>${paths}${boxes}</svg></div>`;
}

export function flowPage(store: Store, url: URL, esc: Esc): { title: string; body: string } {
  const all = store.listWorkstreams();
  const wanted = url.searchParams.get('ws');
  const ws = wanted ? store.getWorkstream(wanted) : all.length === 1 ? all[0] : undefined;
  const intro = '<p class="intro">Etapas, puertas humanas y recuentos de la fábrica. Se genera desde el código: el flujo se cambia allí, no en la web.</p>';
  if (!ws) return { title: 'Flujo', body: `${intro}${all.length ? `<p>Elige un workstream:</p><ul class="workstreams">${all.map(w => `<li><a href="/flujo?ws=${enc(w.slug)}">${esc(w.slug)}</a></li>`).join('')}</ul>` : '<p class="empty">No hay workstreams.</p>'}` };
  const g = flowGraph(ws);
  const nodes = g.nodes.filter(n => n.present);
  const counts = stageCounts(store, ws.id);
  const edges = g.edges.filter(e => nodes.some(n => n.id === e.from) && nodes.some(n => n.id === e.to));
  const rows = nodes.map(n => `<tr><th scope="row">${esc(n.label)}</th><td>${esc(KIND_LABEL[n.kind])}</td><td>${esc(gate(n))}</td><td>${esc(n.roles?.join(', ') ?? '—')}</td><td>${counts[n.id as keyof typeof counts] ?? 0}</td></tr>`).join('');
  const links = edges.map(e => `<li>${esc(nodes.find(n => n.id === e.from)!.label)} → ${esc(nodes.find(n => n.id === e.to)!.label)}: ${esc(e.label)}</li>`).join('');
  return { title: `Flujo · ${ws.slug}`, body: `${intro}${svg(nodes, edges, counts, ws.slug, esc)}<div class="table-wrap" tabindex="0"><table><caption>Etapas del flujo</caption><thead><tr><th scope="col">Etapa</th><th scope="col">Tipo</th><th scope="col">Puerta</th><th scope="col">Adaptador o roles</th><th scope="col">Changes</th></tr></thead><tbody>${rows}</tbody></table></div><h2>Transiciones</h2><ul>${links}</ul><p class="muted">Un change con varias activities abiertas se cuenta en una sola etapa. Las señales nuevas aún no son changes. Un change que no encaja en ninguna etapa se cuenta como detenido.</p>` };
}

export const FLOW_STYLE = `
.flow-wrap{overflow:auto;margin:24px 0}.flow{display:block;color:var(--text)}.fl-node rect{fill:var(--panel);stroke:var(--accent);stroke-width:1.5}.fl-node.fl-open rect{stroke:var(--warn);stroke-dasharray:6 4}.fl-node text{fill:var(--text);font-size:13px}.fl-node .fl-name{font-weight:700}.fl-node .fl-warn{fill:var(--warn);font-weight:700;font-size:12px}.fl-edge{fill:none;stroke:var(--muted);stroke-width:1.5}.fl-edge.fl-bad{stroke:var(--bad);stroke-dasharray:3 3}.fl-head{fill:var(--muted)}.fl-label{fill:var(--muted);font-size:11px}a:focus-visible .fl-node rect{stroke:var(--focus);stroke-width:3}`;
