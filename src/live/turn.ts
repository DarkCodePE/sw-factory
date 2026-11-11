// Turno vivo de una activity dentro del pool (06 §5.1, S1, S2, S6). El pool sigue siendo quien lanza: reclama, prepara el
// worktree y llama aquí; el residente no lanza nada. Un turno = una sesión escrita antes de lanzar, un `onReport` que
// persiste por intento y, al acabar, el report manda sobre la línea `STATUS:` (T26).
import { randomUUID } from 'node:crypto';
import type { AgentRun } from '../agents.ts';
import { runLiveTurn } from '../admission/channel.ts';
import type { AdmissionDb } from '../admission/db.ts';
import type { CrashPoint } from '../admission/effects.ts';
import { markAnswerDelivered, planTurn } from '../admission/recovery.ts';
import { liveOutcome, ReportStore, type LiveOutcome } from '../admission/reports.ts';
import { isSessionLoss, reconstructPrompt, SessionStore, supersede } from '../admission/sessions.ts';
import type { WorkerTemplates } from '../prompts.ts';
import type { Activity, Store } from '../store.ts';
import { claudeLive } from './claude.ts';
import type { LiveBackend } from './contract.ts';

/** Backends vivos conocidos, por nombre de adaptador. Hoy solo claude (`native` no está en esta rama). */
export const LIVE_BACKENDS: Record<string, LiveBackend> = { claude: claudeLive };

/**
 * Criterio explícito de la rama viva: el pool se arrancó con `live` (`fab run --live`), el adaptador del workstream tiene backend
 * vivo y la activity es de trabajo (investigación o implementación). Validadores y gates siguen en un disparo. Nunca por defecto.
 */
export function liveBackendFor(opts: { live?: boolean; liveBackends?: Record<string, LiveBackend> }, agentName: string, a: Activity): LiveBackend | undefined {
  if (!opts.live || a.validator || a.kind === 'gates') return undefined;
  const registry = opts.liveBackends ?? LIVE_BACKENDS;
  return Object.hasOwn(registry, agentName) ? registry[agentName] : undefined;
}

/** Lo que el agente necesita saber para hablar con la fab: sin esto nunca preguntaría ni informaría por la tool. */
export const LIVE_RULES = `

# Reporting (live session)
Report through the \`report\` tool (mcp__fab__report): state "done" when you finish, "blocked" with the reason if you cannot, or "awaiting" with \`human_action\` set to your question when you need a human answer to continue. After an "awaiting" report, stop working: the factory will resume this same session with the answer. When you call the tool, the STATUS line is ignored.`;

export type LiveActivityCtx = {
  backend: LiveBackend; cwd: string; branch: string; profileDigest: string; factoryCommits?: boolean; templates?: WorkerTemplates;
  /** Prompt completo del primer turno (el que construye el pool). */
  prompt: string;
  timeoutMs?: number; signal: AbortSignal; confine?: boolean; capturePath?: string;
  onSpawn: (pgid: number) => void; crash?: (point: CrashPoint) => void;
};

/** El resultado de un turno con el aspecto de un disparo, para que el pool siga con las mismas comprobaciones. */
function asRun(run: AgentRun, outcome: LiveOutcome | undefined): AgentRun {
  if (!outcome) return run;
  const { kind, report } = outcome;
  const text = report.summary.trim() || run.output;
  return kind === 'blocked' ? { ...run, ok: false, output: text, status: { kind: 'blocked', reason: report.summary } }
    : { ...run, ok: true, output: kind === 'done' && run.output.trim() ? run.output : text, status: { kind: 'done', reason: '' } };
}

/** Un turno: sesión escrita antes de lanzar (S2), `onReport` durable (S6) y resultado por precedencia del report (T26). */
export async function runLiveActivity(store: Store, adm: AdmissionDb, a: Activity, ctx: LiveActivityCtx): Promise<{ run: AgentRun; outcome?: LiveOutcome }> {
  const sessions = new SessionStore(adm), reports = new ReportStore(adm);
  const plan = planTurn(adm, a);
  if (plan.action === 'apply-report') { // S4: el turno huérfano ya había informado: se aplica el report, no se reejecuta ni se lanza nada
    const outcome = liveOutcome([plan.report]);
    return { run: asRun({ ok: true, output: '', exitCode: 0, durationMs: 0, status: { kind: 'missing', reason: 'recuperado de un report guardado' } }, outcome), outcome };
  }
  const meta = { backend: ctx.backend.name, cwd: ctx.cwd, model: null, profileDigest: ctx.profileDigest };
  let prompt = plan.action === 'fresh' ? ctx.prompt + LIVE_RULES : plan.prompt;
  const questionId = plan.action === 'resume' ? plan.questionId : undefined;
  reports.markApplied(a.id); // lo que quede pendiente es de un intento anterior ya resuelto; este turno produce el suyo
  for (;;) {
    try {
      const { session, turn } = sessions.begin(a.changeId, a.kind, meta);
      ctx.crash?.('session-written');
      sessions.markLaunched(session.sessionId); // A8: antes de lanzar, no en onSpawn
      ctx.crash?.('session-launched');
      const attemptId = randomUUID();
      const result = await runLiveTurn(adm, ctx.backend, a.changeId, {
        ...turn, prompt, cwd: ctx.cwd, attemptId, timeoutMs: ctx.timeoutMs, signal: ctx.signal, confine: ctx.confine, capturePath: ctx.capturePath,
        onSpawn: pgid => { ctx.onSpawn(pgid); if (questionId) markAnswerDelivered(adm, questionId); },
        onReport: reports.recorder(a.id, attemptId, ctx.crash),
      });
      ctx.crash?.('turn-ended');
      const outcome = liveOutcome(result.reports);
      return { run: asRun(result, outcome), outcome };
    } catch (error) {
      // S3: solo «sesión inexistente» o «backend/cwd/modelo/perfil distintos» cuentan como pérdida; el resto (red, límite, timeout) sube tal cual.
      if (!isSessionLoss(error)) throw error;
      supersede(store, adm, a, (error as Error).message, meta); // evento + tope; agotado lanza SessionLostExhaustedError
      prompt = reconstructPrompt(store, adm, a.id, { worktree: ctx.cwd, branch: ctx.branch, factoryCommits: ctx.factoryCommits, templates: ctx.templates }) + LIVE_RULES;
    }
  }
}
