import type { AgentOptions } from './types.ts';

/** Invocation-local capability; neither tool arguments nor saved session JSON can mint it. */
const children = new WeakMap<AgentOptions, { paused: () => boolean; saved: () => void }>();
export class MissionRunControl {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly pause: () => void;
  requested = false;
  constructor(private readonly parent: AbortSignal, private readonly host?: AbortSignal) {
    this.signal = AbortSignal.any([parent, this.controller.signal]);
    this.pause = () => { this.requested = true; this.controller.abort(new Error('Paused by host')); };
    host?.addEventListener('abort', this.pause, { once: true });
    if (host?.aborted) this.pause();
  }
  get pausedByHost() { return this.requested && !this.parent.aborted; }
  authorize(options: AgentOptions, saved: () => void): AgentOptions {
    children.set(options, { paused: () => this.pausedByHost && this.signal.aborted, saved });
    return options;
  }
  dispose() { this.host?.removeEventListener('abort', this.pause); }
}
export function canReconcileMissionPause(options: AgentOptions): boolean {
  return options.signal?.aborted === true && children.get(options)?.paused() === true;
}

export function missionChildSessionSaved(options: AgentOptions) { children.get(options)?.saved(); }
