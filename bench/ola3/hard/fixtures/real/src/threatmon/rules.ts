// Behavior monitoring rules for captured agent output.
// Cites and reimplements in TypeScript the rules from:
//   internal/threatmon/rules.go@d901657 (ESF, MIT License)
//
// Límite declarado / Post-hoc limitation:
// Este monitor opera de forma post-hoc sobre la salida capturada (stdout, stderr, diff)
// tras finalizar la ejecución del agente. Detecta comportamientos fuera de límites u
// ofensivos para poner el change en cuarentena ('quarantined') antes de validación, pero
// NO puede revertir ni evitar efectos secundarios ya ocurridos en el host si el agente
// corrió sin aislamiento previo (p. ej. con agy). La mitigación de fondo de H1 es envolver
// los CLIs en sandboxes de egress, fuera de este plan.

export type ThreatSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ThreatRule {
  id: string;
  category: string;
  description: string;
  severity: ThreatSeverity;
  pattern: RegExp;
  stream?: string;
}

export function severityRank(s: ThreatSeverity): number {
  switch (s) {
    case 'LOW':
      return 1;
    case 'MEDIUM':
      return 2;
    case 'HIGH':
      return 3;
    case 'CRITICAL':
      return 4;
    default:
      return 0;
  }
}

// Reimplemented regular expressions citing internal/threatmon/rules.go@d901657

// PE-001: writing /etc/sudoers grants durable root via sudo.
const reSudoersWrite = /(?:>>?\s*\S*\/etc\/sudoers\b|\b(?:tee|visudo|sed\s+-i|cp|mv|install)\b[^\n]{0,80}\/etc\/sudoers\b)/i;

// PE-002: granting elevated privilege (setuid, setcap, chown root).
const rePrivilegeBits = /(?:\bchmod\b[^\n]{0,40}(?:\bu\+s\b|\bg\+s\b|\bo\+s\b|\b4[0-7]{3}\b)|\bsetcap\b[^\n]{0,40}\bcap_[a-z]|\bchown\b[^\n]{0,40}\broot(?::root)?\b)/i;

// PE-003: loading kernel modules or mounting filesystems.
const reKernelModuleOrMount = /(?:\b(?:insmod|modprobe|rmmod)\b\s+[A-Za-z0-9_./-]\S*|\bmount\b[^|\n]{0,60}(?:\s-o\s|\/dev\/\S+\s+\S+|--bind\b|\b-t\s+(?:tmpfs|proc|sysfs)\b|\btmpfs\b|\bproc\b|\bsysfs\b))/i;

// PE-004: altering firewall or packet filter rules.
const reFirewallChange = /\b(?:iptables|ip6tables|nft|nftables|ufw)\b\s+/i;

// CA-001: reading /proc/<pid>/environ for secrets.
const reProcEnviron = /(?:^|[\s;|&`$()<])(?:cat|less|more|head|tail|grep|awk|sed|cp|scp|strings|xxd|od|hexdump|dd|getent|python[0-9.]*|perl)\b[^\n]{0,60}\/proc\/[A-Za-z0-9_.-]+\/environ\b|<[^\n]{0,20}\/proc\/[A-Za-z0-9_.-]+\/environ\b/i;

// CA-002: sweeping environment for secrets with env/printenv | grep.
const reEnvGrepSweep = /\b(?:env|printenv)\b[^\n]{0,20}\|\s*grep\b/i;

// CA-003: touching credential stores (aws, netrc, docker, opencode, gh).
const reCredentialStores = /(?:\.aws\/credentials\b|(?:^|[\s/])\.netrc\b|\.docker\/config\.json\b|(?:\.config\/)?opencode\/(?:auth\.json|credentials\.json)\b|\.config\/gh\/hosts\.yml\b|\bAWS_SECRET_ACCESS_KEY\s*[:=]\s*['"]?[A-Za-z0-9/+=]{16,}|\bexport\s+AWS_SECRET_ACCESS_KEY=\S+)/i;

// CA-004: reading SSH private keys under .ssh.
const reSSHPrivateKey = /(?:\.ssh\/|\/)id_(?:rsa|ed25519|ecdsa|dsa)\b/i;

// CA-005: cloud instance metadata service (IMDS).
const reCloudMetadata = /(?:^|[\s;|&`$()<>])(?:curl|wget|http|fetch|nc|ncat|netcat|socat|telnet|python[0-9.]*|urllib|requests)\b[^\n]{0,120}\b(?:169\.254\.169\.254|metadata\.google\.internal|100\.100\.100\.200)\b/i;

