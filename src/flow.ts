// Flujo de la fábrica derivado del código: puro, sin HTML. La vista (web-flow.ts) solo lo dibuja.
import { REVIEWABLE_KINDS, REVIEW_FOLLOW_UP } from './enums.ts';
import type { Activity, Change, Store, Workstream } from './store.ts';
import { VALIDATOR_KINDS } from './validators/index.ts';

export type StageId = 'signal' | 'change_review' | 'investigation' | 'spec_review' | 'implementation' | 'gates' | 'validators' | 'merge' | 'done' | 'stopped';
export type NodeKind = 'entrada' | 'agente' | 'puerta_humana' | 'automático' | 'final';
export interface FlowNode { id: string; label: string; kind: NodeKind; present: boolean; open?: boolean; roles?: string[] }
export type EdgeLabel = 'aprobar' | 'comentar' | 'rechazar' | 'triar' | 'termina' | 'pasa' | 'falla' | 'fusionar';
export interface FlowEdge { from: string; to: string; label: EdgeLabel }

/** Orden de columnas, de izquierda a derecha. Un kind nuevo de REVIEW_FOLLOW_UP se coloca antes de `merge`. */
export const STAGE_ORDER: readonly StageId[] = ['signal', 'change_review', 'investigation', 'spec_review', 'implementation', 'gates', 'validators', 'merge', 'done', 'stopped'];
const LABELS: Record<StageId, string> = { signal: 'Señal', change_review: 'Revisión del change', investigation: 'Investigación', spec_review: 'Revisión de la spec', implementation: 'Implementación', gates: 'Gates', validators: 'Validadores', merge: 'Merge', done: 'Hecho', stopped: 'Detenido' };
const KINDS: Record<StageId, NodeKind> = { signal: 'entrada', change_review: 'puerta_humana', investigation: 'agente', spec_review: 'puerta_humana', implementation: 'agente', gates: 'automático', validators: 'automático', merge: 'puerta_humana', done: 'final', stopped: 'final' };
/** Etapa-puerta que revisa la salida de cada kind revisable; sin entrada, el propio kind es la puerta. */
const GATE_OF: Record<string, StageId> = { investigation: 'spec_review' };
const TERMINAL = ['completed', 'canceled', 'declined'];
const ACTIVE = ['pending', 'in_progress'];

export function stageOrder(ids: Iterable<string>): string[] {
  const rank = (id: string) => { const i = STAGE_ORDER.indexOf(id as StageId); return i >= 0 ? i : STAGE_ORDER.indexOf('merge') - 0.5; };
  return [...ids].sort((a, b) => rank(a) - rank(b));
}

export function flowGraph(ws: Workstream): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes = new Map<string, FlowNode>();
  const node = (id: string): FlowNode => {
    let n = nodes.get(id);
    if (!n) { const known = id in LABELS; n = { id, label: known ? LABELS[id as StageId] : id, kind: known ? KINDS[id as StageId] : 'agente', present: true }; nodes.set(id, n); }
    return n;
  };
  const edges: FlowEdge[] = [];
  const edge = (from: string, to: string, label: EdgeLabel) => { node(from); node(to); edges.push({ from, to, label }); };

  // Revisión: se recorre el dominio, de modo que una entrada nueva aparece sin tocar la vista.
  for (const kind of REVIEWABLE_KINDS) {
    const next = REVIEW_FOLLOW_UP[kind];
    if (!next) continue;
    const gate = GATE_OF[kind] ?? kind;
    if (gate !== kind) edge(kind, gate, 'termina');
    edge(gate, next.approve, 'aprobar');
    edge(gate, next.comment === 'change_review' ? gate : next.comment, 'comentar');
  }
  edge('signal', ws.requireChangeApproval ? 'change_review' : 'investigation', 'triar');
  node('change_review').open = !ws.requireChangeApproval;
  node('spec_review').open = !ws.requireApproval;

  // Cola fija: duplica lo que hace Store.completeActivity; tests/flow.test.ts comprueba que no se desvíe.
  const verify = (ws.verify?.length ?? 0) > 0;
  node('gates').present = verify;
  node('validators').roles = [...VALIDATOR_KINDS];
  for (const id of ['investigation', 'implementation']) node(id).roles = [ws.agent];
  // Sin `verify` no hay gates y los validadores solo se piden a mano (`fab validate`): se pasa directo a merge.
  if (verify) { edge('implementation', 'gates', 'termina'); edge('gates', 'validators', 'pasa'); edge('gates', 'stopped', 'falla'); edge('validators', 'merge', 'pasa'); edge('validators', 'stopped', 'falla'); }
  else edge('implementation', 'merge', 'termina');
  edge('merge', 'done', 'fusionar');
  for (const gate of ['change_review', 'spec_review']) edge(gate, 'done', 'rechazar');
  edge('implementation', 'stopped', 'falla');

  return { nodes: stageOrder(nodes.keys()).map(id => nodes.get(id)!), edges };
}

export function stageOf(change: Change, activities: Activity[]): StageId {
  const live = (kind: (a: Activity) => boolean, status = ACTIVE) => activities.some(a => kind(a) && status.includes(a.status));
  if (['blocked', 'quarantined', 'failed'].includes(change.status)) return 'stopped';
  if (TERMINAL.includes(change.status)) return 'done';
  if (live(a => a.validator !== null)) return 'validators';
  if (live(a => a.kind === 'gates')) return 'gates';
  if (change.status === 'implemented') return 'merge';
  const open = [...ACTIVE, 'waiting_reply'];
  if (live(a => a.kind === 'implementation', open)) return 'implementation';
  if (activities.some(a => a.kind === 'investigation' && a.reviewStatus === 'awaiting')) return 'spec_review';
  if (live(a => a.kind === 'investigation', open)) return 'investigation';
  if (change.status === 'in_review') return 'change_review';
  return 'stopped';
}

export function stageCounts(store: Store, wsId: string): Record<StageId, number> {
  const counts = Object.fromEntries(STAGE_ORDER.map(s => [s, 0])) as Record<StageId, number>;
  const byChange = new Map<string, Activity[]>();
  for (const a of store.listActivities({ workstream: wsId })) byChange.set(a.changeId, [...(byChange.get(a.changeId) ?? []), a]);
  for (const c of store.listChanges(wsId)) counts[stageOf(c, byChange.get(c.id) ?? [])]++;
  counts.signal = store.listSignals(wsId, 'new').length;
  return counts;
}
