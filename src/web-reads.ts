/**
 * Lecturas de §4.2 que no son listados de la API original (T119c): señales, estado, eventos, automations, puntuaciones, validadores,
 * benchmarks y experimentos. Solo leen (nunca crean esquema) y redactan el texto libre; las comparten `/api/v1` y la CLI remota (`ops/read`).
 */
import { StoreError, type Store } from './store.ts';
import { redact } from './evidence.ts';
import { benchmarkSummary } from './bench.ts';
import { reportExperiment } from './improve.ts';
import { listCandidates } from './improve-auto.ts';

const rd = (s: string | null | undefined): string | null => (s == null ? null : redact(s));
const hasTable = (store: Store, name: string) => store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
const need = (url: URL, key: string) => { const v = url.searchParams.get(key); if (!v || !/^[\w.-]{1,100}$/.test(v)) throw new StoreError('invalid_input', `falta ?${key}= o no es válido`); return v; };
const idOf = (s: string) => { if (!/^[\w-]+$/.test(s)) throw new StoreError('invalid_input', 'identificador inválido'); return s; };

/** Devuelve `undefined` si la ruta no es de este módulo. */
export function extraRoute(store: Store, url: URL, path: string): unknown {
  if (path === '/signals') return store.listSignals(need(url, 'ws')).map(s => ({ id: s.id, status: s.status, title: rd(s.title), changeId: s.changeId, createdAt: s.createdAt }));
  if (path === '/status') {
    const ws = store.getWorkstream(need(url, 'ws'));
    return { slug: ws.slug, state: ws.state, agent: ws.agent, goal: rd(ws.goal), changes: store.listChanges(ws.id).map(c => {
      const last = store.listActivities({ changeId: c.id }).at(-1);
      return { id: c.id, status: c.status, title: rd(c.title), last: last ? { kind: last.kind, status: last.status, reviewStatus: last.reviewStatus } : null };
    }) };
  }
  if (path === '/events') {
    const raw = url.searchParams.get('limit') ?? '50';
    if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 200) throw new StoreError('invalid_input', 'limit debe ser un entero entre 1 y 200');
    const change = url.searchParams.get('change') || undefined;
    return store.listEvents(need(url, 'ws'), Number(raw), change && idOf(change)).map(e => ({ at: e.created_at, severity: e.severity, actor: e.actor ?? null, message: rd(String(e.message)) }));
  }
  if (path === '/automations') return store.listAutomations(need(url, 'ws')).map(a => ({ id: a.id, name: a.name, cron: a.cron, enabled: a.enabled, title: rd(a.title) }));
  if (path === '/scores') {
    const ws = store.getWorkstream(need(url, 'ws')), change = url.searchParams.get('change');
    if (!hasTable(store, 'scores')) return [];
    // La explicación deriva de texto no confiable: no sale.
    return store.db.query(`SELECT id, change_id AS changeId, scorer, round, status, label, score FROM scores WHERE workstream_id = ? ${change ? 'AND change_id = ?' : ''} ORDER BY created_at, id`)
      .all(...(change ? [ws.id, idOf(change)] : [ws.id]));
  }
  let m = /^\/validate\/([^/]+)$/.exec(path);
  if (m) {
    const s = store.validationSummary(idOf(m[1]!));
    return JSON.parse(redact(JSON.stringify(s)));
  }
  m = /^\/bench\/([^/]+)$/.exec(path);
  if (m) return JSON.parse(redact(JSON.stringify(benchmarkSummary(store.db, idOf(m[1]!)))));
  if (path === '/improve') return listCandidates(store.db, need(url, 'ws')).map(c => ({ id: c.id, role: c.role, status: c.status, origin: c.origin, createdAt: c.createdAt, finishedAt: c.finishedAt }));
  m = /^\/improve\/([^/]+)$/.exec(path);
  if (m) {
    if (!hasTable(store, 'experiments')) throw new StoreError('not_found', 'experimento no encontrado');
    return { report: redact(reportExperiment(store.db, idOf(m[1]!))) };
  }
  return undefined;
}
