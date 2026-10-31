import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAgent, runAgent, type AgentAdapter } from '../src/agents.ts';
import { runPool } from '../src/pool.ts';
import { Store, StoreError } from '../src/store.ts';
import { branchCommits } from '../src/worktrees.ts';

let dir: string;
let repo: string;
let simTime: Date;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-leases-test-'));
  repo = join(dir, 'repo');
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'calc.txt'), '0\n');
  Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.']);
  Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'initial commit']);
  simTime = new Date('2026-10-30T12:00:00.000Z');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('aborto mata al hijo y al nieto', async () => {
  const childPidFile = join(dir, 'child.pid');
  const grandchildPidFile = join(dir, 'grandchild.pid');

  const script = join(dir, 'spawn-tree.sh');
  writeFileSync(
    script,
    `#!/bin/sh
echo "$$" > "${childPidFile}"
sh -c 'echo "$$" > "${grandchildPidFile}"; exec sleep 60' &
wait
`
  );
  Bun.spawnSync(['chmod', '+x', script]);

  const treeAgent: AgentAdapter = {
    name: 'tree-agent',
    command: () => [script],
  };

  const controller = new AbortController();
  const runPromise = runAgent(treeAgent, 'test prompt', dir, 60_000, { signal: controller.signal });

  // Wait until both child and grandchild have started and recorded their PIDs
  let childPid = 0;
  let grandchildPid = 0;
  for (let i = 0; i < 50; i++) {
    if (existsSync(childPidFile) && existsSync(grandchildPidFile)) {
      childPid = Number(readFileSync(childPidFile, 'utf8').trim());
      grandchildPid = Number(readFileSync(grandchildPidFile, 'utf8').trim());
      if (childPid > 0 && grandchildPid > 0) break;
    }
    await Bun.sleep(20);
  }

  expect(childPid).toBeGreaterThan(0);
  expect(grandchildPid).toBeGreaterThan(0);

  // Both should be alive before abort
  let childAliveBefore = false;
  let gcAliveBefore = false;
  try {
    process.kill(childPid, 0);
    childAliveBefore = true;
  } catch {}
  try {
    process.kill(grandchildPid, 0);
    gcAliveBefore = true;
  } catch {}
  expect(childAliveBefore).toBe(true);
  expect(gcAliveBefore).toBe(true);

  // Abort!
  controller.abort();
  const run = await runPromise;
  expect(run.ok).toBe(false);

  // Allow OS a brief moment to finish reaping the process group
  await Bun.sleep(50);

  // Both child and grandchild must be dead
  let childAliveAfter = false;
  let gcAliveAfter = false;
  try {
    process.kill(childPid, 0);
    childAliveAfter = true;
  } catch {}
  try {
    process.kill(grandchildPid, 0);
    gcAliveAfter = true;
  } catch {}

  expect(childAliveAfter).toBe(false);
  expect(gcAliveAfter).toBe(false);
});

test('dos pools contra el mismo store, uno muere -> 0 duplicados y recuperación <= 180s (reloj simulado)', async () => {
  const dbPath = join(dir, 'shared.db');
  const clock = () => simTime;
  const store1 = new Store(dbPath, { clock });
  const store2 = new Store(dbPath, { clock });

  try {
    const ws = store1.createWorkstream({ slug: 'recovery-ws', goal: 'recovery', repo, agent: 'fake', requireChangeApproval: false, requireApproval: false });
    store1.setWorkstreamState(ws.id, 'active');

    const change = store1.createChange(ws.id, 'Recov change', 'desc');

    // Pool 1 claims the activity with a 90s lease
    const claimedByPool1 = store1.claimActivity(ws.id, 'pool1-worker');
    expect(claimedByPool1).not.toBeNull();
    expect(claimedByPool1?.status).toBe('in_progress');
    expect(claimedByPool1?.workerId).toBe('pool1-worker');

    // At this moment, Pool 2 cannot claim it (exclusive lease held by Pool 1)
    expect(store2.claimActivity(ws.id, 'pool2-worker')).toBeNull();

    // Pool 1 "dies": process crashes or stops heartbeating.
    // Pool 2 runs with --once. At current simTime, lease has not expired.
    // We advance simulated time by 95 seconds (<= 180s):
    simTime = new Date(simTime.getTime() + 95_000);

    // Pool 2 runs until idle. Its loop will requeue the expired lease and process it.
    await runPool(store2, {
      workstream: ws.id,
      stateDir: dir,
      untilIdle: true,
      pollMs: 10,
      log: () => {},
    });

    // Check store state:
    const activities = store2.listActivities({ changeId: change.id });
    // Exactly investigation and implementation were completed once, no duplicated activities
    const completed = activities.filter((a) => a.status === 'completed');
    expect(completed.length).toBe(2); // investigation + implementation
    expect(activities.filter((a) => a.kind === 'investigation').length).toBe(1);
    expect(activities.filter((a) => a.kind === 'implementation').length).toBe(1);

    const c = store2.getChange(change.id);
    expect(c.status).toBe('implemented');
  } finally {
    store1.close();
    store2.close();
  }
});

