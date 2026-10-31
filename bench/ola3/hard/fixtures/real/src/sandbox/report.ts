import { detectSandbox } from './detect.ts';

/**
 * Returns a human-readable diagnostic report of the sandbox status,
 * detailing availability, backend in use, network isolation support,
 * and exact remediation steps if degraded.
 *
 * @param forceRefresh When true, bypasses any cached detection result.
 */
export async function sandboxReport(forceRefresh = false): Promise<string> {
  const detection = await detectSandbox(forceRefresh);

  const lines: string[] = [
    `=== Sandbox Status Report ===`,
    `Backend:            ${detection.backend}`,
    `Available:          ${detection.available ? 'YES' : 'NO'}`,
    `Network Isolation:  ${detection.network ? 'ENABLED' : 'DISABLED'}`,
    `Status:             ${detection.available ? 'OPERATIONAL' : 'DEGRADED'}`,
    `Diagnostic Reason:  ${detection.reason}`,
  ];

  if (!detection.available) {
    lines.push(
      ``,
      `================================================================================`,
      `REMEDIATION GUIDE: APPARMOR USER NAMESPACE RESTRICTION`,
      `================================================================================`,
      `This Linux host enforces unprivileged user namespace restrictions via AppArmor`,
      `(kernel.apparmor_restrict_unprivileged_userns = 1), causing bwrap to fail with:`,
      `  'setting up uid map: Permission denied'`,
      ``,
      `Choose ONE of the following remediation options:`,
      ``,
      `[Option 1] (Recommended) Install AppArmor profile for bwrap:`,
      `  1. Create /etc/apparmor.d/bwrap-userns-restrict with:`,
      `     abi <abi/4.0>,`,
      `     include <tunables/global>`,
      ``,
      `     profile bwrap /usr/bin/bwrap flags=(unconfined) {`,
      `       userns,`,
      `       include if exists <local/bwrap>`,
      `     }`,
      ``,
      `  2. Load profile into the kernel:`,
      `     sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict`,
      ``,
      `[Option 2] (Alternative) Disable restriction via sysctl:`,
      `  Temporary (until reboot):`,
      `     sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`,
      ``,
      `  Persistent (across reboots):`,
      `     echo "kernel.apparmor_restrict_unprivileged_userns = 0" | sudo tee /etc/sysctl.d/60-apparmor-namespace.conf`,
      `     sudo sysctl -p /etc/sysctl.d/60-apparmor-namespace.conf`,
      `================================================================================`
    );
  }

  return lines.join('\n');
}
