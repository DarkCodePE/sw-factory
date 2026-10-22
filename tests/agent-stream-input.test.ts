import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mockModel } from './agent-stream-input-fixture.test.ts';
const roots: string[] = [], clean: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of clean.splice(0)) await fn(); for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
async function fixture(extra: string[] = [], hookFile?: unknown, enabledSetting?: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'fab-stream-')); roots.push(root); const cwd = join(root, 'work'); await mkdir(cwd);
  if (hookFile) { await mkdir(join(cwd, '.fab')); await writeFile(join(cwd, '.fab/hooks.json'), JSON.stringify(hookFile)); }
  const { server, requests } = mockModel(); clean.push(async () => server.stop(true));
  const settings = join(root, 'settings.json'); await writeFile(settings, JSON.stringify({ modelId: 'custom:fixture', customModels: [{ id: 'custom:fixture', model: 'fixture', provider: 'generic-chat-completion-api', baseUrl: server.url.href + 'v1' }], ...(enabledSetting !== undefined ? { hooks: { enabled: enabledSetting } } : {}) }));
  const child = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, '../src/cli.ts'), 'exec', '--cwd', cwd, '--settings', settings, '--session-dir', join(root, 'sessions'), '--auto', 'high', '--input-format', 'stream-json', '-o', 'stream-json', ...extra], { cwd: root, env: { PATH: process.env.PATH!, HOME: root }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const frames: any[] = [], output = (async () => { let buffer = ''; for await (const data of child.stdout) { buffer += new TextDecoder().decode(data); let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line.trim()) frames.push(JSON.parse(line)); } } })();
  const error = new Response(child.stderr).text(); clean.push(async () => { child.kill('SIGKILL'); await child.exited; await output; });
  return { root, cwd, child, frames, requests, error, async end() { child.stdin.end(); const status = await child.exited; await output; return status; } };
}
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 5000; while (!await check()) { if (Date.now() > end) throw new Error('Wait timeout'); await Bun.sleep(4); } }
const frame = (value: unknown) => JSON.stringify(value) + '\n';

test('three stream-json prompts reuse a persisted session, turn_end and session hooks exactly once', async () => {
  const f = await fixture(['--hooks'], { SessionStart: [{ hooks: [{ type: 'command', command: 'printf start' }] }], SessionEnd: [{ hooks: [{ type: 'command', command: 'touch ended' }] }] });
  f.child.stdin.write(['one', 'two', 'three'].map(content => frame({ type: 'user', content })).join(''));
  expect(await f.end()).toBe(0); expect((await f.error)).toContain('deprecado, usa stream-jsonrpc');
  const ends = f.frames.filter(e => e.type === 'turn_end'); expect(ends).toHaveLength(3); expect(new Set(ends.map(e => e.sessionId)).size).toBe(1);
  const snapshot = JSON.parse(await readFile(join(f.root, 'sessions', ends[0].sessionId + '.json'), 'utf8')); expect(snapshot.turns).toBe(3);
  expect(f.frames.filter(e => e.type === 'hook' && e.event === 'SessionStart')).toHaveLength(1); expect(f.frames.filter(e => e.type === 'hook' && e.event === 'SessionEnd')).toHaveLength(1);
  expect(await Bun.file(join(f.cwd, 'ended')).exists()).toBe(true);
});

test('invalid/oversized lines are rejected, framing recovers and valid image/text content is accepted', async () => {
  const f = await fixture(); f.child.stdin.write('bad-json\n' + 'x'.repeat(1024 * 1024 + 1) + '\n' + frame({ type: 'user', content: [{ type: 'text', text: 'one' }, { type: 'image', mime: 'image/png', data: 'YQ==' }] }) + frame({ type: 'end' }));
  expect(await f.end()).toBe(0); const errors = await f.error; expect(errors).toContain('line exceeds 1 MiB'); expect(errors).toContain('stream-json:'); expect(f.frames.filter(e => e.type === 'turn_end')).toHaveLength(1);
  expect(JSON.stringify(f.requests[0].messages)).toContain('data:image/png;base64,YQ==');
});

test('incompatible output, positional prompt, file and mission fail before a turn', async () => {
  for (const args of [['-o', 'text'], ['prompt'], ['--mission'], ['-f', 'absent']]) {
    const f = await fixture(args); expect(await f.end()).toBe(1); expect(await f.error).toContain('requires -o stream-json'); expect(f.frames.some(e => e.type === 'turn_end')).toBe(false);
  }
});

test('interrupt drains Execute, reconciles this proven drained turn and accepts another prompt; SIGINT closes', async () => {
  const f = await fixture(); f.child.stdin.write(frame({ type: 'user', content: 'slow' }));
  await until(() => Bun.file(join(f.cwd, 'started')).exists());
  f.child.stdin.write(frame({ type: 'interrupt' }) + frame({ type: 'user', content: 'next' }));
  await until(() => f.frames.filter(e => e.type === 'turn_end').length === 2);
  const turns = f.frames.filter(e => e.type === 'turn_end'); expect(turns.map(t => t.ok)).toEqual([false, true]); expect(turns[0].sessionId).toBe(turns[1].sessionId);
  expect(f.frames.some(e => e.type === 'reconciled')).toBe(true); expect(await readFile(join(f.cwd, 'count'), 'utf8')).toBe('x'); expect(await Bun.file(join(f.cwd, 'late')).exists()).toBe(false);
  f.child.kill('SIGINT'); expect(await f.end()).toBe(130);
});

test('settings hooks.enabled activates hooks without --hooks', async () => {
  const f = await fixture([], { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'printf enabled-via-settings' }] }] }, true);
  f.child.stdin.write(frame({ type: 'user', content: 'one' })); expect(await f.end()).toBe(0);
  expect(JSON.stringify(f.requests)).toContain('enabled-via-settings'); expect(f.frames.some(e => e.type === 'hook')).toBe(true);
});

test('a later image-only prompt is preserved when the session is loaded', async () => {
  const f = await fixture(); f.child.stdin.write(frame({ type: 'user', content: 'one' }) + frame({ type: 'user', content: [{ type: 'image', mime: 'image/png', data: 'YQ==' }] }));
  expect(await f.end()).toBe(0); expect(f.requests).toHaveLength(2);
  expect(f.requests[1].messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: '' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] });
});

test('a hook-blocked prompt never leaks into the next turn or persisted history', async () => {
  const f = await fixture(['--hooks'], { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'payload=$(cat); case "$payload" in *BLOCK_ME*) exit 2;; *) true;; esac' }] }] });
  f.child.stdin.write(frame({ type: 'user', content: 'BLOCK_ME' }) + frame({ type: 'user', content: 'next' }));
  expect(await f.end()).toBe(0); expect(f.frames.filter(e => e.type === 'turn_end').map(e => e.ok)).toEqual([false, true]);
  expect(JSON.stringify(f.requests)).not.toContain('BLOCK_ME');
  const id = f.frames.find(e => e.type === 'turn_end').sessionId;
  expect(await readFile(join(f.root, 'sessions', id + '.json'), 'utf8')).not.toContain('BLOCK_ME');
});
