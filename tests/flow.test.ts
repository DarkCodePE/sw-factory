import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REVIEWABLE_KINDS, REVIEW_FOLLOW_UP } from '../src/enums.ts';
import { STAGE_ORDER, flowGraph, stageCounts, stageOf, type StageId } from '../src/flow.ts';
import { Store } from '../src/store.ts';

let dir: string, store: Store;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fab-flow-test-')); store = new Store(join(dir, 'fabrica.db')); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
const mk = (slug: string, extra: Record<string, unknown> = {}) => {
  const ws = store.createWorkstream({ slug, goal: 'g', repo: '/synthetic', agent: 'fake', ...extra });
  store.setWorkstreamState(ws.id, 'active');
  return store.getWorkstream(ws.id);
};
const stage = (id: string) => stageOf(store.getChange(id), store.listActivities({ changeId: id }));

test('una entrada nueva en REVIEW_FOLLOW_UP aparece como un nodo y dos aristas sin tocar flow.ts', () => {
  const ws = mk('uno');
  const before = flowGraph(ws);
  REVIEW_FOLLOW_UP.qa_extra = { approve: 'implementation', comment: 'qa_extra' } as never;
  const REVIEWABLE = REVIEWABLE_KINDS as string[];
  REVIEWABLE.push('qa_extra');
  try {
    const after = flowGraph(ws);
    expect(after.nodes.length - before.nodes.length).toBe(1);
    expect(after.edges.length - before.edges.length).toBe(2);
    expect(after.nodes.map(n => n.id)).toContain('qa_extra');
    expect(after.edges).toContainEqual({ from: 'qa_extra', to: 'implementation', label: 'aprobar' });
    expect(after.edges).toContainEqual({ from: 'qa_extra', to: 'qa_extra', label: 'comentar' });
  } finally { delete REVIEW_FOLLOW_UP.qa_extra; REVIEWABLE.pop(); }
});

test('las puertas y los gates salen de los flags del workstream', () => {
  const g = (ws: ReturnType<typeof mk>) => Object.fromEntries(flowGraph(ws).nodes.map(n => [n.id, n]));
  const cerrado = g(mk('cerrado', { verify: ['true'] }));
  expect(cerrado.spec_review!.open).toBe(false); expect(cerrado.gates!.present).toBe(true);
  const abierto = g(mk('abierto', { requireApproval: false, requireChangeApproval: false }));
  expect(abierto.spec_review!.open).toBe(true); expect(abierto.change_review!.open).toBe(true);
  expect(abierto.gates!.present).toBe(false);
  expect(abierto.implementation!.roles).toEqual(['fake']);
  expect(abierto.validators!.roles).toEqual(['code_review', 'security_audit', 'qa']);
});

test('un change en cada etapa da recuento 1 por etapa y la suma cuadra', () => {
  const ws = mk('etapas', { verify: ['true'], requireChangeApproval: true });
  const c = (title: string) => store.createChange(ws.id, title, '');
  const setStatus = (id: string, status: string) => store.db.query('UPDATE changes SET status=? WHERE id=?').run(status, id);
  const act = (id: string, kind: string, status: string, review: string | null = null, validator: string | null = null) =>
    store.db.query('INSERT INTO activities(id,workstream_id,change_id,kind,status,review_status,validator,retry_count,created_at) VALUES (?,?,?,?,?,?,?,0,?)')
      .run(crypto.randomUUID(), ws.id, id, kind, status, review, validator, new Date().toISOString());
  const clear = (id: string) => store.db.query('DELETE FROM activities WHERE change_id=?').run(id);
  const fixtures: Record<string, string> = {};
  for (const s of STAGE_ORDER.filter(s => s !== 'signal')) { const ch = c(s); fixtures[s] = ch.id; clear(ch.id); }
  setStatus(fixtures.change_review!, 'in_review'); act(fixtures.change_review!, 'change_review', 'completed', 'awaiting');
  act(fixtures.investigation!, 'investigation', 'pending');
  setStatus(fixtures.spec_review!, 'in_review'); act(fixtures.spec_review!, 'investigation', 'completed', 'awaiting');
  act(fixtures.implementation!, 'implementation', 'in_progress');
  setStatus(fixtures.gates!, 'implemented'); act(fixtures.gates!, 'gates', 'pending');
  setStatus(fixtures.validators!, 'implemented'); act(fixtures.validators!, 'change_review', 'pending', null, 'qa');
  setStatus(fixtures.merge!, 'implemented');
  setStatus(fixtures.done!, 'completed');
  setStatus(fixtures.stopped!, 'blocked');
  store.addSignal(ws.id, 'nueva', 'cuerpo');
  const counts = stageCounts(store, ws.id);
  for (const s of STAGE_ORDER) expect(counts[s]).toBe(1);
  expect(Object.entries(counts).filter(([s]) => s !== 'signal').reduce((n, [, v]) => n + v, 0)).toBe(store.listChanges(ws.id).length);
  for (const [s, id] of Object.entries(fixtures)) expect(stage(id)).toBe(s as StageId);
});

test('un change sin etapa reconocible se cuenta como detenido', () => {
  const ws = mk('raro', { requireChangeApproval: false });
  const ch = store.createChange(ws.id, 'x', '');
  store.db.query('DELETE FROM activities WHERE change_id=?').run(ch.id);
  expect(stageCounts(store, ws.id).stopped).toBe(1);
});

/** ¿Hay camino a→b que solo atraviese puertas abiertas (sin revisión humana)? */
function connected(g: ReturnType<typeof flowGraph>, a: string, b: string): boolean {
  const open = new Set(g.nodes.filter(n => n.open).map(n => n.id));
  const seen = new Set<string>(); const queue = [a];
  while (queue.length) {
    const from = queue.shift()!;
    for (const e of g.edges.filter(e => e.from === from)) {
      if (e.to === b) return true;
      if (open.has(e.to) && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
    }
  }
  return false;
}

for (const verify of [true, false]) for (const open of [true, false]) {
  test(`coherencia: un change recorre un camino del grafo (verify=${verify}, puertas abiertas=${open})`, () => {
    const ws = mk('ruta', { ...(verify ? { verify: ['true'] } : {}), requireChangeApproval: !open, requireApproval: !open });
    const g = flowGraph(ws);
    const ch = store.createChange(ws.id, 'camino', '');
    const seen: string[] = [];
    for (let i = 0; i < 30; i++) {
      const s = stage(ch.id);
      if (seen.at(-1) !== s) seen.push(s);
      if (s === 'done') break;
      const acts = store.listActivities({ changeId: ch.id });
      const awaiting = acts.find(a => a.reviewStatus === 'awaiting' && !a.validator);
      if (awaiting) { store.resolveReview(awaiting.id, 'approve'); continue; }
      if (s === 'merge') { store.closeChange(ch.id, 'completed'); continue; }
      const a = store.claimActivity(ws.id, 'w');
      expect(a).not.toBeNull();
      const head = { verifiedHead: 'abc' };
      store.completeActivity(a!.id, 'w', a!.kind === 'gates' || a!.validator ? 'VERDICT: pass\n\nok' : 'hecho', a!.kind === 'gates' ? head : undefined);
    }
    expect(seen.at(-1)).toBe('done');
    expect(seen).toContain('implementation');
    expect(seen.includes('validators')).toBe(verify);
    for (let i = 1; i < seen.length; i++) expect(connected(g, seen[i - 1]!, seen[i]!)).toBe(true);
  });
}
