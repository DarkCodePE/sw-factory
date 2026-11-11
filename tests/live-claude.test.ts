import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgent } from '../src/agents.ts';
import { checkReport, claudeLive, liveClaudeArgv } from '../src/live/claude.ts';
import { SessionNotFoundError } from '../src/live/contract.ts';

const mcp = { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer x' } };
const base = getAgent('claude').command('hola');

// A stand-in `claude` on PATH: prints its argv to a file, then acts per FAKE_MODE.
function fakeClaude(script: string) {
  const dir = mkdtempSync(join(tmpdir(), 'live-claude-'));
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\n${script}\n`);
  chmodSync(join(dir, 'claude'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  return { dir, restore: () => { process.env.PATH = saved; } };
}

describe('live claude argv', () => {
  test('new turn uses --session-id with the given uuid', () => {
    const argv = liveClaudeArgv(base, {}, 'abc', mcp);
    expect(argv.slice(argv.indexOf('--session-id'), argv.indexOf('--session-id') + 2)).toEqual(['--session-id', 'abc']);
    expect(argv).not.toContain('--resume');
    expect(argv).toContain('--strict-mcp-config');
    expect(JSON.parse(argv[argv.indexOf('--mcp-config') + 1]!).mcpServers.fab).toEqual(mcp);
    expect(argv.at(-1)).toBe('mcp__fab__report');
  });
  test('resumed turn uses --resume and no --session-id', () => {
    const argv = liveClaudeArgv(base, { sessionId: 'abc' }, 'abc', mcp);
    expect(argv[argv.indexOf('--resume') + 1]).toBe('abc');
    expect(argv).not.toContain('--session-id');
  });
});

describe('live claude run', () => {
  test('unknown session id raises SessionNotFoundError', async () => {
    const f = fakeClaude(`echo "No conversation found with session ID: $2" >&2; exit 1`);
    try {
      await expect(claudeLive.run({ sessionId: 'nope', prompt: 'x', cwd: f.dir, attemptId: 'a' })).rejects.toBeInstanceOf(SessionNotFoundError);
    } finally { f.restore(); }
  });
  test('valid and invalid reports reach the agent through the MCP tool', async () => {
    // The stand-in reads the MCP config from its argv and calls `report` like a real agent would.
    const f = fakeClaude(`
cfg=$(printf '%s\\n' "$@" | grep mcpServers)
url=$(printf '%s' "$cfg" | sed 's/.*"url":"\\([^"]*\\)".*/\\1/')
auth=$(printf '%s' "$cfg" | sed 's/.*"Authorization":"\\([^"]*\\)".*/\\1/')
call() { curl -s -H "Authorization: $auth" -d "$1" "$url"; echo; }
call '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"report","arguments":{"state":"awaiting","summary":"s"}}}' > "${'$'}{0%/*}/bad"
call '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"report","arguments":{"state":"awaiting","summary":"s","human_action":"color?"}}}'
call '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"report","arguments":{"state":"nope","summary":"s"}}}' > "${'$'}{0%/*}/bad2"
echo '{"type":"result","result":"ok","session_id":"x"}'`);
    try {
      const r = await claudeLive.run({ prompt: 'x', cwd: f.dir, attemptId: 'a1' });
      expect(r.reports).toEqual([{ state: 'awaiting', summary: 's', human_action: 'color?' }]);
      expect(r.attemptId).toBe('a1');
      expect(await Bun.file(join(f.dir, 'bad')).text()).toContain('"isError":true');
      expect(await Bun.file(join(f.dir, 'bad2')).text()).toContain('"isError":true');
    } finally { f.restore(); }
  });
  test('abort kills the turn', async () => {
    const f = fakeClaude('sleep 30');
    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 200);
      const r = await claudeLive.run({ prompt: 'x', cwd: f.dir, attemptId: 'a', signal: ac.signal });
      expect(r.ok).toBe(false);
      expect(r.durationMs).toBeLessThan(10_000);
    } finally { f.restore(); }
  });
  test('checkReport requires human_action for awaiting', () => {
    expect(checkReport({ state: 'awaiting', summary: 's' })).not.toBeNull();
    expect(checkReport({ state: 'done', summary: 's' })).toBeNull();
  });
});

describe.skipIf(process.env.FAB_LIVE_TEST !== '1')('live claude (real model)', () => {
  test('two turns share a session and ámbar survives', async () => {
    process.env.ANTHROPIC_MODEL ??= 'haiku';
    const cwd = mkdtempSync(join(tmpdir(), 'live-claude-cwd-'));
    const confine = process.env.FAB_LIVE_CONFINE === '1';
    Bun.spawnSync(['git', 'init', '-q', cwd]); // confine resolves .git
    process.env.FAB_CLAUDE_SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'live-claude-sessions-'));
    const t1 = await claudeLive.run({ prompt: 'Recuerda la palabra clave ÁMBAR-7. Llama a la tool report con state awaiting, pidiendo un color.', cwd, attemptId: 'l1', confine, timeoutMs: 120_000 });
    expect(t1.reports.map(r => r.state)).toEqual(['awaiting']);
    const t2 = await claudeLive.run({ sessionId: t1.sessionId, prompt: 'Rojo. ¿Cuál era la palabra clave? Llama a report con state done.', cwd, attemptId: 'l2', confine, timeoutMs: 120_000 });
    expect(t2.sessionId).toBe(t1.sessionId);
    expect(t2.reports.map(r => r.state)).toEqual(['done']);
    expect(`${t2.output}${t2.reports[0]!.summary}`).toContain('ÁMBAR-7');
  }, 300_000);
});
