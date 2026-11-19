// `fab runner …`. `check` (T74e) y `serve` (T74d); el resto de la gestión (add, list…) llega con T74a.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { serveSession } from './runners/serve.ts';
import { RunnerError, checkRunner, type RemoteRunner, type Transport } from './runners/client.ts';

const USAGE = 'uso: fab runner check --ssh <alias> | fab runner serve --root <dir>';

/** `transport` solo lo inyectan los tests. Con T74a, `check <nombre>` resolverá el alias desde la tabla `runners`. */
export async function runnerMain(argv: string[], transport?: Transport): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === 'serve') return serve(rest);
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

/** Lado runner: lo arranca `sshd` por el comando forzado de `authorized_keys`. Ignora `SSH_ORIGINAL_COMMAND` y todo argumento que no sea `--root`. */
async function serve(args: string[]): Promise<number> {
  let root: string | undefined;
  try { root = parseArgs({ args, options: { root: { type: 'string' } }, strict: true }).values.root; } catch { root = undefined; }
  if (!root) { console.error(USAGE); return 2; }
  const ac = new AbortController();
  for (const sig of ['SIGHUP', 'SIGTERM'] as const) process.on(sig, () => ac.abort());
  const write = (b: string | Buffer) => new Promise<void>(r => { process.stdout.write(b, () => r()); });
  return serveSession(resolve(root), Bun.stdin.stream(), write, { signal: ac.signal });
}
