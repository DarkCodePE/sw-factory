// Worker pool: claims pending activities FIFO, runs one headless agent per activity
// in the change's worktree, and records the result back in the store.
import { runGates, runSetupAt, type GateStep } from './gates.ts';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { selfCommand } from './self.ts';
import { activityLog, atomicEvidence, gitEvidence, isolationFor, readEgressProbe, runDirectory, writeManifest } from './manifest.ts';
import { verifyAgentStart } from './agents-verify.ts';
import { getAgent, runAgent, type AgentRun } from './agents.ts';
import { expireQuestions } from './admission/answers.ts';
import { isChannelChange } from './admission/channel.ts';
import { AdmissionDb, hasAdmission } from './admission/db.ts';
import { CrashInjected, Effects, type CrashPoint } from './admission/effects.ts';
import { applyReport, closeWithReport } from './admission/reports.ts';
import { assertConfinement } from './sandbox/confine.ts';
import { liveBackendFor, runLiveActivity } from './live/turn.ts';
import type { LiveOutcome } from './admission/reports.ts';
import type { LiveBackend } from './live/contract.ts';
import { buildWorkerPrompt } from './prompts.ts';
import { fabSha, resolveProfile } from './profile.ts';
import { HEARTBEAT_INTERVAL_MS, isBusyError, LEASE_TTL_MS, type Activity, type Store, type Workstream } from './store.ts';
import { buildValidatorPrompt } from './validators/prompts.ts';
import { protectedIntegrity, purgeRegenerableCaches } from './validators/integrity.ts';
import { parseVerdict } from './validators/verdict.ts';
import { branchCommits, commitWorktree, ensureWorktree, GIT_SAFE_FLAGS, WorktreeNeedsRepair } from './worktrees.ts';
import { defaultRules, ThreatMonitor } from './threatmon/index.ts';

