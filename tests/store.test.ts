import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store, StoreError } from '../src/store.ts';
import { MAX_ACTIVITY_RETRIES } from '../src/enums.ts';

let store: Store;
let simTime: Date;

beforeEach(() => {
  simTime = new Date('2026-10-30T12:00:00.000Z');
  store = new Store(':memory:', { clock: () => simTime });
});
afterEach(() => store.close());

function activeWs(opts: { changeApproval?: boolean; specApproval?: boolean; taskLimit?: number } = {}) {
  const ws = store.createWorkstream({
    slug: 'demo',
    goal: 'keep calc correct',
    repo: '/tmp/demo',
    requireChangeApproval: opts.changeApproval ?? true,
    requireApproval: opts.specApproval ?? true,
    taskLimit: opts.taskLimit,
  });
  store.setWorkstreamState(ws.id, 'active');
  return ws;
}

describe('workstream lifecycle', () => {
  test('starts in draft and follows allowed transitions', () => {
    const ws = store.createWorkstream({ slug: 'a', goal: 'g', repo: '/r' });
    expect(ws.state).toBe('draft');
    expect(store.setWorkstreamState('a', 'active').state).toBe('active');
    expect(store.setWorkstreamState('a', 'paused').state).toBe('paused');
    expect(() => store.setWorkstreamState('a', 'draft')).toThrow(StoreError);
  });

  test('rejects invalid slugs', () => {
    expect(() => store.createWorkstream({ slug: 'Bad Slug', goal: 'g', repo: '/r' })).toThrow(StoreError);
  });
});

describe('change pipeline with both gates', () => {
  test('signal -> change review -> investigation -> spec review -> implementation -> implemented', () => {
    const ws = activeWs();
    const sig = store.addSignal(ws.id, 'add() subtracts', 'calc.add(2,2) returns 0');
    const change = store.triageSignal(sig.id);
    expect(change.status).toBe('in_review');
    expect(store.listSignals(ws.id)[0]?.status).toBe('triaged');

    // nothing for workers until a human approves the change
    expect(store.claimActivity(ws.id, 'w1')).toBeNull();
    const [review] = store.inbox(ws.id);
    expect(review?.kind).toBe('change_review');
    store.resolveReview(review!.id, 'approve');

    const inv = store.claimActivity(ws.id, 'w1');
    expect(inv?.kind).toBe('investigation');
    expect(store.getChange(change.id).status).toBe('in_progress');
    store.completeActivity(inv!.id, 'w1', 'STATUS: done\nspec: use a + b');
    expect(store.getChange(change.id).status).toBe('in_review');

    const [spec] = store.inbox(ws.id);
    expect(spec?.kind).toBe('investigation');
    store.resolveReview(spec!.id, 'approve');

    const impl = store.claimActivity(ws.id, 'w2');
    expect(impl?.kind).toBe('implementation');
    const ctx = store.activityContext(impl!.id);
    expect(ctx.history.some((h) => h.result?.includes('use a + b'))).toBe(true);
    store.completeActivity(impl!.id, 'w2', 'STATUS: done');
    expect(store.getChange(change.id).status).toBe('implemented');
    expect(store.closeChange(change.id, 'completed').status).toBe('completed');
  });

  test('a review comment re-queues the same kind with the comment in history', () => {
    const ws = activeWs({ changeApproval: false });
    const change = store.createChange(ws.id, 't', 'd');
    const inv = store.claimActivity(ws.id, 'w1')!;
    store.completeActivity(inv.id, 'w1', 'STATUS: done\nspec v1');
    store.resolveReview(inv.id, 'comment', 'also handle floats');
    const again = store.claimActivity(ws.id, 'w1')!;
    expect(again.kind).toBe('investigation');
    expect(again.parentActivityId).toBe(inv.id);
    expect(store.activityContext(again.id).history.some((h) => h.reviewComment === 'also handle floats')).toBe(true);
    expect(store.getChange(change.id).status).toBe('in_progress');
  });

  test('decline closes the change', () => {
    const ws = activeWs();
    const c = store.createChange(ws.id, 't', 'd');
    store.resolveReview(store.inbox(ws.id)[0]!.id, 'decline', 'not worth it');
    expect(store.getChange(c.id).status).toBe('declined');
    expect(store.claimActivity(ws.id, 'w1')).toBeNull();
  });

  test('without gates investigation flows straight into implementation', () => {
    const ws = activeWs({ changeApproval: false, specApproval: false });
    store.createChange(ws.id, 't', 'd');
    const inv = store.claimActivity(ws.id, 'w1')!;
    store.completeActivity(inv.id, 'w1', 'STATUS: done');
    expect(store.claimActivity(ws.id, 'w1')?.kind).toBe('implementation');
  });
});

