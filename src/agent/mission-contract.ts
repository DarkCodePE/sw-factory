import { inputObject, stringArg } from './tools.ts';
import type { ObservedCommand, VerifierResult } from './mission-evidence.ts';

export interface FeatureHandoff {
  successState: 'success' | 'partial' | 'failure';
  returnToOrchestrator: boolean;
  featureId?: string;
  commitId?: string;
  repoPath?: string;
  validatorsPassed?: boolean;
  handoff: {
    salientSummary: string; whatWasImplemented: string; whatWasLeftUndone: string;
    verification: { commandsRun: Array<{ command: string; exitCode: number; observation: string }>; interactiveChecks?: Array<{ action: string; observed: string }> };
    tests: { added: Array<{ file: string; cases: Array<{ name: string; verifies: string }> }>; updated?: string[]; coverage: string };
    discoveredIssues: Array<{ severity: 'blocking' | 'non_blocking' | 'suggestion'; description: string; suggestedFix?: string }>;
    skillFeedback?: { followedProcedure: boolean; deviations: Array<{ step: string; whatIDidInstead: string; why: string }>; suggestedChanges?: string[] };
  };
}
export interface MissionFeature {
  id: string; description: string; skillName: string; preconditions: string[]; expectedBehavior: string[];
  fulfills: string[]; milestone: string; status: 'pending' | 'completed' | 'cancelled';
  /** Simple commands the runner itself executes (read-only sandbox) before a milestone completes. */
  verificationCommands: string[];
  /** Workspace-relative files the workers may not change (e.g. the tests the verifiers run). */
  protectedPaths: string[];
}
export interface MissionAttempt {
  workerSessionId: string; featureId: string; role: 'worker' | 'scrutiny' | 'user-testing';
  handoff?: FeatureHandoff; error?: string;
  milestone?: string;
  /** Set only by the runner's host-pause path; never inferred from error text. */
  pausedByHost?: boolean;
  /** False until the child saved its initial session; permits same-ID launch after an early pause. */
  sessionCreated?: boolean;
  status?: 'running' | 'completed' | 'failed';
  usage?: { inputTokens: number; outputTokens: number };
  durationMs?: number;
  /** Execute calls the runtime observed during this attempt (the handoff is only a claim). */
  observed?: ObservedCommand[];
}
export interface MissionState {
  version: 1; missionId: string; directory: string; title: string; proposal: string; workingDirectory: string;
  state: 'planning' | 'running' | 'paused' | 'orchestrator_turn' | 'completed';
  createdAt: string; updatedAt: string; initialFeatureCount?: number;
  features: Record<string, { status: MissionFeature['status'] | 'awaiting_validation'; attempts: number; milestone?: string; workerSessionIds: string[]; definitionHash: string }>;
  validations: Record<string, { scrutiny?: boolean; 'user-testing'?: boolean; sourceDigest?: string; verifiers?: VerifierResult[] }>;
  attempts: MissionAttempt[];
  /** `attempt` is the index in `attempts` of the handoff whose item this dismissal addresses. */
  dismissals: Array<{ type: string; sourceFeatureId: string; summary: string; justification: string; attempt: number }>;
  /** Verifier commands and protected paths sealed the first time a feature is planned; edits may only add. */
  sealedContract?: Record<string, { verificationCommands: string[]; protectedPaths: string[] }>;
  /** Per-file digest of protected paths taken before the first worker of the current run. */
  protectedBaseline?: Record<string, string>;
}
export type MissionPauseReason = 'host_request' | 'worker_failed' | 'validation_failed' | 'protected_paths_changed' | 'verification_missing' | 'error';
export interface MissionProgressSnapshot {
  missionId: string; title: string; state: MissionState['state']; updatedAt: string;
  features: Array<{ id: string; milestone: string; status: string; attempts: number }>;
  milestones: Array<{ id: string; scrutiny: boolean; userTesting: boolean; verifiersPassed: boolean | null }>;
  workers: Array<{ workerSessionId: string; featureId: string; role: 'worker' | 'scrutiny' | 'user-testing';
    status: 'running' | 'completed' | 'failed'; usage: { inputTokens: number; outputTokens: number }; durationMs: number }>;
  totals: { completed: number; total: number; usage: { inputTokens: number; outputTokens: number }; durationMs: number };
}
const str = { type: 'string' }, strings = { type: 'array', items: str };
const reservedKeys = new Set(Object.getOwnPropertyNames(Object.prototype));
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
export const handoffSchema = obj({
  successState: { type: 'string', enum: ['success', 'partial', 'failure'] }, returnToOrchestrator: { type: 'boolean' }, featureId: str,
  commitId: str, repoPath: str, validatorsPassed: { type: 'boolean' },
  handoff: obj({ salientSummary: str, whatWasImplemented: str, whatWasLeftUndone: str,
    verification: obj({ commandsRun: { type: 'array', items: obj({ command: str, exitCode: { type: 'number' }, observation: str }, ['command', 'exitCode', 'observation']) },
      interactiveChecks: { type: 'array', items: obj({ action: str, observed: str }, ['action', 'observed']) } }, ['commandsRun']),
    tests: obj({ added: { type: 'array', items: obj({ file: str, cases: { type: 'array', items: obj({ name: str, verifies: str }, ['name', 'verifies']) } }, ['file', 'cases']) },
      updated: strings, coverage: str }, ['added', 'coverage']),
    discoveredIssues: { type: 'array', items: obj({ severity: { type: 'string', enum: ['blocking', 'non_blocking', 'suggestion'] }, description: str, suggestedFix: str }, ['severity', 'description']) },
    skillFeedback: obj({ followedProcedure: { type: 'boolean' }, deviations: { type: 'array', items: obj({ step: str, whatIDidInstead: str, why: str }, ['step', 'whatIDidInstead', 'why']) }, suggestedChanges: strings }, ['followedProcedure', 'deviations']),
  }, ['salientSummary', 'whatWasImplemented', 'whatWasLeftUndone', 'verification', 'tests', 'discoveredIssues']),
}, ['successState', 'returnToOrchestrator', 'handoff']);