async function getWorktreeDiff(worktreePath: string, baseSha?: string): Promise<string> {
  const parts: string[] = [];
  try {
    const diffArgs = baseSha
      ? ['git', ...GIT_SAFE_FLAGS, 'diff', baseSha]
      : ['git', ...GIT_SAFE_FLAGS, 'diff', 'HEAD'];
    const p1 = Bun.spawn(diffArgs, { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe' });
    const diffText = (await new Response(p1.stdout).text()).trim();
    if (diffText) parts.push(diffText);
  } catch {}

  try {
    const p2 = Bun.spawn(['git', ...GIT_SAFE_FLAGS, 'status', '--porcelain', '-uall'], {
      cwd: worktreePath,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const statusText = (await new Response(p2.stdout).text()).trim();
    if (statusText) {
      parts.push(statusText);
      const lines = statusText.split('\n');
      for (const line of lines) {
        if (line.startsWith('?? ')) {
          const filePath = line.slice(3).trim();
          try {
            const file = Bun.file(`${worktreePath}/${filePath}`);
            const content = await file.text();
            parts.push(`--- /dev/null\n+++ b/${filePath}\n${content}`);
          } catch {}
        }
      }
    }
  } catch {}

  return parts.join('\n');
}

export interface PoolOptions {
  workstream: string;
  stateDir: string;
  agentOverride?: string;
  confine?: boolean;
  /** Stop once nothing is pending or running (instead of polling forever). */
  untilIdle?: boolean;
  /** Start even when the workstream agent's pinned sha256 does not match the binary on PATH. */
  acceptAgentBinaries?: boolean;
  /** Rama viva (S1): las activities de trabajo cuyo adaptador tiene backend vivo corren con sesión reanudable y `report`. Por defecto, no. */
  live?: boolean;
  /** Backends vivos por adaptador; por defecto los de `src/live/turn.ts`. Para tests. */
  liveBackends?: Record<string, LiveBackend>;
  /** Caída inyectada por un test en un punto del turno vivo; un `CrashInjected` sale del pool sin tocar la activity. */
  crash?: (point: CrashPoint) => void;
  pollMs?: number;
  heartbeatMs?: number;
  leaseTtlMs?: number;
  /** Tope de un turno en ms (T28). Sin él, FAB_TURN_TIMEOUT_MS o los 20 min de runAgent. */
  turnTimeoutMs?: number;
  log?: (msg: string) => void;
}

const setupInFlight = new Map<string, Promise<{ ok: boolean; steps: GateStep[] }>>();

/** Run the workstream's setup argv before the first gate, and again only when the argv changed. One run per workstream at a time. */
function ensureSetup(store: Store, ws: Workstream, cwd: string, deps: string, signal: AbortSignal) {
  const commands = ws.verifySetup ?? [];
  if (!commands.length) return Promise.resolve({ ok: true, steps: [] as GateStep[] });
  const hash = createHash('sha256').update(JSON.stringify(commands)).digest('hex');
  if (store.getWorkstream(ws.id).verifySetupHash === hash) return Promise.resolve({ ok: true, steps: [] as GateStep[] });
  const running = setupInFlight.get(ws.id);
  if (running) return running;
  const job = (async () => {
    const steps: GateStep[] = [];
    for (const argv of commands) {
      const step = await runSetupAt(cwd, argv, deps, signal);
      steps.push(step);
      if (step.exitCode !== 0 || step.timedOut || step.error) return { ok: false, steps };
    }
    store.setVerifySetupHash(ws.id, hash);
    return { ok: true, steps };
  })().finally(() => setupInFlight.delete(ws.id));
  setupInFlight.set(ws.id, job);
  return job;
}

/**
 * T28 (H-13): un bloqueo pasajero de la base (SQLITE_BUSY agotado, p. ej. con un residente escribiendo) no debe matar un turno
 * sano. Se tolera mientras quede al menos un latido antes de que venza el lease (`sinceLastOk` + un intervalo < ttl); un error
 * que no es de bloqueo (la activity ya no es nuestra, el change es terminal) aborta de inmediato, como siempre.
 */
export function heartbeatVerdict(err: unknown, sinceLastOkMs: number, ttlMs: number, intervalMs: number): 'tolerate' | 'abort' {
  return isBusyError(err) && sinceLastOkMs + intervalMs < ttlMs ? 'tolerate' : 'abort';
}

/** Tope de un turno: `opts.turnTimeoutMs`, si no `FAB_TURN_TIMEOUT_MS`, si no el de `runAgent` (20 min). Un valor no positivo se ignora. */
export function turnTimeoutMs(opts: { turnTimeoutMs?: number }): number | undefined {
  const value = opts.turnTimeoutMs ?? Number(process.env.FAB_TURN_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : undefined;
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

  let lastBeat = Date.now();
  const heartbeatTimer = setInterval(() => {
    try {
      store.heartbeat(activity.id, workerId, opts.leaseTtlMs);
      lastBeat = Date.now();
    } catch (err) {
      if (heartbeatVerdict(err, Date.now() - lastBeat, opts.leaseTtlMs ?? LEASE_TTL_MS, heartbeatIntervalMs) === 'tolerate') {
        log(`[${workerId}] heartbeat busy (${(err as Error).message}); retrying next tick`);
        return;
      }
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

    const meta = `${runDirectory(opts.stateDir, change.id)}/${a.id}.json`;
    const previous = existsSync(meta) ? JSON.parse(readFileSync(meta, 'utf8')) : null;
    // Preserve all costs, including unknown attempts from legacy evidence. Reports remain attempt-local.
    const attemptCosts: unknown[] = previous?.attemptCosts ?? Array.from({ length: a.retryCount }, (_, i) =>
      i === a.retryCount - 1 ? previous?.usage?.costUsd ?? null : null);
    attemptCosts.push(0);
    // Reset before setup too: a launch/setup failure must not reuse an earlier report or cost.
    const pendingEvidence = { isolation: opts.confine ? 'bwrap-allowlist' : isolationFor(agent.name), workerReport: null, attemptCosts };
    atomicEvidence(meta, JSON.stringify(pendingEvidence));
    const { path, branch, baseSha } = await ensureWorktree(ws.repo, opts.stateDir, change.id);
    store.setChangeBranch(change.id, branch);
    store.setChangeBase(change.id, baseSha);
    const { digest: profileDigest, profile } = resolveProfile(opts.stateDir, ws.profile);
    store.setActivityProvenance(a.id, profileDigest, fabSha());
    const verifiedWorkspace = (head: string | null | undefined) => !!head &&
      gitEvidence(path, 'rev-parse', 'HEAD') === head && gitEvidence(path, 'status', '--porcelain', '-uall') === '';
    if (a.kind === 'gates') {
      const head = gitEvidence(path, 'rev-parse', 'HEAD');
      const current = store.getChange(change.id);
      purgeRegenerableCaches(path);
      const { tampered } = await protectedIntegrity(path, current.baseSha!, ws.protectedPaths, current.protectedBaseline);
      if (tampered.length || !verifiedWorkspace(head)) {
        store.blockActivity(a.id, workerId, tampered.length ? `GATE_TAMPERED: ${tampered.join(', ')}` : 'GATE_HEAD_CHANGED: worktree must be clean');
        return;
      }
      const started = Date.now();
      const stepEvidence: Array<Record<string, unknown>> = [];
      const deps = join(resolve(opts.stateDir), 'deps', ws.slug);
      // Gates record no cost; if used in improve, armCost will return null for this activity.
      const metadata = () => atomicEvidence(`${runDirectory(opts.stateDir, change.id)}/${a.id}.json`, JSON.stringify({
        isolation: { adapter: 'gates', posture: 'required OS sandbox; no network; disposable source; read-only dependencies; filtered environment' },
        verifiedHead: head, durationMs: Date.now() - started, steps: stepEvidence,
      }));
      metadata();
      const setup = await ensureSetup(store, ws, path, deps, abortController.signal);
      if (setup.steps.length) {
        const name = `${a.id}.setup.log`;
        atomicEvidence(`${runDirectory(opts.stateDir, change.id)}/${name}`, setup.steps.map(s => s.output).join('\n'));
        stepEvidence.push(...setup.steps.map(s => ({ ...s, output: undefined, log: name, phase: 'setup' })));
        metadata();
      }
      if (!setup.ok) {
        const out = setup.steps.map(s => `SETUP: ${JSON.stringify(s.argv)}\nexit=${s.exitCode} timeout=${s.timedOut}\n${s.output}${s.error ? `\n${s.error}` : ''}`).join('\n');
        atomicEvidence(activityLog(opts.stateDir, change.id, a.id), out);
        store.blockActivity(a.id, workerId, `GATES_FAIL setup\n${out}`);
        log(`[${workerId}] gates fail (setup): ${change.id}`);
        return;
      }
      const result = await runGates(path, ws.verify ?? [], abortController.signal, (step, index) => {
        const name = `${a.id}.step-${index + 1}.log`;
        atomicEvidence(`${runDirectory(opts.stateDir, change.id)}/${name}`, step.output);
        stepEvidence.push({ ...step, output: undefined, log: name });
        metadata();
      }, undefined, ws.verifySetup?.length ? deps : undefined);
      const output = result.steps.map((step, i) => `STEP ${i + 1}: ${JSON.stringify(step.argv)}\nexit=${step.exitCode} timeout=${step.timedOut}\n${step.output}${step.error ? `\n${step.error}` : ''}`).join('\n');
      atomicEvidence(activityLog(opts.stateDir, change.id, a.id), output);
      if (abortController.signal.aborted || store.isTerminalChange(store.getChange(change.id).status)) {
        store.releaseActivity(a.id, workerId);
        return;
      }
      if (!result.passed || !verifiedWorkspace(head)) {
        store.blockActivity(a.id, workerId, `GATES_FAIL${verifiedWorkspace(head) ? '' : ' GATE_HEAD_CHANGED'}\n${output}`);
        log(`[${workerId}] gates fail: ${change.id}`);
        return;
      }
      store.completeActivity(a.id, workerId, `VERDICT: pass\n${output}`, { verifiedHead: head! });
      log(`[${workerId}] gates pass: ${change.id} HEAD ${head}`);
      return;
    }
    if (a.validator && ws.verify?.length && !verifiedWorkspace(a.verifiedHead)) {
      store.blockActivity(a.id, workerId, 'GATE_HEAD_CHANGED: validator requires the verified HEAD and a clean worktree');
      return;
    }
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
    const live = liveBackendFor(opts, agent.name, a);
    const adm = live || hasAdmission(store) ? new AdmissionDb(store) : undefined;
    // T32/B1: el trabajo que entra por un canal es texto no confiable: va delimitado en el prompt y solo corre confinado.
    const channel = !!adm && isChannelChange(adm, change.id);
    const confine = !!opts.confine || channel;
    if (channel && !opts.confine) {
      try { assertConfinement(agent.name); } catch (err) {
        store.blockActivity(a.id, workerId, `CHANNEL_NOT_CONFINABLE: ${(err as Error).message}`);
        log(`[${workerId}] ${a.kind} blocked: change de canal sin adaptador confinable (${agent.name})`);
        return;
      }
    }
    const prompt = a.validator
      ? buildValidatorPrompt(a.validator, { change, diffStat, base: 'main', branch, worktree: path, history }, profile.validators)
      : buildWorkerPrompt({ workstream: ws, change, activity: a, history, worktree: path, branch, untrusted: channel || undefined }, { factoryCommits: agent.factoryCommits }, profile.worker);
    log(`[${workerId}] ${a.validator ?? a.kind} "${change.title}" -> ${agent.name} in ${path}`);
    const readOnly = a.validator ? (a.validator !== 'qa') : (a.kind === 'investigation');
    const probeFile = `${runDirectory(opts.stateDir, change.id)}/${a.id}.egress.json`;
    // A retry keeps the activity id: drop the previous attempt's probe so it is never reported as this one's.
    rmSync(probeFile, { force: true });
    const captureAgent = { ...agent, env: () => ({ ...agent.env?.(), FABRICA_EGRESS_PROBE_FILE: probeFile }), command: (text: string, options?: { readOnly?: boolean; promptStdin?: boolean }) => [
      ...selfCommand('__capture', new URL('./manifest-capture.ts', import.meta.url)),
      activityLog(opts.stateDir, change.id, a.id), ...agent.command(text, options),
    ] };
    // From launch onward the cost is unknown until the agent reports it.
    attemptCosts[attemptCosts.length - 1] = null;
    atomicEvidence(meta, JSON.stringify(pendingEvidence));
    const crash = (point: CrashPoint) => opts.crash?.(point);
    let outcome: LiveOutcome | undefined;
    let run: AgentRun;
    if (live) {
      ({ run, outcome } = await runLiveActivity(store, adm!, a, {
        backend: live, cwd: path, profileDigest, prompt, timeoutMs: turnTimeoutMs(opts), signal: abortController.signal, confine,
        capturePath: confine ? activityLog(opts.stateDir, change.id, a.id) : undefined,
        onSpawn: pgid => store.setActivityAgentPgid(a.id, pgid), crash,
        templates: profile.worker, branch, factoryCommits: agent.factoryCommits,
      }));
      if (!confine) atomicEvidence(activityLog(opts.stateDir, change.id, a.id), `${run.stdout ?? ''}${run.stderr ?? ''}`);
    } else run = await runAgent(confine ? agent : captureAgent, prompt, path, turnTimeoutMs(opts), {
      confine,
      capturePath: confine ? activityLog(opts.stateDir, change.id, a.id) : undefined,
      readOnly,
      signal: abortController.signal,
      onSpawn: (pgid) => {
        store.setActivityAgentPgid(a.id, pgid);
      },
    });

    attemptCosts[attemptCosts.length - 1] = run.usage?.costUsd ?? null;
    atomicEvidence(meta, JSON.stringify({
      isolation: confine ? 'bwrap-allowlist' : isolationFor(agent.name), durationMs: run.durationMs, exitCode: run.exitCode, usage: run.usage ?? null,
      attemptCosts,
      egressProbe: agent.name === 'native' ? readEgressProbe(probeFile) : null,
      // Keep only a declared final worker report, independently of later block/failure decisions; never diagnostics or an earlier attempt.
      workerReport: !a.validator && !abortController.signal.aborted && run.status.kind !== 'missing' ? run.output : null,
    }));

    // Barrier check after agent run
    if (abortController.signal.aborted || store.isTerminalChange(store.getChange(change.id).status)) {
      log(`[${workerId}] ${a.validator ?? a.kind} aborted or change is terminal`);
      store.releaseActivity(a.id, workerId);
      return;
    }

    if (a.validator && ws.verify?.length && !verifiedWorkspace(a.verifiedHead)) {
      store.blockActivity(a.id, workerId, 'GATE_HEAD_CHANGED: validator changed the verified HEAD or worktree');
      return;
    }

    // Post-hoc behavior monitoring via threatmon.
    // Límite declarado / Post-hoc limitation:
    // Este monitor opera de forma post-hoc sobre la salida capturada (stdout, stderr, diff)
    // tras finalizar la ejecución del agente. Detecta comportamientos fuera de límites u
    // ofensivos para poner el change en cuarentena ('quarantined') antes de validación, pero
    // NO puede revertir ni evitar efectos secundarios ya ocurridos en el host si el agente
    // corrió sin aislamiento previo (p. ej. con agy). La mitigación de fondo de H1 es envolver
    // los CLIs en sandboxes de egress, fuera de este plan.
    const monitor = new ThreatMonitor(defaultRules(), 'HIGH');
    monitor.observe('stdout', run.stdout ?? '');
    monitor.observe('stderr', run.stderr ?? '');
    const worktreeDiff = await getWorktreeDiff(path, baseSha);
    monitor.observe('patch', worktreeDiff);
    const threatReport = monitor.report();
    if (threatReport.tripped) {
      const findingsSummary = threatReport.findings
        .map((f) => `[${f.severity}] ${f.rule_id} (${f.category}) at ${f.stream}:${f.line} -> ${f.excerpt}`)
        .join('\n');
      const reason = `THREAT_DETECTED (${threatReport.max_severity}):\n${findingsSummary}`;
      store.quarantineActivity(a.id, workerId, reason);
      log(`[${workerId}] threat detected (${threatReport.max_severity}): change ${change.id} quarantined:\n${findingsSummary}`);
      return;
    }

    if (a.kind === 'implementation' || a.validator) {
      const current = store.getChange(change.id);
      purgeRegenerableCaches(path);
      const { tampered } = await protectedIntegrity(path, current.baseSha!, ws.protectedPaths, current.protectedBaseline);
      if (tampered.length) {
        const reason = `GATE_TAMPERED: ${tampered.join(', ')}`;
        store.blockActivity(a.id, workerId, reason);
        log(`[${workerId}] ${reason}`);
        return;
      }
    }
    if (outcome?.kind === 'awaiting') {
      const r = applyReport(store, adm!, new Effects(adm!, {}), { activityId: a.id, workerId, crash });
      log(`[${workerId}] ${a.kind} waiting for a human reply${r.state === 'awaiting' ? ` (${r.questionId})` : ''}`);
      return;
    }
    // A5: con un turno vivo, el cierre y la marca del report como aplicado van en una sola transacción.
    const close = <T>(fn: () => T): T => outcome ? closeWithReport(store, adm!, { activityId: a.id, workerId }, fn) : fn();
    if (run.status.kind === 'blocked') {
      close(() => store.blockActivity(a.id, workerId, run.status.reason));
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
    close(() => store.completeActivity(a.id, workerId, run.output));
    log(`[${workerId}] ${a.kind} done in ${Math.round(run.durationMs / 1000)}s`);
  } catch (err) {
    if (err instanceof CrashInjected) throw err;
    if (!(err instanceof WorktreeNeedsRepair) && isBusyError(err)) {
      log(`[${workerId}] database locked during activity processing, preserving activity without failing`);
      try {
        store.requeueActivity(activity.id, workerId);
      } catch {}
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    try {
      const currentChange = store.getChange(activity.changeId);
      if (!store.isTerminalChange(currentChange.status) && !abortController.signal.aborted) {
        if (err instanceof WorktreeNeedsRepair) store.blockActivity(activity.id, workerId, msg);
        else if (activity.kind === 'gates') store.blockActivity(activity.id, workerId, `GATES_FAIL: ${msg}`);
        else store.failActivity(activity.id, workerId, msg);
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
/** Nota (T31): `workerConcurrency` se aplica por proceso de pool, no global; para no duplicarlo, un pool por workstream. */
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
      let recovered = 0;
      try {
        recovered = store.requeueOrphans(ws.id);
        // M4: el plazo de una espera también lo vigila el pool (no solo el residente), para que venza aunque el residente no corra.
        if (opts.live) expireQuestions(store, new AdmissionDb(store));
      } catch (err) {
        if (isBusyError(err)) {
          await Promise.race([Bun.sleep(50), interruptPromise]);
          continue;
        }
        throw err;
      }
      if (recovered) log(`recovered ${recovered} orphaned activities`);

      let current: Workstream;
      try {
        current = store.getWorkstream(ws.id);
      } catch (err) {
        if (isBusyError(err)) {
          await Promise.race([Bun.sleep(50), interruptPromise]);
          continue;
        }
        throw err;
      }
      while (!interrupted && current.state === 'active' && running.size < current.workerConcurrency) {
        const workerId = `w${(slot++ % current.workerConcurrency) + 1}-${process.pid}-${randomUUID()}`;
        let claimed: Activity | null = null;
        try {
          claimed = store.claimActivity(ws.id, workerId, opts.leaseTtlMs);
        } catch (err) {
          if (isBusyError(err)) {
            break;
          }
          throw err;
        }
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
