import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Checkpoints } from '../src/chat/checkpoints.ts';
import { builtinTools } from '../src/agent/tools.ts';
import type { FileMutation, ModelProvider, ModelTurn, ToolContext } from '../src/agent/types.ts';
import { ChatController, type ChatIO } from '../src/chat/controller.ts';
import { PromptHistory } from '../src/chat/history.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fab-rewind-')); roots.push(root);
  const cwd = join(root, 'workspace'), home = join(root, 'home'); await mkdir(cwd);
  expect(await Bun.spawn(['git', 'init', '-q', cwd], { stdout: 'ignore', stderr: 'pipe' }).exited).toBe(0);
  const journal = new Checkpoints(cwd, home);
  const context: ToolContext = { cwd, autonomy: 'high', interactionMode: 'auto', sandbox: 'required', signal: new AbortController().signal, fileJournal: journal };
  const run = (name: string, args: unknown) => builtinTools().find(t => t.schema.function.name === name)!.run(args, context);
  return { root, cwd, home, journal, context, run };
}
test('persistent checkpoints restore original binary bytes/mode, coalesce edits and remove only created files', async () => {
  const f = await fixture(), original = Buffer.from([0, 255, 13, 10, 65]);
  await writeFile(join(f.cwd, 'data'), original); await chmod(join(f.cwd, 'data'), 0o666);
  await f.journal.begin('primer turno');
  try {
    await f.run('Create', { file_path: 'data', content: 'one' });
    await f.run('Edit', { file_path: 'data', old_str: 'one', new_str: 'two' });
    await f.run('Create', { file_path: 'nested/new', content: 'created' });
  } finally { await f.journal.finish(); }
  const reloaded = new Checkpoints(f.cwd, f.home), turns = await reloaded.list();
  expect(turns).toHaveLength(1); expect(turns[0]?.files).toBe(2);
  expect(await reloaded.rewind(turns[0]!.id)).toMatchObject({ files: 2 });
  expect(await readFile(join(f.cwd, 'data'))).toEqual(original);
  expect((await stat(join(f.cwd, 'data'))).mode & 0o777).toBe(0o666);
  expect(await Bun.file(join(f.cwd, 'nested/new')).exists()).toBe(false);
  expect((await stat(join(f.cwd, 'nested'))).isDirectory()).toBe(true);
  expect(await reloaded.list()).toEqual([]);
});

test('rewind preflights all files and refuses outside paths, symlinks and later changes without effects', async () => {
  const f = await fixture(); await writeFile(join(f.root, 'outside'), 'private');
  await f.journal.begin('turn');
  try {
    await expect(f.run('Create', { file_path: '../outside', content: 'bad' })).rejects.toThrow('outside');
    await f.run('Create', { file_path: 'a', content: 'a' });
    await f.run('Create', { file_path: 'b', content: 'b' });
  } finally { await f.journal.finish(); }
  const mode = (await stat(join(f.cwd, 'b'))).mode & 0o777;
  await writeFile(join(f.cwd, 'b'), 'user edit');
  await expect(f.journal.rewind()).rejects.toThrow('Cambio posterior'); expect(await readFile(join(f.cwd, 'a'), 'utf8')).toBe('a\n');
  await rm(join(f.cwd, 'b')); await symlink(join(f.root, 'outside'), join(f.cwd, 'b'));
  await expect(f.journal.rewind()).rejects.toThrow(); expect(await readFile(join(f.root, 'outside'), 'utf8')).toBe('private');
  await rm(join(f.cwd, 'b')); await writeFile(join(f.cwd, 'b'), 'b\n'); await chmod(join(f.cwd, 'b'), mode);
  await f.journal.rewind(); expect(await Bun.file(join(f.cwd, 'a')).exists()).toBe(false);
});

test('prepared-only mutations, metadata paths, swapped parents, and workspace mismatches fail closed', async () => {
  const f = await fixture(); await f.journal.begin('uncertain');
  try {
    const mutation: FileMutation = { path: join(f.cwd, '.git/config'), after: Buffer.from('bad'), mode: 0o644 };
    await expect(f.journal.prepare(mutation, f.context)).rejects.toThrow('protegida');
    await expect(f.journal.prepare({ ...mutation, path: join(f.cwd, 'safe') }, { ...f.context, cwd: f.root })).rejects.toThrow('otro workspace');
    await f.journal.prepare({ ...mutation, path: join(f.cwd, 'uncertain') }, f.context);
  } finally { await f.journal.finish(); }
  await expect(f.journal.rewind()).rejects.toThrow('incierto');
  await f.journal.begin('nested');
  try { await f.run('Create', { file_path: 'dir/file', content: 'x' }); } finally { await f.journal.finish(); }
  await rename(join(f.cwd, 'dir'), join(f.root, 'moved')); await symlink(join(f.root, 'moved'), join(f.cwd, 'dir'));
  await expect(f.journal.rewind()).rejects.toThrow('Symlink'); expect(await readFile(join(f.root, 'moved/file'), 'utf8')).toBe('x\n');
});

