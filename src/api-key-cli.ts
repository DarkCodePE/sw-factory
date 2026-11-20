// fab api-key create|list|revoke. La clave solo se imprime al crearla (K1, K5): nunca va en argv ni en logs.
import { parseArgs } from 'node:util';
import { Store, StoreError } from './store.ts';

export function apiKeyMain(argv: string[], store: Store): number {
  try {
    const { values, positionals } = parseArgs({
      args: argv, allowPositionals: true, options: { name: { type: 'string' }, scope: { type: 'string' } },
    });
    const [sub, arg] = positionals;
    if (sub === 'create') {
      if (!values.name || !values.scope) throw new StoreError('invalid_input', 'usage: fab api-key create --name <n> --scope read|decide');
      const { id, key } = store.createApiKey(values.name, values.scope as 'read' | 'decide');
      console.log(`clave ${id} (${values.name}, ${values.scope}) creada. Cópiala ahora: no se podrá volver a ver.\n${key}`);
    } else if (sub === 'list') {
      for (const k of store.listApiKeys()) {
        console.log(`${k.id}  ${k.name}  ${k.scope}  creada ${k.createdAt} por ${k.createdBy}  ${k.revokedAt ? `revocada ${k.revokedAt}` : 'activa'}`);
      }
    } else if (sub === 'revoke') {
      if (!arg) throw new StoreError('invalid_input', 'usage: fab api-key revoke <id|nombre>');
      store.revokeApiKey(arg);
      console.log(`clave ${arg} revocada`);
    } else throw new StoreError('invalid_input', 'fab api-key create|list|revoke');
    return 0;
  } catch (err) {
    console.error(err instanceof StoreError ? `error (${err.code}): ${err.message}` : `error: ${(err as Error).message}`);
    return 1;
  }
}
