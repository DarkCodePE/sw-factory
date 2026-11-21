// Worker pool: claims pending activities FIFO, runs one headless agent per activity
// in the change's worktree, and records the result back in the store.
import { reserveTurnPrompt } from './note-delivery.ts';
import { runGates, runSetupAt, type GateStep } from './gates.ts';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { selfCommand } from './self.ts';
import { activityLog, atomicEvidence, gitEvidence, isolationFor, readEgressProbe, runDirectory, writeManifest } from './manifest.ts';
import { verifyAgentStart, type AgentStartCheck } from './agents-verify.ts';
import { getAgent, MCP_AGENTS, runAgent, type AgentAdapter, type AgentRun } from './agents.ts';
import { expireQuestions } from './admission/answers.ts';
import { isChannelChange } from './admission/channel.ts';
import { AdmissionDb, hasAdmission } from './admission/db.ts';
import { CrashInjected, Effects, type CrashPoint } from './admission/effects.ts';
import { planTurn } from './admission/recovery.ts';
import { applyReport, closeWithReport, ReportStore } from './admission/reports.ts';
import { assertConfinement, CONFINABLE_AGENTS, hostDir, type EnvDecl } from './sandbox/confine.ts';
import { RunnerError, runRemoteAgent, type RemoteDeps, type Transport } from './runners/client.ts';
import { agentEnv, scrubValues } from './sandbox/env.ts';
import { claudeMcpServers, loadMcpRegistry, McpRegistryError } from './mcp-registry.ts';
import { backendOf, liveBackendFor, runLiveActivity } from './live/turn.ts';
import type { LiveOutcome } from './admission/reports.ts';
import type { LiveBackend } from './live/contract.ts';
import { buildWorkerPrompt, notesBlock } from './prompts.ts';
import { fabSha, profileRunnerNames, resolveProfile, resolveRole, roleOf, roleRunner, type RoleConfig } from './profile.ts';
import { HEARTBEAT_INTERVAL_MS, isBusyError, LEASE_TTL_MS, StoreError, type Activity, type Runner, type Store, type Workstream } from './store.ts';
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
  /** Allow launch even when an agent's pinned sha256 does not match the binary on PATH. */
  acceptAgentBinaries?: boolean;
  /** Rama viva (S1): las activities de trabajo cuyo adaptador tiene backend vivo corren con sesión reanudable y `report`. Por defecto, no. */
  live?: boolean;
  /** Backends vivos por adaptador; por defecto los de `src/live/turn.ts`. Para tests. */
  liveBackends?: Record<string, LiveBackend>;
  /** Caída inyectada por un test en un punto del turno vivo; un `CrashInjected` sale del pool sin tocar la activity. */
  crash?: (point: CrashPoint) => void;
  /** Transporte de los runners remotos; por defecto `ssh`. Para tests. */
  runnerTransport?: Transport;
  runnerDeps?: RemoteDeps;
  pollMs?: number;
  heartbeatMs?: number;
  leaseTtlMs?: number;
  /** Tope de un turno en ms (T28). Sin él, FAB_TURN_TIMEOUT_MS o los 20 min de runAgent. */
  turnTimeoutMs?: number;
  log?: (msg: string) => void;
}

/** Lo que recibe un rol (T72 §5.1, §5.4). `decl` ausente = modo anterior: nada cambia (S4). */
type Access =
  | { block: string }
  | { decl?: EnvDecl; values: Record<string, string>; meta: { env: string[]; mcp: string[]; missing: string[] }; servers?: Record<string, unknown> };

/**
 * Modo declarado si el workstream fija `env_allow` o `mcp_allow`; la lista no fijada cuenta como vacía. Entrega
 * `declarado por el perfil ∩ permitido por el workstream` y bloquea, sin lanzar, lo que el perfil pide fuera del tope (S2).
 * Un change de canal no recibe ninguna variable ni servidor declarados (S3).
 */
