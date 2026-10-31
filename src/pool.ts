// Worker pool: claims pending activities FIFO, runs one headless agent per activity
// in the change's worktree, and records the result back in the store.
import { selfCommand } from './self.ts';
import { activityLog, atomicEvidence, isolationFor, runDirectory, writeManifest } from './manifest.ts';
import { verifyAgentStart } from './agents-verify.ts';
import { getAgent, runAgent } from './agents.ts';
import { buildWorkerPrompt } from './prompts.ts';
import { HEARTBEAT_INTERVAL_MS, LEASE_TTL_MS, type Activity, type Store } from './store.ts';
import { buildValidatorPrompt } from './validators/prompts.ts';
import { protectedIntegrity } from './validators/integrity.ts';
import { parseVerdict } from './validators/verdict.ts';
import { branchCommits, commitWorktree, ensureWorktree, GIT_SAFE_FLAGS } from './worktrees.ts';

export interface PoolOptions {
  workstream: string;
  stateDir: string;
  agentOverride?: string;
  /** Stop once nothing is pending or running (instead of polling forever). */
  untilIdle?: boolean;
  /** Start even when the workstream agent's pinned sha256 does not match the binary on PATH. */
  acceptAgentBinaries?: boolean;
  pollMs?: number;
  heartbeatMs?: number;
  leaseTtlMs?: number;
  log?: (msg: string) => void;
}

