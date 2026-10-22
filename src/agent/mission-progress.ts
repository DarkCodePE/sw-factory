import { handoffSucceeded, type MissionAttempt, type MissionProgressSnapshot, type MissionState } from './mission-contract.ts';

const label = (s: unknown, n = 100) => typeof s === 'string' ? s.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, n) : '';
const number = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.min(n, Number.MAX_SAFE_INTEGER) : 0;
const sum = (a: number, b: number) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
export const attemptUsage = (a: Pick<MissionAttempt, 'usage'>) => ({
  inputTokens: Math.floor(number(a.usage?.inputTokens)), outputTokens: Math.floor(number(a.usage?.outputTokens)),
});
export const attemptDuration = (a: Pick<MissionAttempt, 'durationMs'>) => number(a.durationMs);

/** Detached, bounded telemetry only. No handoff prose or authority is restored from this view. */
export function missionProgressSnapshot(m: MissionState): MissionProgressSnapshot {
  const features = Object.entries(m.features).slice(0, 100).map(([id, f]) => ({
    id: label(id), milestone: label(f.milestone), status: label(f.status, 32), attempts: Math.floor(number(f.attempts)),
  }));
  const ids = [...new Set([...features.map(f => f.milestone).filter(Boolean), ...Object.keys(m.validations)])].slice(0, 100);
  const milestones = ids.map(id => {
    const v = m.validations[id];
    return { id: label(id), scrutiny: v?.scrutiny === true, userTesting: v?.['user-testing'] === true,
      verifiersPassed: v?.verifiers?.length ? v.verifiers.every(v => v.exitCode === 0) : null };
  });
  const workers = m.attempts.slice(-100).map(a => ({
    workerSessionId: label(a.workerSessionId), featureId: label(a.featureId), role: ['worker', 'scrutiny', 'user-testing'].includes(a.role) ? a.role : 'worker',
    status: a.status === 'running' ? 'running' as const : !a.error && handoffSucceeded(a.handoff) ? 'completed' as const : 'failed' as const,
    usage: attemptUsage(a), durationMs: attemptDuration(a),
  }));
  const totals = { completed: Object.values(m.features).filter(f => f.status === 'completed').length,
    total: Object.keys(m.features).length, usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 0 };
  for (const a of m.attempts) {
    const usage = attemptUsage(a);
    totals.usage.inputTokens = sum(totals.usage.inputTokens, usage.inputTokens);
    totals.usage.outputTokens = sum(totals.usage.outputTokens, usage.outputTokens);
    totals.durationMs = sum(totals.durationMs, attemptDuration(a));
  }
  return { missionId: label(m.missionId), title: label(m.title, 200), state: ['planning', 'running', 'paused', 'orchestrator_turn', 'completed'].includes(m.state) ? m.state : 'paused', updatedAt: label(m.updatedAt),
    features, milestones, workers, totals };
}
