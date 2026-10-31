// fab profile export|import|inspect|list. Los perfiles viven en <stateDir>/profiles/<digest>.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { StoreError } from './store.ts';
import { canonicalJson, defaultProfile, DEFAULT_DIGEST, listProfiles, loadProfile, profileDigest, saveProfile } from './profile.ts';

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
      const { digest, created } = saveProfile(stateDir, JSON.parse(readFileSync(arg, 'utf8')));
      console.log(`${digest}${created ? '' : ' (ya existía)'}`);
    } else if (sub === 'inspect') {
      if (!arg) throw fail('usage: fab profile inspect <digest>');
      const p = arg === DEFAULT_DIGEST ? defaultProfile() : loadProfile(stateDir, arg);
      console.log(`digest ${profileDigest(p)}\nharness ${p.harness}${p.model ? ` model ${p.model}` : ''}${p.repo ? ` repo ${p.repo}` : ''}\n${canonicalJson(p).length} bytes canónicos`);
      console.log(JSON.stringify(p, null, 2));
    } else if (sub === 'list') {
      console.log(`${DEFAULT_DIGEST}  (por defecto)`);
      for (const d of listProfiles(stateDir)) if (d !== DEFAULT_DIGEST) console.log(d);
    } else throw fail('fab profile export|import|inspect|list');
    return 0;
  } catch (err) {
    console.error(err instanceof StoreError ? `error (${err.code}): ${err.message}` : `error: ${(err as Error).message}`);
    return 1;
  }
}
