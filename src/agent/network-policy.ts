import type { Autonomy, InteractionMode } from './types.ts';

export const NETWORK_POLICIES = ['auto', 'ask', 'deny'] as const;
export type NetworkPolicy = typeof NETWORK_POLICIES[number];
export function networkPolicy(value: unknown = 'auto'): NetworkPolicy {
  if (!NETWORK_POLICIES.includes(value as NetworkPolicy)) throw new Error('Network policy must be auto, ask or deny');
  return value as NetworkPolicy;
}
export function requestsNetwork(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Execute input must be an object');
  const value = (input as Record<string, unknown>).network;
  if (value !== undefined && typeof value !== 'boolean') throw new Error('Execute network must be a boolean');
  return value === true;
}
export function networkDecision(requested: boolean, policy: NetworkPolicy, autonomy: Autonomy, mode: InteractionMode): 'none' | 'deny' | 'ask' | 'allow' {
  if (!requested) return 'none';
  if (policy === 'deny' || mode === 'spec') return 'deny';
  return policy === 'auto' && autonomy === 'high' ? 'allow' : 'ask';
}