export function resolveAccess(i: { ws: Workstream; cfg?: RoleConfig; adapter: string; model: string | null; channel: boolean; confine: boolean; stateDir: string }): Access {
  const { ws } = i;
  if (ws.envAllow === null && ws.mcpAllow === null) return { values: {}, meta: { env: [], mcp: [], missing: [] } };
  const wsAllow = ws.envAllow ?? [], mcpAllow = ws.mcpAllow ?? [];
  const roleEnv = i.channel ? [] : i.cfg?.env ?? [], roleMcp = i.channel ? [] : i.cfg?.mcp ?? [];
  const list = (code: string, names: string[]) => ({ block: `${code}: ${names.join(', ')}` });
  let registry = {}, mcpRequired: string[] = [];
  if (roleMcp.length) {
    if (!MCP_AGENTS.includes(i.adapter)) return list('MCP_NOT_SUPPORTED', [i.adapter]);
    const notAllowed = roleMcp.filter(n => !mcpAllow.includes(n));
    if (notAllowed.length) return list('MCP_NOT_ALLOWED', notAllowed);
    try { registry = loadMcpRegistry(i.stateDir); } catch (e) {
      if (e instanceof McpRegistryError) return { block: `MCP_REGISTRY_INVALID: ${e.message}` };
      throw e;
    }
    const unknown = roleMcp.filter(n => !Object.hasOwn(registry, n));
    if (unknown.length) return list('MCP_UNKNOWN', unknown);
    const commands = roleMcp.filter(n => (registry as Record<string, { kind: string }>)[n]!.kind === 'command');
    if (i.confine && commands.length) return list('MCP_NOT_CONFINABLE', commands);
    mcpRequired = [...new Set(roleMcp.flatMap(n => (registry as Record<string, { required: string[] }>)[n]!.required))];
  }
  const decl: EnvDecl = { wsAllow, channel: i.channel, roleEnv, mcpRequired };
  const r = agentEnv({ adapter: i.adapter, confined: i.confine, channel: i.channel, wsAllow, roleEnv, mcpRequired, host: process.env, model: i.model ?? undefined });
  if (r.denied.length) return list('ENV_NOT_ALLOWED', r.denied);
  return {
    decl, values: Object.fromEntries(r.delivered.map(n => [n, process.env[n]!])), meta: { env: r.delivered, mcp: roleMcp, missing: r.missing },
    servers: MCP_AGENTS.includes(i.adapter) ? claudeMcpServers(registry, roleMcp) : undefined,
  };
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

/** M5: al fallar una activity (que se reintentará) el report pendiente es de un intento ya resuelto: se descarta en la misma transacción. */
function failLive(store: Store, activityId: string, workerId: string, error: string): void {
  if (!hasAdmission(store)) { store.failActivity(activityId, workerId, error); return; }
  const adm = new AdmissionDb(store);
  adm.tx(() => { new ReportStore(adm).markApplied(activityId); store.failActivity(activityId, workerId, error); });
}

export async function processActivity(
  store: Store,
  activity: Activity,
  workerId: string,
  opts: PoolOptions,
  abortController = new AbortController(),
  agentChecks = new Map<string, AgentStartCheck>(),
): Promise<void> {
  const log = opts.log ?? console.log;
  const heartbeatIntervalMs = opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;

  let mcpConfigPath: string | undefined;
  let scrub: Record<string, string> = {};
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

    const role = roleOf(a);
    const { ws, profile, digest: profileDigest, runner, runnerProblem } = store.withRetry(() => {
      const ws = store.getWorkstream(a.workstreamId);
      const resolved = resolveProfile(opts.stateDir, ws.profile);
      const name = a.kind === 'gates' ? null : roleRunner(resolved.profile, role) ?? ws.runner;
      let runner: Runner | null = null;
      let runnerProblem: string | undefined;
      if (name !== null) {
        try { runner = store.reserveActivityRunner(a.id, workerId, name); }
        catch (error) {
          if (!(error instanceof StoreError && error.code === 'not_found')) throw error;
          runnerProblem = `RUNNER_NOT_FOUND: ${name}`;
        }
        if (runner && !runner.enabled) runnerProblem = `RUNNER_DISABLED: ${name}`;
        else if (runner?.kind === 'ssh' && opts.live) runnerProblem = `LIVE_NOT_REMOTE: ${name}`;
      }
      return { ws, ...resolved, runner, runnerProblem };
    });
    const { adapter, model } = resolveRole(profile, role, ws.agent, opts.agentOverride);
    const meta = `${runDirectory(opts.stateDir, change.id)}/${a.id}.json`;
    const previous = existsSync(meta) ? JSON.parse(readFileSync(meta, 'utf8')) : null;
    // Preserve all costs, including unknown attempts from legacy evidence. Reports remain attempt-local.
    const attemptCosts: unknown[] = previous?.attemptCosts ?? Array.from({ length: a.retryCount }, (_, i) =>
      i === a.retryCount - 1 ? previous?.usage?.costUsd ?? null : null);
    attemptCosts.push(0);
    // Reset before setup too: a launch/setup failure must not reuse an earlier report or cost.
    const pendingEvidence = { isolation: opts.confine ? 'bwrap-allowlist' : isolationFor(adapter), workerReport: null, attemptCosts };
    atomicEvidence(meta, JSON.stringify(pendingEvidence));
    if (runnerProblem) {
      store.setActivityProvenance(a.id, profileDigest, fabSha());
      store.blockActivity(a.id, workerId, runnerProblem);
      return;
    }
    const { path, branch, baseSha } = await ensureWorktree(ws.repo, opts.stateDir, change.id);
    store.setChangeBranch(change.id, branch);
    store.setChangeBase(change.id, baseSha);
    const verifiedWorkspace = (head: string | null | undefined) => !!head &&
      gitEvidence(path, 'rev-parse', 'HEAD') === head && gitEvidence(path, 'status', '--porcelain', '-uall') === '';
    // Procedencia base antes de cualquier bloqueo; el lanzamiento real la completa con agente y modelo.
    store.setActivityProvenance(a.id, profileDigest, fabSha());
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
    const remote = runner?.kind === 'ssh' ? runner : null;
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
    const agent = getAgent(adapter);
    // El binario del agente de un runner remoto lo comprueba el runner (`agent_missing`), no esta máquina.
    let agentCheck = remote ? undefined : agentChecks.get(adapter);
    if (!remote && !agentCheck) {
      agentCheck = verifyAgentStart(adapter);
      agentChecks.set(adapter, agentCheck);
      if (agentCheck.warning) log(agentCheck.warning);
    }
    if (agentCheck?.violation && !opts.acceptAgentBinaries) {
      store.blockActivity(a.id, workerId, `AGENT_BINARY_MISMATCH: ${agentCheck.violation}`);
      return;
    }
    const live = remote ? undefined : liveBackendFor(opts, adapter, a); // un runner remoto corre de un disparo (T74 §1)
    const adm = live || hasAdmission(store) ? new AdmissionDb(store) : undefined;
    // T32/B1: el trabajo que entra por un canal es texto no confiable: va delimitado en el prompt y solo corre confinado.
    const channel = !!adm && isChannelChange(adm, change.id);
    const localConfine = runner?.kind === 'local' && runner.options.confine === true;
    const confine = !!opts.confine || channel || localConfine;
    if (channel && !remote) {
      try { assertConfinement(adapter); } catch (err) {
        store.blockActivity(a.id, workerId, `CHANNEL_NOT_CONFINABLE: ${(err as Error).message}`);
        log(`[${workerId}] ${a.kind} blocked: change de canal sin adaptador confinable (${adapter})`);
        return;
      }
    } else if (localConfine) {
      try { assertConfinement(adapter); } catch (err) {
        store.blockActivity(a.id, workerId, `RUNNER_NOT_CONFINABLE: ${(err as Error).message}`);
        log(`[${workerId}] ${a.kind} blocked: runner ${runner!.name} confina y el adaptador no puede (${adapter})`);
        return;
      }
    }
    if (remote) {
      // Antes de conectar: nada sale de casa si el rol pide valores o servidores (R2, A15) o el adaptador no se confina (R3).
      const cfg = role && !channel ? profile.roles?.[role] : undefined;
      const refusal = !CONFINABLE_AGENTS.includes(adapter) ? 'RUNNER_REFUSED: not_confinable'
        : cfg?.env?.length ? `ENV_NOT_REMOTE: ${cfg.env.join(', ')}`
        : cfg?.mcp?.length ? `MCP_NOT_REMOTE: ${cfg.mcp.join(', ')}` : null;
      if (refusal) {
        store.blockActivity(a.id, workerId, refusal);
        log(`[${workerId}] ${a.kind} blocked: ${refusal}`);
        return;
      }
    }
    // T72: lo declarado por el perfil dentro del tope del workstream; fuera del tope, se bloquea sin lanzar.
    const access = remote ? { values: {}, meta: { env: [], mcp: [], missing: [] } } satisfies Access
      : resolveAccess({ ws, cfg: role ? profile.roles?.[role] : undefined, adapter, model, channel, confine, stateDir: opts.stateDir });
    if ('block' in access) {
      store.blockActivity(a.id, workerId, access.block);
      log(`[${workerId}] ${a.kind} blocked: ${access.block}`);
      return;
    }
    scrub = access.values;
    const accessMeta = access.decl ? access.meta : {};
    // M1: un pool sin --live no ejecuta de un disparo una activity que ya tiene sesión lanzada, una respuesta por entregar o un report guardado.
    if (!live && adm && !a.validator && planTurn(adm, a).action !== 'fresh') {
      store.blockActivity(a.id, workerId, 'LIVE_SESSION_REQUIRED: la activity tiene una sesión viva (lanzada, respuesta pendiente o report guardado); arranca el pool con `fab run --live`');
      log(`[${workerId}] ${a.kind} blocked: requiere un pool --live`);
      return;
    }
    // Un report huérfano se aplica sin lanzar otro turno. Conserva la procedencia del que lo emitió.
    const recoveringReport = !!live && !!adm && !!new ReportStore(adm).pending(a.id);
    const provenance = recoveringReport ? { adapter: a.agent ?? adapter, model: a.model } : { adapter, model };
    if (!recoveringReport) {
      store.setActivityProvenance(a.id, profileDigest, fabSha(), { agent: adapter, model, runner: runner?.name ?? null });
      if (profile.schemaVersion === 2 && role && (adapter !== ws.agent || model !== null)) {
        store.event(ws.id, 'info', `rol ${role}: adaptador ${adapter}, modelo ${model ?? 'por defecto'} (perfil ${profileDigest.slice(0, 8)})`, change.id, a.id);
      }
    }
    if (access.meta.missing.length && !recoveringReport) store.event(ws.id, 'warning', `variables permitidas y no definidas: ${access.meta.missing.join(', ')}`, change.id, a.id);
    // Un turno vivo escribe su propia configuración (T72f); un disparo, esta. Con `--strict-mcp-config` no se cargan los servidores del usuario (S5).
    if (access.decl && !live && access.servers) {
      mcpConfigPath = join(hostDir(join(resolve(opts.stateDir), 'live', change.id.slice(0, 8), 'mcp'), path), `mcp-${randomUUID()}.json`);
      writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: access.servers }), { mode: 0o600 });
    }
    // Con runner remoto el agente trabaja en el clon del runner: el prompt no lleva la ruta de casa (T74 §3.3; el e2e con claude real se perdía buscándola).
    const promptDir = remote ? '.' : path;
    const prompt = a.validator
      ? buildValidatorPrompt(a.validator, { change, diffStat, base: 'main', branch, worktree: promptDir, history, untrusted: channel || undefined }, profile.validators)
      : buildWorkerPrompt({ workstream: ws, change, activity: a, history, worktree: promptDir, branch, untrusted: channel || undefined }, { factoryCommits: agent.factoryCommits }, profile.worker);
    log(`[${workerId}] ${a.validator ?? a.kind} "${change.title}" -> ${adapter} in ${path}`);
    const readOnly = a.validator ? (a.validator !== 'qa') : (a.kind === 'investigation');
    const probeFile = `${runDirectory(opts.stateDir, change.id)}/${a.id}.egress.json`;
    // A retry keeps the activity id: drop the previous attempt's probe so it is never reported as this one's.
    rmSync(probeFile, { force: true });
    const captureAgent: AgentAdapter = { ...agent, env: () => ({ ...agent.env?.(), FABRICA_EGRESS_PROBE_FILE: probeFile, ...(access.meta.env.length ? { FABRICA_SCRUB_NAMES: access.meta.env.join(',') } : {}) }), command: (text, options) => [
      ...selfCommand('__capture', new URL('./manifest-capture.ts', import.meta.url)),
      activityLog(opts.stateDir, change.id, a.id), ...agent.command(text, options),
    ] };
    // From launch onward the cost is unknown until the agent reports it.
    attemptCosts[attemptCosts.length - 1] = null;
    let runnerMeta: Record<string, unknown> = runner ? { runner: { name: runner.name, kind: runner.kind } } : {};
    atomicEvidence(meta, JSON.stringify({ ...pendingEvidence, ...provenance, ...accessMeta, ...runnerMeta }));
    const crash = (point: CrashPoint) => opts.crash?.(point);
    let outcome: LiveOutcome | undefined;
    let run: AgentRun;
    let notesAttemptId: string | undefined;
    if (live) {
      ({ run, outcome } = await runLiveActivity(store, adm!, a, {
        backend: live, cwd: path, stateDir: opts.stateDir, profileDigest, model, prompt, timeoutMs: turnTimeoutMs(opts), signal: abortController.signal, confine,
        claudeProjects: join(resolve(opts.stateDir), 'live', change.id.slice(0, 8), 'claude-projects'),
        mcpConfigDir: join(resolve(opts.stateDir), 'live', change.id.slice(0, 8), 'mcp'),
        capturePath: confine ? activityLog(opts.stateDir, change.id, a.id) : undefined,
        onSpawn: pgid => store.setActivityAgentPgid(a.id, pgid), crash,
        templates: profile.worker, branch, factoryCommits: agent.factoryCommits,
        mcpServers: access.servers, envDecl: access.decl, scrub: access.decl ? scrub : undefined,
      }));
      if (!confine) atomicEvidence(activityLog(opts.stateDir, change.id, a.id), `${run.stdout ?? ''}${run.stderr ?? ''}`);
    } else {
      let turnPrompt = prompt;
      if (role === 'investigate' || role === 'implement') {
        const attemptId = randomUUID();
        const delivery = reserveTurnPrompt(store, a, attemptId, {
          cwd: path, remote: !!remote, confine, adapter, promptStdin: agent.promptStdin,
          persistentMounts: [join(resolve(opts.stateDir), 'live')],
        }, notes => prompt + notesBlock(notes));
        turnPrompt = delivery.prompt;
        if (delivery.reserved) notesAttemptId = attemptId;
      }
      if (remote) {
        const head = gitEvidence(path, 'rev-parse', 'HEAD');
        if (!head) throw new Error('no se pudo leer HEAD del worktree');
        const attempt = a.retryCount + 1, jobId = `${a.id}-${attempt}`;
        store.event(ws.id, 'info', `encargo enviado al runner ${remote.name} (${jobId})`, change.id, a.id);
        try {
          const done = await runRemoteAgent({ name: remote.name, target: remote.target! }, {
            activityId: a.id, attempt, adapter, model, readOnly, expectChanges: !a.validator && a.kind === 'implementation',
            prompt: turnPrompt, repo: ws.repo, worktree: path, head, base: baseSha, timeoutMs: turnTimeoutMs(opts) ?? 20 * 60_000,
            ...(typeof remote.options.maxBundleMb === 'number' ? { maxBundleMb: remote.options.maxBundleMb } : {}),
            repoKey: createHash('sha256').update(ws.id).digest('hex'), signal: abortController.signal,
            onSpawn: pgid => store.setActivityAgentPgid(a.id, pgid),
          }, opts.runnerTransport, opts.runnerDeps);
          const { declared, ...rest } = done;
          run = rest;
          runnerMeta = { runner: { name: remote.name, kind: remote.kind, jobId, declared } };
          const after = gitEvidence(path, 'rev-parse', 'HEAD');
          if (after && after !== head) store.event(ws.id, 'info', `resultado del runner ${remote.name} importado (${after.slice(0, 8)})`, change.id, a.id);
        } catch (err) {
          if (!(err instanceof RunnerError)) throw err;
          // R9: ningún fallo del runner vuelve a local. Solo códigos y nombres a la base y al log; nunca texto libre del runner.
          if (abortController.signal.aborted || store.isTerminalChange(store.getChange(change.id).status)) { store.releaseActivity(a.id, workerId); return; }
          if (err.code === 'RUNNER_BUSY') store.requeueActivity(a.id, workerId); // sin gastar reintento
          else if (err.code === 'RUNNER_LOST') failLive(store, a.id, workerId, err.message);
          else {
            if (err.code === 'RUNNER_RESULT_REJECTED') store.event(ws.id, 'warning', `resultado del runner ${remote.name} rechazado (${jobId})`, change.id, a.id);
            store.blockActivity(a.id, workerId, err.message);
          }
          log(`[${workerId}] ${a.validator ?? a.kind} runner ${remote.name}: ${err.code}`);
          return;
        }
      } else run = await runAgent(confine ? agent : captureAgent, turnPrompt, path, turnTimeoutMs(opts), {
        confine,
        model: model ?? undefined,
        envDecl: access.decl, scrub, mcpConfig: mcpConfigPath,
        capturePath: confine ? activityLog(opts.stateDir, change.id, a.id) : undefined,
        readOnly,
        signal: abortController.signal,
        onSpawn: (pgid) => {
          store.setActivityAgentPgid(a.id, pgid);
        },
      });
    }

    // S6: nada de lo que la fab guarda de la ejecución lleva un valor entregado (los backends vivos y falsos no pasan por runAgent).
    if (access.decl) {
      const clean = (t: string) => scrubValues(t, scrub);
      run = { ...run, output: clean(run.output), status: { ...run.status, reason: clean(run.status.reason) }, ...(run.stdout !== undefined ? { stdout: clean(run.stdout) } : {}), ...(run.stderr !== undefined ? { stderr: clean(run.stderr) } : {}) };
    }
    attemptCosts[attemptCosts.length - 1] = run.usage?.costUsd ?? null;
    atomicEvidence(meta, JSON.stringify({
      ...provenance, ...accessMeta, ...runnerMeta, isolation: remote ? 'remote: declarado por el runner, no verificado' : confine ? 'bwrap-allowlist' : isolationFor(provenance.adapter ?? adapter), durationMs: run.durationMs, exitCode: run.exitCode, usage: run.usage ?? null,
      attemptCosts,
      egressProbe: adapter === 'native' ? readEgressProbe(probeFile) : null,
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
    // Cierra junto con la marca del report vivo o con la confirmación de las notas de un disparo.
    const close = (fn: () => Activity): Activity => {
      if (outcome) return closeWithReport(store, adm!, { activityId: a.id, workerId }, fn);
      if (!notesAttemptId) return fn();
      return store.withRetry(() => {
        const closed = fn();
        store.confirmNotes(notesAttemptId);
        return closed;
      });
    };
    if (run.status.kind === 'blocked') {
      close(() => store.blockActivity(a.id, workerId, run.status.reason));
      log(`[${workerId}] ${a.validator ?? a.kind} blocked: ${run.status.reason}`);
      return;
    }
    if (!run.ok) {
      failLive(store, a.id, workerId, `agent exit ${run.exitCode}: ${run.output.slice(-1000)}`);
      log(`[${workerId}] ${a.validator ?? a.kind} failed (exit ${run.exitCode})`);
      return;
    }
    if (run.status.kind !== 'done') {
      const prefix = run.status.reason;
      failLive(store, a.id, workerId, `${prefix}\n\n${run.output.slice(-2000)}`);
      log(`[${workerId}] ${a.validator ?? a.kind} failed: ${run.status.reason}`);
      return;
    }
    if (a.validator) {
      const verdictResult = parseVerdict(run.output);
      if (!verdictResult) {
        failLive(store, a.id, workerId, `report has no valid VERDICT line:\n\n${run.output.slice(-2000)}`);
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
        failLive(store, a.id, workerId, `${a.validator} dejó cambios en el worktree`);
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
      if (agent.factoryCommits && !remote) await commitWorktree(path, `${change.title}\n\nImplemented by ${adapter} (fab activity ${a.id.slice(0, 8)}).`);
      const commits = await branchCommits(ws.repo, branch);
      if (commits.length === 0 && adapter !== 'fake') {
        failLive(store, a.id, workerId, 'implementation reported done but left no commits on the branch');
        log(`[${workerId}] implementation produced no commits`);
        return;
      }
    }
    close(() => store.completeActivity(a.id, workerId, run.output));
    log(`[${workerId}] ${a.kind} done in ${Math.round(run.durationMs / 1000)}s`);
  } catch (err) {
    if (err instanceof CrashInjected) throw err;
    if (isBusyError(err)) {
      log(`[${workerId}] database locked during activity processing, preserving activity without failing`);
      try {
        store.requeueActivity(activity.id, workerId);
      } catch {}
      return;
    }
    const msg = scrubValues(err instanceof Error ? err.message : String(err), scrub);
    try {
      const currentChange = store.getChange(activity.changeId);
      if (!store.isTerminalChange(currentChange.status) && !abortController.signal.aborted) {
        if (err instanceof WorktreeNeedsRepair) store.blockActivity(activity.id, workerId, msg);
        else if (activity.kind === 'gates') store.blockActivity(activity.id, workerId, `GATES_FAIL: ${msg}`);
        else failLive(store, activity.id, workerId, msg);
      } else {
        store.releaseActivity(activity.id, workerId);
      }
    } catch {
      // Activity already moved on (e.g. canceled); nothing to record.
    }
    log(`[${workerId}] error: ${msg}`);
  } finally {
    clearInterval(heartbeatTimer);
    if (mcpConfigPath) rmSync(mcpConfigPath, { force: true });
    writeManifest(store, activity.changeId, opts.stateDir);
  }
}

/** Run the pool. Returns when idle (untilIdle) or never (daemon mode). */
/** Nota (T31): `workerConcurrency` se aplica por proceso de pool, no global; para no duplicarlo, un pool por workstream. */
export async function runPool(store: Store, opts: PoolOptions): Promise<void> {
  const log = opts.log ?? console.log;
  const ws = store.getWorkstream(opts.workstream);
  // Conserva la comprobación inicial y reutilízala al comprobar cada adaptador por rol.
  const startupAdapter = opts.agentOverride ?? ws.agent;
  const fallback = ws.runner ? store.findRunner(ws.runner) : null;
  let perRole = false;
  try { perRole = profileRunnerNames(resolveProfile(opts.stateDir, ws.profile).profile).length > 0; }
  catch { perRole = true; } // el reclamo registra el error del perfil en la activity
  const remote = fallback?.kind === 'ssh';
  // Un runner remoto corre de un disparo: la sesión del harness y el servidor de `report` no pueden cruzar la red (T74 §1).
  if (opts.live && remote && !perRole) throw new StoreError('invalid_input', `LIVE_NOT_REMOTE: el workstream usa el runner remoto ${ws.runner}; --live no es compatible`);
  // El binario de un runner remoto lo comprueba el runner, no esta máquina.
  const agentCheck = perRole || remote || (ws.runner !== null && !fallback?.enabled) ? undefined : verifyAgentStart(startupAdapter);
  const agentChecks = new Map<string, AgentStartCheck>(agentCheck ? [[startupAdapter, agentCheck]] : []);
  if (agentCheck?.violation && !opts.acceptAgentBinaries) throw new Error(agentCheck.violation);
  if (agentCheck?.warning) log(agentCheck.warning);
  if (opts.live && !backendOf(opts, startupAdapter)) log(`aviso: --live pero el adaptador «${startupAdapter}» no tiene backend vivo: depende del rol; las activities sin backend vivo correrán de un disparo, sin sesión reanudable`); // B4
  const adm = opts.live || hasAdmission(store) ? new AdmissionDb(store) : undefined; // una vez, no en cada vuelta del bucle (B3)
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
        recovered = store.requeueOrphans(ws.id, undefined, id => !!adm && new ReportStore(adm).pending(id) !== undefined); // M2
        // M4: el plazo de una espera también lo vigila el pool (no solo el residente), para que venza aunque el residente no corra.
        if (opts.live && adm) expireQuestions(store, adm);
      } catch (err) {
        if (isBusyError(err)) {
          await Promise.race([Bun.sleep(50), interruptPromise]);
          continue;
        }
        throw err;
      }
      if (recovered) log(`recovered ${recovered} orphaned activities`);
      // T68d: solo crea señales (nunca activities); el triage sigue siendo del dueño.
      // Aislada: un fallo (contención o no) de una función auxiliar no puede parar el reclamo ni terminar el pool.
      try {
        for (const r of store.fireDueAutomations(ws.id)) log(`automation ${r.id.slice(0, 8)}: ${r.result}`);
      } catch (err) {
        if (!isBusyError(err)) log(`automation: ${(err as Error).message}`);
      }

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
        const p: Promise<void> = processActivity(store, claimed, workerId, opts, controller, agentChecks).finally(() => {
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
