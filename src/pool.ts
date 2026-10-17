// Worker pool: claims pending activities FIFO, runs one headless agent per activity
// in the change's worktree, and records the result back in the store.
import { getAgent, runAgent } from './agents.ts';
import { buildWorkerPrompt, parseReportStatus } from './prompts.ts';
import type { Activity, Store } from './store.ts';
import { branchCommits, ensureWorktree } from './worktrees.ts';

export interface PoolOptions {
  workstream: string;
  stateDir: string;
  agentOverride?: string;
  /** Stop once nothing is pending or running (instead of polling forever). */
  untilIdle?: boolean;
  pollMs?: number;
  log?: (msg: string) => void;
}

export async function processActivity(store: Store, activity: Activity, workerId: string, opts: PoolOptions): Promise<void> {
  const log = opts.log ?? console.log;
  const ws = store.getWorkstream(activity.workstreamId);
  const agent = getAgent(opts.agentOverride ?? ws.agent);
  try {
    const { activity: a, change, history } = store.activityContext(activity.id);
    const { path, branch } = await ensureWorktree(ws.repo, opts.stateDir, change.id);
    store.setChangeBranch(change.id, branch);
    const prompt = buildWorkerPrompt({ workstream: ws, change, activity: a, history, worktree: path, branch });
    log(`[${workerId}] ${a.kind} "${change.title}" -> ${agent.name} in ${path}`);
    const run = await runAgent(agent, prompt, path, undefined, { readOnly: a.kind === 'investigation' });
    const status = parseReportStatus(run.output);
    if (!run.ok) {
      store.failActivity(a.id, workerId, `agent exit ${run.exitCode}: ${run.output.slice(-1000)}`);
      log(`[${workerId}] ${a.kind} failed (exit ${run.exitCode})`);
      return;
    }
    if (!status.done) {
      store.failActivity(a.id, workerId, `blocked: ${status.reason}\n\n${run.output.slice(-2000)}`);
      log(`[${workerId}] ${a.kind} blocked: ${status.reason}`);
      return;
    }
    if (a.kind === 'implementation') {
      const commits = await branchCommits(ws.repo, branch);
      if (commits.length === 0 && agent.name !== 'fake') {
        store.failActivity(a.id, workerId, 'implementation reported done but left no commits on the branch');
        log(`[${workerId}] implementation produced no commits`);
        return;
      }
    }
    store.completeActivity(a.id, workerId, run.output);
    log(`[${workerId}] ${a.kind} done in ${Math.round(run.durationMs / 1000)}s`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      store.failActivity(activity.id, workerId, msg);
    } catch {
      // Activity already moved on (e.g. canceled); nothing to record.
    }
    log(`[${workerId}] error: ${msg}`);
  }
}

/** Run the pool. Returns when idle (untilIdle) or never (daemon mode). */
export async function runPool(store: Store, opts: PoolOptions): Promise<void> {
  const log = opts.log ?? console.log;
  const ws = store.getWorkstream(opts.workstream);
  const recovered = store.requeueOrphans(ws.id);
  if (recovered) log(`requeued ${recovered} orphaned activities`);
  const running = new Set<Promise<void>>();
  let slot = 0;
  for (;;) {
    const current = store.getWorkstream(ws.id);
    while (current.state === 'active' && running.size < current.workerConcurrency) {
      const workerId = `w${(slot++ % current.workerConcurrency) + 1}-${process.pid}`;
      const claimed = store.claimActivity(ws.id, workerId);
      if (!claimed) break;
      const p: Promise<void> = processActivity(store, claimed, workerId, opts).finally(() => running.delete(p));
      running.add(p);
    }
    if (running.size === 0 && opts.untilIdle) {
      const pending = store.listActivities({ workstream: ws.id, status: 'pending' }).length;
      if (pending === 0 || current.state !== 'active') return;
    }
    if (running.size > 0) await Promise.race([...running, Bun.sleep(opts.pollMs ?? 30_000)]);
    else await Bun.sleep(opts.untilIdle ? 50 : (opts.pollMs ?? 30_000));
  }
}