describe('claiming and failures', () => {
  test('claims are FIFO and exclusive', () => {
    const ws = activeWs({ changeApproval: false });
    const c1 = store.createChange(ws.id, 'first', 'd');
    const c2 = store.createChange(ws.id, 'second', 'd');
    const a = store.claimActivity(ws.id, 'w1')!;
    const b = store.claimActivity(ws.id, 'w2')!;
    expect(a.changeId).toBe(c1.id);
    expect(b.changeId).toBe(c2.id);
    expect(store.claimActivity(ws.id, 'w3')).toBeNull();
    expect(() => store.completeActivity(a.id, 'w2', 'x')).toThrow(StoreError);
  });

  test('no claims while the workstream is not active', () => {
    const ws = activeWs({ changeApproval: false });
    store.createChange(ws.id, 't', 'd');
    store.setWorkstreamState(ws.id, 'paused');
    expect(store.claimActivity(ws.id, 'w1')).toBeNull();
  });

  test('failures retry up to the limit then fail the change', () => {
    const ws = activeWs({ changeApproval: false });
    const c = store.createChange(ws.id, 't', 'd');
    for (let i = 1; i <= 3; i++) {
      const a = store.claimActivity(ws.id, 'w1')!;
      const after = store.failActivity(a.id, 'w1', `boom ${i}`);
      expect(after.status).toBe(i < 3 ? 'pending' : 'failed');
    }
    expect(store.getChange(c.id).status).toBe('failed');
    expect(store.claimActivity(ws.id, 'w1')).toBeNull();
  });

  test('a failed change can be retried by a human', () => {
    const ws = activeWs({ changeApproval: false });
    const c = store.createChange(ws.id, 't', 'd');
    for (let i = 0; i < 3; i++) store.failActivity(store.claimActivity(ws.id, 'w1')!.id, 'w1', 'boom');
    expect(() => store.retryChange(store.createChange(ws.id, 'other', 'd').id)).toThrow(StoreError);
    const again = store.retryChange(c.id);
    expect(again.kind).toBe('investigation');
    expect(again.retryCount).toBe(0);
    expect(store.getChange(c.id).status).toBe('pending');
  });

  test('task limit caps open changes', () => {
    const ws = activeWs({ taskLimit: 1 });
    store.createChange(ws.id, 't1', 'd');
    expect(() => store.createChange(ws.id, 't2', 'd')).toThrow(StoreError);
  });

  test('orphaned in-progress activities are requeued only when lease expires', () => {
    const ws = activeWs({ changeApproval: false });
    store.createChange(ws.id, 't', 'd');
    store.claimActivity(ws.id, 'dead-worker');
    expect(store.requeueOrphans(ws.id)).toBe(0);
    simTime = new Date(simTime.getTime() + 91_000);
    expect(store.requeueOrphans(ws.id)).toBe(1);
    expect(store.claimActivity(ws.id, 'w1')).not.toBeNull();
  });
});


test('inserts tolerate extra nullable columns in store tables', () => {
  for (const table of ['workstreams', 'signals', 'changes', 'activities', 'events']) {
    store.db.exec(`ALTER TABLE ${table} ADD COLUMN future_value TEXT`);
  }
  const ws = store.createWorkstream({ slug: 'extended', goal: 'g', repo: '/r' });
  expect(ws.slug).toBe('extended');
  const signal = store.addSignal(ws.id, 'signal', 'body');
  const change = store.triageSignal(signal.id);
  expect(change.title).toBe('signal');
  expect(store.listActivities({ changeId: change.id })).toHaveLength(1);
  expect(store.listEvents(ws.id).length).toBeGreaterThan(0);
});