/** Validate structural protocol facts, without trusting the worker's claims as test evidence. */
function validate(value: unknown, schema: any, path: string): void {
  if (schema.type === 'object') {
    const p = inputObject(value);
    for (const name of schema.required ?? []) if (!(name in p)) throw new Error(`${path}.${name} is required`);
    for (const name of Object.keys(p)) {
      if (!Object.hasOwn(schema.properties, name)) throw new Error(`${path}.${name} is not supported`);
      validate(p[name], schema.properties[name], path + '.' + name);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > 100) throw new Error(`${path} must be an array of at most 100 items`);
    for (const item of value) validate(item, schema.items, path);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 64 * 1024 || schema.enum && !schema.enum.includes(value)) throw new Error(`Invalid ${path}`);
  } else if (schema.type === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${path}`);
  } else if (typeof value !== schema.type) throw new Error(`Invalid ${path}`);
}
export function parseHandoff(input: unknown, featureId: string): FeatureHandoff {
  if (Buffer.byteLength(JSON.stringify(input)) > 256 * 1024) throw new Error('Handoff exceeds 256 KiB');
  validate(input, handoffSchema, 'EndFeatureRun');
  const p = structuredClone(input) as FeatureHandoff, h = p.handoff;
  if (p.featureId && p.featureId !== featureId) throw new Error('Handoff feature ID does not match the assigned feature');
  if (h.salientSummary.length < 20 || h.salientSummary.length > 500 || h.whatWasImplemented.length < 50) throw new Error('Handoff summary or implementation description is too short/long');
  if (p.commitId !== undefined && !p.commitId.trim() || p.repoPath !== undefined && !p.repoPath.trim()) throw new Error('Invalid handoff repository/commit');
  return { ...p, featureId };
}
export function parseFeatures(input: unknown): MissionFeature[] {
  const p = inputObject(input);
  if (!Array.isArray(p.features) || !p.features.length || p.features.length > 100) throw new Error('features.json must contain 1..100 features');
  const ids = new Set<string>();
  return p.features.map(value => {
    const f = inputObject(value), id = stringArg(f, 'id'), skillName = stringArg(f, 'skillName');
    if (!/^[\w-]{1,100}$/.test(id) || reservedKeys.has(id) || ids.has(id) || !/^[\w-]{1,100}$/.test(skillName)) throw new Error('Invalid/duplicate feature ID or skillName');
    ids.add(id);
    const array = (key: string) => {
      const v = f[key] ?? [];
      if (!Array.isArray(v) || v.length > 100 || v.some(s => typeof s !== 'string' || s.length > 8192)) throw new Error(`Invalid feature ${key}`);
      return v as string[];
    };
    const description = stringArg(f, 'description'), milestone = stringArg(f, 'milestone');
    if (!description.trim() || description.length > 8192 || !/^[\w-]{1,100}$/.test(milestone) || reservedKeys.has(milestone) || !['pending', 'completed', 'cancelled'].includes(String(f.status ?? 'pending'))) throw new Error('Invalid feature description/milestone/status');
    const verificationCommands = array('verificationCommands'), protectedPaths = array('protectedPaths');
    if (verificationCommands.length > 20 || verificationCommands.some(c => !c.trim() || c.length > 1000)) throw new Error('Invalid feature verificationCommands');
    if (protectedPaths.length > 100 || protectedPaths.some(p => !p.trim() || p.startsWith('/') || p.split('/').includes('..'))) throw new Error('Invalid feature protectedPaths');
    return { id, skillName, description, milestone, preconditions: array('preconditions'), expectedBehavior: array('expectedBehavior'), fulfills: array('fulfills'), verificationCommands, protectedPaths, status: (f.status ?? 'pending') as MissionFeature['status'] };
  });
}
export function handoffSucceeded(h?: FeatureHandoff) {
  return h?.successState === 'success' && !h.handoff.whatWasLeftUndone.trim() && !h.handoff.discoveredIssues.some(i => i.severity === 'blocking');
}
