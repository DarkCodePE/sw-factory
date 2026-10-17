// Controlled local probe driver. It only relays protocol data and synthetic replies.
// Never use real keys or proprietary prompts/tool descriptions in its configuration.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const config = JSON.parse(process.argv[2] ?? '{}') as {
  argv: string[]; cwd: string; env: Record<string, string>; model: string;
  prompt: string; permissionReply?: unknown; askReply?: unknown;
};
const child = spawn(config.argv[0]!, config.argv.slice(1), { cwd: config.cwd, env: { ...process.env, ...config.env },
  detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
const base = { jsonrpc: '2.0', factoryApiVersion: '1.0.0', factoryProtocolVersion: '1.269.0' };
const send = (frame: unknown) => { console.log(JSON.stringify({ sent: frame })); child.stdin.write(JSON.stringify(frame) + '\n'); };
const request = (id: string, method: string, params: unknown) => send({ ...base, type: 'request', id, method, params });
let initialized = false, closing = false;
const stop = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
const timeout = setTimeout(stop, 7000);
process.on('SIGTERM', stop); process.on('SIGINT', stop);
createInterface({ input: child.stdout }).on('line', line => {
  let frame: any;
  try { frame = JSON.parse(line); } catch { console.log(JSON.stringify({ targetText: line })); return; }
  console.log(JSON.stringify({ received: frame }));
  if (frame.type === 'response' && frame.id === 'init' && !initialized) {
    initialized = true;
    if (frame.error) { closing = true; request('close', 'droid.close_session', {}); }
    else request('message', 'droid.add_user_message', { text: config.prompt });
  }
  if (frame.type === 'request' && frame.method === 'droid.request_permission' && config.permissionReply !== undefined) {
    send({ ...base, type: 'response', id: frame.id, result: config.permissionReply });
  }
  if (frame.type === 'request' && frame.method === 'droid.ask_user' && config.askReply !== undefined) {
    send({ ...base, type: 'response', id: frame.id, result: config.askReply });
  }
  if (frame.params?.notification?.type === 'agent_turn_completed' && !closing) {
    closing = true; request('close', 'droid.close_session', {});
  }
});
child.stderr.on('data', data => console.error(String(data)));
child.once('spawn', () => request('init', 'droid.initialize_session', {
  machineId: 'replica-controlled-probe', cwd: config.cwd, modelId: config.model,
}));
child.once('close', code => { clearTimeout(timeout); process.exitCode = code ?? 1; });
