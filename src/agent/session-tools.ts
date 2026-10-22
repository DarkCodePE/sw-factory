import { abortable } from './cancellation.ts';
import { tool, inputObject } from './tools.ts';
import { validateSettingsChanges, type SettingsPolicy } from './staged-settings.ts';
import type { AgentOptions, ToolContext } from './types.ts';

/** Root-session capabilities are provided by the host, never by tool arguments. */
export function sessionTools(opts: AgentOptions, context: ToolContext, policy: SettingsPolicy,
  queueExit: () => void, sessionId: string) {
  return [
    tool('ExitSpecMode', 'read', { reason: { type: 'string', maxLength: 8192 } }, [], async (input, c) => {
      const p = inputObject(input);
      if (Object.keys(p).some(k => k !== 'reason') || p.reason !== undefined && (typeof p.reason !== 'string' || Buffer.byteLength(p.reason) > 8192)) throw new Error('Invalid exit reason (maximum 8 KiB)');
      if (context.interactionMode !== 'spec' || opts.allowExitSpecMode === false || opts.missionWorker) throw new Error('This scope cannot leave spec mode');
      if (context.autonomy !== 'high') {
        if (!opts.permissionHandler) throw new Error('Leaving spec requires interactive confirmation');
        const decision = await abortable(opts.permissionHandler({
          toolUses: [{ toolUse: { type: 'tool_use', id: c.toolUseId!, name: 'ExitSpecMode', input: Object.freeze({ ...p }) },
            confirmationType: 'exit_spec_mode', details: { type: 'exit_spec_mode', nextMode: 'auto', autonomy: context.autonomy } }],
          options: [{ label: 'Leave spec for the next turn', value: 'proceed_once' }, { label: 'Stay in spec', value: 'cancel' }],
        }, c), c.signal);
        c.signal.throwIfAborted();
        if (decision !== 'proceed_once') throw new Error('Leaving spec cancelled by caller');
      }
      c.signal.throwIfAborted();
      queueExit();
      return { nextMode: 'auto', autonomy: context.autonomy, effective: 'next_model_turn' };
    }, 'Request a switch from planning to execution for the next model turn, preserving host permissions.'),
    tool('StageSettingsChanges', 'read', {
      modelId: { type: 'string', enum: policy.modelIds }, autonomy: { type: 'string', enum: ['off', 'low', 'medium', 'high'] },
      networkPolicy: { type: 'string', enum: ['auto', 'ask', 'deny'] },
    }, [], async (input, c) => {
      const changes = validateSettingsChanges(input, policy, context.executionPolicy);
      c.signal.throwIfAborted();
      const proposal = Object.freeze({ proposalId: c.toolUseId!, changes, applied: false as const });
      opts.onEvent?.({ type: 'settings_staged', sessionId, proposal });
      return proposal;
    }, 'Propose session settings for user review. This tool never applies settings or changes host permissions.'),
  ];
}
