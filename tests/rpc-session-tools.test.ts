import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExecRpc } from '../src/agent/rpc.ts';
import type { ModelProvider, ModelTurn } from '../src/agent/types.ts';

const roots: string[] = [];
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
const request = (id: string, method: string, params = {}) => ({ jsonrpc: '2.0', type: 'request', id, method: 'droid.' + method, params });
const turn = (name?: string, input = {}): ModelTurn => ({ text: name ? '' : 'done', finishReason: name ? 'tool_calls' : 'stop',
  toolCalls: name ? [{ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(input) } }] : [] });
async function fixture(turns: ModelTurn[]) {
  const cwd = await mkdtemp(join(tmpdir(), 'fab-rpc-staged-')); roots.push(cwd);
  const frames: any[] = [];
  const provider: ModelProvider = { id: 'actual-provider-id', async complete() { return turns.shift() ?? turn(); } };
  const rpc = new ExecRpc({ cwd, sessionDir: join(cwd, 'sessions'), providers: { alias: provider, other: { ...provider, id: 'other-id' } },
    defaultModelId: 'alias' }, frame => frames.push(frame));
  return { cwd, frames, rpc };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() >= deadline) throw new Error('RPC timeout'); await Bun.sleep(2); }
}

test('RPC notifies staged settings without applying; Exit uses bidirectional approval, updates mode and invalidates catalog', async () => {
  const f = await fixture([turn('StageSettingsChanges', { modelId: 'other', autonomy: 'off', networkPolicy: 'deny' }), turn('ExitSpecMode'), turn()]);
  try {
    await f.rpc.accept(request('init', 'initialize_session', { machineId: 'local', interactionMode: 'spec', autonomyLevel: 'low' }));
    await f.rpc.accept(request('catalog', 'list_tools'));
    const tools = f.frames.find(x => x.id === 'catalog').result.tools;
    expect(tools.some((t: any) => t.llmId === 'ExitSpecMode')).toBe(true);
    expect(tools.find((t: any) => t.llmId === 'StageSettingsChanges').schema.function.parameters.properties.modelId.enum).toEqual(['alias', 'other']);
    await f.rpc.accept(request('m', 'add_user_message', { text: 'proponer y salir' }));
    await until(() => f.frames.some(x => x.method === 'droid.request_permission'));
    const permission = f.frames.find(x => x.method === 'droid.request_permission');
    expect(permission.params.toolUses[0].confirmationType).toBe('exit_spec_mode');
    expect(f.frames.find(x => x.params?.notification?.type === 'fab_settings_staged').params.notification.proposal)
      .toMatchObject({ changes: { modelId: 'other', autonomy: 'off', networkPolicy: 'deny' }, applied: false });
    await f.rpc.accept({ jsonrpc: '2.0', type: 'response', id: permission.id, result: { selectedOption: 'proceed_once' } });
    await until(() => f.frames.some(x => x.params?.notification?.type === 'agent_turn_completed'));
    expect(f.frames.find(x => x.params?.notification?.type === 'fab_mode_changed').params.notification)
      .toMatchObject({ interactionMode: 'auto', autonomyLevel: 'low' });
    await f.rpc.accept(request('after', 'list_tools'));
    expect(f.frames.find(x => x.id === 'after').result.tools.some((t: any) => t.llmId === 'ExitSpecMode')).toBe(false);
    await f.rpc.accept(request('unchanged', 'update_session_settings'));
    expect(f.frames.find(x => x.id === 'unchanged').result).toEqual({});
    const settings = f.frames.filter(x => x.params?.notification?.type === 'settings_updated').at(-1).params.notification.settings;
    expect(settings).toMatchObject({ modelId: 'alias', autonomyLevel: 'low', interactionMode: 'auto', networkPolicy: 'deny' });
    expect(settings.fab_execution_policy.permissionMode).toBe('standard');
  } finally { await f.rpc.shutdown(); }
});

test('RPC interruption during Exit confirmation never publishes a mode change', async () => {
  const f = await fixture([turn('ExitSpecMode')]);
  try {
    await f.rpc.accept(request('i', 'initialize_session', { machineId: 'local', interactionMode: 'spec' }));
    await f.rpc.accept(request('m', 'add_user_message', { text: 'salir' }));
    await until(() => f.frames.some(x => x.method === 'droid.request_permission'));
    await f.rpc.accept(request('stop', 'interrupt_session'));
    expect(f.frames.some(x => x.params?.notification?.type === 'fab_mode_changed')).toBe(false);
    expect(f.frames.find(x => x.params?.notification?.type === 'agent_turn_completed').params.notification.reason).toBe('interrupted');
  } finally { await f.rpc.shutdown(); }
});

test('CLI --list-tools applies mode and wire-id removal filters for the three tools', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'fab-tools-catalog-')); roots.push(cwd);
  const entry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  for (const spec of [false, true]) {
    const child = Bun.spawn([process.execPath, '--no-env-file', entry, 'exec', '--list-tools', '-o', 'json',
      '--remove-tools', 'apply-patch-cli', ...(spec ? ['--use-spec'] : [])], {
      cwd, env: { PATH: process.env.PATH ?? '', HOME: cwd }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit).toBe(0); expect(err).toBe('');
    const names = JSON.parse(out).map((t: any) => t.llmId);
    expect(names.includes('ExitSpecMode')).toBe(spec);
    expect(names.includes('ApplyPatch')).toBe(false);
    expect(names.includes('StageSettingsChanges')).toBe(true);
  }
});
