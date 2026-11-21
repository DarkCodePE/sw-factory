// fab automation add|list|enable|disable|rm|run-now|tick|run (T68c). Solo crea señales: nunca triaje ni trabajo (I2).
import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { lastDue, parseCron, scheduleExpr } from './cron.ts';
import { automationRevision, StoreError, type Automation, type Store } from './store.ts';

const USAGE = `fab automation add <ws> --name <n> (--cron "<e>" | --every hour|day|week [--at HH:MM] [--weekday N]) --title <t> --body-file <f>
fab automation update <id> [--name <n>] [--cron "<e>" | --every …] [--title <t>] [--body-file <f>]
fab automation list [<ws>] [--json] | enable <id> | disable <id> | rm <id> | run-now <id> | tick | run`;
const MAX_BODY = 8192;
const HOUR = 3_600_000;

export { scheduleExpr } from './cron.ts';

export type AutomationOpts = { intervalMs?: number; signal?: AbortSignal };

const fail = (m: string) => new StoreError('invalid_input', m);

function readBody(file: string): string {
  let size: number;
  try { size = statSync(file).size; } catch { throw fail(`no se puede leer ${file}`); }
  if (size > MAX_BODY) throw fail(`el fichero del cuerpo ocupa ${size} bytes; el máximo es ${MAX_BODY}`);
  return readFileSync(file, 'utf8');
}
function scheduleOrFail(v: Parameters<typeof scheduleExpr>[0]): string {
  try { return scheduleExpr(v); } catch (error) { throw fail((error as Error).message); }
}

/** Próximo instante programado tras `now`, o null si no hay en 366 días. */
function nextDue(expr: string, now: Date): Date | null {
  const cron = parseCron(expr);
  let t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), cron.minute);
  if (t <= now.getTime()) t += HOUR;
  for (let i = 0; i < 366 * 24; i++, t += HOUR) {
    if (lastDue(cron, new Date(t - 1), new Date(t))) return new Date(t);
  }
  return null;
}

function resolve(store: Store, prefix: string | undefined): Automation {
  if (!prefix) throw fail(USAGE);
  const m = store.listAutomations().filter(a => a.id.startsWith(prefix));
  if (m.length !== 1) throw new StoreError('not_found', `automation "${prefix}": ${m.length} coincidencias`);
  return m[0]!;
}

function tick(store: Store): void {
  for (const r of store.fireDueAutomations()) {
    console.log(`${r.id.slice(0, 8)} ${r.result}${r.signalId ? ` señal ${r.signalId.slice(0, 8)}` : ''}`);
  }
}

export async function automationMain(argv: string[], store: Store, opts: AutomationOpts = {}): Promise<number> {
  try {
    const { values: v, positionals: [sub, arg] } = parseArgs({
      args: argv, allowPositionals: true,
      options: {
        name: { type: 'string' }, cron: { type: 'string' }, every: { type: 'string' }, at: { type: 'string' },
        weekday: { type: 'string' }, title: { type: 'string' }, 'body-file': { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
    if (v.help) { console.log(USAGE); return 0; }
    switch (sub) {
      case 'add': {
        if (!arg || !v.name || !v.title) throw fail(USAGE);
        if (!v['body-file']) throw fail('falta --body-file: el cuerpo se lee de un fichero');
        const body = readBody(v['body-file']);
        const a = store.createAutomation({ workstream: arg, name: v.name, cron: scheduleOrFail(v), title: v.title, body });
        console.log(`${a.id.slice(0, 8)} ${a.name} (${a.cron})`);
        return 0;
      }
      case 'update': {
        const a = resolve(store, arg);
        const schedule = v.cron || v.every ? scheduleOrFail(v) : a.cron;
        let body = a.body;
        if (v['body-file']) body = readBody(v['body-file']);
        const u = store.updateAutomation(a.id, automationRevision(a), { name: v.name ?? a.name, cron: schedule, title: v.title ?? a.title, body });
        console.log(`${u.id.slice(0, 8)} ${u.name} (${u.cron})`);
        return 0;
      }
      case 'list': {
        const list = store.listAutomations(arg);
        const slug = new Map(store.listWorkstreams().map(w => [w.id, w.slug]));
        const now = store.clock();
        // Un horario inválido (fila vieja o editada a mano) no tumba el listado.
        const next = (cron: string) => { try { return nextDue(cron, now)?.toISOString() ?? null; } catch { return 'horario inválido'; } };
        const rows = list.map(a => ({ ...a, workstream: slug.get(a.workstreamId) ?? a.workstreamId, nextDue: next(a.cron) }));
        if (v.json) console.log(JSON.stringify(rows, null, 2));
        else for (const a of rows) {
          console.log(`${a.id.slice(0, 8)} ${a.workstream} ${a.name} [${a.cron}] ${a.enabled ? 'activa' : 'pausada'} último=${a.lastResult ?? '-'} próxima=${a.nextDue ?? '-'} (UTC)`);
        }
        return 0;
      }
      case 'enable': case 'disable': {
        const a = store.setAutomationEnabled(resolve(store, arg).id, sub === 'enable');
        console.log(`${a.name} ${a.enabled ? 'activada' : 'pausada'}`);
        return 0;
      }
      case 'rm': {
        const a = resolve(store, arg);
        store.deleteAutomation(a.id);
        console.log(`${a.name} borrada`);
        return 0;
      }
      case 'run-now': {
        const r = store.runAutomationNow(resolve(store, arg).id);
        console.log(`${r.result}${r.signalId ? ` señal ${r.signalId.slice(0, 8)}` : ''}`);
        return 0;
      }
      case 'tick':
        tick(store);
        return 0;
      case 'run': {
        const ac = new AbortController();
        const stop = () => ac.abort();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        const signal = opts.signal ? AbortSignal.any([ac.signal, opts.signal]) : ac.signal;
        try {
          while (!signal.aborted) {
            // Un fallo transitorio (SQLITE_BUSY) no tumba el bucle: se reintenta en la vuelta siguiente.
            try { tick(store); } catch (err) { console.error(`automation: ${(err as Error).message}`); }
            await new Promise<void>(res => {
              const onAbort = () => { clearTimeout(t); res(); };
              const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); res(); }, opts.intervalMs ?? 60_000);
              signal.addEventListener('abort', onAbort, { once: true });
            });
          }
        } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
        return 0;
      }
      default: throw fail(USAGE);
    }
  } catch (err) {
    console.error(err instanceof StoreError ? `error (${err.code}): ${err.message}` : `error: ${(err as Error).message}`);
    return 1;
  }
}
