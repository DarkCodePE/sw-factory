// Agregados de lectura sobre una cohorte explícita. null siempre significa desconocido.
import type { Store } from './store.ts';
import { activityCosts, activityMetadata, changeCost } from './evidence.ts';
export const METRICS_LIMIT = 1000;
export type MetricsRange = '7' | '30' | 'all' | 'custom';
export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { median: n ? (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2 : null,
    p90: n ? sorted[Math.ceil(n * .9) - 1]! : null, samples: n };
}
export interface CostGroup { name: string; measured: number | null; unknown: number; total: number | null }
function addCost(groups: Map<string, CostGroup>, name: string, value: number | null) {
  const g = groups.get(name) ?? { name, measured: null, unknown: 0, total: null };
  if (value === null) g.unknown++; else g.measured = (g.measured ?? 0) + value;
  g.total = g.unknown ? null : g.measured; groups.set(name, g);
}
const counts = (values: string[]): [string, number][] => [...values.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map<string, number>())].sort(([a], [b]) => a.localeCompare(b));
const textField = (v: unknown) => typeof v === 'string' && v.trim() ? v : 'No medido';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SOURCES_LABELS: Record<string, string> = { cli: 'CLI', channel: 'Canal', jira: 'Jira' };

function validateDay(d: string): void {
  if (!DAY.test(d) || isNaN(Date.parse(`${d}T00:00:00.000Z`))) throw new URIError('Rango inválido');
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, day!));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== m || dt.getUTCDate() !== day) throw new URIError('Rango inválido');
}

