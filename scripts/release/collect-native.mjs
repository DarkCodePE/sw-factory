import { constants } from 'node:fs';
import { copyFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { assets, assert, hashFile } from './common.mjs';

// Metadata is already sealed. Import only the binary from the native artifact;
// never extract duplicate receipts/checksums over that authoritative metadata.
export async function collectNative(source, destination, name, manifest) {
  assert(assets.includes(name), 'Unexpected native asset');
  const path = join(source, name), record = manifest.assets[name], info = await lstat(path);
  assert(info.isFile() && info.size === record.bytes && await hashFile(path) === record.sha256, `Native artifact differs from seal: ${name}`);
  await copyFile(path, join(destination, name), constants.COPYFILE_EXCL);
}
