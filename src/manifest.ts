// Evidence design reference: ext/esf/internal/factory/{model,redact}.go@d901657 (MIT).
// Reimplemented locally; evidence is scrubbed before any bytes reach disk.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.ts';
import { GIT_SAFE_FLAGS, branchFor } from './worktrees.ts';

export function redact(text: string): string {
  return text
    .replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[\w-]{35})\b/g, '[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, '[REDACTED]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b([\w-]*(?:api[_-]?key|token|secret|password|credential)[\w-]*\s*[:=]\s*)["']?[^\s"',}]+["']?/gi, '$1[REDACTED]');
}

export function atomicEvidence(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, redact(text), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}

function evidenceId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('invalid evidence id');
  return id;
}
export function runDirectory(stateDir: string, changeId: string): string {
  return join(resolve(stateDir), 'runs', evidenceId(changeId));
}
export function activityLog(stateDir: string, changeId: string, activityId: string): string {
  return join(runDirectory(stateDir, changeId), `${evidenceId(activityId)}.log`);
}
export function gitEvidence(repo: string, ...args: string[]): string | null {
  try {
    const p = Bun.spawnSync(['git', ...GIT_SAFE_FLAGS, ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    return p.exitCode === 0 ? p.stdout.toString().trim() : null;
  } catch (error) {
    // Store also supports records for repos not mounted on this host.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export function isolationFor(adapter: string) {
  const posture: Record<string, string> = {
    fake: 'test process; no sandbox', codex: 'CLI sandbox: read-only or workspace-write',
    claude: 'CLI tool allowlist; no fab sandbox', agy: 'CLI permissions bypassed; no fab sandbox',
    droid: 'CLI auto medium; no fab sandbox', native: 'native tool sandbox policy',
  };
  return { adapter, posture: posture[adapter] ?? 'unknown; no isolation attested' };
}

// Sonda de egress escrita por el hijo native; ausente si la activity no usó red.
export function readEgressProbe(path: string) {
  try {
    const { reachable, decided, positiveControl, probedAt } = JSON.parse(readFileSync(path, 'utf8'));
    return { reachable, decided, positiveControl, probedAt };
  } catch { return null; }
}

export function writeManifest(store: Store, changeId: string, stateDir = store.stateDir): void {
  if (!stateDir) return; // In-memory stores have no durable state directory.
  const c = store.getChange(changeId);
  const ws = store.getWorkstream(c.workstreamId);
  const dir = runDirectory(stateDir, changeId);
  const previous = existsSync(join(dir, 'run.json')) ? JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) : {};
  const branch = c.branch ?? branchFor(c.id);
  const head = gitEvidence(ws.repo, 'rev-parse', '--verify', branch) ?? previous.head ?? null;
  const activities = store.listActivities({ changeId }).map(a => {
    const path = activityLog(stateDir, changeId, a.id);
    if (!existsSync(path)) atomicEvidence(path, a.result ?? a.error ?? '');
    const metaPath = join(dir, `${a.id}.json`);
    const execution = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : { isolation: isolationFor(ws.agent), egressProbe: null };
    return { ...a, verdict: a.validator ? ({ approved: 'pass', declined: 'fail', commented: 'needs_human' } as Record<string,string>)[a.reviewStatus ?? ''] ?? null : null,
      reason: a.error ?? a.reviewComment, log: `${a.id}.log`, ...execution,
      durationMs: execution.durationMs ?? (a.startedAt && a.completedAt ? Math.max(0, Date.parse(a.completedAt) - Date.parse(a.startedAt)) : null) };
  });
  const cleanup = { worktree: existsSync(join(stateDir, 'worktrees', c.id.slice(0, 8))) ? 'retained' : 'absent',
    branch: gitEvidence(ws.repo, 'show-ref', '--verify', `refs/heads/${branch}`) ? 'retained' : 'absent' };
  // Redact strings before JSON encoding so multiline PEMs cannot evade scrubbing.
  const scrub = (_key: string, value: unknown) => typeof value === 'string' ? redact(value) : value;
  atomicEvidence(join(dir, 'run.json'), JSON.stringify({ schemaVersion: 1, changeId, status: c.status,
    baseSha: c.baseSha, branch, head, createdAt: c.createdAt, updatedAt: c.updatedAt,
    durationMs: Math.max(0, Date.parse(c.updatedAt) - Date.parse(c.createdAt)), activities, cleanup }, scrub, 2) + '\n');
}
