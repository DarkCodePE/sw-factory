// fab bench create|run|cancel|report|add-task. Superficie CLI de T66; las reglas viven en bench.ts y bench-task.ts.
import type { Database } from 'bun:sqlite';
import { parseArgs } from 'node:util';
import { benchmarkSummary, cancelBenchmark, createBenchmark, runBenchmark, type Variant } from './bench.ts';
import { writeSuiteWithTask } from './bench-task.ts';
import { SPLITS, type Split } from './improve.ts';
import { StoreError, type Store } from './store.ts';

export { benchmarkSummary } from './bench.ts';

const bad = (m: string) => new StoreError('invalid_input', m);
const FORMAT = '--variant debe ser <nombre>=<digest>@<agente>';

export function parseVariant(raw: string): Variant {
  const eq = raw.indexOf('='), at = raw.lastIndexOf('@');
  if (eq < 1 || at < eq + 2 || at === raw.length - 1) throw bad(`${FORMAT} (recibido: ${raw})`);
  return { name: raw.slice(0, eq), profile: raw.slice(eq + 1, at), agent: raw.slice(at + 1) };
}

/** El error puede traer salida de un agente: una línea, sin caracteres de control. */
const oneLine = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim().slice(0, 300);

export function reportBenchmarkText(db: Database, id: string): string {
  const s = benchmarkSummary(db, id);
  const lines = [`benchmark ${id}  estado ${s.status}  suite ${s.suite_digest.slice(0, 12)}${s.error ? `  error: ${oneLine(s.error)}` : ''}`];
  if (!s.variants.length) return lines.concat('sin corridas todavía').join('\n');
  const head = ['variante', 'agente', 'n', 'éxito', 'diff medio', 'duración media s', 'coste medio USD'];
  const table = [head, ...s.variants.map(v => [v.variant, v.agent, String(v.n), v.success_rate.toFixed(3), v.mean_diff_lines.toFixed(1), (v.mean_duration_ms / 1000).toFixed(1),
    v.mean_cost_usd === null ? '—' : v.mean_cost_usd.toFixed(4) + (v.cost_known < v.n ? ` (${v.cost_known}/${v.n})` : '')])];
  const w = head.map((_, c) => Math.max(...table.map(r => r[c]!.length)));
  lines.push(...table.map(r => r.map((x, c) => x.padEnd(w[c]!)).join('  ').trimEnd()));
  if (s.judge_profile) {
    lines.push('', `jueces (perfil ${s.judge_profile.slice(0, 12)}, avisos: no cambian el resultado)`);
    for (const v of s.variants) for (const j of v.judges)
      lines.push(`  ${v.variant}  ${j.scorer}  aprobado ${j.pass_rate === null ? '—' : `${(j.pass_rate * 100).toFixed(0)}% (${j.passed}/${j.scored})`}  puntuación media ${j.mean_score === null ? '—' : j.mean_score.toFixed(2)}${j.unscored ? `  sin puntuar ${j.unscored}` : ''}`);
  }
  // R6: `agente` es el del workstream de la variante.
  return lines.concat('', 'agente: adaptador del workstream; el de cada rol (perfil v2) está en activities.agent del Store del brazo.').join('\n');
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
