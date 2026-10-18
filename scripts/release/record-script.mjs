import { resolve } from 'node:path';
import { assert, hashFile, readJson, sourceSha, writeJson } from './common.mjs';
const binary = resolve(process.argv[2]), native = await readJson(binary + '.receipt.json'), probe = await readJson(binary + '.script.json');
assert(native.sourceSha === sourceSha() && native.sha256 === probe.sha256 && native.sha256 === await hashFile(binary), 'Script probe artifact differs');
assert(probe.results.length === 2 && probe.results[0].case === 'callback' && probe.results[0].ok && probe.results[0].sandboxedCallbackObserved && probe.results[0].exit === 0
  && probe.results[1].case === 'timeout' && probe.results[1].ok === false && probe.results[1].error === 'timeout' && probe.results[1].exit === 1, 'Script callback/timeout qualification failed');
await writeJson(binary + '.receipt.json', { ...native, scriptIsolation: true, scriptReceiptSha256: await hashFile(binary + '.script.json') });
