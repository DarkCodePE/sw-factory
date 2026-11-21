// fab profile export|import|inspect|list. Los perfiles viven en <stateDir>/profiles/<digest>.json.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { printable } from './printable.ts';
import { StoreError } from './store.ts';
import { TAR_MAX_BYTES } from './definition-tar.ts';
import { assertRoleMcpRegistered, canonicalJson, defaultProfile, DEFAULT_DIGEST, listProfiles, loadProfile, profileDigest, saveProfile, validateProfile } from './profile.ts';

export function profileMain(argv: string[], stateDir: string): number {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: 'string' } } });
  const [sub, arg] = positionals;
  const fail = (m: string) => new StoreError('invalid_input', m);
  try {
    if (sub === 'export') {
      const json = JSON.stringify(defaultProfile(), null, 2) + '\n';
      if (values.out) writeFileSync(values.out, json); else process.stdout.write(json);
      if (values.out) console.log(`perfil por defecto exportado a ${values.out} (digest ${DEFAULT_DIGEST})`);
    } else if (sub === 'import') {
      if (!arg) throw fail('usage: fab profile import <archivo>');
      let size: number;
      try { const st = statSync(arg); if (!st.isFile()) throw 0; size = st.size; } catch { throw fail(`no se puede leer ${arg}: no es un fichero regular`); } // IE1-H4: /dev/zero o un FIFO no terminan
      if (size > TAR_MAX_BYTES) throw fail(`el perfil ocupa ${size} bytes; el máximo es ${TAR_MAX_BYTES}`);
      const profile = validateProfile(JSON.parse(readFileSync(arg, 'utf8')));
      assertRoleMcpRegistered(stateDir, profile);
      const { digest, created } = saveProfile(stateDir, profile);
      console.log(`${digest}${created ? '' : ' (ya existía)'}`);
    } else if (sub === 'inspect') {
      if (!arg) throw fail('usage: fab profile inspect <digest>');
      const p = arg === DEFAULT_DIGEST ? defaultProfile() : loadProfile(stateDir, arg);
      console.log(`digest ${profileDigest(p)}\nharness ${p.harness}${p.model ? ` model ${p.model}` : ''}${p.repo ? ` repo ${p.repo}` : ''}\n${canonicalJson(p).length} bytes canónicos`);
      for (const [role, c] of Object.entries(p.roles ?? {})) console.log(`${role}  ${c.harness ?? '(workstream)'}  ${c.model ?? p.model ?? '(por defecto)'}`);
      console.log(JSON.stringify(p, null, 2));
    } else if (sub === 'list') {
      console.log(`${DEFAULT_DIGEST}  (por defecto)`);
      for (const d of listProfiles(stateDir)) if (d !== DEFAULT_DIGEST) console.log(d);
    } else throw fail('fab profile export|import|inspect|list');
    return 0;
  } catch (err) {
    console.error(err instanceof StoreError ? `error (${err.code}): ${printable(err.message)}` : `error: ${printable((err as Error).message)}`);
    return 1;
  }
}
