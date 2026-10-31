import { resolveExecutionPolicy } from './execution-policy.ts';
import { networkPolicy, type NetworkPolicy } from './network-policy.ts';
import type { Autonomy, ToolContext } from './types.ts';
export interface SettingsChanges { modelId?: string; autonomy?: Autonomy; networkPolicy?: NetworkPolicy }
export interface SettingsPolicy { modelIds: string[]; maxAutonomy: Autonomy; networkPolicy: NetworkPolicy }
export interface SettingsProposal { proposalId: string; changes: Readonly<SettingsChanges>; applied: false }
const levels = ['off', 'low', 'medium', 'high'];
const restriction = { auto: 0, ask: 1, deny: 2 };
export function validateSettingsChanges(input: unknown, policy: SettingsPolicy, mode: ToolContext['executionPolicy']): Readonly<SettingsChanges> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input)) > 8192) throw new Error('Settings proposal must be an object of at most 8 KiB');
  const p = input as Record<string, unknown>, keys = Object.keys(p);
  if (!keys.length || keys.some(k => !['modelId', 'autonomy', 'networkPolicy'].includes(k))) throw new Error('Only modelId, autonomy and networkPolicy may be staged');
  if (!levels.includes(policy.maxAutonomy)) throw new Error('Invalid host settings ceiling');
  networkPolicy(policy.networkPolicy);
  if (Object.hasOwn(p, 'modelId') && (typeof p.modelId !== 'string' || !p.modelId || p.modelId.length > 256 || !policy.modelIds.includes(p.modelId))) throw new Error('Unknown configured model in proposal');
  if (Object.hasOwn(p, 'autonomy')) {
    resolveExecutionPolicy({ autonomy: p.autonomy as Autonomy });
    if (!levels.includes(p.autonomy as string) || levels.indexOf(p.autonomy as string) > levels.indexOf(policy.maxAutonomy)) throw new Error('Proposal exceeds host autonomy ceiling');
  }
  if (Object.hasOwn(p, 'networkPolicy')) {
    const value = networkPolicy(p.networkPolicy);
    if (p.networkPolicy === undefined || restriction[value] < restriction[policy.networkPolicy]) throw new Error('Proposal exceeds host network policy');
  }
  if (mode?.permissionMode === 'yolo' && (p.autonomy !== undefined && p.autonomy !== 'high' || p.networkPolicy !== undefined && p.networkPolicy !== 'auto')) throw new Error('Restart without YOLO before changing autonomy or network restrictions');
  return Object.freeze({ ...p }) as Readonly<SettingsChanges>;
}
