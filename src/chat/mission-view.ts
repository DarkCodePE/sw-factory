import { fit } from './render.ts';

export interface MissionFeatureProgress {
  id: string;
  milestone: string;
  status: string; // 'pending' | 'awaiting_validation' | 'completed' | 'cancelled'
  attempts: number;
}

export interface MissionMilestoneProgress {
  id: string;
  scrutiny: boolean;
  userTesting: boolean;
  verifiersPassed: boolean | null;
}

export interface MissionWorkerProgress {
  workerSessionId: string;
  featureId: string;
  role: 'worker' | 'scrutiny' | 'user-testing';
  status: 'running' | 'completed' | 'failed';
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
}

export interface MissionProgressSnapshot {
  missionId: string;
  title: string;
  state: string; // 'planning' | 'running' | 'paused' | 'orchestrator_turn' | 'completed'
  updatedAt: string;
  features: MissionFeatureProgress[];
  milestones: MissionMilestoneProgress[];
  workers: MissionWorkerProgress[];
  totals: {
    completed: number;
    total: number;
    usage: { inputTokens: number; outputTokens: number };
    durationMs: number;
  };
}

export function formatMissionEvent(event: Record<string, any>): string {
  if (!event || typeof event.type !== 'string') return '[Misión] Evento no estructurado';
  switch (event.type) {
    case 'mission_state_changed':
      return `[Misión] Estado: ${event.state ?? 'desconocido'}`;
    case 'mission_worker_started':
      return `[Misión] Worker iniciado: ${event.featureId ?? 'desconocida'} (${event.role ?? 'worker'}${event.milestone ? `, milestone ${event.milestone}` : ''})`;
    case 'mission_worker_completed': {
      const tokens = event.usage ? `in ${event.usage.inputTokens ?? 0} / out ${event.usage.outputTokens ?? 0}` : '';
      const dur = typeof event.durationMs === 'number' ? `${(event.durationMs / 1000).toFixed(1)}s` : '';
      const parts = [tokens, dur].filter(Boolean).join(' · ');
      return `[Misión] Worker completado: ${event.featureId ?? 'desconocida'} (${event.role ?? 'worker'}) -> exit ${event.exitCode ?? 0}${event.successState ? ` (${event.successState})` : ''}${parts ? ' · ' + parts : ''}`;
    }
    case 'mission_feature_updated':
      return `[Misión] Feature ${event.featureId ?? 'desconocida'}: ${event.status ?? 'actualizada'} (intento ${event.attempts ?? 1})`;
    case 'mission_milestone_validated':
      return `[Misión] Milestone ${event.milestone ?? ''}: ${event.passed ? 'aprobado' : 'fallido'} (${Array.isArray(event.verifiers) ? event.verifiers.length : 0} verificadores)`;
    case 'mission_paused':
      return `[Misión] Pausada (${event.reason ?? 'host_request'})${event.message ? `: ${event.message}` : ''}`;
    case 'mission_progress': {
      const snap = event.snapshot as MissionProgressSnapshot | undefined;
      const comp = snap?.totals?.completed ?? 0;
      const tot = snap?.totals?.total ?? 0;
      return `[Misión] Progreso: ${comp}/${tot} features completadas (${snap?.state ?? 'en curso'})`;
    }
    default:
      return `[Misión] ${String(event.type).replace(/^mission_/, '')}`;
  }
}

