// fab improve create|run|report|delete. Experimentos de la fase 1: sin cualificación ni rollout.
import { parseArgs } from 'node:util';
import { AGENT_NAMES } from './agents.ts';
import { createExperiment, deleteExperiment, reportExperiment, runExperiment, SPLITS, type Split } from './improve.ts';
import { StoreError, type Store } from './store.ts';

export async function improveMain(argv: string[], store: Store, stateDir: string): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    'experiment-id': { type: 'string' }, baseline: { type: 'string' }, candidate: { type: 'string' }, suite: { type: 'string' },
    split: { type: 'string' }, repeats: { type: 'string' }, agent: { type: 'string' }, seed: { type: 'string' },
    'accept-agent-binaries': { type: 'boolean' },
  } });
  const [sub, id] = positionals;
  const need = (v: string | undefined, name: string) => { if (!v) throw new StoreError('invalid_input', `falta ${name}`); return v; };
  try {
    if (sub === 'create') {
      const expId = need(values['experiment-id'], '--experiment-id');
      createExperiment(store.db, stateDir, { id: expId, baseline: need(values.baseline, '--baseline'), candidate: need(values.candidate, '--candidate'), suitePath: need(values.suite, '--suite') });
      console.log(`experimento ${expId} registrado`);
    } else if (sub === 'run') {
      const agent = values.agent ?? 'native';
      if (!AGENT_NAMES.includes(agent)) throw new StoreError('invalid_input', `unknown agent ${agent}`);
      const split = need(values.split, '--split') as Split;
      if (!SPLITS.includes(split)) throw new StoreError('invalid_input', `--split debe ser ${SPLITS.join('|')}`);
      const r = await runExperiment(store.db, stateDir, need(id, '<id>'), { split, repeats: Number(values.repeats ?? 1), agent,
        seed: values.seed ? Number(values.seed) : undefined, acceptBinaries: values['accept-agent-binaries'], log: console.error });
      console.log(`${r.runs} corridas registradas (semilla ${r.seed}); resumen: fab improve report ${id}`);
    } else if (sub === 'report') console.log(reportExperiment(store.db, need(id, '<id>')));
    else if (sub === 'delete') { deleteExperiment(store.db, need(id, '<id>')); console.log(`experimento ${id} borrado; su id no se reutilizará`); }
    else throw new StoreError('invalid_input', 'fab improve create|run|report|delete');
    return 0;
  } catch (err) {
    console.error(err instanceof StoreError ? `error (${err.code}): ${err.message}` : `error: ${(err as Error).message}`);
    return 1;
  }
}