// CA-006: password cracking tools.
const rePasswordCracker = /\b(?:hydra|hashcat|medusa|john)\b\s+-{1,2}\S/i;

// RC-001: network scanning or probe loops.
const reNetworkScanner = /(?:^|[\s;|&`$()<>])nmap\s+(?:-[A-Za-z0-9]|(?:\d{1,3}\.){3}\d{1,3}|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})|\b(?:masscan|zmap)\b|\b(?:nc|ncat|netcat)\b[^\n]{0,30}\s-z\b|\bfor\s+([A-Za-z_]\w*)\s+in\s+\$\(\s*seq\b[^\n]{0,120}\b(?:nc|ncat|netcat|\/dev\/tcp)[^\n]{0,60}\$\1\b/i;

// RC-002: offensive exploitation frameworks.
const reExploitFramework = /(?:^|[\s;|&`$()<>])(?:msfconsole|msfvenom|metasploit|sqlmap|nikto|gobuster|ffuf|enum4linux|wpscan|nuclei)\s+(?:-[A-Za-z0-9]|\S+)/i;

// RC-003: reading /etc/shadow.
const reShadowRead = /\/etc\/shadow\b/i;

// RC-004: reading /etc/passwd with reader commands.
const rePasswdRead = /(?:^|[\s;|&])(?:cat|less|more|head|tail|grep|awk|cp|scp|strings|xxd|getent)\b[^\n]{0,60}\/etc\/passwd\b/i;

// RC-005: enumerating listening sockets with ss/netstat.
const reSocketSweep = /\b(?:ss|netstat)\b\s+-{1,2}[A-Za-z]*[tunlaxp][A-Za-z]*/i;

// RC-006: fetching Kubernetes secrets.
const reKubectlSecrets = /\bkubectl\b[^\n]{0,80}\bsecrets?\b/i;

// RS-001: netcat execute flag reverse shell.
const reNetcatExec = /\b(?:nc|ncat|netcat)\b[^\n]{0,40}\s-(?:[A-Za-z]*e[A-Za-z]*|-exec)\s+(?:\S*\/)?(?:sh|bash|zsh|dash|ash|csh|tcsh|python[0-9.]*|perl|ruby|cmd(?:\.exe)?|powershell(?:\.exe)?)\b/i;

// RS-002: bash /dev/tcp interactive shell.
const reBashDevTCP = /(?:\b(?:bash|sh)\s+-[A-Za-z]*i\b[^\n]{0,60}\/dev\/tcp\/|>&[0-9]*\s*\/dev\/tcp\/|\bexec\s+(\d+)\s*<>?\s*\/dev\/tcp\/\S+[^\n]*(?:<&\1|>&\1|\$line|while\s+read)|\b\d+<>\s*\/dev\/tcp\/\S+[^\n]*(?:0>&|1>&|2>&))/i;

// RS-003: socat exec reverse shell.
const reSocatExec = /\bsocat\b[^\n]{0,80}\bexec:/i;

// RS-004: Python pty.spawn shell upgrade.
const rePtySpawn = /\bpty\.spawn\b/i;

// RS-005: Download and execute piped directly into shell interpreter.
const reCurlPipeShell = /\b(?:curl|wget|fetch)\b[^\n]{0,120}(?:http:\/\/|https?:\/\/(?:\d{1,3}\.){3}\d{1,3})[^\n]{0,80}\|\s*(?:sudo\s+)?(?:bash|sh|zsh|dash|ash)\b/i;