test('F1: lock mantenido por otra conexión durante una completeActivity → la activity termina sin consumir reintento', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'fab-f1-test-'));
  const dbPath = join(tmpDir, 'test.db');
  try {
    const fileStore = new Store(dbPath);
    const ws = fileStore.createWorkstream({
      slug: 'f1-test',
      goal: 'f1 lock test',
      repo: '/repo',
      requireApproval: false,
      requireChangeApproval: false,
    });
    fileStore.setWorkstreamState(ws.id, 'active');
    fileStore.createChange(ws.id, 'title', 'desc');
    const claimed = fileStore.claimActivity(ws.id, 'worker-1');
    expect(claimed).not.toBeNull();
    expect(claimed!.retryCount).toBe(0);

    // Force lock with a second connection in a child process (BEGIN EXCLUSIVE for 500ms)
    const lockScript = `
      import { Database } from 'bun:sqlite';
      const db = new Database('${dbPath}');
      db.exec('PRAGMA busy_timeout = 5000;');
      db.exec('BEGIN EXCLUSIVE');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      db.exec('COMMIT');
      db.close();
    `;
    const child = Bun.spawn(['bun', '-e', lockScript]);
    // Give child time to acquire the exclusive lock
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);

    // completeActivity should wait / retry through the lock, succeed, and NOT increment retryCount
    const completed = fileStore.completeActivity(claimed!.id, 'worker-1', 'STATUS: done\\nResult OK');
    await child.exited;

    expect(completed.status).toBe('completed');
    expect(completed.retryCount).toBe(0);
    const fresh = fileStore.getActivity(claimed!.id);
    expect(fresh.status).toBe('completed');
    expect(fresh.retryCount).toBe(0);
    fileStore.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('expired leases consume the retry budget and permanently fail the activity and change', () => {
  const ws = activeWs({ changeApproval: false, specApproval: false });
  const change = store.createChange(ws.id, 'orphan', 'd');
  let id = '';
  for (let attempt = 1; attempt <= MAX_ACTIVITY_RETRIES; attempt++) {
    const activity = store.claimActivity(ws.id, `worker-${attempt}`)!;
    if (id) expect(activity.id).toBe(id);
    id = activity.id;
    simTime = new Date(simTime.getTime() + 91_000);
    expect(store.requeueOrphans(ws.id)).toBe(1);
    expect(store.getActivity(id)).toMatchObject({
      retryCount: attempt, status: attempt < MAX_ACTIVITY_RETRIES ? 'pending' : 'failed',
      workerId: null, leaseExpiresAt: null, agentPgid: null,
    });
  }
  expect(store.getActivity(id).completedAt).toBe(simTime.toISOString());
  expect(store.getChange(change.id).status).toBe('failed');
  expect(store.claimActivity(ws.id, 'late-worker')).toBeNull();
  expect(store.requeueOrphans(ws.id)).toBe(0);
  expect(store.listEvents(ws.id).some(e => e.severity === 'error' && typeof e.message === 'string' && e.message.includes('lease expired'))).toBe(true);
});

test('worker failures and expired leases share one retry budget', () => {
  const ws = activeWs({ changeApproval: false });
  const change = store.createChange(ws.id, 'mixed', 'd');
  const first = store.claimActivity(ws.id, 'worker')!;
  store.failActivity(first.id, 'worker', 'first failure');
  for (let attempt = 2; attempt <= MAX_ACTIVITY_RETRIES; attempt++) {
    store.claimActivity(ws.id, 'worker');
    simTime = new Date(simTime.getTime() + 91_000);
    store.requeueOrphans(ws.id);
  }
  expect(store.getActivity(first.id)).toMatchObject({ status: 'failed', retryCount: MAX_ACTIVITY_RETRIES });
  expect(store.getChange(change.id).status).toBe('failed');
});

test('an orphaned gates activity keeps the implemented change closable', () => {
  const ws = store.createWorkstream({ slug: 'gated', goal: 'g', repo: '/tmp/demo', verify: ['true'],
    requireChangeApproval: false, requireApproval: false });
  store.setWorkstreamState(ws.id, 'active');
  const change = store.createChange(ws.id, 'gated', 'd');
  for (let step = 0; step < 2; step++) {
    const a = store.claimActivity(ws.id, 'worker')!;
    store.completeActivity(a.id, 'worker', 'STATUS: done');
  }
  expect(store.getChange(change.id).status).toBe('implemented');
  const gate = store.claimActivity(ws.id, 'gate-worker')!;
  expect(gate.kind).toBe('gates');
  simTime = new Date(simTime.getTime() + 91_000);
  expect(store.requeueOrphans(ws.id)).toBe(1);
  expect(store.getActivity(gate.id)).toMatchObject({ status: 'pending', retryCount: 1 });
  expect(store.getChange(change.id).status).toBe('implemented');
});

test('orphaned validators exhaust retries without failing the implemented change', () => {
  const ws = activeWs({ changeApproval: false, specApproval: false });
  const change = store.createChange(ws.id, 'validate', 'd');
  for (let step = 0; step < 2; step++) {
    const a = store.claimActivity(ws.id, 'worker')!;
    store.completeActivity(a.id, 'worker', 'STATUS: done');
  }
  const [qa] = store.requestValidation(change.id, ['qa']);
  for (let attempt = 1; attempt <= MAX_ACTIVITY_RETRIES; attempt++) {
    expect(store.claimActivity(ws.id, 'validator')!.id).toBe(qa!.id);
    simTime = new Date(simTime.getTime() + 91_000);
    store.requeueOrphans(ws.id);
  }
  expect(store.getActivity(qa!.id)).toMatchObject({ status: 'failed', retryCount: MAX_ACTIVITY_RETRIES });
  expect(store.getChange(change.id).status).toBe('implemented');
});
