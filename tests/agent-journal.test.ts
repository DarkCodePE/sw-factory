import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore, type SessionState } from '../src/agent/session.ts';
import { Journal, reconcile } from '../src/agent/journal.ts';
import { runCodingAgent } from '../src/agent/engine.ts';
import { mockModel } from './agent-stream-input-fixture.test.ts';
const roots: string[] = [], cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
async function root() { const dir = await mkdtemp(join(tmpdir(), 'fab-journal-')); roots.push(dir); await mkdir(join(dir, 'work')); return dir; }
const snapshot = (id: string, cwd: string, name = 'Create'): SessionState => ({ version: 1, id, cwd, provider: 'fixture', status: 'running', pending: ['tool'], turns: 1, tags: [],
  messages: [{ role: 'user', content: 'start' }, { role: 'assistant', content: null, tool_calls: [{ id: 'tool', type: 'function', function: { name, arguments: '{}' } }] }] });
async function deadPid() { const child = Bun.spawn(['true']); await child.exited; return child.pid; }
async function until(check: () => boolean | Promise<boolean>, max = 5000) { const end = Date.now() + max; while (!await check()) { if (Date.now() > end) throw new Error('Wait timeout'); await Bun.sleep(3); } }
async function cli(dir: string, settings: string, args: string[]) {
  const child = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, '../src/cli.ts'), 'exec', '--cwd', join(dir, 'work'), '--settings', settings, '--session-dir', join(dir, 'sessions'), '--auto', 'high', '-o', 'stream-json', ...args],
    { cwd: dir, env: { PATH: process.env.PATH!, HOME: dir }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const frames: any[] = [], reading = (async () => { let buffer = ''; for await (const bytes of child.stdout) { buffer += new TextDecoder().decode(bytes); let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line.trim()) frames.push(JSON.parse(line)); } } })();
  const stderr = new Response(child.stderr).text(); cleanup.push(async () => { child.kill('SIGKILL'); await child.exited; await reading; });
  return { child, frames, stderr, async done() { const code = await child.exited; await reading; return code; } };
}
async function model(dir: string) {
  const { server } = mockModel(); cleanup.push(async () => server.stop(true));
  const settings = join(dir, 'settings.json'); await writeFile(settings, JSON.stringify({ modelId: 'custom:fixture', customModels: [{ id: 'custom:fixture', model: 'fixture', provider: 'generic-chat-completion-api', baseUrl: server.url.href + 'v1' }] })); return settings;
}

test('a completed turn journals lifecycle and durable tool start/end records', async () => {
  const dir = await root(); let n = 0;
  const result = await runCodingAgent({ cwd: join(dir, 'work'), sessionDir: join(dir, 'sessions'), prompt: 'create', autonomy: 'high', provider: { id: 'fixture', async complete() {
    return !n++ ? { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'create', type: 'function', function: { name: 'Create', arguments: '{"file_path":"once","content":"yes"}' } }] } : { text: 'done', toolCalls: [], finishReason: 'stop' };
  } } });
  expect(result.ok).toBe(true);
  const records = (await readFile(join(dir, 'sessions', result.sessionId + '.journal.jsonl'), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
  expect(records.map(r => r.type)).toEqual(['session_start', 'turn_start', 'tool_start', 'tool_end', 'turn_end', 'session_end']);
  expect(records.map(r => r.seq)).toEqual([1, 2, 3, 4, 5, 6]); expect(records[2]).toMatchObject({ toolCallId: 'create', name: 'Create', effect: 'write', pid: process.pid });
});

test('dead PID reconciles uncertain effects, read calls are discarded, live PID and legacy snapshots remain blocked', async () => {
  for (const name of ['Create', 'Read']) {
    const dir = await root(), session = join(dir, 'sessions'), s = await SessionStore.create(session), state = snapshot('owned', join(dir, 'work'), name);
    await s.acquire(state.id); await s.save(state); await s.journal!.append('session_start'); await s.journal!.append('tool_start', { toolCallId: 'tool', name, effect: name === 'Read' ? 'read' : 'write' }); await s.close();
    await writeFile(join(session, 'owned.json.lock'), JSON.stringify({ pid: await deadPid(), startedAt: Date.now() }));
    const next = await SessionStore.create(session); await next.acquire('owned'); const loaded = await next.load('owned');
    expect(loaded.pending).toEqual([]); expect(next.reconciled).toBeDefined();
    if (name === 'Create') expect(loaded.messages.at(-2)?.content).toContain('effect uncertain');
    else expect(loaded.messages.some(m => m.role === 'tool')).toBe(false);
    await next.close();
  }
  const dir = await root(), session = join(dir, 'sessions'), live = await SessionStore.create(session); await live.acquire('live');
  const owner = JSON.parse(await readFile(join(session, 'live.json.lock'), 'utf8')); expect(owner.pid).toBe(process.pid); expect(typeof owner.startedAt).toBe('number');
  const other = await SessionStore.create(session); await expect(other.acquire('live')).rejects.toThrow('locked'); await other.close(); await live.close();
  const old = await SessionStore.create(session); await old.save(snapshot('legacy', join(dir, 'work'))); await old.acquire('legacy'); await expect(old.load('legacy')).rejects.toThrow('reconciliation'); await old.close();
});

test('corrupt final record ignored and repaired; corruption before final record fails closed; 10000 records', async () => {
  const dir = await root(), path = join(dir, 'large.journal.jsonl'); let journal = await Journal.open(path);
  await Promise.all(Array.from({ length: 10000 }, () => journal.append('turn_start'))); await journal.close();
  await writeFile(path, '{"seq":10001', { flag: 'a' }); journal = await Journal.open(path); expect(journal.entries.length).toBe(10000); await journal.append('turn_end', { ok: false }); await journal.close();
  journal = await Journal.open(path); expect(journal.entries.at(-1)!.seq).toBe(10001); await journal.close();
  await writeFile(join(dir, 'bad'), 'bad\n' + JSON.stringify({ seq: 1, at: 0, pid: process.pid, type: 'turn_start' }) + '\n');
  await expect(Journal.open(join(dir, 'bad'))).rejects.toThrow('before final');
}, 30000);