export function calculateMetrics(store: Store, stateDir: string, options: { ws?: string; range?: MetricsRange | string; from?: string; to?: string; now?: number } = {}) {
  const now = options.now ?? Date.now();
  let range = options.range;
  const from = options.from?.trim() || undefined;
  const to = options.to?.trim() || undefined;

  if (from !== undefined) validateDay(from);
  if (to !== undefined) validateDay(to);
  if (from !== undefined && to !== undefined) {
    if (from > to) throw new URIError('Rango inválido');
    const fromMs = Date.parse(`${from}T00:00:00.000Z`);
    const toMs = Date.parse(`${to}T00:00:00.000Z`);
    const diffDays = Math.round((toMs - fromMs) / 86400000) + 1;
    if (diffDays > 366) throw new URIError('Rango demasiado amplio');
  } else if (from !== undefined) {
    const fromMs = Date.parse(`${from}T00:00:00.000Z`);
    const diffDays = Math.round((now - fromMs) / 86400000) + 1;
    if (diffDays > 366) throw new URIError('Rango demasiado amplio');
  }
  if (range !== undefined && !['7', '30', 'all', 'custom'].includes(range)) throw new URIError('Rango inválido');

  let since: string | null = null;
  let until: string;

  if (from !== undefined || to !== undefined) {
    range = 'custom';
    since = from ? new Date(`${from}T00:00:00.000Z`).toISOString() : null;
    until = to ? new Date(`${to}T23:59:59.999Z`).toISOString() : new Date(now).toISOString();
  } else {
    if (range === 'custom') throw new URIError('Rango inválido');
    range ??= 'all';
    since = range === 'all' ? null : new Date(now - Number(range) * 86400000).toISOString();
    until = new Date(now).toISOString();
  }

  const cohort = store.metricsCohort(options.ws, since, until, METRICS_LIMIT);
  const events = new Map(store.metricsEvents(cohort.changes.map(c => c.id), until).map(e => [e.changeId, e]));
  const values: number[][] = [[], [], [], []];
  const kickoffPr: number[] = [], prMerge: number[] = [];
  const kinds: string[] = [], adapters = new Map<string, CostGroup>(), models = new Map<string, CostGroup>();
  const sources = new Map<string, CostGroup>(), actors = new Map<string, CostGroup>();
  const humans: Array<{ id: string; title: string; reviews: number; answers: number; retries: number; total: number }> = [];
  const costs: Array<{ id: string; title: string; cost: number | null }> = [];
  for (const c of cohort.changes) {
    const acts = store.listActivities({ changeId: c.id }), e = events.get(c.id);
    const first = (dates: Array<string | null | undefined>) => {
      const valid = dates.map(d => d ? Date.parse(d) : NaN).filter(d => Number.isFinite(d) && d >= Date.parse(c.createdAt) && d <= now);
      return valid.length ? Math.min(...valid) : null;
    };
    // change_review se crea ya solicitando revisión, incluso después de resolverse.
    const milestones = [first(acts.map(a => a.createdAt)), first([...acts.filter(a => a.kind === 'change_review' && !a.validator).map(a => a.createdAt), e?.reviewAt]), first([e?.decisionAt]), first([e?.terminalAt])];
    milestones.forEach((t, i) => { if (t !== null) values[i]!.push(t - Date.parse(c.createdAt)); });

    // Tramos con PR
    const prAt = e?.prOpenedAt ? Date.parse(e.prOpenedAt) : NaN;
    const mergeAt = e?.mergedAt ? Date.parse(e.mergedAt) : NaN;
    const createdMs = Date.parse(c.createdAt);
    if (Number.isFinite(prAt) && prAt >= createdMs && prAt <= now) kickoffPr.push(prAt - createdMs);
    if (Number.isFinite(prAt) && Number.isFinite(mergeAt) && mergeAt >= prAt && mergeAt <= now) prMerge.push(mergeAt - prAt);

    const reviews = e?.reviews ?? 0, answers = e?.answers ?? 0, retries = e?.retries ?? 0;
    humans.push({ id: c.id, title: c.title, reviews, answers, retries, total: reviews + answers + retries });
    let cost: number | null = null;
    try { cost = changeCost(store, stateDir, c.id); } catch { /* Ruta insegura/ilegible: desconocido. */ }
    costs.push({ id: c.id, title: c.title, cost });

    const sourceLabel = c.source ? (SOURCES_LABELS[c.source] ?? c.source) : 'No medido';
    const actorLabel = textField(c.creator);
    addCost(sources, sourceLabel, cost);
    addCost(actors, actorLabel, cost);

    for (const a of acts) {
      if (Date.parse(a.createdAt) > now) continue;
      kinds.push(a.validator ? `validador:${a.validator}` : a.kind);
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

  // Series temporales por día
  const days: string[] = [];
  if (from !== undefined && to !== undefined) {
    let cur = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    while (cur <= end) {
      days.push(cur.toISOString().slice(0, 10));
      cur = new Date(cur.getTime() + 86400000);
    }
  } else if (range === '7' || range === '30') {
    const numDays = Number(range);
    const endDay = until.slice(0, 10);
    const endMs = Date.parse(`${endDay}T00:00:00.000Z`);
    for (let i = numDays - 1; i >= 0; i--) {
      days.push(new Date(endMs - i * 86400000).toISOString().slice(0, 10));
    }
  } else if (cohort.changes.length) {
    const dates = cohort.changes.map(c => c.createdAt.slice(0, 10)).sort();
    const startDay = dates[0]!;
    const endDay = until.slice(0, 10);
    let cur = new Date(`${startDay}T00:00:00.000Z`);
    const end = new Date(`${endDay}T00:00:00.000Z`);
    const diffDays = Math.round((end.getTime() - cur.getTime()) / 86400000);
    if (diffDays > 90) cur = new Date(end.getTime() - 89 * 86400000);
    while (cur <= end) {
      days.push(cur.toISOString().slice(0, 10));
      cur = new Date(cur.getTime() + 86400000);
    }
  }

  const dailyInterventionsMap = store.metricsDailyInterventions(cohort.changes.map(c => c.id), until);
  const dailyPrsMap = store.metricsDailyPrs(cohort.changes.map(c => c.id), until);
  const dailyChanges: Array<number | null> = [];
  const dailyCosts: Array<number | null> = [];
  const dailyInterventions: Array<number | null> = [];
  const dailyPrs: Array<{ opened: number | null; merged: number | null }> = [];

  for (const day of days) {
    const dayChanges = cohort.changes.filter(c => c.createdAt.slice(0, 10) === day);
    if (!dayChanges.length) {
      dailyChanges.push(null);
      dailyCosts.push(null);
    } else {
      dailyChanges.push(dayChanges.length);
      const dayCosts = dayChanges.map(c => costs.find(x => x.id === c.id)?.cost);
      if (dayCosts.some(c => c === null || c === undefined)) {
        dailyCosts.push(null);
      } else {
        dailyCosts.push((dayCosts as number[]).reduce((s, c) => s + c, 0));
      }
    }
    const intCount = dailyInterventionsMap.get(day);
    dailyInterventions.push(intCount !== undefined && intCount > 0 ? intCount : null);
    const op = dailyPrsMap.opened.get(day);
    const mg = dailyPrsMap.merged.get(day);
    dailyPrs.push({
      opened: op !== undefined && op > 0 ? op : null,
      merged: mg !== undefined && mg > 0 ? mg : null,
    });
  }

  const prCycles = [
    { name: 'Kickoff → PR', ...distribution(kickoffPr) },
    { name: 'PR → primera revisión humana', ...distribution([]) },
    { name: 'PR → merge', ...distribution(prMerge) },
  ];

  return { count: cohort.changes.length, omitted: cohort.total - cohort.changes.length, since, until,
    cycles: ['Primera activity', 'Primera revisión pedida', 'Primera decisión humana', 'Primer estado terminal registrado'].map((name, i) => ({ name, ...distribution(values[i]!) })),
    prCycles,
    humans, states: counts(cohort.changes.map(c => c.status)), kinds: counts(kinds),
    daily: { days, changes: dailyChanges, costs: dailyCosts, interventions: dailyInterventions, prs: dailyPrs },
    cost: { total: unknownChanges ? null : measured, measured, unknownChanges,
      top: measuredCosts.sort((a, b) => b.cost - a.cost || a.id.localeCompare(b.id)).slice(0, 10),
      adapters: [...adapters.values()], models: [...models.values()],
      sources: [...sources.values()], actors: [...actors.values()] } };
}