test('--once no sale antes de que venza un lease', async () => {
  const dbPath = join(dir, 'once.db');
  const clock = () => simTime;
  const store1 = new Store(dbPath, { clock });
  const store2 = new Store(dbPath, { clock });

  try {
    const ws = store1.createWorkstream({ slug: 'once-ws', goal: 'once', repo, agent: 'fake', requireChangeApproval: false, requireApproval: false });
    store1.setWorkstreamState(ws.id, 'active');
    const change = store1.createChange(ws.id, 'Once change', 'desc');

    // Worker 1 claims the investigation activity; lease expires at simTime + 90s
    const act = store1.claimActivity(ws.id, 'w1');
    expect(act).not.toBeNull();

    // Start Pool 2 with untilIdle (--once)
    let pool2Finished = false;
    const pool2Promise = runPool(store2, {
      workstream: ws.id,
      stateDir: dir,
      untilIdle: true,
      pollMs: 10,
      log: () => {},
    }).then(() => {
      pool2Finished = true;
    });

    // Wait 60ms real time with simulated clock unchanged (lease not expired)
    await Bun.sleep(60);
    // Pool 2 must NOT have exited!
    expect(pool2Finished).toBe(false);

    // Advance simulated clock past TTL (90s)
    simTime = new Date(simTime.getTime() + 95_000);

    // Now Pool 2 recovers the expired lease, claims it, finishes it, and exits
    await pool2Promise;
    expect(pool2Finished).toBe(true);

    const finalAct = store2.getActivity(act!.id);
    expect(finalAct.status).toBe('completed');
  } finally {
    store1.close();
    store2.close();
  }
});

