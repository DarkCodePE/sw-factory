// fab score run|add|list|backfill. Los jueces son un aviso: este comando solo encola y ejecuta, nunca toca el estado del change.
import { parseArgs } from 'node:util';
import { AGENT_NAMES } from './agents.ts';
import { enqueueBackfill, enqueueManual, enqueueSampled, ensureSchema, previewBackfill, runPending } from './scorers.ts';
import { StoreError, type Store } from './store.ts';

const USAGE = 'fab score run <ws> [--once] [--max N] [--budget-usd X] [--agent <n>] | add <activity> --scorer <n> | list <ws> [--change <id>] [--json] | backfill <ws> [--since <iso>] [--scorer <n>] [--yes]';
const PASS_MS = 30_000;

/** Cada Ctrl-C aborta (`on`, no `once`): un segundo no mata el proceso antes del `finally` de `judge`, que borra el directorio desechable (H1). Devuelve cómo soltar el manejador. */
export function abortOnSigint(ac: AbortController): () => void {
  const h = () => ac.abort();
  process.on('SIGINT', h);
  return () => { process.off('SIGINT', h); };
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((res) => {
  const t = setTimeout(res, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});

export async function scoreMain(argv: string[], store: Store, stateDir: string, signal: AbortSignal = new AbortController().signal): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    once: { type: 'boolean' }, max: { type: 'string' }, 'budget-usd': { type: 'string' }, agent: { type: 'string' }, scorer: { type: 'string' },
    change: { type: 'string' }, json: { type: 'boolean' }, since: { type: 'string' }, yes: { type: 'boolean' },
  } });
  const [sub, target] = positionals;
  const need = (v: string | undefined, name: string) => { if (!v) throw new StoreError('invalid_input', `falta ${name}`); return v; };
  const num = (v: string | undefined, name: string) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new StoreError('invalid_input', `${name} debe ser un número positivo`);
    return n;
  };
  try {
    if (sub === 'run') {
      const ws = store.getWorkstream(need(target, '<ws>'));
      if (values.agent && !AGENT_NAMES.includes(values.agent)) throw new StoreError('invalid_input', `unknown agent ${values.agent}`);
      const opts = { max: num(values.max, '--max'), budgetUsd: num(values['budget-usd'], '--budget-usd'), agentOverride: values.agent, signal, log: console.error };
      do {
        const queued = enqueueSampled(store, stateDir, ws.id);
        const r = await runPending(store, stateDir, opts);
        console.log(`encoladas ${queued}; ejecutadas ${r.ran} (hechas ${r.done}, fallidas ${r.failed})`);
        if (values.once || signal.aborted) break;
        await sleep(PASS_MS, signal);
      } while (!signal.aborted);
    } else if (sub === 'add') {
      const id = enqueueManual(store, stateDir, need(target, '<activity>'), need(values.scorer, '--scorer'), 'manual');
      console.log(`puntuación ${id} encolada; se ejecuta con fab score run <ws>`);
    } else if (sub === 'list') {
      const ws = store.getWorkstream(need(target, '<ws>'));
      ensureSchema(store.db);
      const rows = store.db.query(`SELECT * FROM scores WHERE workstream_id = ? ${values.change ? 'AND change_id = ?' : ''} ORDER BY created_at, id`)
        .all(...(values.change ? [ws.id, values.change] : [ws.id])) as Record<string, unknown>[];
      if (values.json) console.log(JSON.stringify(rows, null, 2));
      // La explicación deriva de texto no confiable: solo sale con --json (A6).
      else for (const r of rows) console.log(`${r.change_id} ${r.scorer} r${r.round} ${r.status} ${r.label === null ? 'sin puntuar' : `${r.label} (${r.score})`}`);
    } else if (sub === 'backfill') {
      const ws = store.getWorkstream(need(target, '<ws>'));
      const o = { since: values.since, scorer: values.scorer };
      const p = previewBackfill(store, stateDir, ws.id, o);
      const cost = (n: number | null) => (n === null ? 'No medido' : `$${n.toFixed(4)}`);
      console.log(`vista previa: ${p.runs} ejecuciones sin puntuar, coste estimado ${cost(p.estimatedUsd)}`);
      for (const b of p.byScorer) console.log(`  ${b.scorer}: ${b.runs} × ${cost(b.avgCostUsd)}`);
      if (!values.yes) console.log('no se ha encolado nada; repite con --yes para encolar');
      else if (p.runs) console.log(`${enqueueBackfill(store, stateDir, ws.id, o)} encoladas; se ejecutan con fab score run ${ws.slug}`);
    } else throw new StoreError('invalid_input', USAGE);
    return 0;
  } catch (err) {
    console.error(err instanceof StoreError ? `error (${err.code}): ${err.message}` : `error: ${(err as Error).message}`);
    return 1;
  }
}
