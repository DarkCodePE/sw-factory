// Agregados de lectura sobre una cohorte explícita. null siempre significa desconocido.
import type { Store } from './store.ts';
import { activityCosts, activityMetadata, changeCost } from './evidence.ts';
export const METRICS_LIMIT = 1000;
export type MetricsRange = '7' | '30' | 'all';
export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { median: n ? (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2 : null,
    p90: n ? sorted[Math.ceil(n * .9) - 1]! : null, samples: n };
}
interface CostGroup { name: string; measured: number | null; unknown: number; total: number | null }
function addCost(groups: Map<string, CostGroup>, name: string, value: number | null) {
  const g = groups.get(name) ?? { name, measured: null, unknown: 0, total: null };
  if (value === null) g.unknown++; else g.measured = (g.measured ?? 0) + value;
  g.total = g.unknown ? null : g.measured; groups.set(name, g);
}
const counts = (values: string[]): [string, number][] => [...values.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map<string, number>())].sort(([a], [b]) => a.localeCompare(b));
const textField = (v: unknown) => typeof v === 'string' && v.trim() ? v : 'No medido';
export function calculateMetrics(store: Store, stateDir: string, options: { ws?: string; range?: MetricsRange; now?: number } = {}) {
  const now = options.now ?? Date.now(), range = options.range ?? 'all';
  const since = range === 'all' ? null : new Date(now - Number(range) * 86400000).toISOString();
  const until = new Date(now).toISOString();
  const cohort = store.metricsCohort(options.ws, since, until, METRICS_LIMIT);
  const events = new Map(store.metricsEvents(cohort.changes.map(c => c.id), until).map(e => [e.changeId, e]));
  const values: number[][] = [[], [], [], []];
  const kinds: string[] = [], adapters = new Map<string, CostGroup>(), models = new Map<string, CostGroup>();
  const humans: Array<{ id: string; title: string; reviews: number; answers: number; retries: number; total: number }> = [];
  const costs: Array<{ id: string; title: string; cost: number | null }> = [];
  for (const c of cohort.changes) {
    const acts = store.listActivities({ changeId: c.id }), e = events.get(c.id);
    const first = (dates: Array<string | null | undefined>) => {
      const valid = dates.map(d => d ? Date.parse(d) : NaN).filter(d => Number.isFinite(d) && d >= Date.parse(c.createdAt) && d <= now);
      return valid.length ? Math.min(...valid) : null;
    };
    // change_review se crea ya solicitando revisión, incluso después de resolverse.
    const milestones = [first(acts.map(a => a.createdAt)), first([...acts.filter(a => a.kind === 'change_review').map(a => a.createdAt), e?.reviewAt]), first([e?.decisionAt]), first([e?.terminalAt])];
    milestones.forEach((t, i) => { if (t !== null) values[i]!.push(t - Date.parse(c.createdAt)); });
    const reviews = e?.reviews ?? 0, answers = e?.answers ?? 0, retries = e?.retries ?? 0;
    humans.push({ id: c.id, title: c.title, reviews, answers, retries, total: reviews + answers + retries });
    let cost: number | null = null;
    try { cost = changeCost(store, stateDir, c.id); } catch { /* Ruta insegura/ilegible: desconocido. */ }
    costs.push({ id: c.id, title: c.title, cost });
    for (const a of acts) {
      if (Date.parse(a.createdAt) > now) continue;
      kinds.push(a.kind);
      let meta: Record<string, unknown> | null = null;
      try { meta = activityMetadata(stateDir, a); } catch { /* Fallo cerrado del lector compartido. */ }
      const attempts = activityCosts(a, meta);
      const sum = attempts && !attempts.some(c => c === null) ? (attempts as number[]).reduce((s, c) => s + c, 0) : null;
      // El agente configurado ahora en el workstream no prueba qué adaptador ejecutó el intento.
      const isolation = meta?.isolation;
      const adapter = isolation && typeof isolation === 'object' ? (isolation as Record<string, unknown>).adapter : undefined;
      const singleAttempt = a.retryCount === 0 && (attempts?.length ?? 0) <= 1;
      addCost(adapters, singleAttempt ? textField(adapter) : 'No medido', sum);
      // La metadata solo conserva el último modelo: con reintentos no se atribuye el total a él.
      addCost(models, singleAttempt ? textField(meta?.model) : 'No medido', sum);
    }
  }
  const measuredCosts = costs.filter((c): c is typeof c & { cost: number } => c.cost !== null);
  const unknownChanges = costs.length - measuredCosts.length;
  const measured = measuredCosts.length ? measuredCosts.reduce((s, c) => s + c.cost, 0) : null;
  return { count: cohort.changes.length, omitted: cohort.total - cohort.changes.length, since, until,
    cycles: ['Primera activity', 'Primera revisión pedida', 'Primera decisión humana', 'Primer estado terminal registrado'].map((name, i) => ({ name, ...distribution(values[i]!) })),
    humans, states: counts(cohort.changes.map(c => c.status)), kinds: counts(kinds),
    cost: { total: unknownChanges ? null : measured, measured, unknownChanges,
      top: measuredCosts.sort((a, b) => b.cost - a.cost || a.id.localeCompare(b.id)).slice(0, 10),
      adapters: [...adapters.values()], models: [...models.values()] } };
}