test('real SIGKILL during Execute reconciles without replay, three repetitions', async () => {
  for (let i = 0; i < 3; i++) {
    const dir = await root(), settings = await model(dir), first = await cli(dir, settings, ['slow']);
    await until(() => Bun.file(join(dir, 'work/started')).exists()); const id = first.frames.find(e => e.type === 'init').sessionId;
    first.child.kill('SIGKILL'); await first.done();
    const records = (await readFile(join(dir, 'sessions', id + '.journal.jsonl'), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
    expect(records.some(r => r.type === 'tool_start')).toBe(true); expect(records.some(r => r.type === 'tool_end')).toBe(false);
    const resumed = await cli(dir, settings, ['--session-id', id, 'recover']); expect(await resumed.done()).toBe(0);
    expect(resumed.frames.find(e => e.type === 'reconciled')).toMatchObject({ sessionId: id, uncertain: [{ name: 'Execute' }] });
    const state = JSON.parse(await readFile(join(dir, 'sessions', id + '.json'), 'utf8'));
    expect(state.messages.some((m: any) => m.role === 'tool' && m.content.includes('effect uncertain'))).toBe(true);
    expect(await readFile(join(dir, 'work/count'), 'utf8')).toBe('x'); expect(state.pending).toEqual([]);
  }
}, 15000);

test('real mission worker crash pauses/logs and resumes the same owned child session', async () => {
  const dir = await root(), settings = await model(dir); await writeFile(join(dir, 'work/contract.txt'), 'intact\n');
  const first = await cli(dir, settings, ['--mission', 'mission-crash']);
  await until(() => Bun.file(join(dir, 'work/started')).exists());
  const id = first.frames.find(e => e.type === 'init').sessionId, worker = first.frames.find(e => e.type === 'mission_worker_started').workerSessionId;
  first.child.kill('SIGKILL'); await first.done();
  const resumed = await cli(dir, settings, ['--mission', '--session-id', id, 'mission-resume ' + worker]);
  expect(await resumed.done()).toBe(0); expect(resumed.frames.find(e => e.type === 'mission_paused')).toMatchObject({ reason: 'error', message: 'Interrupted by crash' });
  expect(resumed.frames.filter(e => e.type === 'mission_worker_started')[0]).toMatchObject({ workerSessionId: worker });
  const state = JSON.parse(await readFile(join(dir, 'sessions', id + '.json'), 'utf8'));
  expect(state.mission.attempts[0]).toMatchObject({ status: 'failed', error: 'Interrupted by crash' });
  expect(state.mission.state).toBe('completed'); expect(await readFile(join(dir, 'work/count'), 'utf8')).toBe('x');
  expect(await readFile(join(state.mission.directory, 'progress_log.jsonl'), 'utf8')).toContain('crash_reconciled');
}, 15000);

test('concurrent stale-lock acquirers cannot steal a newly owned lock', async () => {
  const dir = await root(), session = join(dir, 'sessions'); await mkdir(session);
  await writeFile(join(session, 'race.json.lock'), JSON.stringify({ pid: await deadPid(), startedAt: Date.now() }));
  const stores = await Promise.all([SessionStore.create(session), SessionStore.create(session)]);
  const claims = await Promise.allSettled(stores.map(s => s.acquire('race')));
  expect(claims.filter(c => c.status === 'fulfilled')).toHaveLength(1);
  const owner = JSON.parse(await readFile(join(session, 'race.json.lock'), 'utf8')); expect(owner.pid).toBe(process.pid);
  for (const store of stores) await store.close();
});

test('reused tool IDs from a prior completed turn do not hide the current interrupted call', async () => {
  const state = snapshot('repeat', '/tmp'), previous = structuredClone(state.messages[1]!);
  state.messages.splice(1, 0, previous, { role: 'tool', tool_call_id: 'tool', content: 'old result' }, { role: 'user', content: 'another turn' });
  reconcile(state, [{ seq: 1, at: 1, pid: process.pid, type: 'tool_start', toolCallId: 'tool', name: 'Create', effect: 'write' }]);
  expect(state.messages.filter(m => m.role === 'tool').map(m => m.content)).toEqual(['old result', 'interrupted; effect uncertain, verify before repeating']);
  expect(state.pending).toEqual([]);
});

test('cancellation after durable background tool_end kills an already started namespace subtree', async () => {
  const dir = await root(), cwd = join(dir, 'work'), controller = new AbortController(); let called = false;
  const result = await runCodingAgent({ cwd, sessionDir: join(dir, 'sessions'), prompt: 'background cancel', autonomy: 'high', signal: controller.signal,
    provider: { id: 'fixture', async complete() { if (called) return { text: 'done', finishReason: 'stop', toolCalls: [] }; called = true;
      return { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'background', type: 'function', function: { name: 'Execute', arguments: JSON.stringify({ command: 'sh -c "touch bg-started; sleep 0.5; touch bg-late"', background: true }) } }] }; } },
    afterTool: async () => { await until(() => Bun.file(join(cwd, 'bg-started')).exists()); },
    onEvent: e => { if (e.type === 'tool_result') controller.abort(new Error('cancel after launch')); } });
  expect(result.error?.type).toBe('aborted'); await Bun.sleep(650); expect(await Bun.file(join(cwd, 'bg-late')).exists()).toBe(false);
});