test('reject durante implementación -> change cancelado y sin escrituras posteriores', async () => {
  const dbPath = join(dir, 'reject.db');
  const clock = () => simTime;
  const store = new Store(dbPath, { clock });

  try {
    const ws = store.createWorkstream({ slug: 'reject-ws', goal: 'goal', repo, agent: 'fake', requireChangeApproval: false, requireApproval: false });
    store.setWorkstreamState(ws.id, 'active');
    const change = store.createChange(ws.id, 'Reject feature', 'desc');

    // Run first step (investigation) so change moves to pending implementation
    const inv = store.claimActivity(ws.id, 'w1');
    store.completeActivity(inv!.id, 'w1', 'STATUS: done\nInvestigation done');

    // Now an implementation activity is pending
    const [implAct] = store.listActivities({ changeId: change.id, status: 'pending' });
    expect(implAct).toBeDefined();
    expect(implAct?.kind).toBe('implementation');

    // Use a slow fake agent that creates a marker and waits
    const markerStarted = join(dir, 'impl_started.tmp');
    const slowScript = join(dir, 'slow-impl.sh');
    writeFileSync(
      slowScript,
      `#!/bin/sh
touch "${markerStarted}"
# Sleep until killed/aborted
sleep 10
printf "STATUS: done\\n\\nShould not complete\\n"
`
    );
    Bun.spawnSync(['chmod', '+x', slowScript]);

    const fakeAdapter = getAgent('fake');
    const origCommand = fakeAdapter.command;
    fakeAdapter.command = () => [slowScript];

    try {
      // Start pool in background with short heartbeat interval
      const poolPromise = runPool(store, {
        workstream: ws.id,
        stateDir: dir,
        untilIdle: true,
        heartbeatMs: 50,
        pollMs: 10,
        log: () => {},
      });

      // Wait until implementation has actually started running
      for (let i = 0; i < 50; i++) {
        if (existsSync(markerStarted)) break;
        await Bun.sleep(20);
      }
      expect(existsSync(markerStarted)).toBe(true);

      // Change is currently in progress
      expect(store.getChange(change.id).status).toBe('in_progress');

      // Human executes reject
      store.closeChange(change.id, 'canceled');
      await store.waitForRelease(change.id, 5000);

      // Pool should finish cleanly
      await poolPromise;

      // Verify:
      // 1. Change status is canceled
      expect(store.getChange(change.id).status).toBe('canceled');

      // 2. No subsequent commits on the branch
      const branch = store.getChange(change.id).branch!;
      const commits = await branchCommits(repo, branch);
      expect(commits.length).toBe(0);

      // 3. No activities completed after rejection
      const activities = store.listActivities({ changeId: change.id });
      const impl = activities.find((a) => a.kind === 'implementation');
      expect(impl?.status).toBe('canceled');

      // 4. No completion events logged for implementation
      const events = store.listEvents(ws.id);
      expect(events.some((e) => String(e.message).includes('implementation done'))).toBe(false);
    } finally {
      fakeAdapter.command = origCommand;
    }
  } finally {
    store.close();
  }
});

test('D7 barrera: claim, heartbeat y completeActivity rechazan si el change está terminal', () => {
  const store = new Store(':memory:', { clock: () => simTime });
  try {
    const ws = store.createWorkstream({ slug: 'barrier-ws', goal: 'barrier', repo, requireChangeApproval: false });
    store.setWorkstreamState(ws.id, 'active');
    const change = store.createChange(ws.id, 'Barrier test', 'desc');

    // Claim the activity first while change is pending
    const claimed = store.claimActivity(ws.id, 'w1');
    expect(claimed).not.toBeNull();

    // Now change is terminal (canceled)
    store.closeChange(change.id, 'canceled');

    // 1. Heartbeat on canceled change must throw invalid_transition
    expect(() => store.heartbeat(claimed!.id, 'w1')).toThrow(StoreError);

    // 2. completeActivity on canceled change must throw invalid_transition
    expect(() => store.completeActivity(claimed!.id, 'w1', 'STATUS: done\noutput')).toThrow(StoreError);

    // 3. claimActivity cannot claim any activity whose change is terminal
    // Create a pending activity for the canceled change directly
    store.db.query(`INSERT INTO activities (id, workstream_id, change_id, kind, status, retry_count, created_at)
                    VALUES ('dummy-pending', ?, ?, 'investigation', 'pending', 0, ?)`).run(ws.id, change.id, store.now());
    expect(store.claimActivity(ws.id, 'w2')).toBeNull();
  } finally {
    store.close();
  }
});