// RS-006: reverse shell in scripting language (python, perl, ruby, node, php).
const reScriptReverseShell = /(?:\b(?:python[0-9.]*|perl|ruby|node|php)\b[^\n]{0,250}(?:\bsocket\b[^\n]{0,60}\bconnect\b|TCPSocket|IO::Socket|fsockopen|pfsockopen|\bnet\.(?:Socket|connect)\b|require\(["']net["']\))[^\n]{0,250}(?:(?:\/bin\/|\/usr\/bin\/)?(?:sh|bash)\b|os\.dup2\b|\bdup2\b|child_process[^\n]{0,40}(?:spawn|exec)|\.pipe\([^\n]{0,30}stdin\)|proc_open\b|exec\b[^\n]{0,40}(?:\/bin\/)?(?:sh|bash)|system\b[^\n]{0,40}(?:\/bin\/)?(?:sh|bash))|\b(?:python[0-9.]*|perl|ruby|node|php)\b[^\n]{0,250}(?:(?:\/bin\/|\/usr\/bin\/)?(?:sh|bash)\b|os\.dup2\b|\bdup2\b|child_process[^\n]{0,40}(?:spawn|exec)|\.pipe\([^\n]{0,30}stdin\)|proc_open\b|exec\b[^\n]{0,40}(?:\/bin\/)?(?:sh|bash)|system\b[^\n]{0,40}(?:\/bin\/)?(?:sh|bash))[^\n]{0,250}(?:\bsocket\b[^\n]{0,60}\bconnect\b|TCPSocket|IO::Socket|fsockopen|pfsockopen|\bnet\.(?:Socket|connect)\b|require\(["']net["']\)))/i;

// PS-001: cron job installation or modification.
const reCronPersistence = /(?:\bcrontab\s+(?:-{1,2}[er]\b|-(?:\s|$)|[A-Za-z0-9_./~]+)|\|\s*crontab\b|>>?\s*\S*\/etc\/cron|\/etc\/cron\.d\b|\/var\/spool\/cron\/)/i;

// PS-002: systemd service persistence.
const reSystemdPersistence = /(?:>>?\s*\S*\/etc\/systemd\/system\/|\/etc\/systemd\/system\/\S*\.service\b|\bsystemctl\s+(?:enable|link|daemon-reload)\b)/i;

// PS-003: appending to shell profile startup files (.bashrc, etc.) with network commands.
const reShellRCPersistence = /(?:(?:>>?\s*\S*\.(?:bashrc|bash_profile|profile|zshrc|zprofile)\b|\btee\b[^\n]{0,20}\s-a\b[^\n]{0,60}\.(?:bashrc|bash_profile|zshrc)\b)[^\n]*\b(?:curl|wget|nc|ncat|netcat|\/dev\/tcp|bash\s+-[A-Za-z]*i|socat|fetch)\b|\b(?:curl|wget|nc|ncat|netcat|\/dev\/tcp|bash\s+-[A-Za-z]*i|socat|fetch)\b[^\n]*(?:>>?\s*\S*\.(?:bashrc|bash_profile|profile|zshrc|zprofile)\b|\btee\b[^\n]{0,20}\s-a\b[^\n]{0,60}\.(?:bashrc|bash_profile|zshrc)\b))/i;

// PS-004: adding SSH authorized keys.
const reAuthorizedKeys = /(?:>>?\s*\S*authorized_keys\b|\bauthorized_keys\b[^\n]{0,40}(?:>>|\btee\b)|\bssh-copy-id\b)/i;

// PS-005: user-level systemd service persistence.
const reUserSystemd = /(?:>>?\s*\S*\.config\/systemd\/user\/|\.config\/systemd\/user\/\S*\.service\b|\bsystemctl\s+--user\s+(?:enable|link|daemon-reload|start)\b)/i;

// EX-001: uploading files via curl/wget.
const reUploadTransfer = /\b(?:curl|wget)\b[^\n]{0,120}(?:\s-T\b|--upload-file\b|--post-file\b|--data-binary\s*@|--data\s*@)/i;

// EX-002: base64 payload piped into network client.
const reBase64ToNetwork = /\bbase64\b[^\n]{0,120}\|\s*(?:curl|wget|nc|ncat|netcat|ssh|dig|nslookup)\b/i;

// EX-003: DNS tunnelling tools or queries.
const reDNSTunnel = /\b(?:iodine|dnscat2?|dns2tcp|tuns)\b|\b(?:dig|nslookup)\b[^\n]{0,60}\bTXT\b[^\n]{0,40}\|/i;

// EX-004: copying files to remote host with scp/rsync.
const reRemoteCopy = /\b(?:scp|rsync)\b[^\n]{0,80}\s[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/i;

// DS-001: recursive forced deletion of root or home.
const reRootDelete = /\brm\b[^\n]{0,40}(?:-{1,2}[A-Za-z]*(?:rf|fr)[A-Za-z]*|--recursive[^\n]{0,20}--force)[^\n]{0,20}\s(?:--no-preserve-root\s+)?(?:\/(?:\*|\s|$)|(?:~|\$HOME|\$\{HOME\})(?:\*|\s|$))/i;

// DS-002: mkfs filesystem creation over devices.
const reMkfs = /\bmkfs(?:\.[a-z0-9]+)?\b\s+\S/i;

// DS-003: raw writing to block devices with dd.
const reDDToDevice = /\bdd\b[^\n]{0,80}\bof=\/dev\/(?:sd|nvme|vd|hd|mmcblk|disk|loop|mapper|dm-)/i;

// DS-004: classic shell fork bomb.
const reForkBomb = /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i;

// DS-005: shredding files.
const reShred = /\bshred\b\s+(?:-\S+\s+)*\S/i;

// CE-001: accessing docker.sock.
const reDockerSocket = /\/(?:var\/)?run\/docker\.sock\b/i;

// CE-002: host-level privilege container flags.
const reHostPrivilegeFlags = /(?:--privileged\b|--cap-add\s*=?\s*(?:SYS_ADMIN|ALL)\b|--pid\s*=?\s*host\b|--net(?:work)?\s*=?\s*host\b)/i;

// CE-003: container escape using nsenter.
const reNsenter = /\bnsenter\b/i;

// CE-004: cgroup release_agent escape.
const reReleaseAgent = /\brelease_agent\b/i;

// CM-001: cryptocurrency mining software or stratum pools.
const reCryptominer = /\b(?:xmrig|minerd|cpuminer|ccminer|cgminer|xmr-stak)\b|stratum\+(?:tcp|ssl|tls):\/\//i;

// BG-001: patch modifying build.sh or test.sh verification gate.
const rePatchTouchesGate = /^(?:diff\s+--git|(?:---|\+\+\+))\s+.*[\s/](?:build|test)\.sh(?:[\s\r]|$)/im;

// BG-002: patch modifying adjacent CI or gate machinery (Makefile, workflows).
const rePatchTouchesCI = /^(?:diff\s+--git|(?:---|\+\+\+))\s+.*[\s/](?:(?:Makefile|justfile)(?:[\s\r]|$)|\.github\/workflows\/\S+)/im;

export function defaultRules(): ThreatRule[] {
  return [
    {
      id: 'PE-001',
      category: 'privilege-escalation',
      description: 'Write to /etc/sudoers, granting durable root via sudo',
      severity: 'CRITICAL',
      pattern: reSudoersWrite,
    },
    {
      id: 'PE-002',
      category: 'privilege-escalation',
      description: 'Grant elevated privilege to a file: setuid bit, setcap capability, or chown to root',
      severity: 'HIGH',
      pattern: rePrivilegeBits,
    },
    {
      id: 'PE-003',
      category: 'privilege-escalation',
      description: 'Load a kernel module or mount a device or kernel filesystem',
      severity: 'HIGH',
      pattern: reKernelModuleOrMount,
    },
    {
      id: 'PE-004',
      category: 'privilege-escalation',
      description: 'Modify the packet filter with iptables, nftables, or ufw',
      severity: 'HIGH',
      pattern: reFirewallChange,
    },
    {
      id: 'CA-001',
      category: 'credential-access',
      description: 'Read a process environment block from /proc/<pid>/environ',
      severity: 'HIGH',
      pattern: reProcEnviron,
    },
    {
      id: 'CA-002',
      category: 'credential-access',
      description: 'Sweep the environment for secrets with env or printenv piped into grep',
      severity: 'MEDIUM',
      pattern: reEnvGrepSweep,
    },
    {
      id: 'CA-003',
      category: 'credential-access',
      description: 'Touch a credential store: AWS shared credentials, netrc, Docker or opencode config, gh hosts',
      severity: 'HIGH',
      pattern: reCredentialStores,
    },
    {
      id: 'CA-004',
      category: 'credential-access',
      description: 'Reference an SSH private key under .ssh',
      severity: 'HIGH',
      pattern: reSSHPrivateKey,
    },
    {
      id: 'CA-005',
      category: 'credential-access',
      description: 'Reach a cloud instance metadata endpoint for credentials',
      severity: 'CRITICAL',
      pattern: reCloudMetadata,
    },
    {
      id: 'CA-006',
      category: 'credential-access',
      description: 'Run a password cracking tool against captured hashes',
      severity: 'HIGH',
      pattern: rePasswordCracker,
    },
    {
      id: 'RC-001',
      category: 'recon',
      description: 'Run a port scanner or a shell loop that sweeps a port range',
      severity: 'HIGH',
      pattern: reNetworkScanner,
    },
    {
      id: 'RC-002',
      category: 'recon',
      description: 'Invoke an offensive exploitation or web scanning framework',
      severity: 'HIGH',
      pattern: reExploitFramework,
    },
    {
      id: 'RC-003',
      category: 'recon',
      description: 'Read the shadow password database /etc/shadow',
      severity: 'HIGH',
      pattern: reShadowRead,
    },
    {
      id: 'RC-004',
      category: 'recon',
      description: 'Read the account database /etc/passwd with a file reader',
      severity: 'MEDIUM',
      pattern: rePasswdRead,
    },
    {
      id: 'RC-005',
      category: 'recon',
      description: 'Enumerate sockets and connections with ss or netstat',
      severity: 'MEDIUM',
      pattern: reSocketSweep,
    },
    {
      id: 'RC-006',
      category: 'recon',
      description: 'Read Kubernetes secrets through kubectl',
      severity: 'HIGH',
      pattern: reKubectlSecrets,
    },
    {
      id: 'RS-001',
      category: 'reverse-shell',
      description: 'Hand a shell to a remote peer with nc/ncat -e',
      severity: 'CRITICAL',
      pattern: reNetcatExec,
    },
    {
      id: 'RS-002',
      category: 'reverse-shell',
      description: 'Open an interactive shell or file descriptor over bash /dev/tcp',
      severity: 'CRITICAL',
      pattern: reBashDevTCP,
    },
    {
      id: 'RS-003',
      category: 'reverse-shell',
      description: 'Bridge a socket to a process with socat exec',
      severity: 'CRITICAL',
      pattern: reSocatExec,
    },
    {
      id: 'RS-004',
      category: 'reverse-shell',
      description: 'Allocate a pseudo-terminal with Python pty.spawn to upgrade a shell',
      severity: 'CRITICAL',
      pattern: rePtySpawn,
    },
    {
      id: 'RS-005',
      category: 'reverse-shell',
      description: 'Download and execute script piped directly into a shell interpreter',
      severity: 'CRITICAL',
      pattern: reCurlPipeShell,
    },
    {
      id: 'RS-006',
      category: 'reverse-shell',
      description: 'Reverse shell in scripting language (python, perl, ruby, node, php) connecting socket and spawning shell or redirecting descriptors',
      severity: 'CRITICAL',
      pattern: reScriptReverseShell,
    },
    {
      id: 'PS-001',
      category: 'persistence',
      description: 'Install or alter a scheduled job through crontab or the cron spool',
      severity: 'HIGH',
      pattern: reCronPersistence,
    },
    {
      id: 'PS-002',
      category: 'persistence',
      description: 'Create or enable a systemd unit so code runs at boot',
      severity: 'HIGH',
      pattern: reSystemdPersistence,
    },
    {
      id: 'PS-003',
      category: 'persistence',
      description: 'Append to a shell startup file such as .bashrc or .profile',
      severity: 'HIGH',
      pattern: reShellRCPersistence,
    },
    {
      id: 'PS-004',
      category: 'persistence',
      description: 'Add an SSH key to authorized_keys or via ssh-copy-id',
      severity: 'HIGH',
      pattern: reAuthorizedKeys,
    },
    {
      id: 'PS-005',
      category: 'persistence',
      description: 'Create or enable user-level systemd service persistence',
      severity: 'HIGH',
      pattern: reUserSystemd,
    },
    {
      id: 'EX-001',
      category: 'exfiltration',
      description: 'Upload a file to a remote endpoint with curl or wget',
      severity: 'HIGH',
      pattern: reUploadTransfer,
    },
    {
      id: 'EX-002',
      category: 'exfiltration',
      description: 'Base64-encode a payload and pipe it into a network client',
      severity: 'HIGH',
      pattern: reBase64ToNetwork,
    },
    {
      id: 'EX-003',
      category: 'exfiltration',
      description: 'Tunnel data over DNS with a tunnelling tool or a piped TXT query',
      severity: 'HIGH',
      pattern: reDNSTunnel,
    },
    {
      id: 'EX-004',
      category: 'exfiltration',
      description: 'Copy files to a remote user@host with scp or rsync',
      severity: 'MEDIUM',
      pattern: reRemoteCopy,
    },
    {
      id: 'DS-001',
      category: 'destructive',
      description: 'Recursively force-delete the filesystem root or home root',
      severity: 'CRITICAL',
      pattern: reRootDelete,
    },
    {
      id: 'DS-002',
      category: 'destructive',
      description: 'Create a filesystem over a device with mkfs',
      severity: 'CRITICAL',
      pattern: reMkfs,
    },
    {
      id: 'DS-003',
      category: 'destructive',
      description: 'Write raw data to a block device with dd',
      severity: 'CRITICAL',
      pattern: reDDToDevice,
    },
    {
      id: 'DS-004',
      category: 'destructive',
      description: 'Exhaust the process table with a fork bomb',
      severity: 'CRITICAL',
      pattern: reForkBomb,
    },
    {
      id: 'DS-005',
      category: 'destructive',
      description: 'Destroy file contents beyond recovery with shred',
      severity: 'HIGH',
      pattern: reShred,
    },
    {
      id: 'CE-001',
      category: 'container-escape',
      description: 'Access the Docker socket, which controls the host daemon',
      severity: 'CRITICAL',
      pattern: reDockerSocket,
    },
    {
      id: 'CE-002',
      category: 'container-escape',
      description: 'Request host-level privilege: --privileged, SYS_ADMIN, or host PID/network namespace',
      severity: 'HIGH',
      pattern: reHostPrivilegeFlags,
    },
    {
      id: 'CE-003',
      category: 'container-escape',
      description: 'Enter host namespaces with nsenter',
      severity: 'CRITICAL',
      pattern: reNsenter,
    },
    {
      id: 'CE-004',
      category: 'container-escape',
      description: 'Write a cgroup release_agent to run a binary on the host',
      severity: 'CRITICAL',
      pattern: reReleaseAgent,
    },
    {
      id: 'CM-001',
      category: 'cryptomining',
      description: 'Run a cryptocurrency miner or connect to a mining pool with stratum',
      severity: 'CRITICAL',
      pattern: reCryptominer,
    },
    {
      id: 'BG-001',
      category: 'build-gate-tamper',
      description: 'Patch modifies the build.sh or test.sh verification gate',
      severity: 'HIGH',
      pattern: rePatchTouchesGate,
      stream: 'patch',
    },
    {
      id: 'BG-002',
      category: 'build-gate-tamper',
      description: 'Patch modifies adjacent gate machinery: Makefile, justfile, or a CI workflow',
      severity: 'MEDIUM',
      pattern: rePatchTouchesCI,
    },
  ];
}
