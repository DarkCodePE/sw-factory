import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { binaryPath, ensureBinary, platformAsset, validateManifest } from '../packaging/npm/runtime.mjs';
import { junit } from '../scripts/release/common.mjs';
import { collectNative } from '../scripts/release/collect-native.mjs';
const directories = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const payload = Buffer.from('verified native fixture');
function manifest() {
  return { schemaVersion: 1, version: '0.1.0-rc.1', tag: 'v0.1.0-rc.1', sourceSha: 'a'.repeat(40), assets: Object.fromEntries(['linux', 'darwin'].flatMap(os => ['x64', 'arm64'].map(arch => {
    const filename = platformAsset(os, arch); return [filename, { filename, bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') }];
  }))) };
}
async function home() { const path = await mkdtemp(join(tmpdir(), 'fab-npm-test-')); directories.push(path); return path; }

test('npm distribution rejects unsupported platforms and malformed release identity', () => {
  expect(() => platformAsset('win32', 'x64')).toThrow('WSL'); expect(() => platformAsset('linux', 'riscv64')).toThrow();
  for (const change of [{ sourceSha: 'invalid' }, { tag: 'v9.0.0' }, { version: '../x' }, { assets: {} }]) expect(() => validateManifest({ ...manifest(), ...change })).toThrow();
});
test('npm downloads the pinned asset, verifies bytes and reuses only valid cached content', async () => {
  const m = manifest(), h = await home(); let calls = 0;
  const fetcher = async url => { calls++; expect(String(url)).toBe('https://github.com/DarkCodePE/sw-factory/releases/download/v0.1.0-rc.1/fab-linux-x64'); return new Response(payload); };
  const path = await ensureBinary({ manifest: m, home: h, platform: 'linux', arch: 'x64', fetcher }); expect(await readFile(path)).toEqual(payload);
  await ensureBinary({ manifest: m, home: h, platform: 'linux', arch: 'x64', fetcher }); expect(calls).toBe(1);
  await writeFile(path, 'tampered'); await ensureBinary({ manifest: m, home: h, platform: 'linux', arch: 'x64', fetcher }); expect(calls).toBe(2); expect(await readFile(path)).toEqual(payload);
});
test('checksum, byte limits and HTTP failures never install a payload and remove temporary files', async () => {
  for (const response of [new Response(Buffer.alloc(payload.length, 1)), new Response(Buffer.alloc(payload.length + 1)), new Response('missing', { status: 404 })]) {
    const m = manifest(), h = await home(), target = binaryPath(m, 'fab-linux-x64', h);
    await expect(ensureBinary({ manifest: m, home: h, platform: 'linux', arch: 'x64', fetcher: async () => response })).rejects.toThrow();
    expect(await Bun.file(target).exists()).toBe(false); expect(await readdir(dirname(target))).toEqual([]);
  }
});
test('redirects are bounded and reject HTTP or hosts outside GitHub', async () => {
  for (const location of ['http://github.com/a', 'https://github.com.evil.example/a', 'https://outside.example/file', 'https://github.com/loop']) {
    let calls = 0; await expect(ensureBinary({ manifest: manifest(), home: await home(), platform: 'darwin', arch: 'arm64', fetcher: async () => { calls++; return new Response(null, { status: 302, headers: { location } }); } })).rejects.toThrow();
    expect(calls).toBeLessThanOrEqual(6);
  }
});
test('release QA refuses empty, skipped, failed and malformed JUnit instead of sealing it', () => {
  expect(junit('<testsuites tests="4" failures="0" skipped="0"></testsuites>')).toEqual({ tests: 4, failures: 0, skipped: 0 });
  for (const xml of ['', '<testsuites tests="0" failures="0" skipped="0">', '<testsuites tests="4" failures="1" skipped="0">', '<testsuites tests="4" failures="0" skipped="1">', '<testsuites tests="4" failures="0" skipped="0"><error/>']) expect(() => junit(xml)).toThrow();
});
test('collecting native artifacts preserves sealed duplicate metadata and rejects changed bytes or overwrite', async () => {
  const source = await home(), destination = await home(), name = 'fab-linux-x64', m = manifest();
  await writeFile(join(source, name), payload);
  await writeFile(join(source, name + '.receipt.json'), 'duplicate from native artifact');
  await writeFile(join(destination, name + '.receipt.json'), 'authoritative sealed receipt');
  await collectNative(source, destination, name, m);
  expect(await readFile(join(destination, name))).toEqual(payload);
  expect(await readFile(join(destination, name + '.receipt.json'), 'utf8')).toBe('authoritative sealed receipt');
  await expect(collectNative(source, destination, name, m)).rejects.toThrow();
  await writeFile(join(source, name), 'changed bytes');
  await expect(collectNative(source, await home(), name, m)).rejects.toThrow('differs from seal');
  await expect(collectNative(source, destination, '../outside', m)).rejects.toThrow('Unexpected native asset');
});
