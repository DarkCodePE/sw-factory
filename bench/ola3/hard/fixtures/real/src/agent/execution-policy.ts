import { networkPolicy } from './network-policy.ts';
import type { AgentOptions, Autonomy, ToolContext } from './types.ts';

export type PermissionMode = 'standard' | 'yolo';
export interface ExecutionPolicy {
  readonly permissionMode: PermissionMode;
  readonly effectiveAutonomy: Autonomy;
  readonly execution: 'sandbox' | 'host';
  readonly network: 'per-call' | 'host';
}
type Options = Pick<AgentOptions, 'permissionMode' | 'autonomy' | 'interactionMode' | 'sandbox' | 'networkPolicy'>;
export const YOLO_NOTICE = 'YOLO · sin aprobaciones · ejecución en host · red del equipo';

/** Only trusted invocation options can mint this policy; never session/model data. */
export function resolveExecutionPolicy(opts: Options): ExecutionPolicy {
  const permissionMode = opts.permissionMode ?? 'standard';
  if (!['standard', 'yolo'].includes(permissionMode)) throw new Error('Invalid permissionMode');
  if (opts.interactionMode !== undefined && !['auto', 'spec', 'mission'].includes(opts.interactionMode)) throw new Error('Invalid interactionMode');
  if (opts.autonomy !== undefined && !['off', 'low', 'medium', 'high'].includes(opts.autonomy)) throw new Error('Invalid autonomy');
  if (opts.sandbox !== undefined && !['required', 'best-effort'].includes(opts.sandbox)) throw new Error('Invalid sandbox');
  const network = networkPolicy(opts.networkPolicy);
  if (permissionMode === 'yolo') {
    if (opts.autonomy !== undefined && opts.autonomy !== 'high') throw new Error('--yolo conflicts with --auto off/low/medium; use high or omit --auto');
    if (opts.sandbox !== undefined) throw new Error('--yolo conflicts with an explicit --sandbox');
    if (opts.interactionMode === 'spec') throw new Error('--yolo conflicts with --use-spec');
    if (network !== 'auto') throw new Error(`--yolo conflicts with effective network policy ${network}; explicitly use --sandbox-network auto to override CLI/settings/preferences`);
  }
  return Object.freeze({ permissionMode, effectiveAutonomy: permissionMode === 'yolo' ? 'high' : opts.autonomy ?? 'off',
    execution: permissionMode === 'yolo' ? 'host' : 'sandbox', network: permissionMode === 'yolo' ? 'host' : 'per-call' });
}

/** A child/sidemode can retain the caller capability or reduce it, never elevate it. */
export function scopedExecutionOptions(context: Pick<ToolContext, 'executionPolicy' | 'autonomy' | 'networkPolicy' | 'sandbox'>, readOnly: boolean): Options {
  if (readOnly) return { permissionMode: 'standard', autonomy: context.autonomy, interactionMode: 'spec', sandbox: 'required', networkPolicy: 'deny' };
  return { permissionMode: context.executionPolicy?.permissionMode ?? 'standard', autonomy: context.autonomy, interactionMode: 'auto',
    sandbox: context.executionPolicy?.permissionMode === 'yolo' ? undefined : context.sandbox, networkPolicy: context.networkPolicy };
}
