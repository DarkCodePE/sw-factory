import type { AgentEvent } from '../types.ts';
import { createRoutedProvider } from './router.ts';
import { createOmniPlan } from '../omni/plan.ts';
import type { OmniConfig, OmniDependencies, OmniProvider } from '../omni/contracts.ts';

/** Bound per facade; the engine replaces it so events carry its own session id. */
interface EventSink { value?: (event: AgentEvent) => void }

/**
 * Package C facade: a composite ModelProvider (`modelId: "omni"`) that delegates
 * selection, waiting and quota settlement to the frozen scheduler contract and
 * lets the shared router own the single attempt loop.
 *
 * - One provider instance per execution runtime; `forSubagent` keeps the same
 *   scheduler (shared quota/cooldown) but starts with no inherited event sink
 *   until the child engine binds it.
 * - No HTTP, no credential resolution and no second failover loop live here:
 *   `resolveLeaf` and the leaf adapters are supplied by the integrator.
 */
export function createOmniProvider(config: OmniConfig, deps: OmniDependencies): OmniProvider {
  const build = (sink: EventSink): OmniProvider => ({
    id: 'omni',
    async complete(request, signal, delta) {
      const plan = createOmniPlan({
        config,
        scheduler: deps.scheduler,
        clock: deps.clock,
        resolveLeaf: deps.resolveLeaf,
        estimateRequest: deps.estimateRequest,
        emit: event => sink.value?.(event),
      }, request);
      return createRoutedProvider(plan).complete(request, signal, delta);
    },
    bindEvents(next) { sink.value = next; },
    forSubagent() { return build({ value: undefined }); },
  });
  return build({ value: deps.emit });
}
