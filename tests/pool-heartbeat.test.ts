import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgent } from '../src/agents.ts';
import { heartbeatVerdict, runPool, turnTimeoutMs } from '../src/pool.ts';
import { Store, StoreError } from '../src/store.ts';

let dir: string, repo: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-hb-'));
  repo = join(dir, 'repo');
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), '0\n');
  Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.']);
  Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const busy = () => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });

test('heartbeatVerdict: el bloqueo se tolera mientras quede un latido antes del lease; lo demás aborta ya', () => {
  expect(heartbeatVerdict(busy(), 30_000, 90_000, 30_000)).toBe('tolerate');
  expect(heartbeatVerdict(busy(), 60_000, 90_000, 30_000)).toBe('abort'); // el siguiente latido ya llegaría tarde
  expect(heartbeatVerdict(new StoreError('conflict', 'not held'), 0, 90_000, 30_000)).toBe('abort');
  expect(heartbeatVerdict(new StoreError('invalid_transition', 'change terminal'), 0, 90_000, 30_000)).toBe('abort');
});

test('turnTimeoutMs: opción, luego FAB_TURN_TIMEOUT_MS, luego el de runAgent; valores inválidos se ignoran', () => {
  const saved = process.env.FAB_TURN_TIMEOUT_MS;
  try {
    delete process.env.FAB_TURN_TIMEOUT_MS;
    expect(turnTimeoutMs({})).toBeUndefined();
    process.env.FAB_TURN_TIMEOUT_MS = '3600000';
    expect(turnTimeoutMs({})).toBe(3_600_000);
    expect(turnTimeoutMs({ turnTimeoutMs: 5 })).toBe(5);
    process.env.FAB_TURN_TIMEOUT_MS = 'abc';
    expect(turnTimeoutMs({})).toBeUndefined();
    expect(turnTimeoutMs({ turnTimeoutMs: -1 })).toBeUndefined();
  } finally { if (saved === undefined) delete process.env.FAB_TURN_TIMEOUT_MS; else process.env.FAB_TURN_TIMEOUT_MS = saved; }
});

test('un SQLITE_BUSY pasajero en el latido no mata al agente; el turno termina y la activity se completa', async () => {
  const store = new Store(join(dir, 'hb.db'));
  const script = join(dir, 'slow.sh');
  writeFileSync(script, '#!/bin/sh\nsleep 0.4\nprintf "STATUS: done\\n\\nok\\n"\n');
  Bun.spawnSync(['chmod', '+x', script]);
  const adapter = getAgent('fake'), orig = adapter.command;
  adapter.command = () => [script];
  const heartbeat = store.heartbeat.bind(store);
  let failures = 0;
  store.heartbeat = (...args: Parameters<typeof heartbeat>) => { if (failures < 3) { failures++; throw busy(); } return heartbeat(...args); };
  try {
    const ws = store.createWorkstream({ slug: 'hb', goal: 'g', repo, agent: 'fake', requireChangeApproval: false, requireApproval: false });
    store.setWorkstreamState(ws.id, 'active');
    const change = store.createChange(ws.id, 'c', 'd');
    const logs: string[] = [];
    await runPool(store, { workstream: ws.id, stateDir: dir, untilIdle: true, heartbeatMs: 50, leaseTtlMs: 5000, pollMs: 10, log: l => logs.push(l) });
    expect(failures).toBe(3);
    expect(logs.some(l => /heartbeat busy/.test(l))).toBe(true);
    expect(logs.some(l => /aborting/.test(l))).toBe(false);
    expect(store.listActivities({ changeId: change.id }).filter(a => a.status === 'completed').length).toBeGreaterThan(0);
  } finally { adapter.command = orig; store.close(); }
});