export function renderMissionPanel(snapshot?: MissionProgressSnapshot, width = 80, plain = true, currentState = 'idle'): string {
  const lines: string[] = [];
  const state = snapshot?.state ?? currentState;
  const title = snapshot?.title ?? 'Mission Control';
  const header = `── Mission Control: ${fit(title, Math.max(10, width - 30))} [${state}] ──`;
  lines.push(plain ? header : `\x1b[1;36m${header}\x1b[0m`);

  if (!snapshot) {
    lines.push('Sin snapshot de misión disponible.');
    lines.push('─'.repeat(Math.min(width, 60)));
    return lines.join('\n');
  }

  const totals = snapshot.totals ?? { completed: 0, total: 0, usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 0 };
  const statsLine = `Progreso: ${totals.completed}/${totals.total} completadas · Tokens: in ${totals.usage?.inputTokens ?? 0} / out ${totals.usage?.outputTokens ?? 0} · Tiempo: ${((totals.durationMs ?? 0) / 1000).toFixed(1)}s`;
  lines.push(statsLine);
  lines.push('');

  // Agrupar features por milestone (acotado a 100 features)
  const features = (snapshot.features ?? []).slice(0, 100);
  const milestones = snapshot.milestones ?? [];
  const milestoneMap = new Map<string, MissionFeatureProgress[]>();

  for (const f of features) {
    const msId = f.milestone || 'sin-milestone';
    const list = milestoneMap.get(msId) ?? [];
    list.push(f);
    milestoneMap.set(msId, list);
  }

  lines.push('Milestones y Features:');
  for (const [msId, feats] of milestoneMap) {
    const msInfo = milestones.find(m => m.id === msId);
    let msStatus = '';
    if (msInfo) {
      const vPassed = msInfo.verifiersPassed === true ? 'verificadores ✓' : msInfo.verifiersPassed === false ? 'verificadores ✗' : 'verificadores pend.';
      msStatus = ` (${msInfo.scrutiny ? 'scrutiny ✓, ' : ''}${msInfo.userTesting ? 'user-testing ✓, ' : ''}${vPassed})`;
    }
    lines.push(` ◆ Milestone: ${fit(msId, 30)}${msStatus}`);
    for (const f of feats) {
      const icon = f.status === 'completed' ? (plain ? '[✓]' : '\x1b[32m[✓]\x1b[0m')
        : f.status === 'awaiting_validation' ? (plain ? '[?]' : '\x1b[33m[?]\x1b[0m')
        : f.status === 'cancelled' ? (plain ? '[✗]' : '\x1b[31m[✗]\x1b[0m')
        : (plain ? '[·]' : '\x1b[90m[·]\x1b[0m');
      const featId = fit(f.id, Math.max(15, Math.min(45, width - 35)));
      lines.push(`   ${icon} ${featId} (intentos: ${f.attempts}) [${f.status}]`);
    }
  }

  if (snapshot.workers && snapshot.workers.length > 0) {
    lines.push('');
    lines.push('Workers:');
    for (const w of snapshot.workers.slice(-20)) {
      const statusIcon = w.status === 'completed' ? (plain ? '✓' : '\x1b[32m✓\x1b[0m')
        : w.status === 'failed' ? (plain ? '✗' : '\x1b[31m✗\x1b[0m')
        : (plain ? '►' : '\x1b[33m►\x1b[0m');
      const idStr = fit(w.workerSessionId ?? '', 12);
      const roleStr = fit(w.role ?? 'worker', 14);
      const featStr = fit(w.featureId ?? '', 24);
      const tokensStr = `in ${w.usage?.inputTokens ?? 0} / out ${w.usage?.outputTokens ?? 0}`;
      const timeStr = `${((w.durationMs ?? 0) / 1000).toFixed(1)}s`;
      lines.push(`   ${statusIcon} ${idStr} | ${roleStr} | ${featStr} | ${w.status} | ${tokensStr} | ${timeStr}`);
    }
  }

  lines.push('─'.repeat(Math.min(width, 70)));
  return lines.join('\n');
}

export class MissionTracker {
  snapshot?: MissionProgressSnapshot;
  state = 'idle';
  directory?: string;
  missionId?: string;
  panelVisible = false;
  activeRun = false;

  get hasMission(): boolean {
    return !!this.snapshot || this.state !== 'idle';
  }

  get summary(): string | undefined {
    if (!this.hasMission && !this.snapshot) return undefined;
    const comp = this.snapshot?.totals?.completed ?? 0;
    const tot = this.snapshot?.totals?.total ?? 0;
    return `misión: ${this.state} ${comp}/${tot}`;
  }

  markRunStarted() {
    this.activeRun = true;
    if (this.state === 'idle') this.state = 'running';
  }

  markRunEnded() {
    this.activeRun = false;
  }

  handleEvent(event: Record<string, any>) {
    if (!event || typeof event.type !== 'string') return;
    try {
      if (event.type === 'mission_progress' && event.snapshot) {
        this.snapshot = structuredClone(event.snapshot);
        if (this.snapshot?.state) this.state = this.snapshot.state;
        if (this.snapshot?.missionId) this.missionId = this.snapshot.missionId;
      } else if (event.type === 'mission_state_changed' && event.state) {
        this.state = String(event.state);
        if (this.snapshot) this.snapshot.state = this.state;
      } else if (event.type === 'mission_paused') {
        this.state = 'paused';
        if (this.snapshot) this.snapshot.state = 'paused';
      } else if (event.type === 'mission_feature_updated' && event.featureId && this.snapshot) {
        const feat = this.snapshot.features.find(f => f.id === event.featureId);
        if (feat) {
          if (event.status) feat.status = String(event.status);
          if (typeof event.attempts === 'number') feat.attempts = event.attempts;
        }
      } else if (event.type === 'mission_milestone_validated' && event.milestone && this.snapshot) {
        const ms = this.snapshot.milestones.find(m => m.id === event.milestone);
        if (ms) {
          ms.verifiersPassed = !!event.passed;
        }
      } else if (event.type === 'mission_worker_started' && event.workerSessionId && this.snapshot) {
        const existing = this.snapshot.workers.find(w => w.workerSessionId === event.workerSessionId);
        if (!existing) {
          this.snapshot.workers.push({
            workerSessionId: String(event.workerSessionId),
            featureId: String(event.featureId ?? ''),
            role: (event.role ?? 'worker') as any,
            status: 'running',
            usage: { inputTokens: 0, outputTokens: 0 },
            durationMs: 0,
          });
        }
      } else if (event.type === 'mission_worker_completed' && event.workerSessionId && this.snapshot) {
        const worker = this.snapshot.workers.find(w => w.workerSessionId === event.workerSessionId);
        if (worker) {
          worker.status = event.exitCode === 0 ? 'completed' : 'failed';
          if (event.usage) worker.usage = { inputTokens: event.usage.inputTokens ?? 0, outputTokens: event.usage.outputTokens ?? 0 };
          if (typeof event.durationMs === 'number') worker.durationMs = event.durationMs;
        }
      }
    } catch {
      // Malformed events must never crash the tracker
    }
  }

  renderPanel(width = 80, plain = true): string {
    return renderMissionPanel(this.snapshot, width, plain, this.state);
  }
}
