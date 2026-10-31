/**
 * Shared contract for the `auto` model router. Pure data types only: the core
 * (classifier, selection, upgrade ladder) and the runtime wiring both import
 * from here, so neither depends on the other's internals.
 */

/** One model the router may pick. `modelId` names a configured model (customModels id or alias). */
export interface RouterCandidate {
  modelId: string;
  /** Short text the classifier reads to judge fit. Written by the user; never sent anywhere else. */
  description: string;
  /** Cost relative to other candidates (any positive unit). Lower is cheaper. */
  relativeCost: number;
  supportsImages: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Explicit escalation target. When absent the ladder picks the next more expensive candidate. */
  upgradeTo?: string;
}

export interface AutoRouterConfig {
  candidates: RouterCandidate[];
  /** Configured model used to score candidates. Must not be routed itself. */
  classifierModel?: string;
  /** External decision classifier. When set, classifierModel is not used. */
  classifier?: { kind: 'jev'; model?: string; baseUrl?: string; timeoutMs?: number };
  /** Score a candidate needs to count as able to do the task. Default 0.7. */
  threshold?: number;
  /** Share of candidates that must clear the threshold to call the task routine. Default 0.75. */
  routineShare?: number;
  /** Classifier deadline in ms. Default 10_000. */
  classifierTimeoutMs?: number;
  /** Attempts on one model for retryable errors (429/5xx/timeout) before rotating. Default 3. */
  retriesPerModel?: number;
}

/** Facts about the current turn the classifier sees besides the user text. */
export interface RoutingContext {
  userMessage: string;
  turnNumber: number;
  surface: 'exec' | 'chat' | 'rpc' | 'subagent' | 'mission';
  isSubagent: boolean;
  imagesPresent: boolean;
  hasFailedToolCalls: boolean;
  toolNames: string[];
}

export type RoutingReason =
  | 'single_candidate'   // only one eligible candidate: no classification
  | 'vision_required'    // images present: only image-capable candidates scored
  | 'routine'            // at least routineShare of candidates clear the threshold
  | 'task_fit'           // some candidates clear the threshold
  | 'hard'               // none clears the threshold: highest score wins
  | 'classifier_failed'; // timeout or unparsable output: first eligible candidate

export interface RoutingDecision {
  modelId: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  reason: RoutingReason;
  /** Ordered retry targets for upstream errors; never contains modelId. */
  fallbacks: string[];
  scores: Record<string, number>;
  /** Classifier explanation, kept for logs and the decision event. */
  rationale?: string;
  classifierMs: number;
}

/** Why the session left its routed model. */
export type TransitionSource = 'retry_exhausted' | 'model_specific' | 'self_upgrade' | 'vision';

/** Emitted as AgentEvent payloads by the runtime. */
export interface ModelRoutedEvent { type: 'model_routed'; decision: RoutingDecision }
export interface ModelTransitionEvent { type: 'model_transition'; from: string; to: string; source: TransitionSource; detail?: string }
