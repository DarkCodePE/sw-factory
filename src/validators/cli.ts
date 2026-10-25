import { parseArgs } from 'node:util';

import { VALIDATOR_KINDS, type ChangeLinkLookup, type PullRequestGateway, type ValidatorKind } from '../connectors/types.ts';
import { type Change, type Store, StoreError } from '../store.ts';
import { publishValidation, validationMarkdown } from './publish.ts';

const HELP = `fab validate — validadores automáticos sobre changes y PRs

Uso:
  fab validate <changeId> [--only code_review,security_audit,qa]   Encola actividades de validación
  fab validate status <changeId>                                    Muestra el resumen de validación
  fab validate publish <changeId> [--dry-run]                       Publica el resumen en el PR enlazado

Opciones:
  --only <lista>   Lista separada por comas de validadores a ejecutar
  --dry-run        Imprime el comentario sin publicarlo en GitHub
  -h, --help       Muestra esta ayuda`;

function resolveChange(store: Store, idOrPrefix: string): Change {
  try {
    return store.getChange(idOrPrefix);
  } catch {
    const all = store.listWorkstreams().flatMap((w) => store.listChanges(w.id));
    const matches = all.filter((c) => c.id.startsWith(idOrPrefix));
    if (matches.length === 1) return matches[0]!;
    throw new StoreError('not_found', `change "${idOrPrefix}": ${matches.length} coincidencias`);
  }
}

export async function validateMain(
  argv: string[],
  deps: { store: Store; stateDir: string; lookup?: ChangeLinkLookup; prs?: PullRequestGateway }
): Promise<number> {
  const effectiveArgv = argv[0] === 'validate' ? argv.slice(1) : argv;

  const { values, positionals } = parseArgs({
    args: effectiveArgv,
    allowPositionals: true,
    options: {
      only: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return 0;
  }

  const [subOrId, arg2] = positionals;

  try {
    if (subOrId === 'status') {
      if (!arg2) {
        console.error('Uso: fab validate status <changeId>');
        return 1;
      }
      const change = resolveChange(deps.store, arg2);
      const summary = deps.store.validationSummary(change.id);
      console.log(validationMarkdown(summary));
      return 0;
    }

    if (subOrId === 'publish') {
      if (!arg2) {
        console.error('Uso: fab validate publish <changeId> [--dry-run]');
        return 1;
      }
      const change = resolveChange(deps.store, arg2);
      const summary = deps.store.validationSummary(change.id);

      if (values['dry-run']) {
        const links = deps.lookup?.(change.id);
        if (!links || !links.pr) {
          console.log(`Sin PR enlazado para change ${change.id.slice(0, 8)} (dry-run)`);
        } else {
          console.log(`[dry-run] Comentario para PR #${links.pr.number} (${links.pr.url}):\n\n${validationMarkdown(summary)}`);
        }
        return 0;
      }

      if (!deps.lookup || !deps.prs) {
        console.error('Sin conector de PR configurado');
        return 1;
      }

      const res = await publishValidation(summary, { lookup: deps.lookup, prs: deps.prs });
      if (res === 'no_pr') {
        console.log(`Sin PR enlazado para change ${change.id.slice(0, 8)}`);
      } else {
        console.log(`Validación publicada en el PR`);
      }
      return 0;
    }

    // Default: queue validators for change
    const change = resolveChange(deps.store, subOrId!);
    let validators: ValidatorKind[] = [...VALIDATOR_KINDS];

    if (values.only) {
      const requested = (values.only as string).split(',').map((s) => s.trim()) as ValidatorKind[];
      for (const req of requested) {
        if (!VALIDATOR_KINDS.includes(req)) {
          console.error(`Validador desconocido "${req}" (disponibles: ${VALIDATOR_KINDS.join(', ')})`);
          return 1;
        }
      }
      validators = requested;
    }

    const created = deps.store.requestValidation(change.id, validators);
    console.log(`Encolados ${created.length} validadores para change ${change.id.slice(0, 8)}: ${validators.join(', ')}`);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    return 1;
  }
}
