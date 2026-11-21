// fab resident report [--json]   informe de solo lectura (sin lock) de lo que ha registrado el residente
// fab resident --repo owner/name [--mode off|observe|auto] [--workstream slug] [--once] [--since ISO] [--hook-port N] ...  (auto: --workstream y --self obligatorios)
// --hook-port abre el receptor de avisos de GitHub en 127.0.0.1; el secreto va solo en FAB_GITHUB_WEBHOOK_SECRET (nunca en argv).

// --since solo fija el inicio cuando aún no hay cursor; sin él se lee el último día.
import { parseArgs } from 'node:util';
import { validateRepo, type CommandRunner } from '../connectors/github.ts';
import type { Store } from '../store.ts';
import { DEFAULT_POLICY } from './gate.ts';
import { AdmissionDb } from './db.ts';
import { buildReport, formatReport } from './report.ts';
import { Resident } from './resident.ts';
import { loadResidentConfig, saveResidentConfig } from './config.ts';

export async function residentMain(argv: string[], store: Store, deps: { run?: CommandRunner } = {}): Promise<number> {
  try {
    if (argv[0] === 'report') {
      const { values } = parseArgs({ args: argv.slice(1), options: { json: { type: 'boolean' } } });
      if (!store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name GLOB 'adm_*' LIMIT 1").get()) {
        console.log(values.json ? '{}' : '(el residente nunca se ha ejecutado en esta base)');
        return 0;
      }
      const report = buildReport(new AdmissionDb(store));
      console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
      return 0;
    }
    if (argv[0] === 'config') {
      const { values } = parseArgs({ args: argv.slice(1), options: { repo: { type: 'string' }, label: { type: 'string' }, interval: { type: 'string' }, mode: { type: 'string' } } });
      if (!store.stateDir) throw new Error('fab resident config necesita una base en disco');
      const set = values.repo !== undefined || values.label !== undefined || values.interval !== undefined || values.mode !== undefined;
      const cfg = set ? saveResidentConfig(store.stateDir, { repo: values.repo, label: values.label, mode: values.mode as 'off' | 'observe' | undefined,
        intervalSec: values.interval === undefined ? undefined : /^\d+$/.test(values.interval) ? Number(values.interval) : NaN }, process.env.FAB_ACTOR ?? 'cli') : loadResidentConfig(store.stateDir);
      console.log(JSON.stringify(cfg, null, 2));
      return 0;
    }
    const saved = store.stateDir ? loadResidentConfig(store.stateDir) : {}; // los flags mandan sobre resident.json (T107)
    const { values } = parseArgs({ args: argv, options: {
      repo: { type: 'string' }, mode: { type: 'string' }, once: { type: 'boolean' }, interval: { type: 'string' }, since: { type: 'string' },
      label: { type: 'string' }, self: { type: 'string' }, workstream: { type: 'string' }, comments: { type: 'boolean' }, 'hook-port': { type: 'string' }, 'allow-author': { type: 'string', multiple: true }, trust: { type: 'string' } } });
    values.repo ??= saved.repo; values.mode ??= saved.mode ?? 'observe'; values.label ??= saved.label ?? DEFAULT_POLICY.triggerLabel;
    values.interval ??= String(saved.intervalSec ?? 60);
    if (values.mode !== 'off' && values.mode !== 'observe' && values.mode !== 'auto') throw new Error('--mode debe ser off|observe|auto');
    if (values.mode === 'auto') { if (!values.workstream) throw new Error('el modo auto exige --workstream <slug>'); store.getWorkstream(values.workstream); } // existe el workstream donde se crearán los changes
    if (!values.repo) throw new Error('falta --repo owner/name');
    validateRepo(values.repo);
    const interval = Number(values.interval);
    if (!Number.isFinite(interval) || interval < 1) throw new Error('--interval debe ser un número de segundos >= 1');
    if (values.since !== undefined && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(values.since)) throw new Error('--since debe ser ISO UTC, p. ej. 2026-01-01T00:00:00Z');
    const hookPort = values['hook-port'] === undefined ? undefined : Number(values['hook-port']);
    if (values['hook-port'] !== undefined && !(/^\d{1,5}$/.test(values['hook-port']) && hookPort! <= 65535)) throw new Error('--hook-port debe ser un puerto entre 0 y 65535');
    const resident = new Resident(store, { repo: values.repo, mode: values.mode, run: deps.run, selfLogin: values.self, workstream: values.workstream, comments: values.comments, intervalMs: interval * 1000, hookPort, hookSecret: process.env.FAB_GITHUB_WEBHOOK_SECRET, since: values.since, policy: {
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