test('migración de leases: activities in_progress existentes sin lease reciben now + TTL', () => {
  const dbPath = join(dir, 'migration.db');
  // Initialize SQLite database directly without lease_expires_at column
  const { Database } = require('bun:sqlite');
  const rawDb = new Database(dbPath);
  rawDb.exec(`
    CREATE TABLE workstreams (id TEXT PRIMARY KEY, slug TEXT UNIQUE, goal TEXT, repo TEXT, state TEXT, agent TEXT, worker_concurrency INTEGER, task_limit INTEGER, require_change_approval INTEGER, require_approval INTEGER, created_at TEXT);
    CREATE TABLE changes (id TEXT PRIMARY KEY, workstream_id TEXT, title TEXT, description TEXT, status TEXT, branch TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE activities (id TEXT PRIMARY KEY, workstream_id TEXT, change_id TEXT, parent_activity_id TEXT, kind TEXT, status TEXT, review_status TEXT, review_comment TEXT, worker_id TEXT, result TEXT, error TEXT, retry_count INTEGER DEFAULT 0, created_at TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, workstream_id TEXT, change_id TEXT, activity_id TEXT, severity TEXT, message TEXT, created_at TEXT);
    INSERT INTO workstreams VALUES ('ws-1', 'mig', 'goal', '/repo', 'active', 'fake', 2, 20, 0, 0, '2026-10-30T10:00:00.000Z');
    INSERT INTO changes VALUES ('c-1', 'ws-1', 'c1', 'd', 'in_progress', NULL, '2026-10-30T10:00:00.000Z', '2026-10-30T10:00:00.000Z');
    INSERT INTO activities VALUES ('act-1', 'ws-1', 'c-1', NULL, 'investigation', 'in_progress', NULL, NULL, 'old-w', NULL, NULL, 0, '2026-10-30T10:00:00.000Z', '2026-10-30T10:00:00.000Z', NULL);
  `);
  rawDb.close();

  // Open with Store
  const store = new Store(dbPath, { clock: () => simTime });
  try {
    const act = store.getActivity('act-1');
    expect(act.status).toBe('in_progress');
    expect(act.leaseExpiresAt).not.toBeNull();
    const expectedExpiry = new Date(simTime.getTime() + 90_000).toISOString();
    expect(act.leaseExpiresAt).toBe(expectedExpiry);
  } finally {
    store.close();
  }
});

test('SIGINT al pool mata al agente y su nieto y deja la activity liberada', async () => {
  const childPidFile = join(dir, 'sigint-child.pid');
  const gcPidFile = join(dir, 'sigint-gc.pid');

  const script = join(dir, 'sigint-tree.sh');
  writeFileSync(
    script,
    `#!/bin/sh
echo "$$" > "${childPidFile}"
sh -c 'echo "$$" > "${gcPidFile}"; exec sleep 60' &
wait
`
  );
  Bun.spawnSync(['chmod', '+x', script]);

  const store = new Store(join(dir, 'sigint.db'), { clock: () => simTime });
  const fakeAdapter = getAgent('fake');
  const origCommand = fakeAdapter.command;
  fakeAdapter.command = () => [script];

  try {
    const ws = store.createWorkstream({ slug: 'sigint-ws', goal: 'sigint', repo, agent: 'fake', requireChangeApproval: false, requireApproval: false });
    store.setWorkstreamState(ws.id, 'active');
    const change = store.createChange(ws.id, 'Sigint test', 'desc');

    const poolPromise = runPool(store, {
      workstream: ws.id,
      stateDir: dir,
      pollMs: 10,
      log: () => {},
    });

    // Wait until child and grandchild PIDs are recorded and verified alive
    let childPid = 0;
    let gcPid = 0;
    for (let i = 0; i < 50; i++) {
      if (existsSync(childPidFile) && existsSync(gcPidFile)) {
        childPid = Number(readFileSync(childPidFile, 'utf8').trim());
        gcPid = Number(readFileSync(gcPidFile, 'utf8').trim());
        if (childPid > 0 && gcPid > 0) break;
      }
      await Bun.sleep(20);
    }
    expect(childPid).toBeGreaterThan(0);
    expect(gcPid).toBeGreaterThan(0);

    // Verify alive before SIGINT
    let childAliveBefore = false;
    let gcAliveBefore = false;
    try {
      process.kill(childPid, 0);
      childAliveBefore = true;
    } catch {}
    try {
      process.kill(gcPid, 0);
      gcAliveBefore = true;
    } catch {}
    expect(childAliveBefore).toBe(true);
    expect(gcAliveBefore).toBe(true);

    // Emit SIGINT to the process
    process.emit('SIGINT', 'SIGINT');

    // Pool must wait for the agent to exit and resolve cleanly
    await poolPromise;

    // Both child and grandchild must be dead
    let childAliveAfter = false;
    let gcAliveAfter = false;
    try {
      process.kill(childPid, 0);
      childAliveAfter = true;
    } catch {}
    try {
      process.kill(gcPid, 0);
      gcAliveAfter = true;
    } catch {}

    expect(childAliveAfter).toBe(false);
    expect(gcAliveAfter).toBe(false);

    // Activity must be liberada (status = canceled, worker_id = null)
    const [act] = store.listActivities({ changeId: change.id });
    expect(act).toBeDefined();
    expect(act?.status).toBe('canceled');
    expect(act?.workerId).toBeNull();
  } finally {
    fakeAdapter.command = origCommand;
    store.close();
  }
});

