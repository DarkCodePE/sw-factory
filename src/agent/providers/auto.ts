import type { AgentEvent, Message, ModelProvider, ModelRequest, ModelTurn } from '../types.ts';
import type { AutoRouterConfig, RouterCandidate, RoutingContext, RoutingDecision, TransitionSource } from '../router/types.ts';
import { ProviderError } from '../transport.ts';
import { abortable } from '../cancellation.ts';
import * as routerCore from '../router/index.ts';

/** Signatures fixed by the router contract; declared here so this file compiles before the core is merged. */
export type RouteFn = (config: AutoRouterConfig, classifierProvider: ModelProvider, ctx: RoutingContext, signal: AbortSignal) => Promise<RoutingDecision>;
export type UpgradeFn = (current: string, cands: RouterCandidate[], available: Set<string>) => string | undefined;
export interface RouterCore { route: RouteFn; upgradeTarget: UpgradeFn; validateAutoRouterConfig: (raw: unknown, knownModelIds: Set<string>) => AutoRouterConfig }

export interface AutoProviderOptions {
  config: AutoRouterConfig;
  /** Providers already built by configuredProviders (candidates and classifier). */
  providers: Record<string, ModelProvider>;
  /** Injected so the wiring can be tested without the real core. */
  route: RouteFn;
  upgradeTarget: UpgradeFn;
  surface: RoutingContext['surface'];
  isSubagent?: boolean;
  onEvent?: (e: AgentEvent) => void;
  /** Test seams. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

export type AutoProvider = ModelProvider & {
  readonly currentModelId: string | undefined;
  canUpgrade(): boolean;
  upgrade(): { from: string; to: string } | undefined;
  /** The engine routes events through its own sink so they carry the session id. */
  bindEvents(sink: ((e: AgentEvent) => void) | undefined): void;
  setSurface(surface: RoutingContext['surface']): void;
  /** Fresh, undecided router for a child agent: it classifies on its own. */
  forSubagent(): AutoProvider;
};

export const AUTO_MODEL_ID = 'auto';
export const UPGRADE_TOOL = 'UpgradeSessionModel';

export function isAutoProvider(p: ModelProvider | undefined): p is AutoProvider {
  return !!p && typeof (p as Partial<AutoProvider>).bindEvents === 'function' && typeof (p as Partial<AutoProvider>).canUpgrade === 'function';
}

/** The routing core; kept behind these helpers so tests can inject fakes. */
export async function loadRouterCore(): Promise<RouterCore> {
  return routerCore;
}

export function lazyRouterCore(): { route: RouteFn; upgradeTarget: UpgradeFn } {
  return { route: routerCore.route, upgradeTarget: routerCore.upgradeTarget };
}

const BASE_DELAY_MS = 500, MAX_DELAY_MS = 8000;

function statusOf(e: unknown): number | undefined {
  const any = e as { status?: unknown; message?: unknown };
  if (typeof any?.status === 'number') return any.status;
  const m = /\bHTTP (\d{3})\b/.exec(String(any?.message ?? ''));
  return m ? Number(m[1]) : undefined;
}

/** retry: same model again; rotate: this model cannot serve the request; fatal: surface as today. */
function classifyFailure(e: unknown): 'retry' | 'rotate' | 'fatal' {
  if (!(e instanceof ProviderError) || e.contextLimit) return 'fatal';
  const status = statusOf(e);
  if (status === 401 || status === 403) return 'fatal';
  if (e.retryable) return 'retry';
  return status === 400 || status === 404 ? 'rotate' : 'fatal';
}

const text = (content: Message['content']): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map(p => p.type === 'text' ? p.text : '').join('') : '';

export function buildRoutingContext(request: ModelRequest, surface: RoutingContext['surface'], isSubagent: boolean): RoutingContext {
  const messages = request.messages;
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user' && messages[i]!.contextKind !== 'summary') { last = i; break; }
  }
  const user = last >= 0 ? messages[last]! : undefined;
  const after = last >= 0 ? messages.slice(last + 1) : [];
  return {
    userMessage: user ? text(user.content) : '',
    turnNumber: messages.filter(m => m.role === 'user' && m.contextKind !== 'summary').length,
    surface, isSubagent,
    imagesPresent: Array.isArray(user?.content) && user.content.some(p => p.type === 'image_url'),
    hasFailedToolCalls: after.some(m => m.role === 'tool' && typeof m.content === 'string' && /^Error\b/.test(m.content)),
    toolNames: request.tools.map(t => t.function.name),
  };
}

