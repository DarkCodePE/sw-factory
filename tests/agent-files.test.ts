import { afterEach, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicReplace, readAnchored, readWorkspaceFile, unlinkAnchored, withWorkspaceFile } from '../src/agent/files.ts';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fab-files-'))); roots.push(root);
  const cwd = join(root, 'workspace'), outside = join(root, 'outside'); await mkdir(cwd); await mkdir(outside);
  await writeFile(join(cwd, 'a.txt'), 'original'); await writeFile(join(outside, 'a.txt'), 'outside');
  return { root, cwd, outside };
}
const signal = () => new AbortController().signal;

test('directory capabilities read and replace actual bytes, create parents and preserve exact mode', async () => {
  const { cwd } = await fixture(); expect((await readWorkspaceFile(cwd, 'a.txt')).text).toBe('original');
  await withWorkspaceFile(cwd, 'nested/new.txt', true, (parent, name) => atomicReplace(parent, name, 'new', signal(), 0o640, true));
  expect(await readFile(join(cwd, 'nested/new.txt'), 'utf8')).toBe('new'); expect((await stat(join(cwd, 'nested/new.txt'))).mode & 0o777).toBe(0o640);
  await withWorkspaceFile(cwd, 'nested/new.txt', false, unlinkAnchored); expect(await Bun.file(join(cwd, 'nested/new.txt')).exists()).toBe(false);
});
test('file and directory symlinks cannot read or create files outside the workspace', async () => {
  const { cwd, outside } = await fixture(); await symlink(join(outside, 'a.txt'), join(cwd, 'file-link')); await symlink(outside, join(cwd, 'dir-link'));
  for (const path of ['file-link', 'dir-link/a.txt']) await expect(readWorkspaceFile(cwd, path)).rejects.toThrow();
  await expect(withWorkspaceFile(cwd, 'dir-link/sub/new.txt', true, (parent, name) => atomicReplace(parent, name, 'bad', signal()))).rejects.toThrow();
  expect(await readdir(outside)).toEqual(['a.txt']); expect(await readFile(join(outside, 'a.txt'), 'utf8')).toBe('outside');
});
test('atomic replacement does not mutate an inode hardlinked outside the workspace', async () => {
  const { cwd, outside } = await fixture(); await link(join(outside, 'a.txt'), join(cwd, 'hardlink'));
  await withWorkspaceFile(cwd, 'hardlink', false, (parent, name) => atomicReplace(parent, name, 'inside', signal()));
  expect(await readFile(join(cwd, 'hardlink'), 'utf8')).toBe('inside'); expect(await readFile(join(outside, 'a.txt'), 'utf8')).toBe('outside');
});
test('cancellation before replacement preserves the original and removes staging files', async () => {
  const { cwd } = await fixture(), abort = new AbortController(); abort.abort(new Error('cancelled'));
  await expect(withWorkspaceFile(cwd, 'a.txt', false, (parent, name) => atomicReplace(parent, name, 'bad', abort.signal))).rejects.toThrow('cancelled');
  expect(await readdir(cwd)).toEqual(['a.txt']); expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('original');
});
test('a renamed checked ancestor stays anchored when its old name becomes an external symlink', async () => {
  const { cwd, outside } = await fixture(); await mkdir(join(cwd, 'checked')); await writeFile(join(cwd, 'checked/a.txt'), 'before');
  await withWorkspaceFile(cwd, 'checked/a.txt', false, async (parent, name) => {
    await rename(join(cwd, 'checked'), join(cwd, 'retired')); await symlink(outside, join(cwd, 'checked'));
    await atomicReplace(parent, name, 'anchored', signal());
  });
  expect(await readFile(join(cwd, 'retired/a.txt'), 'utf8')).toBe('anchored'); expect(await readFile(join(outside, 'a.txt'), 'utf8')).toBe('outside');
});
test('absolute external paths, traversal and embedded NUL are rejected', async () => {
  const { cwd, outside } = await fixture();
  for (const path of ['../outside/a.txt', join(outside, 'a.txt'), 'a.txt\0ignored']) await expect(readWorkspaceFile(cwd, path)).rejects.toThrow();
  expect(await readFile(join(outside, 'a.txt'), 'utf8')).toBe('outside');
});
test('byte limits remain bounded for tool files and larger private journal records', async () => {
  const { cwd } = await fixture(), data = Buffer.alloc(1024 * 1024 + 1, 1); await writeFile(join(cwd, 'large'), data);
  await expect(readWorkspaceFile(cwd, 'large')).rejects.toThrow();
  const result = await withWorkspaceFile(cwd, 'large', false, (parent, name) => readAnchored(parent, name, 2 * 1024 * 1024)); expect(result.data).toEqual(data);
  await expect(withWorkspaceFile(cwd, 'a.txt', false, (parent, name) => atomicReplace(parent, name, data, signal()))).rejects.toThrow();
  expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('original');
});
