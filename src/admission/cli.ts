// fab resident report [--json]   informe de solo lectura (sin lock) de lo que ha registrado el residente
// fab resident --repo owner/name [--mode off|observe] [--once] [--since ISO] ...  (fase 1: `auto` se rechaza)

// --since solo fija el inicio cuando aún no hay cursor; sin él se lee el último día.
import { parseArgs } from 'node:util';
import { validateRepo, type CommandRunner } from '../connectors/github.ts';
import type { Store } from '../store.ts';
import { DEFAULT_POLICY } from './gate.ts';
import { AdmissionDb } from './db.ts';
import { buildReport, formatReport } from './report.ts';
import { Resident } from './resident.ts';

export async function residentMain(argv: string[], store: Store, deps: { run?: CommandRunner } = {}): Promise<number> {
  try {
    if (argv[0] === 'report') {
      const { values } = parseArgs({ args: argv.slice(1), options: { json: { type: 'boolean' } } });
      const report = buildReport(new AdmissionDb(store));
      console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
      return 0;
    }
    const { values } = parseArgs({ args: argv, options: {
      repo: { type: 'string' }, mode: { type: 'string', default: 'observe' }, once: { type: 'boolean' }, interval: { type: 'string', default: '60' }, since: { type: 'string' },
      label: { type: 'string', default: DEFAULT_POLICY.triggerLabel }, self: { type: 'string' }, comments: { type: 'boolean' }, 'allow-author': { type: 'string', multiple: true }, trust: { type: 'string' } } });
    if (values.mode === 'auto') throw new Error('El modo auto no existe en la fase 1: usa off|observe');
    if (values.mode !== 'off' && values.mode !== 'observe') throw new Error('--mode debe ser off|observe');
    if (!values.repo) throw new Error('falta --repo owner/name');
    validateRepo(values.repo);
    const interval = Number(values.interval);
    if (!Number.isFinite(interval) || interval < 1) throw new Error('--interval debe ser un número de segundos >= 1');
    if (values.since !== undefined && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(values.since)) throw new Error('--since debe ser ISO UTC, p. ej. 2026-01-01T00:00:00Z');
    const resident = new Resident(store, { repo: values.repo, mode: values.mode, run: deps.run, selfLogin: values.self, comments: values.comments, intervalMs: interval * 1000, since: values.since, policy: {
      repos: [values.repo], triggerLabel: values.label!, allowAuthors: values['allow-author'] ?? [],
      trustedAssociations: values.trust ? values.trust.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_POLICY.trustedAssociations } });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => resident.stop());
    await resident.run({ once: values.once, log: line => console.log(line) });
    return 0;
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return 1;
  }
}