export async function processActivity(
  store: Store,
  activity: Activity,
  workerId: string,
  opts: PoolOptions,
  abortController = new AbortController()
): Promise<void> {
  const log = opts.log ?? console.log;
  const ws = store.getWorkstream(activity.workstreamId);
  const agent = getAgent(opts.agentOverride ?? ws.agent);
  const heartbeatIntervalMs = opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;

  const heartbeatTimer = setInterval(() => {
    try {
      store.heartbeat(activity.id, workerId, opts.leaseTtlMs);
    } catch (err) {
      log(`[${workerId}] heartbeat failed: ${err instanceof Error ? err.message : String(err)}; aborting`);
      abortController.abort();
      clearInterval(heartbeatTimer);
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  try {
    const { activity: a, change, history } = store.activityContext(activity.id);

    // Barrier check before worktree setup
    if (store.isTerminalChange(change.status)) {
      store.releaseActivity(a.id, workerId);
      return;
    }

    const { path, branch, baseSha } = await ensureWorktree(ws.repo, opts.stateDir, change.id);
    store.setChangeBranch(change.id, branch);
    store.setChangeBase(change.id, baseSha);
    let diffStat = '';
    if (a.validator) {
      try {
        const proc = Bun.spawn(['git', ...GIT_SAFE_FLAGS, 'diff', '--stat', 'main...' + branch], { cwd: path, stdout: 'pipe', stderr: 'pipe' });
        diffStat = (await new Response(proc.stdout).text()).trim();
        if (!diffStat) {
          const proc2 = Bun.spawn(['git', ...GIT_SAFE_FLAGS, 'diff', '--stat', 'HEAD~1'], { cwd: path, stdout: 'pipe', stderr: 'pipe' });
          diffStat = (await new Response(proc2.stdout).text()).trim();
        }
      } catch {
        diffStat = '';
      }
    }
    const prompt = a.validator
      ? buildValidatorPrompt(a.validator, { change, diffStat, base: 'main', branch, worktree: path, history })
      : buildWorkerPrompt({ workstream: ws, change, activity: a, history, worktree: path, branch }, { factoryCommits: agent.factoryCommits });
    log(`[${workerId}] ${a.validator ?? a.kind} "${change.title}" -> ${agent.name} in ${path}`);
    const readOnly = a.validator ? (a.validator !== 'qa') : (a.kind === 'investigation');
    const captureAgent = { ...agent, command: (text: string, options?: { readOnly?: boolean }) => [
      ...selfCommand('__capture', new URL('./manifest-capture.ts', import.meta.url)),
      activityLog(opts.stateDir, change.id, a.id), ...agent.command(text, options),
    ] };
    atomicEvidence(`${runDirectory(opts.stateDir, change.id)}/${a.id}.json`, JSON.stringify({ isolation: isolationFor(agent.name) }));
    const run = await runAgent(captureAgent, prompt, path, undefined, {
      readOnly,
      signal: abortController.signal,
      onSpawn: (pgid) => {
        store.setActivityAgentPgid(a.id, pgid);
      },
    });

    atomicEvidence(`${runDirectory(opts.stateDir, change.id)}/${a.id}.json`, JSON.stringify({
      isolation: isolationFor(agent.name), durationMs: run.durationMs, exitCode: run.exitCode,
    }));

    // Barrier check after agent run
    if (abortController.signal.aborted || store.isTerminalChange(store.getChange(change.id).status)) {
      log(`[${workerId}] ${a.validator ?? a.kind} aborted or change is terminal`);
      store.releaseActivity(a.id, workerId);
      return;
    }

    if (a.kind === 'implementation' || a.validator) {
      const current = store.getChange(change.id);
      const { tampered } = await protectedIntegrity(path, current.baseSha!, ws.protectedPaths, current.protectedBaseline);
      if (tampered.length) {
        const reason = `GATE_TAMPERED: ${tampered.join(', ')}`;
        store.blockActivity(a.id, workerId, reason);
        log(`[${workerId}] ${reason}`);
        return;
      }
    }
    if (run.status.kind === 'blocked') {
      store.blockActivity(a.id, workerId, run.status.reason);
      log(`[${workerId}] ${a.validator ?? a.kind} blocked: ${run.status.reason}`);
      return;
    }
    if (!run.ok) {
      store.failActivity(a.id, workerId, `agent exit ${run.exitCode}: ${run.output.slice(-1000)}`);
      log(`[${workerId}] ${a.validator ?? a.kind} failed (exit ${run.exitCode})`);
      return;
    }
    if (run.status.kind !== 'done') {
      const prefix = run.status.reason;
      store.failActivity(a.id, workerId, `${prefix}\n\n${run.output.slice(-2000)}`);
      log(`[${workerId}] ${a.validator ?? a.kind} failed: ${run.status.reason}`);
      return;
    }
    if (a.validator) {
      const verdictResult = parseVerdict(run.output);
      if (!verdictResult) {
        store.failActivity(a.id, workerId, `report has no valid VERDICT line:\n\n${run.output.slice(-2000)}`);
        log(`[${workerId}] ${a.validator} rejected: missing valid VERDICT`);
        return;
      }
      let isDirty = false;
      try {
        const proc = Bun.spawn(['git', ...GIT_SAFE_FLAGS, 'status', '--porcelain'], { cwd: path, stdout: 'pipe', stderr: 'pipe' });
        const statusText = (await new Response(proc.stdout).text()).trim();
        if (statusText.length > 0) isDirty = true;
      } catch {}
      if (isDirty) {
        store.failActivity(a.id, workerId, `${a.validator} dejó cambios en el worktree`);
        log(`[${workerId}] ${a.validator} dejó cambios en el worktree`);
        return;
      }
    }
    if (a.kind === 'implementation') {
      // Barrier check before commit
      if (store.isTerminalChange(store.getChange(change.id).status)) {
        store.releaseActivity(a.id, workerId);
        return;
      }
      // The commit is attributed to the factory and only records what the agent left on disk.
      if (agent.factoryCommits) await commitWorktree(path, `${change.title}\n\nImplemented by ${agent.name} (fab activity ${a.id.slice(0, 8)}).`);
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
      const currentChange = store.getChange(activity.changeId);
      if (!store.isTerminalChange(currentChange.status) && !abortController.signal.aborted) {
        store.failActivity(activity.id, workerId, msg);
      } else {
        store.releaseActivity(activity.id, workerId);
      }
    } catch {
      // Activity already moved on (e.g. canceled); nothing to record.
    }
    log(`[${workerId}] error: ${msg}`);
  } finally {
    clearInterval(heartbeatTimer);
    writeManifest(store, activity.changeId, opts.stateDir);
  }
}

/** Run the pool. Returns when idle (untilIdle) or never (daemon mode). */
export async function runPool(store: Store, opts: PoolOptions): Promise<void> {
  const log = opts.log ?? console.log;
  const ws = store.getWorkstream(opts.workstream);
  // agents-verify: única comprobación al arrancar. El pin del adaptador del
  // workstream que no coincida impide arrancar; sin pin → aviso, no bloqueo.
  const agentCheck = verifyAgentStart(opts.agentOverride ?? ws.agent);
  if (agentCheck.violation && !opts.acceptAgentBinaries) throw new Error(agentCheck.violation);
  if (agentCheck.warning) log(agentCheck.warning);
  const running = new Set<Promise<void>>();
  const activeControllers = new Map<Promise<void>, AbortController>();
  let slot = 0;
  let interrupted = false;
  let triggerInterrupt: () => void;
  const interruptPromise = new Promise<void>((resolve) => {
    triggerInterrupt = resolve;
  });

  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    for (const controller of activeControllers.values()) {
      controller.abort();
    }
    triggerInterrupt();
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    for (;;) {
      if (interrupted) break;
      const recovered = store.requeueOrphans(ws.id);
      if (recovered) log(`requeued ${recovered} orphaned activities`);

      const current = store.getWorkstream(ws.id);
      while (!interrupted && current.state === 'active' && running.size < current.workerConcurrency) {
        const workerId = `w${(slot++ % current.workerConcurrency) + 1}-${process.pid}`;
        const claimed = store.claimActivity(ws.id, workerId, opts.leaseTtlMs);
        if (!claimed) break;
        const controller = new AbortController();
        const p: Promise<void> = processActivity(store, claimed, workerId, opts, controller).finally(() => {
          running.delete(p);
          activeControllers.delete(p);
        });
        running.add(p);
        activeControllers.set(p, controller);
      }
      if (interrupted) break;
      if (running.size === 0 && opts.untilIdle) {
        if (current.state !== 'active') return;
        const pending = store.listActivities({ workstream: ws.id, status: 'pending' }).length;
        if (pending === 0) {
          const inProgress = store.listActivities({ workstream: ws.id, status: 'in_progress' });
          if (inProgress.length === 0) return;
          // There are still activities in progress (running on another worker/pool).
          // --once must NOT exit before their leases expire.
          const nowMs = store.clock ? store.clock().getTime() : Date.now();
          let waitMs = opts.pollMs ?? 1000;
          for (const act of inProgress) {
            if (act.leaseExpiresAt) {
              const expMs = new Date(act.leaseExpiresAt).getTime();
              const diff = expMs - nowMs;
              if (diff > 0 && diff < waitMs) {
                waitMs = diff;
              }
            }
          }
          await Promise.race([Bun.sleep(Math.max(10, Math.min(waitMs, opts.pollMs ?? 1000))), interruptPromise]);
          continue;
        }
      }
      if (interrupted) break;
      if (running.size > 0) await Promise.race([...running, Bun.sleep(opts.pollMs ?? 30_000), interruptPromise]);
      else await Promise.race([Bun.sleep(opts.untilIdle ? 50 : (opts.pollMs ?? 30_000)), interruptPromise]);
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (running.size > 0) {
      await Promise.allSettled(Array.from(running));
    }
  }
}
