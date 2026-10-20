// Offline end-to-end probe of the compiled TUI, with fresh permission replies.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashFile } from './release/common.mjs';

const binary = resolve(process.argv[2] ?? 'dist/fab-linux-x64');
const root = await mkdtemp(join(tmpdir(), 'fab-network-artifact-'));
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
let hits = 0, network = true, toolResult = '', command = '';
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  if (new URL(req.url).pathname === '/probe') { hits++; return new Response('compiled-network-ok'); }
  const body = await req.json() as any, result = body.messages.findLast((m: any) => m.role === 'tool');
  if (result) toolResult = result.content;
  return Response.json({ choices: [{ message: result ? { role: 'assistant', content: 'network fixture complete' }
    : { role: 'assistant', content: null, tool_calls: [{ id: 'compiled-network', type: 'function', function: { name: 'Execute', arguments: JSON.stringify({ command, network }) } }] }, finish_reason: result ? 'stop' : 'tool_calls' }] });
} });
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
// Pipes intentionally cannot approve a fresh TUI permission. Use a real PTY;
// reply only after observing the actual prompt, like a human at the terminal.
const bridge = `
import os, pty, selectors, signal, subprocess, sys
master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
selector = selectors.DefaultSelector()
selector.register(master, selectors.EVENT_READ)
selector.register(0, selectors.EVENT_READ)
signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
try:
    running = True
    while running:
        for key, _ in selector.select(0.2):
            if key.fd == master:
                try: data = os.read(master, 65536)
                except OSError: running = False; break
                if not data: running = False; break
                os.write(1, data)
            else:
                data = os.read(0, 65536)
                if data: os.write(master, data)
                else: selector.unregister(0)
    sys.exit(child.wait())
finally:
    selector.close()
    os.close(master)
    if child.poll() is None: os.killpg(child.pid, signal.SIGKILL)
`;
const proofs: any[] = [];
try {
  const cwd = join(root, 'workspace'), settings = join(root, 'settings.json'); await mkdir(cwd);
  await writeFile(settings, JSON.stringify({ modelId: 'custom:network-probe', customModels: [{ id: 'custom:network-probe', model: 'fixture', provider: 'generic-chat-completion-api', baseUrl: server.url.href + 'v1' }] }));
  const script = `fetch(${JSON.stringify(server.url.href + 'probe')},{signal:AbortSignal.timeout(1000)}).then(async r=>console.log(await r.text())).catch(()=>{console.error('offline');process.exitCode=2})`;
  command = `${quote(Bun.which('node')!)} -e ${quote(script)}`;
  for (const scenario of [
    { name: 'low-approve', auto: 'low', policy: 'auto', requested: true, answer: 's', prompts: 1, hits: 1 },
    { name: 'medium-reject', auto: 'medium', policy: 'auto', requested: true, answer: 'n', prompts: 1, hits: 0 },
    { name: 'high-automatic', auto: 'high', policy: 'auto', requested: true, answer: '', prompts: 0, hits: 1 },
    { name: 'high-policy-deny', auto: 'high', policy: 'deny', requested: true, answer: '', prompts: 0, hits: 0 },
    { name: 'high-no-request', auto: 'high', policy: 'auto', requested: false, answer: '', prompts: 0, hits: 0 },
  ]) {
    hits = 0; toolResult = ''; network = scenario.requested;
    const home = join(root, scenario.name); await mkdir(home);
    const outcome = await new Promise<{ code: number | null; out: string; err: string; prompts: number }>((resolve, reject) => {
      const child = spawn('python3', ['-u', '-c', bridge, binary, 'tui', '--cwd', cwd, '--settings', settings, '--auto', scenario.auto, '--sandbox-network', scenario.policy, '--timeout-ms', '10000'],
        { env: { PATH: process.env.PATH ?? '', HOME: home, FABRICA_HOME: home, TERM: 'dumb' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '', answered = false, exited = false, prompts = 0;
      const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
      child.stdout.on('data', data => {
        out += String(data);
        if (!answered && out.includes('¿Permitir una vez?')) {
          answered = true; prompts++;
          check(hits === 0, 'Process connected before approval');
          setTimeout(() => child.stdin.write(scenario.answer + '\n'), 10);
        }
        if (!exited && /\d+ turnos · \d+ tools/.test(out)) { exited = true; setTimeout(() => child.stdin.end('/exit\n'), 10); }
      });
      child.stderr.on('data', data => { err += String(data); });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => { clearTimeout(timer); resolve({ code, out, err, prompts }); });
      child.stdin.write('Run the connection probe.\n');
    });
    check(outcome.code === 0, `${scenario.name}: compiled TUI failed: ${outcome.err}`);
    check(outcome.prompts === scenario.prompts && hits === scenario.hits, `${scenario.name}: wrong approval/network behavior (${outcome.prompts} prompts, ${hits} requests). Tool: ${toolResult}. Transcript: ${outcome.out}`);
    if (scenario.prompts) check(outcome.out.includes('No se limita la conexión a un dominio concreto'), 'Permission did not state the real network scope');
    if (scenario.name === 'high-automatic') check(outcome.out.includes('Red autorizada automáticamente'), 'Automatic grant was not visible');
    if (scenario.hits) { const result = JSON.parse(toolResult); check(result.exitCode === 0 && result.sandboxed === true && result.network.enabled === true, 'Connected command lost sandbox or metadata'); }
    else if (scenario.requested) check(toolResult.startsWith('Error:'), 'Denied request did not return a tool error');
    else check(JSON.parse(toolResult).network.enabled === false && JSON.parse(toolResult).exitCode === 2, 'Offline default escaped isolation');
    proofs.push({ scenario: scenario.name, permissionPrompts: outcome.prompts, requests: hits, passed: true });
  }
  const receipt = { schemaVersion: 1, binary, sha256: await hashFile(binary), localProvider: true, localHTTP: true, realPTY: true, freshHomes: true, proofs };
  if (process.argv[3]) await writeFile(resolve(process.argv[3]), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
