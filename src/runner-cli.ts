// fab runner add|list|enable|disable|rm. Gestiona los runners (T74a); no abre ninguna conexión.
import { parseArgs } from 'node:util';
import { StoreError, type Runner, type Store } from './store.ts';

export const CODE_LEAVES_WARNING = 'con un runner remoto el código de este workstream sale de tu máquina hacia';

const row = (r: Runner) => `${r.name.padEnd(20)} ${r.kind.padEnd(5)} ${(r.target ?? '-').padEnd(24)} ${r.enabled ? 'activo' : 'pausado'}  ${JSON.stringify(r.options)}`;

export function runnerMain(argv: string[], store: Store): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { ssh: { type: 'string' }, local: { type: 'boolean' }, confine: { type: 'boolean' }, 'max-bundle-mb': { type: 'string' }, json: { type: 'boolean' } },
  });
  const [sub, name] = positionals;
  const need = () => { if (!name) throw new StoreError('invalid_input', 'falta el nombre del runner'); return name; };
  if (sub === 'add') {
    if (!!values.ssh === !!values.local) throw new StoreError('invalid_input', 'fab runner add <nombre> --ssh <alias> [--max-bundle-mb N] | --local [--confine]');
    if (values.ssh !== undefined && values.confine) throw new StoreError('invalid_input', '--confine solo existe con --local');
    if (values.local && values['max-bundle-mb'] !== undefined) throw new StoreError('invalid_input', '--max-bundle-mb solo existe con --ssh');
    const options: Record<string, unknown> = values.local ? { confine: !!values.confine } : {};
    if (values['max-bundle-mb'] !== undefined) options.maxBundleMb = Number(values['max-bundle-mb']);
    const r = store.createRunner({ name: need(), kind: values.local ? 'local' : 'ssh', target: values.ssh, options });
    console.log(`runner ${r.name} creado (${r.kind}${r.target ? ` ${r.target}` : ''})`);
    if (r.kind === 'ssh') console.log(`aviso: ${CODE_LEAVES_WARNING} ${r.target} cuando se lo asignes.`);
  } else if (sub === 'list') {
    const all = store.listRunners();
    if (values.json) console.log(JSON.stringify(all, null, 2));
    else for (const r of all) console.log(row(r));
  } else if (sub === 'enable' || sub === 'disable') {
    const r = store.setRunnerEnabled(need(), sub === 'enable');
    console.log(`runner ${r.name} ${r.enabled ? 'activado' : 'pausado'}`);
  } else if (sub === 'rm') {
    store.deleteRunner(need());
    console.log(`runner ${name} borrado`);
  } else throw new StoreError('invalid_input', 'fab runner add|list|enable|disable|rm');
  return 0;
}