test('pool muerto con agente vivo -> requeueOrphans mata el grupo y no reencola hasta que muere', async () => {
  const orphanMarker = join(dir, 'orphan-wrote.tmp');
  const orphanPidFile = join(dir, 'orphan.pid');

  // Agent script that records its PID, sleeps 2 seconds, and if still alive, touches orphanMarker
  const orphanScript = join(dir, 'orphan-script.sh');
  writeFileSync(
    orphanScript,
    `#!/bin/sh
echo "$$" > "${orphanPidFile}"
sleep 3
touch "${orphanMarker}"
printf "STATUS: done\\n\\nCompleted\\n"
`
  );
  Bun.spawnSync(['chmod', '+x', orphanScript]);

  const dbPath = join(dir, 'orphan.db');
  const clock = () => simTime;
  const store1 = new Store(dbPath, { clock });
  const store2 = new Store(dbPath, { clock });

  try {
    const ws = store1.createWorkstream({ slug: 'orphan-ws', goal: 'orphan', repo, agent: 'fake', requireChangeApproval: false, requireApproval: false });
    store1.setWorkstreamState(ws.id, 'active');
    const change = store1.createChange(ws.id, 'Orphan change', 'desc');

    // Pool 1 claims the activity
    const act = store1.claimActivity(ws.id, 'pool1-worker');
    expect(act).not.toBeNull();

    // Spawn the detached orphan agent process as Pool 1 would
    const proc = Bun.spawn([orphanScript], {
      cwd: dir,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
    store1.setActivityAgentPgid(act!.id, proc.pid);

    // Wait until script recorded its PID
    let orphanPid = 0;
    for (let i = 0; i < 50; i++) {
      if (existsSync(orphanPidFile)) {
        orphanPid = Number(readFileSync(orphanPidFile, 'utf8').trim());
        if (orphanPid > 0) break;
      }
      await Bun.sleep(20);
    }
    expect(orphanPid).toBeGreaterThan(0);

    // Advance simulated clock past TTL (90s)
    simTime = new Date(simTime.getTime() + 95_000);

    // Round 1 of requeueOrphans: orphan process is still alive.
    // requeueOrphans MUST send SIGKILL and NOT requeue in this round (returns 0).
    const round1Recovered = store2.requeueOrphans(ws.id);
    expect(round1Recovered).toBe(0);

    // Activity remains in_progress
    const actRound1 = store2.getActivity(act!.id);
    expect(actRound1.status).toBe('in_progress');

    // Wait brief moment for SIGKILL to be delivered and OS to reap
    await proc.exited;
    await Bun.sleep(30);

    // Process is now confirmed dead
    let orphanAlive = false;
    try {
      process.kill(orphanPid, 0);
      orphanAlive = true;
    } catch {}
    expect(orphanAlive).toBe(false);

    // Round 2 of requeueOrphans: orphan is dead now, so it re-enqueues!
    const round2Recovered = store2.requeueOrphans(ws.id);
    expect(round2Recovered).toBe(1);

    const actRound2 = store2.getActivity(act!.id);
    expect(actRound2.status).toBe('pending');
    expect(actRound2.agentPgid).toBeNull();

    // Pool 2 now claims and finishes the activity
    const claimedByPool2 = store2.claimActivity(ws.id, 'pool2-worker');
    expect(claimedByPool2).not.toBeNull();
    store2.completeActivity(claimedByPool2!.id, 'pool2-worker', 'STATUS: done\nHandled by pool 2');

    // Wait another 500ms to guarantee orphan script had enough time to write if it had lived
    await Bun.sleep(500);

    // Zero writes from the orphaned agent!
    expect(existsSync(orphanMarker)).toBe(false);
  } finally {
    store1.close();
    store2.close();
  }
});


