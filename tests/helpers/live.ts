import { AdmissionDb } from '../../src/admission/db.ts';
import { Effects, type EffectHandler, type CrashPoint } from '../../src/admission/effects.ts';
import { Store } from '../../src/store.ts';

/** Store en memoria con un change y su primera activity ya reclamada por `w1`. */
export function claimed(handlers: Record<string, EffectHandler> = {}, opts: { crash?: (p: CrashPoint) => void; clock?: () => Date } = {}) {
  const store = new Store(':memory:', opts.clock ? { clock: opts.clock } : undefined);
  const ws = store.createWorkstream({ slug: 'ws', goal: 'g', repo: '/tmp/none', agent: 'fake', requireChangeApproval: false, requireApproval: false });
  store.setWorkstreamState(ws.slug, 'active');
  const signal = store.addSignal(ws.slug, 'título', 'descripción');
  const change = store.triageSignal(signal.id);
  const adm = new AdmissionDb(store);
  const effects = new Effects(adm, { reply: { run: () => {}, rerunnable: false }, ...handlers }, { baseMs: 1, crash: opts.crash });
  const claim = (worker = 'w1') => store.claimActivity(ws.slug, worker)!;
  return { store, ws, change, adm, effects, claim };
}

// ---- backend vivo falso (T12) ----------------------------------------------------------------------------------------
import { SessionNotFoundError, type LiveBackend, type LiveReport, type LiveTurn, type LiveTurnResult } from '../../src/live/contract.ts';

export type FakeStep = { reports?: LiveReport[]; output?: string; before?: (turn: LiveTurn) => void | Promise<void>; error?: Error };
export type FakeLive = LiveBackend & { turns: LiveTurn[]; known: Set<string>; steps: FakeStep[] };

/**
 * Backend vivo falso: cada llamada consume el siguiente paso del guion (el último se repite). Reanudar una sesión que no
 * arrancó nunca lanza SessionNotFoundError, como `claude --resume` con un id desconocido. `onReport` se llama como el real.
 */
export function fakeLive(steps: FakeStep[], over: Partial<Pick<LiveBackend, 'name' | 'confinable'>> = {}): FakeLive {
  const known = new Set<string>(), turns: LiveTurn[] = [];
  const backend: FakeLive = { name: over.name ?? 'fake', confinable: over.confinable ?? true, turns, known, steps,
    async run(turn): Promise<LiveTurnResult> {
      turns.push(turn);
      const step = steps[Math.min(turns.length - 1, steps.length - 1)] ?? {};
      if (turn.sessionId && !known.has(turn.sessionId)) throw new SessionNotFoundError(turn.sessionId, 'unknown');
      const sessionId = turn.sessionId ?? turn.newSessionId ?? crypto.randomUUID();
      known.add(sessionId);
      turn.onSpawn?.(0);
      await step.before?.(turn);
      if (step.error) throw step.error;
      const reports: LiveReport[] = [];
      for (const r of step.reports ?? []) { turn.onReport?.(r); reports.push(r); }
      return { ok: true, output: step.output ?? 'fake live output', exitCode: 0, durationMs: 1, status: { kind: 'missing', reason: 'report has no STATUS line' },
        stdout: '', stderr: '', sessionId, attemptId: turn.attemptId, reports };
    } };
  return backend;
}
