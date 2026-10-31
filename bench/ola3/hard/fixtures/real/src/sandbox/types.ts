export type SandboxBackend = 'bwrap' | 'none';

export type SandboxMode = 'required' | 'best-effort';

export interface SandboxDetectionResult {
  backend: SandboxBackend;
  available: boolean;
  reason: string;
  network: boolean;
}

export interface WrapCommandOptions {
  workdir: string;
  allowNetwork?: boolean;
  readOnlyPaths?: string[];
  /** Mount `source` read-only at `target` (the target directory must already exist). Applied after the path binds. */
  readOnlyBinds?: Array<{ source: string; target: string }>;
  writablePaths?: string[];
  env?: Record<string, string>;
  mode?: SandboxMode;
}

export interface WrapCommandResult {
  argv: string[];
  env: Record<string, string>;
  backend: SandboxBackend;
  degraded: boolean;
  reason: string;
}

export class SandboxUnavailableError extends Error {
  public readonly reason: string;

  constructor(reason: string) {
    super(
      `Sandbox execution is required (mode='required') but sandbox backend is unavailable: ${reason}\n\n` +
      `Remediation:\n` +
      `  Option 1 (Recommended - AppArmor profile for bwrap):\n` +
      `    Create /etc/apparmor.d/bwrap-userns-restrict with:\n` +
      `      abi <abi/4.0>,\n` +
      `      include <tunables/global>\n\n` +
      `      profile bwrap /usr/bin/bwrap flags=(unconfined) {\n` +
      `        userns,\n` +
      `        include if exists <local/bwrap>\n` +
      `      }\n\n` +
      `    Then reload AppArmor: sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict\n\n` +
      `  Option 2 (System-wide sysctl):\n` +
      `    sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\n`
    );
    this.name = 'SandboxUnavailableError';
    this.reason = reason;
  }
}
