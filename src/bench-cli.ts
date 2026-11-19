// fab bench create|run|cancel|report|add-task. Superficie CLI de T66; las reglas viven en bench.ts y bench-task.ts.
import type { Database } from 'bun:sqlite';
import { parseArgs } from 'node:util';
import { cancelBenchmark, createBenchmark, runBenchmark, type Variant } from './bench.ts';
import { writeSuiteWithTask } from './bench-task.ts';
import { SPLITS, type Split } from './improve.ts';
import { StoreError, type Store } from './store.ts';

const bad = (m: string) => new StoreError('invalid_input', m);
const FORMAT = '--variant debe ser <nombre>=<digest>@<agente>';

export function parseVariant(raw: string): Variant {
  const eq = raw.indexOf('='), at = raw.lastIndexOf('@');
  if (eq < 1 || at < eq + 2 || at === raw.length - 1) throw bad(`${FORMAT} (recibido: ${raw})`);
  return { name: raw.slice(0, eq), profile: raw.slice(eq + 1, at), agent: raw.slice(at + 1) };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Una sola fuente para la tabla y el JSON: los dos salen de aquí, así no pueden discrepar. */
export function benchmarkSummary(db: Database, id: string) {
  let b: { suite_digest: string; judge_profile: string | null; status: string; error: string | null } | null;
  try { b = db.query('SELECT suite_digest, judge_profile, status, error FROM benchmarks WHERE id = ?').get(id) as typeof b; } catch { b = null; }
  if (!b) throw new StoreError('not_found', `benchmark ${id} no existe`);
  const rows = db.query('SELECT * FROM experiment_runs WHERE experiment_id = ? ORDER BY rowid').all(id) as Record<string, any>[];
  const variants = [...new Set(rows.map(r => r.arm as string))].map(arm => {
    const r = rows.filter(x => x.arm === arm);
    const cost = r.map(x => x.cost_usd as number | null).filter((c): c is number => c !== null);
    return {
      variant: arm, agent: r[0]!.agent as string, profile: r[0]!.profile_digest as string, n: r.length,
      success_rate: mean(r.map(x => x.success as number)), mean_diff_lines: mean(r.map(x => x.diff_lines as number)),
      mean_duration_ms: mean(r.map(x => x.duration_ms as number)),
      // Coste desconocido es null («—»), nunca 0; `cost_known` dice cuántas filas lo informaron.
      mean_cost_usd: cost.length ? mean(cost) : null, cost_known: cost.length,
    };
  });
  return { benchmark: id, status: b.status, error: b.error, suite_digest: b.suite_digest, judge_profile: b.judge_profile, variants };
}

export function reportBenchmarkText(db: Database, id: string): string {
  const s = benchmarkSummary(db, id);
  const lines = [`benchmark ${id}  estado ${s.status}  suite ${s.suite_digest.slice(0, 12)}${s.error ? `  error: ${s.error}` : ''}`];
  if (!s.variants.length) return lines.concat('sin corridas todavía').join('\n');
  const head = ['variante', 'agente', 'n', 'éxito', 'diff medio', 'duración media s', 'coste medio USD'];
  const table = [head, ...s.variants.map(v => [v.variant, v.agent, String(v.n), v.success_rate.toFixed(3), v.mean_diff_lines.toFixed(1), (v.mean_duration_ms / 1000).toFixed(1),
    v.mean_cost_usd === null ? '—' : v.mean_cost_usd.toFixed(4) + (v.cost_known < v.n ? ` (${v.cost_known}/${v.n})` : '')])];
  const w = head.map((_, c) => Math.max(...table.map(r => r[c]!.length)));
  return lines.concat(table.map(r => r.map((x, c) => x.padEnd(w[c]!)).join('  ').trimEnd())).join('\n');
}

export async function benchMain(argv: string[], store: Store, stateDir: string): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      id: { type: 'string' }, suite: { type: 'string' }, variant: { type: 'string', multiple: true }, 'judge-profile': { type: 'string' },
      split: { type: 'string' }, repeats: { type: 'string' }, seed: { type: 'string' }, confine: { type: 'boolean' }, concurrency: { type: 'string' },
      'accept-agent-binaries': { type: 'boolean' }, json: { type: 'boolean' }, out: { type: 'string' }, verify: { type: 'string' },
    } });
    const [sub, arg] = positionals;
    const need = (v: string | undefined, name: string) => { if (!v) throw bad(`falta ${name}`); return v; };
    const split = () => { const s = need(values.split, '--split'); if (!SPLITS.includes(s as Split)) throw bad(`--split debe ser ${SPLITS.join('|')}`); return s as Split; };
    if (sub === 'create') {
      const id = need(values.id, '--id');
      createBenchmark(store.db, stateDir, { id, suitePath: need(values.suite, '--suite'), variants: (values.variant ?? []).map(parseVariant), judgeProfile: values['judge-profile'] });
      console.log(`benchmark ${id} registrado`);
    } else if (sub === 'run') {
      const id = need(arg, '<id>');
      const r = await runBenchmark(store.db, stateDir, id, { split: split(), repeats: Number(values.repeats ?? 1), confine: values.confine, concurrency: Number(values.concurrency ?? 1),
        seed: values.seed ? Number(values.seed) : undefined, acceptBinaries: values['accept-agent-binaries'], log: console.error });
      console.log(`${r.runs} corridas registradas (semilla ${r.seed}); resumen: fab bench report ${id}`);
    } else if (sub === 'cancel') { cancelBenchmark(store.db, need(arg, '<id>')); console.log(`benchmark ${arg} cancelado`); }
    else if (sub === 'report') console.log(values.json ? JSON.stringify(benchmarkSummary(store.db, need(arg, '<id>')), null, 2) : reportBenchmarkText(store.db, need(arg, '<id>')));
    else if (sub === 'add-task') {
      const out = need(values.out, '--out');
      writeSuiteWithTask(store, need(arg, '<change>'), { id: need(values.id, '--id'), split: split(), verify: values.verify, out, suitePath: values.suite });
      console.log(`tarea candidata escrita en ${out}; revísala antes de usarla`);
    } else throw bad('fab bench create|run|cancel|report|add-task');
    return 0;
  } catch (err) {
    console.error(err instanceof StoreError ? `error (${err.code}): ${err.message}` : `error: ${(err as Error).message}`);
    return 1;
  }
}
