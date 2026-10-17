import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCodingAgent } from '../src/agent/engine.ts';
import type { ModelProvider, ModelTurn } from '../src/agent/types.ts';

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
const done = (text = 'done'): ModelTurn => ({ text, toolCalls: [], finishReason: 'stop' });
const calls = (...tools: Array<[string, unknown]>): ModelTurn => ({ text: '', finishReason: 'tool_calls', toolCalls: tools.map(([name, input]) => ({ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(input) } })) });
async function repo() {
  const cwd = await mkdtemp(join(tmpdir(), 'fab-task-test-')); roots.push(cwd);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', cwd, '-c', 'user.name=fixture', '-c', 'user.email=fixture@local', ...args]);
    if (result.exitCode) throw new Error(result.stderr.toString()); return result.stdout.toString();
  };
  git('init', '-q'); await writeFile(join(cwd, 'file'), 'baseline'); await writeFile(join(cwd, 'deleted'), 'deleted');
  git('add', '.'); git('commit', '-qm', 'fixture'); return { cwd, git };
}

test('Task snapshots dirty bytes/deletions/binary files and returns an isolated child diff', async () => {
  const { cwd, git } = await repo(); await writeFile(join(cwd, 'file'), 'dirty-start');
  const binary = Buffer.from([0, 255, 128, 13, 10]); await writeFile(join(cwd, 'binary'), binary); git('rm', '-q', 'deleted');
  const before = git('status', '--porcelain'); let parentTurns = 0, childTurns = 0, childCwd = '', task: any;
  const provider: ModelProvider = { id: 'fixture', async complete(request) {
    const workspace = /^Workspace: (.+)$/m.exec(request.messages[1]!.content as string)![1]!;
    if (workspace === cwd) {
      if (!parentTurns++) return calls(['Task', { prompt: 'Edit file and create a new file' }]);
      task = JSON.parse(request.messages.at(-1)!.content as string); return done('STATUS: done');
    }
    childCwd = workspace;
    if (!childTurns++) return calls(['Read', { file_path: join(workspace, 'file') }]);
    if (childTurns === 2) {
      expect(request.messages.at(-1)!.content).toBe('dirty-start');
      return calls(['Edit', { file_path: 'file', old_str: 'dirty-start', new_str: 'child-change' }], ['Create', { file_path: 'new-file', content: 'new' }]);
    }
    return done('child complete');
  } };
  const result = await runCodingAgent({ prompt: 'delegate', cwd, provider, autonomy: 'medium' });
  if (childCwd) roots.push(dirname(childCwd));
  expect(result.ok).toBe(true); expect(task.status).toBe('completed');
  expect(task.diff).toContain('-dirty-start'); expect(task.diff).toContain('+child-change'); expect(task.diff).toContain('new-file');
  expect(await readFile(join(cwd, 'file'), 'utf8')).toBe('dirty-start'); expect(git('status', '--porcelain')).toBe(before);
  expect(await readFile(join(childCwd, 'binary'))).toEqual(binary);
  expect(await Bun.file(join(childCwd, 'deleted')).exists()).toBe(false);
});

test('parent completion aborts and drains background agents before terminal notification', async () => {
  const { cwd } = await repo(); let parentTurns = 0, aborted = false, childCwd = '', terminalAfterAbort = false;
  const provider: ModelProvider = { id: 'fixture', async complete(request, signal) {
    const workspace = /^Workspace: (.+)$/m.exec(request.messages[1]!.content as string)![1]!;
    if (workspace === cwd) {
      if (!parentTurns++) return calls(['SpawnAgent', { prompt: 'wait' }]);
      const deadline = Date.now() + 2000;
      while (!childCwd) { if (Date.now() > deadline) throw new Error('Child did not start'); await Bun.sleep(2); }
      return done();
    }
    childCwd = workspace;
    return new Promise((_, reject) => {
      const abort = () => { aborted = true; reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
  } };
  const result = await runCodingAgent({ prompt: 'delegate', cwd, provider, autonomy: 'medium', onEvent: e => { if (e.type === 'result') terminalAfterAbort = aborted; } });
  if (childCwd) roots.push(dirname(childCwd));
  expect(result.ok).toBe(true); expect(aborted).toBe(true); expect(terminalAfterAbort).toBe(true);
});

test('delegation depth cannot be increased by tool arguments', async () => {
  const { cwd } = await repo(); let n = 0, error = '';
  const provider: ModelProvider = { id: 'fixture', async complete(request) {
    if (!n++) return calls(['Task', { prompt: 'try', maxDepth: 100 }]);
    error = request.messages.at(-1)!.content as string; return done();
  } };
  expect((await runCodingAgent({ prompt: 'delegate', cwd, provider, autonomy: 'medium', subagents: { maxDepth: 0 } })).ok).toBe(true);
  expect(error).toContain('depth');
});

test('child-controlled Git filters cannot write outside the sandbox during diff collection', async () => {
  const { cwd } = await repo(), outside = await mkdtemp(join(tmpdir(), 'fab-task-outside-')); roots.push(outside);
  let parentTurns = 0, childTurns = 0, childCwd = '';
  const provider: ModelProvider = { id: 'fixture', async complete(request) {
    const workspace = /^Workspace: (.+)$/m.exec(request.messages[1]!.content as string)![1]!;
    if (workspace === cwd) return parentTurns++ ? done() : calls(['Task', { prompt: 'make fixture changes' }]);
    childCwd = workspace;
    if (childTurns++) return done('child done');
    return calls(['Create', {file_path:'.git/config', content:`[core]\n repositoryformatversion = 0\n[filter "escape"]\n clean = "sh -c 'echo escaped > ${outside}/escape; cat'"\n`}],
      ['Create', {file_path:'.gitattributes',content:'new-file filter=escape'}], ['Create',{file_path:'new-file',content:'data'}]);
  } };
  expect((await runCodingAgent({ prompt: 'delegate', cwd, provider, autonomy: 'medium' })).ok).toBe(true);
  if (childCwd) roots.push(dirname(childCwd));
  expect(await Bun.file(join(outside, 'escape')).exists()).toBe(false);
});
