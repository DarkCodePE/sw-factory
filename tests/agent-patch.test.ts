import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodingAgent } from '../src/agent/engine.ts';
import { builtinTools } from '../src/agent/tools.ts';
import { applyHunks, parsePatch } from '../src/agent/patch.ts';
import type { AgentEvent, ModelProvider, ModelTurn, ToolContext } from '../src/agent/types.ts';
import { Checkpoints } from '../src/chat/checkpoints.ts';

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fab-patch-')); roots.push(root);
  const cwd = join(root, 'work'); await mkdir(cwd);
  const ac = new AbortController();
  const context: ToolContext = { cwd, autonomy: 'high', interactionMode: 'auto', sandbox: 'required', signal: ac.signal, fileReads: new Map() };
  const run = (name: string, input: unknown) => builtinTools().find(t => t.schema.function.name === name)!.run(input, context);
  const path = join(cwd, 'file');
  return { root, cwd, path, ac, context, run };
}
const update = (path: string, from = 'before', to = 'after') => '*** Update File: ' + path + '\n@@\n-' + from + '\n+' + to + '\n';

test('ApplyPatch applies ordered unique hunks atomically, preserves mode and supports Add without overwriting', async () => {
  const f = await fixture(); await writeFile(f.path, 'alpha\nbefore\nbeta\ntail\n'); await chmod(f.path, 0o640);
  const patch = '*** Begin Patch\n*** Update File: ' + f.path + '\n@@\n alpha\n-before\n+after\n beta\n@@\n-tail\n+end\n*** End Patch\n';
  expect(await f.run('ApplyPatch', { patch })).toMatchObject({ success: true, operation: 'update' });
  expect(await readFile(f.path, 'utf8')).toBe('alpha\nafter\nbeta\nend\n'); expect((await stat(f.path)).mode & 0o777).toBe(0o640);
  const added = join(f.cwd, 'nested/new');
  await f.run('ApplyPatch', { patch: '*** Add File: ' + added + '\n+one\n+two\n' });
  expect(await readFile(added, 'utf8')).toBe('one\ntwo\n');
  await expect(f.run('ApplyPatch', { patch: '*** Add File: ' + added + '\n+other\n' })).rejects.toThrow('existing');
  expect(await readFile(added, 'utf8')).toBe('one\ntwo\n');
  expect(applyHunks('before', parsePatch(update(f.path)))).toBe('after');
});

test('ApplyPatch rejects malformed/relative/multifile/oversize patches, ambiguous and inapplicable hunks without partial mutation', async () => {
  const f = await fixture(); await writeFile(f.path, 'before\n');
  const bad = [update('relative'), update(f.path) + '*** Add File: /tmp/second\n+x\n',
    '*** Delete File: ' + f.path, '*** Update File: ' + f.path + '\n@@\n+unanchored\n',
    update(f.path) + '@@\n-missing\n+new\n', update(f.path).replace('@@', '@@ -1 +1 @@'),
    'x'.repeat(1024 * 1024 + 1), update('/' + 'a'.repeat(4097)), update(f.path) + '\0',
    '*** Update File: ' + f.path + '\n@@\n before\n'];
  for (const patch of bad) {
    await expect(f.run('ApplyPatch', { patch })).rejects.toThrow();
    expect(await readFile(f.path, 'utf8')).toBe('before\n');
  }
  await writeFile(f.path, 'before\nbefore\n');
  await expect(f.run('ApplyPatch', { patch: update(f.path) })).rejects.toThrow('ambiguous');
  expect(await readFile(f.path, 'utf8')).toBe('before\nbefore\n');
});

test('ApplyPatch bounds output and hunk counts; rejects binary/CRLF input explicitly', async () => {
  const f = await fixture();
  expect(() => parsePatch('*** Update File: ' + f.path + '\n' + '@@\n-a\n+b\n'.repeat(129))).toThrow('128 hunks');
  await writeFile(f.path, 'before\n' + 'x'.repeat(1024 * 1024 - 7));
  await expect(f.run('ApplyPatch', { patch: update(f.path, 'before', 'after'.repeat(10)) })).rejects.toThrow('1 MiB');
  for (const bytes of [Buffer.from([0xff, 10]), Buffer.from('before\r\n'), Buffer.from('before\0\n')]) {
    await writeFile(f.path, bytes);
    await expect(f.run('ApplyPatch', { patch: update(f.path) })).rejects.toThrow();
    expect(await readFile(f.path)).toEqual(bytes);
  }
});

test('ApplyPatch rejects outside paths and symlinks and does not mutate linked targets', async () => {
  const f = await fixture(), outside = join(f.root, 'outside'); await writeFile(outside, 'before\n');
  await expect(f.run('ApplyPatch', { patch: update(outside) })).rejects.toThrow('outside');
  await symlink(outside, f.path);
  await expect(f.run('ApplyPatch', { patch: update(f.path) })).rejects.toThrow();
  await symlink(f.root, join(f.cwd, 'link'));
  await expect(f.run('ApplyPatch', { patch: '*** Add File: ' + join(f.cwd, 'link/new') + '\n+x\n' })).rejects.toThrow();
  expect(await readFile(outside, 'utf8')).toBe('before\n');
});

