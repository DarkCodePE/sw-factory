// `fab runner …`. Aquí solo `check` (T74e); el resto de la gestión (add, list, serve…) llega con T74a y T74d.
import { parseArgs } from 'node:util';
import { RunnerError, checkRunner, type RemoteRunner, type Transport } from './runners/client.ts';

const USAGE = 'uso: fab runner check --ssh <alias>';

/** `transport` solo lo inyectan los tests. Con T74a, `check <nombre>` resolverá el alias desde la tabla `runners`. */
export async function runnerMain(argv: string[], transport?: Transport): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== 'check') { console.error(USAGE); return 2; }
  const { values } = parseArgs({ args: rest, options: { ssh: { type: 'string' } }, strict: true });
  if (!values.ssh) { console.error(USAGE); return 2; }
  const runner: RemoteRunner = { name: values.ssh, target: values.ssh };
  try {
    const c = await checkRunner(runner, transport);
    console.log(`protocolo: ${c.protocol}\nfabSha: ${c.fabSha}\nsandbox: ${c.sandbox}\nadaptadores: ${Object.entries(c.agents).map(([n, a]) => `${n}=${a.sha256.slice(0, 12)}`).join(' ') || '-'}\n(declarado por el runner, no verificado)`);
    return 0;
  } catch (e) {
    if (!(e instanceof RunnerError)) throw e;
    console.error(e.message);
    return 1;
  }
}
