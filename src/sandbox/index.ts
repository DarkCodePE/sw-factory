export * from './types.ts';
export { detectSandbox, clearSandboxCache, _setSandboxDetectionForTesting } from './detect.ts';
export { wrapCommand } from './wrap.ts';
export { sandboxReport } from './report.ts';
export {
  probeEgress,
  getLastEgressProbe,
  setLastEgressProbe,
  buildProbeScript,
  type EgressProbeResult,
  type EgressProbeOptions,
} from './egress-probe.ts';
