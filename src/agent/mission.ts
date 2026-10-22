import { scopedExecutionOptions, resolveExecutionPolicy } from './execution-policy.ts';
import { resolve, join } from 'node:path';
import { readWorkspaceFile } from './files.ts';
import { handoffSchema, handoffSucceeded, parseFeatures, parseHandoff, type FeatureHandoff, type MissionAttempt, type MissionFeature, type MissionState } from './mission-contract.ts';
import { createCommandObserver, observedSuccessfulCommand, runVerifier, unobservedClaims } from './mission-evidence.ts';
import { createMissionDirectory, digest, digestPaths, fingerprintWorkspace, missionDirectory, missionGit, writeMissionFile, writeMissionState } from './mission-files.ts';
import { inputObject, stringArg, tool } from './tools.ts';
import type { SessionState } from './session.ts';
import type { AgentLineage, CallReservation } from './tasks.ts';
import type { AgentOptions, AgentResult, AgentTool, ToolContext } from './types.ts';

const str = { type: 'string' };
const now = () => new Date().toISOString();

/** Serial, invocation-owned runner. Session snapshots are authoritative;
 * model-editable planning files never supply completion or validation state. */
export class MissionManager {
  readonly directory: string;
  private runSignal?: AbortSignal;
  /** Model calls reserved for the active StartMissionRun; workers and validators spend them first. */
  private calls?: CallReservation;
  private get execution() { return { ...this.context, signal: this.runSignal ?? this.context.signal }; }
  constructor(private readonly opts: AgentOptions, private readonly context: ToolContext,
    private readonly state: SessionState, private readonly lineage: AgentLineage, private readonly maxDepth: number,
    private readonly save: () => Promise<void>, private readonly runChild: (opts: AgentOptions, reservation?: CallReservation) => Promise<AgentResult>) {
    this.directory = missionDirectory(opts, state.id);
    if (state.mission && (state.mission.version !== 1 || state.mission.directory !== this.directory || state.mission.workingDirectory !== context.cwd)) throw new Error('Mission snapshot ownership mismatch');
    context.missionDir = this.directory;
  }
  private get mission() { if (!this.state.mission) throw new Error('ProposeMission must be accepted first'); return this.state.mission; }
  private emit(type: 'mission_state_changed' | 'mission_worker_started' | 'mission_worker_completed', fields: Record<string, unknown>) {
    this.opts.onEvent?.({ type, sessionId: this.state.id, ...fields });
  }
  private async sync(state?: MissionState['state']) {
    const m = this.mission; if (state) m.state = state; m.updatedAt = now();
    await this.save(); await writeMissionState(m);
    if (state) this.emit('mission_state_changed', { state, missionId: m.missionId });
  }
  private async log(type: string, fields: Record<string, unknown> = {}) {
    let before = '';
    try { before = (await readWorkspaceFile(this.directory, 'progress_log.jsonl')).text; } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const lines = before.split('\n').filter(Boolean).slice(-999);
    lines.push(JSON.stringify({ timestamp: now(), type, ...fields }));
    await writeMissionFile(this.directory, 'progress_log.jsonl', lines.join('\n') + '\n', true);
  }
  private async propose(input: unknown) {
    const p = inputObject(input), title = stringArg(p, 'title'), proposal = stringArg(p, 'proposal');
    if (!title.trim() || title.length > 200 || !proposal.trim() || Buffer.byteLength(proposal) > 64 * 1024) throw new Error('Invalid mission title/proposal');
    if (p.workingDirectory !== undefined && resolve(this.context.cwd, stringArg(p, 'workingDirectory')) !== this.context.cwd) throw new Error('Mission workingDirectory must match the session workspace');
    if (this.state.mission) throw new Error('This session already owns a mission; update its planning files instead');
    await createMissionDirectory(this.context, this.directory);
    this.state.mission = { version: 1, missionId: `mis_${crypto.randomUUID()}`, directory: this.directory, title, proposal,
      workingDirectory: this.context.cwd, state: 'planning', createdAt: now(), updatedAt: now(), features: {}, validations: {}, attempts: [], dismissals: [] };
    await this.sync('planning');
    await writeMissionFile(this.directory, 'mission.md', `# ${title}\n\n${proposal}\n`, true);
    await writeMissionFile(this.directory, 'model-settings.json', { workerModel: this.opts.mission?.workerProvider?.id ?? this.opts.provider.id,
      validationWorkerModel: this.opts.mission?.validatorProvider?.id ?? this.opts.provider.id });
    await this.log('mission_accepted', { title });
    return { accepted: true, missionDir: this.directory };
  }
  private async planning() {
    const m = this.mission;
    const features = parseFeatures(JSON.parse((await readWorkspaceFile(this.directory, 'features.json')).text));
    if (Object.keys(m.features).some(id => !features.some(f => f.id === id))) throw new Error('Keep known features in the plan; explicitly mark removed scope cancelled');
    const skills = new Map<string, string>();
    const optional = async (name: string) => { try { return (await readWorkspaceFile(this.directory, name)).text; } catch (e: any) { if (e.code !== 'ENOENT') throw e; return ''; } };
    const guidance = await optional('AGENTS.md'), contract = await optional('validation-contract.md');
    for (const f of features) {
      const text = (await readWorkspaceFile(this.directory, `skills/${f.skillName}/SKILL.md`)).text;
      const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
      if (!header || !/^name:[ \t]*\S.*$/m.test(header) || !/^description:[ \t]*\S.*$/m.test(header)) throw new Error(`Mission skill ${f.skillName} needs name/description frontmatter`);
      skills.set(f.skillName, text);
    }
    m.initialFeatureCount ??= features.length;
    if (features.length >= m.initialFeatureCount + 25 && features.length > m.initialFeatureCount * 4) throw new Error('Mission scope-growth limit exceeded');
    const sealed = m.sealedContract ??= {};
    for (const f of features) {
      const prior = sealed[f.id];
      if (prior) {
        const dropped = [...prior.verificationCommands.filter(c => !f.verificationCommands.includes(c)),
          ...prior.protectedPaths.filter(p => !f.protectedPaths.includes(p))];
        if (dropped.length) throw new Error(`Feature ${f.id} cannot drop sealed verification: ${dropped.join(', ')}`);
      }
      sealed[f.id] = { verificationCommands: [...f.verificationCommands], protectedPaths: [...f.protectedPaths] };
    }
    for (const f of features) {
      const { status: ignored, ...definition } = f, hash = digest({ definition, skill: skills.get(f.skillName), guidance, contract }), previous = m.features[f.id];
      if (previous && previous.definitionHash !== hash) {
        previous.status = 'pending'; previous.definitionHash = hash; delete m.validations[f.milestone];
      }
      if (!m.features[f.id]) { m.features[f.id] = { status: 'pending', attempts: 0, workerSessionIds: [], definitionHash: hash }; delete m.validations[f.milestone]; }
      // A model cannot self-approve by writing status: completed in features.json.
      if (f.status === 'completed' && m.features[f.id]!.status !== 'completed') throw new Error('Only validated worker progress can complete a feature');
      if (f.status === 'cancelled') m.features[f.id]!.status = 'cancelled';
      f.status = m.features[f.id]!.status === 'awaiting_validation' ? 'pending' : m.features[f.id]!.status as MissionFeature['status'];
    }
    return { features: structuredClone(features), skills, guidance, contract };
  }
  private preflight() {
    if (this.lineage.depth >= this.maxDepth) throw new Error('Mission worker delegation depth exhausted');
    if (this.opts.removeTools?.includes('EndFeatureRun') || this.opts.onlyTools && !this.opts.onlyTools.includes('EndFeatureRun')) throw new Error('Mission workers require EndFeatureRun in their inherited tool policy');
    if (this.lineage.budget.agents >= this.lineage.budget.maxAgents) throw new Error('Shared mission agent budget exhausted');
  }
  private async attempt(feature: MissionFeature, role: MissionAttempt['role'], skill: string, resume?: string, message?: string) {
    this.preflight();
    const m = this.mission, record = m.features[feature.id]!;
    if (m.attempts.length >= 100) throw new Error('Mission handoff history limit reached');
    if (role === 'worker' && record.attempts >= 5) throw new Error('Feature attempt limit reached');
    if (role !== 'worker' && m.attempts.filter(a => a.featureId === feature.id && a.role === role).length >= 5) throw new Error('Validator attempt limit reached');
    if (resume && !m.attempts.some(a => a.workerSessionId === resume && a.featureId === feature.id && a.role === role && !handoffSucceeded(a.handoff))) throw new Error('Worker resume ID is not owned by this active feature');
    this.lineage.budget.reserveAgent();
    const workerSessionId = resume ?? crypto.randomUUID();
    const attempt: MissionAttempt = { workerSessionId, featureId: feature.id, role };
    m.attempts.push(attempt); if (role === 'worker') record.attempts++;
    record.workerSessionIds.push(workerSessionId);
    let sealed = false;
    try {
      await this.sync(); await this.log('worker_started', { workerSessionId, featureId: feature.id, role });
      this.emit('mission_worker_started', { workerSessionId, featureId: feature.id, role, executionPolicy: resolveExecutionPolicy(scopedExecutionOptions(this.context, role !== 'worker')) });
      const submit = async (input: unknown) => {
        if (sealed) throw new Error('A handoff has already been submitted for this attempt');
        const handoff = parseHandoff(input, feature.id); sealed = true;
        try {
          if (handoff.repoPath && resolve(this.context.cwd, handoff.repoPath) !== this.context.cwd) throw new Error('Handoff repoPath must match the assigned workspace');
          if (handoff.commitId) {
            if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(handoff.commitId)) throw new Error('Handoff commitId must be a full commit hash');
            const head = await missionGit(this.execution, ['rev-parse', 'HEAD']);
            if (head.exitCode || head.stdout.trim() !== handoff.commitId) throw new Error('Handoff commitId does not match the workspace HEAD');
          }
          attempt.handoff = handoff;
          return { accepted: true, featureId: feature.id, workerSessionId };
        } catch (error) { sealed = false; throw error; }
      };
      const validation = role !== 'worker';
      const observer = createCommandObserver();
      const prompt = `Assigned mission feature ${feature.id}; role ${role}.\n${feature.description}\nPreconditions: ${JSON.stringify(feature.preconditions)}\nExpected behavior: ${JSON.stringify(feature.expectedBehavior)}\nAssertion IDs: ${JSON.stringify(feature.fulfills)}\n\n${skill}\n\n${message ?? ''}\n${validation ? 'Independently verify the current code and tests. The workspace is read-only. Report observed evidence, failures and unfinished work.' : 'Implement this feature and verify it with the available tools.'}\nSubmit exactly one truthful EndFeatureRun handoff. A final text response without a valid handoff does not complete the feature. After submission, workspace mutation is closed.`;
      const result = await this.runChild({ ...this.opts, prompt, cwd: this.context.cwd,
        provider: validation ? this.opts.mission?.validatorProvider ?? this.opts.provider : this.opts.mission?.workerProvider ?? this.opts.provider,
        ...scopedExecutionOptions(this.context, validation), allowExitSpecMode: false,
        signal: this.execution.signal, sessionDir: this.opts.sessionDir ?? join(this.directory, 'sessions'),
        newSessionId: resume ? undefined : workerSessionId, sessionId: resume, fork: false,
        tools: [], images: undefined, validateFinal: undefined, receiveMessages: undefined, onEvent: undefined,
        appendSystemPrompt: undefined, mission: undefined, missionWorker: { directory: this.directory, featureId: feature.id, sealed: () => sealed, submit, observe: observer.observe },
      }, this.calls);
      this.execution.signal.throwIfAborted();
      if (!result.ok) attempt.error = result.error?.message ?? 'Worker failed';
      if (!attempt.handoff) attempt.error = 'Worker ended without a valid EndFeatureRun handoff';
      // The handoff is a claim; success is derived from what the runtime observed.
      attempt.observed = observer.observed();
      if (attempt.handoff && !attempt.error) {
        const forged = unobservedClaims(attempt.handoff, attempt.observed);
        if (forged.length) attempt.error = `Handoff claims verification the runtime did not observe: ${forged.join('; ')}`;
        else if (validation && !observedSuccessfulCommand(attempt.observed)) attempt.error = 'Validator reported success without running any successful verification command';
      }
      await writeMissionFile(this.directory, `handoffs/${workerSessionId}-${m.attempts.length}.json`, attempt);
      await this.log(attempt.error ? 'worker_failed' : 'worker_completed', { workerSessionId, featureId: feature.id, role, successState: attempt.handoff?.successState, error: attempt.error });
      this.emit('mission_worker_completed', { workerSessionId, featureId: feature.id, role, exitCode: result.ok ? 0 : 1, hasHandoff: !!attempt.handoff });
      return attempt;
    } finally { this.lineage.budget.releaseAgent(); }
  }
  private snapshot() {
    const m = this.mission, records = Object.values(m.features);
    return { kind: 'start_mission_run_snapshot', state: m.state, updatedAt: m.updatedAt, counts: { total: records.length,
      completed: records.filter(f => f.status === 'completed').length, cancelled: records.filter(f => f.status === 'cancelled').length } };
  }
  /**
   * Items each attempt left open. A dismissal is bound to the attempt that produced the item, so
   * the same text reported by a later attempt is a new item and inherits no earlier approval.
   */
  private pendingItems() {
    const items: Array<{ type: string; sourceFeatureId: string; summary: string; attempt: number }> = [];
    this.mission.attempts.forEach((a, attempt) => {
      if (!a.handoff) return;
      for (const issue of a.handoff.handoff.discoveredIssues) items.push({ type: 'discovered_issue', sourceFeatureId: a.featureId, summary: issue.description, attempt });
      if (a.handoff.handoff.whatWasLeftUndone.trim()) items.push({ type: 'incomplete_work', sourceFeatureId: a.featureId, summary: a.handoff.handoff.whatWasLeftUndone, attempt });
    });
    return items.filter(item => !this.mission.dismissals.some(d => d.attempt === item.attempt && d.type === item.type && d.sourceFeatureId === item.sourceFeatureId && d.summary === item.summary));
  }
  private async dismiss(input: unknown) {
    const p = inputObject(input), pending = this.pendingItems(), claimed = new Set<(typeof pending)[number]>();
    if (!Array.isArray(p.dismissals) || !p.dismissals.length || p.dismissals.length > 100) throw new Error('Invalid handoff dismissals');
    const entries = p.dismissals.map(value => {
      const d = inputObject(value), type = stringArg(d, 'type'), sourceFeatureId = stringArg(d, 'sourceFeatureId'), summary = stringArg(d, 'summary'), justification = stringArg(d, 'justification');
      // A dismissal addresses the oldest matching open item; repeating the same text later needs its own dismissal.
      const item = pending.find(i => i.type === type && i.sourceFeatureId === sourceFeatureId && i.summary === summary && !claimed.has(i));
      if (justification.trim().length < 20 || justification.length > 8192 || !item) throw new Error('Dismissal must identify a pending handoff item and include a meaningful justification');
      claimed.add(item);
      return { type, sourceFeatureId, summary, justification, attempt: item.attempt };
    });
    if (this.mission.dismissals.length + entries.length > 1000) throw new Error('Mission dismissal limit reached');
    this.mission.dismissals.push(...entries); await this.sync(); await this.log('handoff_items_dismissed', { count: entries.length });
    return { dismissed: entries.length };
  }
  private async start(input: unknown, scope: ToolContext) {
    const p = inputObject(input), { features, skills, guidance, contract } = await this.planning();
    if (this.pendingItems().length) throw new Error('Address the returned handoff items and record DismissHandoffItems before continuing');
    if (p.restartFeature !== undefined && typeof p.restartFeature !== 'boolean') throw new Error('Invalid restartFeature');
    const resume = p.resumeWorkerSessionId === undefined ? undefined : stringArg(p, 'resumeWorkerSessionId');
    const message = p.messageToWorker === undefined ? undefined : stringArg(p, 'messageToWorker');
    if (resume && p.restartFeature) throw new Error('resumeWorkerSessionId and restartFeature are mutually exclusive');
    this.preflight(); scope.signal.throwIfAborted();
    const jobs = features.filter(f => this.mission.features[f.id]!.status === 'pending').length +
      2 * new Set(features.filter(f => this.mission.features[f.id]!.status !== 'cancelled').map(f => f.milestone)).size;
    if (this.lineage.budget.maxAgents - this.lineage.budget.agents < jobs) throw new Error('Insufficient shared agent budget for workers and independent validators');
    // Minimum model calls the run must be able to afford before its first effect: one handoff
    // per pending worker, and one verification call plus one handoff per validator role.
    const pendingWorkers = features.filter(f => this.mission.features[f.id]!.status === 'pending').length;
    this.calls = this.lineage.budget.reserveCalls(pendingWorkers + 2 * (jobs - pendingWorkers));
    this.runSignal = scope.signal;
    const handoffs: MissionAttempt[] = [];
    try {
      await this.sync('running'); await this.log('mission_run_started');
      const guarded = [...new Set(features.flatMap(f => f.protectedPaths))].sort();
      // The baseline survives pauses: work resumed later is still compared with the original files.
      this.mission.protectedBaseline ??= await digestPaths(this.execution, guarded);
      for (const path of guarded) if (!(path in this.mission.protectedBaseline)) this.mission.protectedBaseline[path] = (await digestPaths(this.execution, [path]))[path]!;
      await this.sync();
      let resumed = false;
      for (const feature of features) {
        this.execution.signal.throwIfAborted();
        const record = this.mission.features[feature.id]!;
        if (record.status !== 'pending') continue;
        const work = await this.attempt(feature, 'worker', skills.get(feature.skillName)! + '\nMission guidance:\n' + guidance + '\nValidation contract:\n' + contract, !resumed ? resume : undefined, message);
        resumed = true; handoffs.push(work);
        if (work.error || !handoffSucceeded(work.handoff)) { await this.sync('orchestrator_turn'); return { started: true, workerHandoffs: handoffs, progressSnapshot: this.snapshot() }; }
        record.status = 'awaiting_validation'; delete this.mission.validations[feature.milestone]; await this.sync();
        if (work.handoff?.returnToOrchestrator || work.handoff?.handoff.discoveredIssues.length) { await this.sync('orchestrator_turn'); return { started: true, workerHandoffs: handoffs, progressSnapshot: this.snapshot() }; }
      }
      if (resume && !resumed) throw new Error('No pending feature owns the requested worker resume');
      // Workers may not weaken the checks that will judge them (tests, fixtures, verifier scripts).
      const current = await digestPaths(this.execution, guarded);
      const tampered = guarded.filter(path => current[path] !== this.mission.protectedBaseline![path]);
      if (tampered.length) {
        await this.log('protected_paths_changed', { paths: tampered });
        await this.sync('paused');
        return { started: true, workerHandoffs: handoffs, protectedPathsChanged: tampered, progressSnapshot: this.snapshot() };
      }
      // All workers have drained. Validate each milestone against the same frozen
      // source bytes; worker claims and editable feature statuses grant no success.
      const sourceDigest = await fingerprintWorkspace(this.execution);
      for (const milestone of new Set(features.map(f => f.milestone))) {
        const group = features.filter(f => f.milestone === milestone && this.mission.features[f.id]!.status !== 'cancelled');
        if (!group.length) continue;
        const checks = this.mission.validations[milestone] ??= {};
        if (checks.sourceDigest !== sourceDigest) { checks.scrutiny = false; checks['user-testing'] = false; checks.sourceDigest = sourceDigest; }
        if (checks.scrutiny && checks['user-testing']) continue;
        for (const f of group) this.mission.features[f.id]!.status = 'awaiting_validation';
        const feature = { ...group[0]!, description: `Validate milestone ${milestone}:\n` + group.map(f => `${f.id}: ${f.description}`).join('\n'),
          expectedBehavior: group.flatMap(f => f.expectedBehavior), fulfills: group.flatMap(f => f.fulfills) };
        for (const role of ['scrutiny', 'user-testing'] as const) {
          if (checks[role]) continue;
          await this.sync();
          const checked = await this.attempt(feature, role, `Independently review the requested behavior. Run relevant tests and inspect actual outputs. Do not claim unperformed verification.\nMission guidance:\n${guidance}\nValidation contract:\n${contract}`);
          handoffs.push(checked);
          if (await fingerprintWorkspace(this.execution) !== sourceDigest) throw new Error('Source changed during read-only mission validation');
          if (checked.error || !handoffSucceeded(checked.handoff)) { await this.sync('paused'); return { started: true, workerHandoffs: handoffs, progressSnapshot: this.snapshot() }; }
          if (checked.handoff?.returnToOrchestrator || checked.handoff?.handoff.discoveredIssues.length) {
            await this.sync('orchestrator_turn'); return { started: true, workerHandoffs: handoffs, progressSnapshot: this.snapshot() };
          }
          checks[role] = true;
        }
        // Contract verifiers run by the runner itself against the same frozen source.
        const commands = [...new Set(group.flatMap(f => f.verificationCommands))];
        if (!commands.length) {
          await this.log('verification_contract_missing', { milestone });
          await this.sync('paused');
          return { started: true, workerHandoffs: handoffs, verificationMissing: milestone, progressSnapshot: this.snapshot() };
        }
        {
          checks.verifiers = [];
          for (const command of commands) checks.verifiers.push(await runVerifier(this.execution, command));
          if (await fingerprintWorkspace(this.execution) !== sourceDigest) throw new Error('Source changed during mission verification');
          await this.log('mission_verifiers_ran', { milestone, verifiers: checks.verifiers.map(v => ({ command: v.command, exitCode: v.exitCode })) });
          if (checks.verifiers.some(v => v.exitCode !== 0)) {
            checks.scrutiny = false; checks['user-testing'] = false;
            await this.sync('paused'); return { started: true, workerHandoffs: handoffs, progressSnapshot: this.snapshot() };
          }
        }
        for (const f of group) this.mission.features[f.id]!.status = 'completed';
        await this.sync();
      }
      await this.sync('completed');
      return { started: true, workerHandoffs: handoffs, progressSnapshot: this.snapshot() };
    } catch (error) { await this.sync('paused'); throw error; }
    finally { this.runSignal = undefined; this.calls?.release(); this.calls = undefined; }
  }
  tools(): AgentTool[] {
    return [
      tool('ProposeMission', 'control', { title: str, proposal: str, workingDirectory: str }, ['title', 'proposal'], input => this.propose(input),
        'Accept a mission proposal and create owned metadata. Create features.json and skills/<skillName>/SKILL.md there before starting. No worker runs during proposal.'),
      tool('StartMissionRun', 'execute', { message: str, resumeWorkerSessionId: str, restartFeature: { type: 'boolean' }, messageToWorker: str }, [], (input, c) => this.start(input, c),
        'Run frozen feature definitions serially with worker handoffs and independent read-only validators. A successful turn is not necessarily a completed mission; inspect progressSnapshot.state.'),
      tool('DismissHandoffItems', 'control', { dismissals: { type: 'array', items: { type: 'object', properties: { type: str, sourceFeatureId: str, summary: str, justification: str }, required: ['type', 'sourceFeatureId', 'summary', 'justification'] } } }, ['dismissals'], input => this.dismiss(input),
        'Record how an observed handoff issue or unfinished item was addressed, with its feature, exact summary and a justification of at least 20 characters. This never marks the feature completed.'),
    ];
  }
}

export function featureHandoffTool(opts: NonNullable<AgentOptions['missionWorker']>): AgentTool {
  return { effect: 'control', schema: { type: 'function', function: { name: 'EndFeatureRun', description: 'Submit the assigned feature handoff. This closes workspace mutation for this worker; report only observed evidence.', parameters: handoffSchema } },
    run: input => opts.submit(input) };
}
