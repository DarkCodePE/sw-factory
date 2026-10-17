import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseReportStatus } from '../src/prompts.ts';
import { runPool } from '../src/pool.ts';
import { Store } from '../src/store.ts';

let dir: string;
let repo: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fabrica-'));
  repo = join(dir, 'repo');
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.']);
  Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  store = new Store(join(dir, 'f.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('pool runs investigation with the fake agent in a per-change worktree', async () => {
  const ws = store.createWorkstream({ slug: 'p', goal: 'g', repo, agent: 'fake', requireChangeApproval: false });
  store.setWorkstreamState(ws.id, 'active');
  const c = store.createChange(ws.id, 'fix it', 'desc');
  await runPool(store, { workstream: ws.id, stateDir: dir, untilIdle: true, log: () => {} });
  const [inv] = store.listActivities({ changeId: c.id });
  expect(inv?.status).toBe('completed');
  expect(inv?.result).toContain('STATUS: done');
  expect(store.getChange(c.id).branch).toBe(`fab/${c.id.slice(0, 8)}`);
  expect(store.getChange(c.id).status).toBe('in_review');
});

test('a blocked report counts as a failure and is retried', async () => {
  process.env.FABRICA_FAKE_STATUS = 'blocked - cannot reproduce';
  try {
    const ws = store.createWorkstream({ slug: 'p', goal: 'g', repo, agent: 'fake', requireChangeApproval: false });
    store.setWorkstreamState(ws.id, 'active');
    const c = store.createChange(ws.id, 'fix it', 'desc');
    await runPool(store, { workstream: ws.id, stateDir: dir, untilIdle: true, log: () => {} });
    const [inv] = store.listActivities({ changeId: c.id });
    expect(inv?.status).toBe('failed');
    expect(inv?.retryCount).toBe(3);
    expect(inv?.error).toContain('cannot reproduce');
  } finally {
    delete process.env.FABRICA_FAKE_STATUS;
  }
});

test('parseReportStatus', () => {
  expect(parseReportStatus('STATUS: done\nok').done).toBe(true);
  expect(parseReportStatus('**STATUS: done**').done).toBe(true);
  expect(parseReportStatus('STATUS: blocked - no repro')).toEqual({ done: false, reason: 'blocked - no repro' });
  expect(parseReportStatus('no status here').done).toBe(false);
});
