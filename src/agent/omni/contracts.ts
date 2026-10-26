import type { AgentEvent, ModelProvider, ModelRequest } from '../types.ts';
export type { SafeHttpFailure } from '../transport.ts';
import type { SafeHttpFailure } from '../transport.ts';

/** Frozen I0 contracts. No configuration, scheduling, credentials or HTTP implementation. */
export type Tos = 'ok' | 'caution' | 'ambiguous' | 'avoid' | 'unknown';
export type FailureKind = 'rate_limit' | 'quota' | 'auth' | 'transient' | 'context' | 'fatal';
export interface LeafDescriptor { id: string; provider: string; baseUrl?: string; model: string; apiKey?: string; apiKeyHelper?: unknown; authFile?: unknown; }
export interface Profile {
  modelId: string; providerId: string; accountId: string; quotaGroup: string;
  costTier: 'free' | 'paid'; tos: Tos; acknowledgeTos?: boolean;
  supportsTools: boolean; supportsImages: boolean; contextWindow: number; priority: number;
}
export interface OmniConfig {
  version: 1; allowPaid: boolean; maxAttempts: number; maxWaitMs: number;
  requestTimeoutMs: number; profiles: readonly Profile[];
}
export interface Needs { tools: boolean; images: boolean; estimatedInputTokens: number; maxOutputTokens: number; }
export interface SafeFailure {
  kind: FailureKind; status?: number; code?: string; retryAt?: number;
  scope: 'turn' | 'model' | 'account' | 'group';
}
export interface Lease { id: string; profile: Profile; }
/** attempted is a stable object for the entire invocation; entries are unique custom-model IDs (not upstream model names). */
export interface AttemptContext { needs: Needs; attempted: ReadonlySet<string>; remainingAttempts: number; waitRemainingMs: number; deadline: number; }
export type Choice = { kind: 'attempt'; lease: Lease } |
  { kind: 'wait'; until: number } | { kind: 'exhausted'; retryAt?: number };
export interface Scheduler {
  select(ctx: AttemptContext): Choice; // reserva de forma síncrona
  settle(lease: Lease, result: { ok: true } | { ok: false; failure: SafeFailure }): void; // actualiza salud, no libera
  release(lease: Lease): void; // idempotente; para finally y abort
}
export interface Clock { now(): number; random(): number; sleep(ms: number, signal: AbortSignal): Promise<void>; }
export interface OmniDependencies {
  scheduler: Scheduler; clock: Clock;
  classify?: ClassifyOmniFailure;
  eligible?: EligibleProfiles;
  resolveLeaf(modelId: string, signal: AbortSignal): Promise<ModelProvider>;
  estimateRequest(request: ModelRequest): Needs;
  emit?: (event: AgentEvent) => void;
}
export interface OmniProvider extends ModelProvider {
  bindEvents(sink: ((event: AgentEvent) => void) | undefined): void;
  forSubagent(): OmniProvider;
}
export interface RoutedAttempt {
  id: string; provider: ModelProvider;
  settle(result: { ok: true } | { ok: false; error: unknown; committed: boolean }): void;
  release(): void;
}
export interface RoutedAttemptPlan {
  id: 'omni'; next(signal: AbortSignal): Promise<RoutedAttempt | undefined>;
  exhausted(): Error; // error final con retryable=false y routingHandled=true
}

export type ValidateOmniConfig = (raw: unknown, leaves: readonly LeafDescriptor[]) => OmniConfig;
export type EligibleProfiles = (config: OmniConfig, needs: Needs) => readonly Profile[];
export type EffectiveTos = (profile: Profile, endpoint: string) => Tos;
export interface SchedulerDependencies { clock: Clock; eligible: EligibleProfiles; }
export type CreateOmniScheduler = (config: OmniConfig, deps: SchedulerDependencies) => Scheduler;
export type ClassifyOmniFailure = (error: unknown, now: number) => SafeFailure;
export type ReadHttpFailure = (response: Response, now: number) => Promise<SafeHttpFailure>;
export type CreateOmniProvider = (config: OmniConfig, deps: OmniDependencies) => OmniProvider;
