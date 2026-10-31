// Design reference: ext/esf/internal/verification/run.go@d901657 (MIT), reimplemented.
import { runVerifierAt } from './agent/mission-evidence.ts';
export { runVerifierAt, runSetupAt } from './agent/mission-evidence.ts';
export type GateStep = Awaited<ReturnType<typeof runVerifierAt>>;

/** Every declared step is mandatory. A failure never suppresses the remaining steps. */
export async function runGates(cwd: string, commands: string[][], signal: AbortSignal,
  onStep: (step: GateStep, index: number) => void = () => {}, timeoutMs = 120_000, deps?: string) {
  const steps: GateStep[] = [];
  for (const argv of commands) {
    signal.throwIfAborted();
    const step = await runVerifierAt(cwd, argv, signal, timeoutMs, deps);
    steps.push(step);
    onStep(step, steps.length - 1);
    signal.throwIfAborted();
  }
  return { passed: steps.length > 0 && steps.every(step => step.exitCode === 0 && !step.timedOut && !step.error), steps };
}
