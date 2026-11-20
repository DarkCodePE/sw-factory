// fab improve create|run|report|delete y la automejora (auto-config|auto|propose|candidates|dismiss). Experimentos de la fase 1: sin cualificación ni rollout.
import { parseArgs } from 'node:util';
import { AGENT_NAMES } from './agents.ts';
import { createCandidate, dismissCandidate, evaluateThreshold, getConfig, listCandidates, setConfig, tick } from './improve-auto.ts';
import { createExperiment, deleteExperiment, experimentRunsJson, reportExperiment, runExperiment, SPLITS, type Split } from './improve.ts';
import { ROLES, type Role } from './profile.ts';
import { StoreError, type Store } from './store.ts';

const TICK_MS = 5 * 60_000;

export async function improveMain(argv: string[], store: Store, stateDir: string): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    'experiment-id': { type: 'string' }, baseline: { type: 'string' }, candidate: { type: 'string' }, suite: { type: 'string' },
    split: { type: 'string' }, repeats: { type: 'string' }, agent: { type: 'string' }, seed: { type: 'string' }, control: { type: 'string' },
    'accept-agent-binaries': { type: 'boolean' }, 'repeated-baseline': { type: 'boolean' }, json: { type: 'boolean' }, confine: { type: 'boolean' }, concurrency: { type: 'string' },
    window: { type: 'string' }, min: { type: 'string' }, threshold: { type: 'string' }, enable: { type: 'boolean' }, disable: { type: 'boolean' }, once: { type: 'boolean' }, role: { type: 'string' },
  } });
  const [sub, id] = positionals;
  const need = (v: string | undefined, name: string) => { if (!v) throw new StoreError('invalid_input', `falta ${name}`); return v; };
  try {
    if (sub === 'create') {
      const expId = need(values['experiment-id'], '--experiment-id');
      createExperiment(store.db, stateDir, { id: expId, baseline: need(values.baseline, '--baseline'), candidate: need(values.candidate, '--candidate'), suitePath: need(values.suite, '--suite'), repeatedBaseline: values['repeated-baseline'], control: values.control });
      console.log(`experimento ${expId} registrado`);
    } else if (sub === 'run') {
      const agent = values.agent ?? 'native';
      if (!AGENT_NAMES.includes(agent)) throw new StoreError('invalid_input', `unknown agent ${agent}`);
      const split = need(values.split, '--split') as Split;
      if (!SPLITS.includes(split)) throw new StoreError('invalid_input', `--split debe ser ${SPLITS.join('|')}`);
      const r = await runExperiment(store.db, stateDir, need(id, '<id>'), { split, repeats: Number(values.repeats ?? 1), agent,
        confine: values.confine, concurrency: Number(values.concurrency ?? 1),
        seed: values.seed ? Number(values.seed) : undefined, acceptBinaries: values['accept-agent-binaries'], log: console.error });
      console.log(`${r.runs} corridas registradas (semilla ${r.seed}); resumen: fab improve report ${id}`);
    } else if (sub === 'report') console.log(values.json ? JSON.stringify(experimentRunsJson(store.db, need(id, '<id>')), null, 2) : reportExperiment(store.db, need(id, '<id>')));
    else if (sub === 'delete') { deleteExperiment(store.db, need(id, '<id>')); console.log(`experimento ${id} borrado; su id no se reutilizará`); }
    else if (sub === 'auto-config') {
      const ws = need(id, '<workstream>'), old = getConfig(store, ws);
      if (values.enable && values.disable) throw new StoreError('invalid_input', '--enable y --disable a la vez');
      setConfig(store, ws, {
        enabled: values.enable ? true : values.disable ? false : old?.enabled ?? false,
        suitePath: values.suite ?? old?.suitePath ?? need(undefined, '--suite'), split: (values.split ?? old?.split ?? need(undefined, '--split')) as Split,
        repeats: Number(values.repeats ?? old?.repeats ?? need(undefined, '--repeats')), window: Number(values.window ?? old?.window ?? 20),
        minScores: Number(values.min ?? old?.minScores ?? 10), threshold: Number(values.threshold ?? old?.threshold ?? 0.4),
      });
      console.log(`automejora de ${ws} ${getConfig(store, ws)!.enabled ? 'activada' : 'desactivada'}`);
    } else if (sub === 'auto') {
      const ws = need(id, '<workstream>');
      if (values.agent && !AGENT_NAMES.includes(values.agent)) throw new StoreError('invalid_input', `unknown agent ${values.agent}`);
      const ctl = new AbortController(); // Ctrl-C: el candidato en curso vuelve a la cola en vez de quedar atascado (H2)
      const stop = () => ctl.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try {
        do {
          try { await tick(store, stateDir, ws, { agent: values.agent, log: console.error, signal: ctl.signal }); } catch (e) { if (values.once) throw e; console.error(`error: ${(e as Error).message}`); }
          if (!values.once && !ctl.signal.aborted) await Promise.race([Bun.sleep(TICK_MS), new Promise((r) => ctl.signal.addEventListener('abort', r, { once: true }))]);
        } while (!values.once && !ctl.signal.aborted);
      } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
      const ready = listCandidates(store.db, ws).filter((c) => c.status === 'ready');
      console.log(`tick hecho; ${ready.length} candidato(s) listo(s) para revisar (fab improve candidates ${ws})`);
    } else if (sub === 'propose') {
      const ws = need(id, '<workstream>'), role = need(values.role, '--role') as Role;
      if (!ROLES.includes(role)) throw new StoreError('invalid_input', `--role debe ser ${ROLES.join('|')}`);
      const wsId = store.getWorkstream(ws).id;
      if (listCandidates(store.db, wsId).some((c) => c.role === role && ['pending', 'proposing', 'proposed', 'experimenting', 'ready'].includes(c.status)))
        throw new StoreError('conflict', `ya hay un candidato abierto para el rol ${role} en ${ws}`);
      const e = evaluateThreshold(store, wsId, role); // sin mirar el umbral: basta con haber fallos
      if (!e.scores.length) throw new StoreError('invalid_input', `no hay puntuaciones fallidas del rol ${role} con el perfil vigente`);
      const cid = createCandidate(store, wsId, role, 'manual', e.scores, e.total);
      console.log(`candidato ${cid.slice(0, 8)} creado (${e.scores.length}/${e.total} puntuaciones); avanza con: fab improve auto ${ws} --once`);
    } else if (sub === 'candidates') {
      const list = listCandidates(store.db, id).map((c) => ({ ...c, experiment: c.experimentId ? summary(store, c.experimentId) : null }));
      if (values.json) console.log(JSON.stringify(list, null, 2));
      else if (!list.length) console.log('sin candidatos');
      else for (const c of list) console.log([c.id.slice(0, 8), c.workstreamId.slice(0, 8), c.role, c.status, c.origin, `${c.baseDigest.slice(0, 8)}→${c.candidateDigest?.slice(0, 8) ?? '—'}`, c.experimentId ?? '—', c.error ?? ''].join('  ').trimEnd());
    } else if (sub === 'dismiss') {
      const ref = need(id, '<id>'), hits = listCandidates(store.db).filter((c) => c.id.startsWith(ref));
      if (hits.length !== 1) throw new StoreError(hits.length ? 'invalid_input' : 'not_found', hits.length ? `el prefijo ${ref} es ambiguo` : `candidato ${ref} no existe`);
      dismissCandidate(store, hits[0]!.id);
      console.log(`candidato ${hits[0]!.id.slice(0, 8)} descartado`);
    } else throw new StoreError('invalid_input', 'fab improve create|run|report|delete|auto-config|auto|propose|candidates|dismiss');
    return 0;
  } catch (err) {
    console.error(err instanceof StoreError ? `error (${err.code}): ${err.message}` : `error: ${(err as Error).message}`);
    return 1;
  }
}

/** Resumen del experimento del candidato (`experimentRunsJson`); null si el experimento ya no existe. */
function summary(store: Store, experimentId: string) {
  try { return experimentRunsJson(store.db, experimentId); } catch (e) { if (e instanceof StoreError && e.code === 'not_found') return null; throw e; }
}
