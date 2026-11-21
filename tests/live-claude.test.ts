import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, symlinkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgent } from '../src/agents.ts';
import { checkReport, claudeLive, liveClaudeArgv } from '../src/live/claude.ts';
import { SessionNotFoundError } from '../src/live/contract.ts';

const base = getAgent('claude').command('hola');
// Config dir del turno: siempre fuera del repo (T41).
const mcpDir = () => join(mkdtempSync(join(tmpdir(), 'live-mcp-')), 'mcp');

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
      const dir = mcpDir();
      await claudeLive.run({ prompt: 'x', cwd: f.dir, attemptId: 'a', mcpConfigDir: dir });
      const argv = readFileSync(join(f.dir, 'argv'), 'utf8');
      expect(argv).not.toMatch(/Bearer|Authorization|127\.0\.0\.1/);
      expect(argv).toMatch(/--mcp-config\n.*\/mcp\/mcp-[0-9a-f-]+\.json\n/);
      expect(existsSync(join(f.dir, '.git', 'fab-live'))).toBe(false); // T41: nada en el git dir
      expect(readdirSync(dir)).toEqual([]); // se borra al terminar el turno
    } finally { f.restore(); }
  });
  test('confine no añade un segundo --mcp-config vacío que pueda ganar al del turno', async () => {
    if (!Bun.which('bwrap')) return;
    const { confineAgent } = await import('../src/sandbox/confine.ts');
    const dir = mkdtempSync(join(tmpdir(), 'live-conf-')); Bun.spawnSync(['git', 'init', '-q', dir]);
    const bin = join(dir, 'probe');
    writeFileSync(bin, `#!/bin/sh
set -eu
count=0
for arg do
  if [ "$arg" = --mcp-config ]; then count=$((count + 1)); fi
done
test "$count" = 1
printf confirmado
`, { mode: 0o755 });
    const c = confineAgent('claude', [bin, ...liveClaudeArgv(base, {}, 'abc', join(dir, '.git/fab-live/m.json'))], dir);
    try {
      expect(c.inspection.mcpConfigCount).toBe(1);
      const child = c.spawn('ignore');
      const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(code).toBe(0);
      expect(stdout).toBe('confirmado');
    } finally {
      c.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('live claude run', () => {
  test('T57e: el argv de Claude nuevo y reanudado lleva un solo --model y un solo --mcp-config', async () => {
    const f = fakeClaude(`echo '{"type":"result","result":"ok","session_id":"x"}'`);
    const dir = mcpDir();
    try {
      Bun.spawnSync(['git', 'init', '-q', f.dir]);
      for (const sessionId of [undefined, 'sesion-existente']) {
        await claudeLive.run({ sessionId, model: 'modelo-t57', prompt: 'x', cwd: f.dir, attemptId: 'a', mcpConfigDir: dir });
        const argv = readFileSync(join(f.dir, 'argv'), 'utf8').trimEnd().split('\n');
        expect(argv.filter(arg => arg === '--model')).toHaveLength(1);
        expect(argv[argv.indexOf('--model') + 1]).toBe('modelo-t57');
        expect(argv.filter(arg => arg === '--mcp-config')).toHaveLength(1);
        expect(argv).toContain(sessionId ? '--resume' : '--session-id');
      }
    } finally {
      f.restore();
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(join(dir, '..'), { recursive: true, force: true });
    }
  });
  test('T99: captura stream-json y conserva el resultado final y su coste', async () => {
    const f = fakeClaude(`cat <<'EOF'
{"type":"system","subtype":"init"}
{"type":"assistant","message":{"content":[{"type":"text","text":"paso"}]}}
{"type":"result","result":"STATUS: done\\nTrabajo hecho","total_cost_usd":0.042,"usage":{"input_tokens":3,"output_tokens":2}}
EOF`);
    const dir = mcpDir();
    try {
      Bun.spawnSync(['git', 'init', '-q', f.dir]);
      const r = await claudeLive.run({ prompt: 'x', cwd: f.dir, attemptId: 'a', mcpConfigDir: dir });
      const argv = readFileSync(join(f.dir, 'argv'), 'utf8').trimEnd().split('\n');
      expect(argv.filter(arg => arg === '--output-format')).toHaveLength(1);
      expect(argv[argv.indexOf('--output-format') + 1]).toBe('stream-json');
      expect(argv).toContain('--verbose');
      expect(r.stdout).toContain('"type":"assistant"');
      expect(r.stdoutForMonitor).toBe(r.stdout?.trimEnd().split('\n').at(-1));
      expect(r.output).toBe('STATUS: done\nTrabajo hecho');
      expect(r.status.kind).toBe('done');
      expect(r.usage).toEqual({ costUsd: 0.042, inputTokens: 3, outputTokens: 2 });
    } finally {
      f.restore();
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(join(dir, '..'), { recursive: true, force: true });
    }
  });
  test('T99-H7: un fallo sin result conserva el diagnóstico por stdout y excluye el stream del monitor', async () => {
    const f = fakeClaude("printf 'Diagnóstico del CLI sin result\\n'; exit 1");
    const dir = mcpDir();
    try {
      Bun.spawnSync(['git', 'init', '-q', f.dir]);
      const r = await claudeLive.run({ prompt: 'x', cwd: f.dir, attemptId: 'a', mcpConfigDir: dir });
      expect(r.exitCode).toBe(1);
      expect(r.output).toBe('Diagnóstico del CLI sin result');
      expect(r.stdoutForMonitor).toBe('');
    } finally {
      f.restore();
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(join(dir, '..'), { recursive: true, force: true });
    }
  });
  test('T99-H4: una mención intermedia no pierde la sesión reanudada', async () => {
    const f = fakeClaude(`cat <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"Documentación: No conversation found"}]}}
{"type":"result","result":"Fallo de otra clase"}
EOF
exit 1`);
    const dir = mcpDir();
    try {
      Bun.spawnSync(['git', 'init', '-q', f.dir]);
      const r = await claudeLive.run({ prompt: 'x', cwd: f.dir, attemptId: 'a', mcpConfigDir: dir, sessionId: 'vigente' });
      expect(r.exitCode).toBe(1);
      expect(r.sessionId).toBe('vigente');
      expect(r.output).toBe('Fallo de otra clase');
    } finally {
      f.restore();
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(join(dir, '..'), { recursive: true, force: true });
    }
  });
  test('unknown session id raises SessionNotFoundError', async () => {
    const f = fakeClaude(`echo "No conversation found with session ID: $2" >&2; exit 1`);
    Bun.spawnSync(['git', 'init', '-q', f.dir]); // hostDir resuelve el git dir
    try {
      await expect(claudeLive.run({ sessionId: 'nope', prompt: 'x', cwd: f.dir, attemptId: 'a', mcpConfigDir: mcpDir() })).rejects.toBeInstanceOf(SessionNotFoundError);
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
    Bun.spawnSync(['git', 'init', '-q', f.dir]);
    try {
      const r = await claudeLive.run({ prompt: 'x', cwd: f.dir, attemptId: 'a1', mcpConfigDir: mcpDir() });
      expect(r.reports).toEqual([{ state: 'awaiting', summary: 's', human_action: 'color?' }]);
      expect(r.attemptId).toBe('a1');
      expect(await Bun.file(join(f.dir, 'bad')).text()).toContain('"isError":true');
      expect(await Bun.file(join(f.dir, 'bad2')).text()).toContain('"isError":true');
    } finally { f.restore(); }
  });
  test('abort kills the turn', async () => {
    const f = fakeClaude('sleep 30');
    Bun.spawnSync(['git', 'init', '-q', f.dir]); // hostDir resuelve el git dir
    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 200);
      const r = await claudeLive.run({ prompt: 'x', cwd: f.dir, attemptId: 'a', signal: ac.signal, mcpConfigDir: mcpDir() });
      expect(r.ok).toBe(false);
      expect(r.durationMs).toBeLessThan(10_000);
    } finally { f.restore(); }
  });
  test('checkReport requires human_action for awaiting', () => {
    expect(checkReport({ state: 'awaiting', summary: 's' })).not.toBeNull();
    expect(checkReport({ state: 'done', summary: 's' })).toBeNull();
  });
});

describe('T40: cableado de claudeProjects', () => {
  test.skipIf(!Bun.which('bwrap'))('dos claudeLive.run confinados seguidos comparten ~/.claude/projects; sin claudeProjects no', async () => {
    const f = fakeClaude(`if [ -f "$HOME/.claude/projects/s" ]; then cat "$HOME/.claude/projects/s" > "$PWD/seen"; else echo t1 > "$HOME/.claude/projects/s"; fi
echo '{"type":"result","result":"ok","session_id":"x"}'`);
    const state = mkdtempSync(join(tmpdir(), 'live-state-'));
    try {
      Bun.spawnSync(['git', 'init', '-q', f.dir]);
      const claudeProjects = join(state, 'live', 'abc', 'claude-projects');
      mkdirSync(claudeProjects, { recursive: true });
      await claudeLive.run({ prompt: 'x', cwd: f.dir, attemptId: 'a', confine: true, claudeProjects, mcpConfigDir: join(state, 'live', 'abc', 'mcp') });
      expect(readFileSync(join(claudeProjects, 's'), 'utf8').trim()).toBe('t1');
      await claudeLive.run({ prompt: 'x', cwd: f.dir, attemptId: 'b', confine: true, claudeProjects, mcpConfigDir: join(state, 'live', 'abc', 'mcp') });
      expect(readFileSync(join(f.dir, 'seen'), 'utf8').trim()).toBe('t1');
    } finally { f.restore(); rmSync(state, { recursive: true, force: true }); }
  });
});

describe('T41: la config MCP (con el token) no vive donde el sandbox escribe', () => {
  test.skipIf(!Bun.which('bwrap'))('fab-live cambiado por un symlink no hace que el host escriba en la víctima; el agente ve la config en solo lectura', async () => {
    // El agente confinado ve la config en la ruta fija y no puede escribirla.
    const f = fakeClaude(`cat /opt/fab-mcp/mcp.json > "$PWD/seen"; if echo x >> /opt/fab-mcp/mcp.json 2>/dev/null; then echo rw > "$PWD/rw"; fi
echo '{"type":"result","result":"ok","session_id":"x"}'`);
    const state = mkdtempSync(join(tmpdir(), 'live-state-')), victim = mkdtempSync(join(tmpdir(), 'live-victim-'));
    try {
      Bun.spawnSync(['git', 'init', '-q', f.dir]);
      symlinkSync(victim, join(f.dir, '.git', 'fab-live')); // lo que el agente dejó en el turno anterior
      const mcpConfigDir = join(state, 'live', 'abc', 'mcp');
      await claudeLive.run({ prompt: 'x', cwd: f.dir, attemptId: 'a', confine: true, mcpConfigDir });
      expect(readdirSync(victim)).toEqual([]);
      expect(readFileSync(join(f.dir, 'argv'), 'utf8')).toContain('/opt/fab-mcp/mcp.json');
      expect(JSON.parse(readFileSync(join(f.dir, 'seen'), 'utf8')).mcpServers.fab).toBeDefined();
      expect(existsSync(join(f.dir, 'rw'))).toBe(false);
      expect(readdirSync(mcpConfigDir)).toEqual([]); // se borra al terminar el turno
    } finally { f.restore(); rmSync(state, { recursive: true, force: true }); rmSync(victim, { recursive: true, force: true }); }
  });
  test('sin mcpConfigDir (confinado o no) falla cerrado, sin lanzar nada', async () => {
    const f = fakeClaude(`echo '{"type":"result","result":"ok","session_id":"x"}'`);
    try {
      Bun.spawnSync(['git', 'init', '-q', f.dir]);
      for (const confine of [true, false]) await expect(claudeLive.run({ prompt: 'x', cwd: f.dir, attemptId: 'a', confine })).rejects.toThrow(/mcpConfigDir/);
      expect(existsSync(join(f.dir, 'argv'))).toBe(false);
      expect(existsSync(join(f.dir, '.git', 'fab-live'))).toBe(false);
    } finally { f.restore(); }
  });
  test('stateDir dentro del git dir y mcp/ cambiado por un symlink a una víctima: el turno falla y la víctima queda intacta', async () => {
    const f = fakeClaude(`echo '{"type":"result","result":"ok","session_id":"x"}'`), victim = mkdtempSync(join(tmpdir(), 'live-victim-'));
    try {
      Bun.spawnSync(['git', 'init', '-q', f.dir]);
      const live = join(f.dir, '.git', 'state', 'live', 'abc');
      mkdirSync(live, { recursive: true });
      symlinkSync(victim, join(live, 'mcp'));
      for (const confine of [true, false]) await expect(claudeLive.run({ prompt: 'x', cwd: f.dir, attemptId: 'a', confine, mcpConfigDir: join(live, 'mcp') })).rejects.toThrow(/symlink/);
      expect(readdirSync(victim)).toEqual([]);
      expect(existsSync(join(f.dir, 'argv'))).toBe(false);
    } finally { f.restore(); rmSync(victim, { recursive: true, force: true }); }
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

describe('T72f: servidores del rol en la configuración del turno', () => {
  const CANARY = 'canario-mcp-7788';
  const tracker = { type: 'sse', url: 'https://mcp.ejemplo.dev/sse', headers: { Authorization: 'Bearer ${TRACKER_TOKEN}' } };
  const run = async (turn: Record<string, unknown>) => {
    // El stand-in copia la configuración que recibe antes de que el turno la borre.
    const f = fakeClaude(`for a in "$@"; do [ "$p" = 1 ] && cat "$a" > "${'$'}{0%/*}/cfg.json"; p=0; [ "$a" = --mcp-config ] && p=1; done\nprintenv TRACKER_TOKEN > "${'$'}{0%/*}/token"\necho '{"type":"result","result":"ok","session_id":"x"}'`);
    const dir = mcpDir();
    try {
      Bun.spawnSync(['git', 'init', '-q', f.dir]);
      const saved = process.env.TRACKER_TOKEN;
      process.env.TRACKER_TOKEN = CANARY;
      try { await claudeLive.run({ prompt: 'x', cwd: f.dir, attemptId: 'a', mcpConfigDir: dir, ...turn }); }
      finally { if (saved === undefined) delete process.env.TRACKER_TOKEN; else process.env.TRACKER_TOKEN = saved; }
      return { argv: readFileSync(join(f.dir, 'argv'), 'utf8'), cfg: JSON.parse(readFileSync(join(f.dir, 'cfg.json'), 'utf8')), token: readFileSync(join(f.dir, 'token'), 'utf8').trim(), left: readdirSync(dir) };
    } finally { f.restore(); rmSync(f.dir, { recursive: true, force: true }); rmSync(join(dir, '..'), { recursive: true, force: true }); }
  };
  test('un solo --mcp-config con fab y los servidores del rol; referencias sin resolver, el valor solo por entorno (B7)', async () => {
    const r = await run({ mcpServers: { tracker }, envDecl: { wsAllow: ['TRACKER_TOKEN'], channel: false, roleEnv: ['TRACKER_TOKEN'], mcpRequired: [] } });
    expect(r.argv.split('\n').filter(a => a === '--mcp-config')).toHaveLength(1);
    expect(r.argv.split('\n').filter(a => a === '--strict-mcp-config')).toHaveLength(1);
    expect(Object.keys(r.cfg.mcpServers).sort()).toEqual(['fab', 'tracker']);
    expect(r.cfg.mcpServers.tracker.headers.Authorization).toBe('Bearer ${TRACKER_TOKEN}');
    expect(JSON.stringify(r.cfg) + r.argv).not.toContain(CANARY);
    expect(r.token).toBe(CANARY);
    expect(r.left).toEqual([]);
  });
  test('un change de canal (sin servidores del rol) lleva solo fab', async () => {
    expect(Object.keys((await run({ mcpServers: {} })).cfg.mcpServers)).toEqual(['fab']);
  });
  test('un servidor del rol llamado fab no sustituye al del turno', async () => {
    const r = await run({ mcpServers: { fab: { type: 'http', url: 'https://otro.dev/x' } } });
    expect(r.cfg.mcpServers.fab.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });
  test('B9: un symlink plantado en el directorio de la configuración hace fallar el turno cerrado, también con servidores del rol', async () => {
    const f = fakeClaude('exit 0');
    try {
      Bun.spawnSync(['git', 'init', '-q', f.dir]);
      const live = mkdtempSync(join(tmpdir(), 'live-sym-')), victim = mkdtempSync(join(tmpdir(), 'live-victim-'));
      symlinkSync(victim, join(live, 'mcp'));
      await expect(claudeLive.run({ prompt: 'x', cwd: f.dir, attemptId: 'a', mcpConfigDir: join(live, 'mcp'), mcpServers: { tracker } })).rejects.toThrow(/symlink/);
      expect(readdirSync(victim)).toEqual([]);
    } finally { f.restore(); }
  });
});