export function createAutoProvider(opts: AutoProviderOptions): AutoProvider {
  const { config, providers } = opts;
  const retries = Math.max(1, config.retriesPerModel ?? 3);
  const sleep = opts.sleep ?? ((ms, signal) => abortable(Bun.sleep(ms), signal));
  const random = opts.random ?? Math.random;
  let surface = opts.surface, sink = opts.onEvent;
  let current: string | undefined, fallbacks: string[] = [];
  const emit = (e: { type: 'model_routed' | 'model_transition'; [k: string]: unknown }) => sink?.({ sessionId: '', ...e });
  const candidate = (id: string | undefined) => config.candidates.find(c => c.modelId === id);
  const available = () => new Set(Object.keys(providers).filter(id => id !== AUTO_MODEL_ID));
  const transition = (to: string, source: TransitionSource, detail?: string) => {
    const from = current!;
    current = to;
    emit({ type: 'model_transition', from, to, source, ...(detail ? { detail } : {}) });
  };

  async function decide(ctx: RoutingContext, signal: AbortSignal): Promise<RoutingDecision> {
    const classifier = providers[config.classifierModel];
    if (!classifier) throw new ProviderError(`Auto router classifier model '${config.classifierModel}' is not configured`);
    let decision: RoutingDecision;
    try {
      decision = await opts.route(config, classifier, ctx, signal);
    } catch (e) {
      if (signal.aborted) throw signal.reason ?? e;
      throw new ProviderError(`Auto router: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!providers[decision.modelId]) throw new ProviderError(`Auto router chose unconfigured model '${decision.modelId}'`);
    return decision;
  }

  const provider: AutoProvider = {
    id: AUTO_MODEL_ID,
    get currentModelId() { return current; },
    bindEvents(next) { sink = next; },
    setSurface(next) { surface = next; },
    forSubagent() {
      return createAutoProvider({ ...opts, surface: 'subagent', isSubagent: true, onEvent: undefined });
    },
    canUpgrade() {
      return current !== undefined && opts.upgradeTarget(current, config.candidates, available()) !== undefined;
    },
    upgrade() {
      if (current === undefined) return undefined;
      const to = opts.upgradeTarget(current, config.candidates, available());
      if (!to) return undefined;
      const from = current;
      fallbacks = fallbacks.filter(f => f !== to);
      transition(to, 'self_upgrade');
      return { from, to };
    },
    async complete(request, signal, delta): Promise<ModelTurn> {
      signal.throwIfAborted();
      const ctx = buildRoutingContext(request, surface, opts.isSubagent ?? false);
      if (current === undefined) {
        const decision = await decide(ctx, signal);
        current = decision.modelId;
        fallbacks = decision.fallbacks.filter(f => f !== decision.modelId);
        emit({ type: 'model_routed', decision });
      } else if (ctx.imagesPresent && candidate(current)?.supportsImages === false) {
        const decision = await decide(ctx, signal);
        fallbacks = decision.fallbacks.filter(f => f !== decision.modelId);
        transition(decision.modelId, 'vision', decision.rationale);
      }
      for (;;) {
        const model = current!, target = providers[model]!;
        // The tool list is fixed before routing; drop the upgrade tool once the routed model has no higher tier.
        const tools = provider.canUpgrade() ? request.tools : request.tools?.filter(t => t.function.name !== UPGRADE_TOOL);
        for (let attempt = 1; ; attempt++) {
          let streamed = false;
          try {
            return await target.complete(tools === request.tools ? request : { ...request, tools }, signal, delta ? t => { if (t.length > 0) streamed = true; delta(t); } : undefined);
          } catch (err) {
            if (signal.aborted) throw signal.reason ?? err;
            const message = err instanceof Error ? err.message : String(err);
            // Text already reached the user: a retry or rotation would duplicate it, and the turn is not a valid answer.
            if (streamed) throw new ProviderError(`Model stream cut after output began (${model}): ${message}`);
            const kind = classifyFailure(err);
            if (kind === 'fatal') throw err;
            if (kind === 'retry' && attempt < retries) {
              const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1)) * (0.5 + random() / 2);
              const retryAfter = Number((err as { retryAfterMs?: unknown }).retryAfterMs);
              await sleep(Math.max(backoff, Number.isFinite(retryAfter) ? retryAfter : 0), signal);
              continue;
            }
            const next = fallbacks.shift();
            if (!next) throw new ProviderError(`All auto-routed models failed; last error from ${model}: ${message}`);
            transition(next, kind === 'retry' ? 'retry_exhausted' : 'model_specific', message);
            break;
          }
        }
      }
    },
  };
  return provider;
}
