import { isBusyError } from '../store.ts';
import type { AdmissionDb } from './db.ts';
import type { TurnPlan } from './recovery.ts';
import type { LiveOutcome } from './reports.ts';

export type TurnReason = 'fresh' | Extract<TurnPlan, { action: 'resume' }>['reason'] | 'reconstructed';

type TurnStart = {
  attemptId: string;
  activityId: string;
  changeId: string;
  sessionId: string;
  generation: number;
  plan: TurnReason;
  questionId?: string;
};

type TurnEnd = {
  outcome: LiveOutcome['kind'] | 'no_report' | 'error' | 'session_lost';
  exitCode?: number;
  durationMs?: number;
  costUsd?: number;
  log?: string;
};

/** La contención al registrar telemetría puede dejar huecos, pero no debe provocar otro turno. */
export class TurnStore {
  constructor(private readonly adm: AdmissionDb) {}

  begin(t: TurnStart): void {
    try {
      this.adm.db.query(
        'INSERT INTO adm_turns(attempt_id, activity_id, change_id, session_id, generation, plan, question_id, started_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run(t.attemptId, t.activityId, t.changeId, t.sessionId, t.generation, t.plan, t.questionId ?? null, this.adm.iso());
    } catch (error) {
      if (!isBusyError(error)) throw error;
    }
  }

  end(attemptId: string, r: TurnEnd): void {
    try {
      this.adm.db.query('UPDATE adm_turns SET ended_at = ?, outcome = ?, exit_code = ?, duration_ms = ?, cost_usd = ?, log = ? WHERE attempt_id = ?')
        .run(this.adm.iso(), r.outcome, r.exitCode ?? null, r.durationMs ?? null, r.costUsd ?? null, r.log ?? null, attemptId);
    } catch (error) {
      if (!isBusyError(error)) throw error;
    }
  }
}