test('read-before-edit policy is shared with Edit and invalidates externally changed bytes', async () => {
  const f = await fixture(); f.context.requireReadBeforeEdit = true;
  await writeFile(f.path, 'before\n');
  await expect(f.run('ApplyPatch', { patch: update(f.path) })).rejects.toThrow('Read this file');
  await expect(f.run('Edit', { file_path: f.path, old_str: 'before', new_str: 'after' })).rejects.toThrow('Read this file');
  await expect(f.run('Read', { file_path: f.path, offset: -1 })).rejects.toThrow('range');
  await expect(f.run('ApplyPatch', { patch: update(f.path) })).rejects.toThrow('Read this file');
  await f.run('Read', { file_path: f.path }); await writeFile(f.path, 'changed\n');
  await expect(f.run('ApplyPatch', { patch: update(f.path, 'changed', 'after') })).rejects.toThrow('Read this file');
  await f.run('Read', { file_path: f.path });
  await f.run('ApplyPatch', { patch: update(f.path, 'changed', 'after') });
  await f.run('Edit', { file_path: f.path, old_str: 'after', new_str: 'end' });
  expect(await readFile(f.path, 'utf8')).toBe('end\n');
});

test('cancellation at the write boundary leaves original bytes unchanged', async () => {
  const f = await fixture(); await writeFile(f.path, 'before\n');
  f.context.fileJournal = { async barrier() {}, async prepare() { f.ac.abort(new Error('cancel')); return async () => {}; } };
  await expect(f.run('ApplyPatch', { patch: update(f.path) })).rejects.toThrow('cancel');
  expect(await readFile(f.path, 'utf8')).toBe('before\n');
});

test('dispatcher binds patch permissions, denies declined/removed/spec writes and supports nested Script checkpoint rewind', async () => {
  const f = await fixture(); await writeFile(f.path, 'before\n');
  expect(await Bun.spawn(['git', 'init', '-q', f.cwd], { stdout: 'ignore', stderr: 'pipe' }).exited).toBe(0);
  const journal = new Checkpoints(f.cwd, join(f.root, 'home'));
  let sequence = 0;
  for (const kind of ['decline', 'remove', 'spec', 'allow', 'script'] as const) {
    const events: AgentEvent[] = []; let step = 0, asked = 0;
    const patch = update(f.path, kind === 'script' ? 'after' : 'before', kind === 'script' ? 'end' : 'after');
    const provider: ModelProvider = { id: 'test', async complete(): Promise<ModelTurn> {
      return step++ ? { text: 'done', finishReason: 'stop', toolCalls: [] } : { text: '', finishReason: 'tool_calls',
        toolCalls: [{ id: 'patch-' + sequence++, type: 'function', function: { name: kind === 'script' ? 'Script' : 'ApplyPatch',
          arguments: JSON.stringify(kind === 'script' ? { code: 'return await tools.ApplyPatch(' + JSON.stringify({ patch }) + ')' } : { patch }) } }] };
    } };
    await journal.begin(kind);
    try {
      const result = await runCodingAgent({ prompt: 'patch', cwd: f.cwd, sessionDir: join(f.root, 'sessions'), provider,
        autonomy: kind === 'spec' || kind === 'script' ? 'high' : 'off', interactionMode: kind === 'spec' ? 'spec' : 'auto',
        removeTools: kind === 'remove' ? ['ApplyPatch'] : undefined, fileJournal: journal, onEvent: e => events.push(e),
        permissionHandler: async request => {
          asked++; expect(request.toolUses[0]!.details).toMatchObject({ type: 'edit', filePath: f.path, patch });
          return kind === 'decline' ? 'cancel' : 'proceed_once';
        } });
      expect(result.ok).toBe(true);
      expect(events.find(e => e.type === 'tool_result')!.isError).toBe(!['allow', 'script'].includes(kind));
      expect(asked).toBe(['allow', 'decline'].includes(kind) ? 1 : 0);
    } finally { await journal.finish(); }
  }
  expect(await readFile(f.path, 'utf8')).toBe('end\n');
  expect((await journal.list()).map(t => t.blocked)).toEqual([false, false]);
  await journal.rewind(); expect(await readFile(f.path, 'utf8')).toBe('after\n');
  await journal.rewind(); expect(await readFile(f.path, 'utf8')).toBe('before\n');
}, 10000);

test('repeated-line adversarial hunk has bounded linear matching and no argument-spread overflow', () => {
  const source = 'a\n'.repeat(250000) + 'end\n';
  const patch = parsePatch('*** Update File: /workspace/file\n@@\n' + ' a\n'.repeat(125000) + '-end\n+done\n');
  const start = performance.now();
  const result = applyHunks(source, patch);
  expect(result).toBe('a\n'.repeat(250000) + 'done\n');
  expect(performance.now() - start).toBeLessThan(2000);
});