const call = (id: string, name: string, input: unknown): ModelTurn => ({ text: '', finishReason: 'tool_calls', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
const final = (): ModelTurn => ({ text: '**Terminado**', finishReason: 'stop', toolCalls: [], usage: { inputTokens: 10, outputTokens: 2 } });
class IO implements ChatIO {
  output = ''; answers: string[] = [];
  write(s: string) { this.output += s; }
  async question() { return this.answers.shift() ?? ''; }
  async select() { return undefined; }
}
function application(f: Awaited<ReturnType<typeof fixture>>, turns: ModelTurn[], autonomy: 'off' | 'high' = 'high') {
  const io = new IO(); const provider: ModelProvider = { id: 'offline', async complete() { return turns.shift() ?? final(); } };
  const app = new ChatController({ cwd: f.cwd, home: f.home, providerFor: () => provider,
    config: { model: 'offline', mode: 'auto', autonomy, theme: 'plain' } }, io);
  return { app, io };
}
test('controller emits compact diffs, accumulates real usage, saves prompts but not permission answers, and exposes /rewind', async () => {
  const f = await fixture(), a = application(f, [call('a', 'Create', { file_path: 'a', content: 'first' }), final(), final()], 'off');
  a.io.answers = ['s']; await a.app.submit('crea un archivo');
  expect(a.io.output).toContain('+    1 │ first'); expect(a.app.statusState.inputTokens).toBe(10);
  await a.app.submit('segunda pregunta'); expect(a.app.statusState.inputTokens).toBe(20);
  expect(await new PromptHistory(f.home, f.cwd).load()).toEqual(['crea un archivo', 'segunda pregunta']);
  await a.app.submit('/rewind list'); expect(a.io.output).toContain('crea un archivo');
  await a.app.submit('/rewind'); expect(await Bun.file(join(f.cwd, 'a')).exists()).toBe(false);
  expect(a.io.output).toContain('Nunca revierte Execute');
});

test('nested Script writes are checkpointed; Execute fences earlier turns and its effects survive rewind', async () => {
  const f = await fixture(), a = application(f, [
    call('s', 'Script', { code: 'return await tools.Create({file_path:"a",content:"first"})' }), final(),
    call('exec', 'Execute', { command: "printf from-execute > a" }), final(),
    call('edit', 'Edit', { file_path: 'a', old_str: 'from-execute', new_str: 'edit-only' }), final(),
  ]);
  await a.app.submit('Script crea'); expect(await readFile(join(f.cwd, 'a'), 'utf8')).toBe('first\n');
  const [first] = await f.journal.list(); expect(first?.files).toBe(1);
  await a.app.submit('Execute cambia'); expect(await readFile(join(f.cwd, 'a'), 'utf8')).toBe('from-execute');
  await expect(a.app.submit('/rewind ' + first!.id)).rejects.toThrow('Execute');
  expect(await readFile(join(f.cwd, 'a'), 'utf8')).toBe('from-execute');
  await a.app.submit('solo Edit'); await a.app.submit('/rewind');
  expect(await readFile(join(f.cwd, 'a'), 'utf8')).toBe('from-execute');
}, 15000);

test('journal ownership prevents a second writer and releases after use', async () => {
  const f = await fixture(), second = new Checkpoints(f.cwd, f.home);
  await f.journal.begin('owned');
  try { await expect(second.begin('competing')).rejects.toThrow(); } finally { await f.journal.finish(); }
  await second.begin('released'); await second.finish();
});

test('Execute nested inside Script fences checkpoints before side effects, even in the same turn', async () => {
  const f = await fixture(), a = application(f, [call('s', 'Script', { code:
    'await tools.Create({file_path:"a",content:"checkpoint"}); return await tools.Execute({command:"printf irreversible > a"})' }), final()]);
  await a.app.submit('crear y ejecutar');
  expect(await readFile(join(f.cwd, 'a'), 'utf8')).toBe('irreversible');
  await expect(a.app.submit('/rewind')).rejects.toThrow('Execute');
  expect(await readFile(join(f.cwd, 'a'), 'utf8')).toBe('irreversible');
}, 15000);

test('out-of-workspace mission metadata is written under existing authority but never checkpointed', async () => {
  const f = await fixture(), mission = join(f.root, 'mission'); await mkdir(mission);
  f.context.missionDir = mission;
  await f.journal.begin('mission');
  try { await f.run('Create', { file_path: join(mission, 'features.json'), content: '{"features":[]}' }); }
  finally { await f.journal.finish(); }
  expect(await readFile(join(mission, 'features.json'), 'utf8')).toBe('{"features":[]}\n');
  expect(await f.journal.list()).toEqual([]);
});

test('private checkpoint state cannot be redirected into the workspace through home or journal symlinks', async () => {
  const f = await fixture(), alias = join(f.root, 'alias'); await symlink(f.cwd, alias);
  await expect(new Checkpoints(f.cwd, alias).begin('bad home')).rejects.toThrow('dentro del workspace');
  await mkdir(f.home); await symlink(f.cwd, join(f.home, 'file-checkpoints'));
  await expect(f.journal.begin('bad directory')).rejects.toThrow('dentro del workspace');
  expect(await Bun.file(join(f.cwd, '.lock')).exists()).toBe(false);
});
