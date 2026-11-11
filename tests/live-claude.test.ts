import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgent } from '../src/agents.ts';
import { checkReport, claudeLive, liveClaudeArgv } from '../src/live/claude.ts';
import { SessionNotFoundError } from '../src/live/contract.ts';

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
    const argv = liveClaudeArgv(base, {}, 'abc', '/g/mcp.json');
    expect(argv.slice(argv.indexOf('--session-id'), argv.indexOf('--session-id') + 2)).toEqual(['--session-id', 'abc']);
    expect(argv).not.toContain('--resume');
    expect(argv).toContain('--strict-mcp-config');
    expect(argv[argv.indexOf('--mcp-config') + 1]).toBe('/g/mcp.json');
  });
  test('resumed turn uses --resume and no --session-id', () => {
    const argv = liveClaudeArgv(base, { sessionId: 'abc' }, 'abc', '/g/mcp.json');
    expect(argv[argv.indexOf('--resume') + 1]).toBe('abc');
    expect(argv).not.toContain('--session-id');
  });
});

describe('T34: flags repetidos y token fuera de argv', () => {
  test('un solo --allowedTools (el del adaptador, ampliado con la tool report) y un solo --mcp-config', () => {
    const argv = liveClaudeArgv(base, {}, 'abc', '/g/mcp.json');
    expect(argv.filter(a => a === '--allowedTools').length).toBe(1);
    expect(argv.filter(a => a === '--mcp-config').length).toBe(1);
    expect(argv.filter(a => a === '--strict-mcp-config').length).toBe(1);
    const tools = argv[argv.indexOf('--allowedTools') + 1]!.split(',');
    expect(tools).toContain('mcp__fab__report'); expect(tools).toContain('Read'); // no se pierden las del adaptador
  });
  test('el token del turno no aparece en argv: el argv real del turno solo lleva la ruta del archivo 0600', async () => {
    const f = fakeClaude(`echo '{"type":"result","result":"ok","session_id":"x"}'`);
    try {
      Bun.spawnSync(['git', 'init', '-q', f.dir]);
      await claudeLive.run({ prompt: 'x', cwd: f.dir, attemptId: 'a' });
      const argv = readFileSync(join(f.dir, 'argv'), 'utf8');
      expect(argv).not.toMatch(/Bearer|Authorization|127\.0\.0\.1/);
      expect(argv).toMatch(/--mcp-config\n.*\/fab-live\/mcp-[0-9a-f-]+\.json\n/);
      expect(existsSync(join(f.dir, '.git', 'fab-live'))).toBe(true);
      expect(readdirSync(join(f.dir, '.git', 'fab-live'))).toEqual([]); // se borra al terminar el turno
    } finally { f.restore(); }
  });
  test('confine no añade un segundo --mcp-config vacío que pueda ganar al del turno', async () => {
    const { confineAgent } = await import('../src/sandbox/confine.ts');
    const dir = mkdtempSync(join(tmpdir(), 'live-conf-')); Bun.spawnSync(['git', 'init', '-q', dir]);
    if (!Bun.which('bwrap')) return; // sin bubblewrap no hay nada que comprobar
    const c = confineAgent('claude', ['claude', ...liveClaudeArgv(base, {}, 'abc', join(dir, '.git/fab-live/m.json'))], dir) as { argv?: string[]; command?: string[] };
    const all = JSON.stringify(c);
    expect((all.match(/--mcp-config/g) ?? []).length).toBe(1);
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
for a in "$@"; do [ "$p" = 1 ] && cfgf=$a; p=0; [ "$a" = --mcp-config ] && p=1; done
cfg=$(cat "$cfgf")
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
