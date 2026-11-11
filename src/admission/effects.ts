// Cola de efectos durable (R3). Inspirada en dsh-superagent-prototype/src/app/effects.ts (MIT): reintento con
// espera creciente y la fila como fuente de verdad. Diferencias: la `key` es única para siempre (un efecto hecho
// no se vuelve a encolar), y la recuperación tras una caída sigue la regla de R6 (identidad de intento, sin
// suponer que reejecutar es seguro).
import { randomUUID } from 'node:crypto';
import type { AdmissionDb } from './db.ts';

export type EffectCtx = { key: string; attemptId: string; attempt: number };
export type EffectHandler = {
  run: (payload: any, ctx: EffectCtx) => void | Promise<void>;
  /** true: reejecutar tras una caída es inocuo (idempotente). false: el efecto queda `unknown` hasta reconciliarlo. */
  rerunnable: boolean;
  /** Para un efecto `unknown`: consulta el mundo exterior y dice si ya se hizo (`done`) o hay que reintentar (`retry`). */
  reconcile?: (payload: any) => Promise<'done' | 'retry'>;
};
/** Un efecto que queda `dead` o `unknown` pide atención humana o reconciliación: no puede quedarse mudo (T29). */
export type EffectAlert = { kind: string; key: string; status: 'dead' | 'unknown'; error: string; payload: any };
export type CrashPoint = 'after-read' | 'after-register' | 'effect-claimed' | 'effect-ran'
  | 'report-recorded' | 'report-applied' | 'answer-applied';
type Row = { id: number; kind: string; key: string; payload: string; attempts: number; attempt_id: string };

export class Effects {
  constructor(private readonly adm: AdmissionDb, private readonly handlers: Record<string, EffectHandler>,
    private readonly opts: { maxAttempts?: number; baseMs?: number; maxMs?: number; fence?: () => void; crash?: (point: CrashPoint) => void;
      onAlert?: (alert: EffectAlert) => void } = {}) {}

  /** Encola dentro de la transacción del cambio de estado que lo origina. false si la `key` ya existía. */
  enqueue(kind: string, key: string, payload: unknown, dueAt = this.adm.now()): boolean {
    if (!this.adm.db.inTransaction) throw new Error('Un efecto se encola en la transacción del cambio de estado que lo origina');
    return this.adm.db.query('INSERT OR IGNORE INTO adm_effects(kind, key, payload, due_at) VALUES (?,?,?,?)')
      .run(kind, key, JSON.stringify(payload), dueAt).changes === 1;
  }

  /** Tras reiniciar con el lock tomado, todo `running` es de un intento muerto: se reanuda o queda `unknown`. */
  recover(): number {
    const max = this.opts.maxAttempts ?? 5, alerts: EffectAlert[] = [];
    const n = this.adm.tx(() => {
      const rows = this.adm.db.query("SELECT id, kind, key, payload, attempts, attempt_id FROM adm_effects WHERE status = 'running'").all() as Row[];
      for (const row of rows) {
        const note = `intento ${row.attempt_id} interrumpido por una caída`;
        if (!this.handlers[row.kind]?.rerunnable) { const error = `resultado desconocido: ${note}; reconciliar antes de reejecutar`; this.set(row.id, 'unknown', error); alerts.push(this.alert(row, 'unknown', error)); }
        else if (row.attempts >= max) { const error = `${note}; tope de ${max} intentos`; this.set(row.id, 'dead', error); alerts.push(this.alert(row, 'dead', error)); }
        else this.set(row.id, 'pending', note, this.adm.now());
      }
      return rows.length;
    });
    alerts.forEach(a => this.opts.onAlert?.(a));
    return n;
  }

  private alert(row: Row, status: EffectAlert['status'], error: string): EffectAlert { return { kind: row.kind, key: row.key, status, error, payload: JSON.parse(row.payload) }; }

  /**
   * Salida de los efectos `unknown` (T29): si el handler sabe consultar el mundo exterior (`reconcile`), se decide aquí si ya se
   * hizo (`done`) o hay que reintentar (`pending`). Sin `reconcile`, el efecto sigue `unknown` y avisa en cada llamada de recover.
   * Un fallo al consultar deja el efecto como estaba. Devuelve cuántos resolvió.
   */
  async reconcile(): Promise<number> {
    const rows = this.adm.db.query("SELECT id, kind, key, payload, attempts, attempt_id FROM adm_effects WHERE status = 'unknown' ORDER BY id").all() as Row[];
    let resolved = 0;
    for (const row of rows) {
      const handler = this.handlers[row.kind];
      if (!handler?.reconcile) continue;
      try {
        const verdict = await handler.reconcile(JSON.parse(row.payload));
        this.adm.tx(() => verdict === 'done' ? this.set(row.id, 'done', null) : this.set(row.id, 'pending', 'reconciliado: no se hizo, se reintenta', this.adm.now()));
        resolved++;
      } catch (error) {
        this.adm.tx(() => this.set(row.id, 'unknown', `reconciliación fallida: ${String((error as Error)?.message ?? error).slice(0, 500)}`));
      }
    }
    return resolved;
  }

  /** Despacha todos los efectos vencidos; devuelve cuántos intentos ejecutó. */
  async dispatch(): Promise<number> {
    let ran = 0;
    for (let row = this.claim(); row; row = this.claim()) { await this.execute(row); ran++; }
    return ran;
  }

  private set(id: number, status: string, error: string | null, dueAt?: number, attemptId?: string): number {
    return this.adm.db.query(`UPDATE adm_effects SET status = ?, last_error = ?, due_at = COALESCE(?, due_at)
      WHERE id = ? AND (? IS NULL OR attempt_id = ?)`).run(status, error, dueAt ?? null, id, attemptId ?? null, attemptId ?? null).changes;
  }

  private claim(): Row | undefined {
    return this.adm.tx(() => {
      this.opts.fence?.();
      const row = this.adm.db.query("SELECT id, kind, key, payload, attempts FROM adm_effects WHERE status = 'pending' AND due_at <= ? ORDER BY id LIMIT 1")
        .get(this.adm.now()) as Row | null;
      if (!row) return undefined;
      const attemptId = randomUUID();
      this.adm.db.query("UPDATE adm_effects SET status = 'running', attempts = attempts + 1, attempt_id = ? WHERE id = ?").run(attemptId, row.id);
      return { ...row, attempts: row.attempts + 1, attempt_id: attemptId };
    });
  }

  private async execute(row: Row): Promise<void> {
    this.opts.crash?.('effect-claimed');
    const handler = this.handlers[row.kind];
    const alerts: EffectAlert[] = [];
    try {
      if (!handler) throw new Error(`sin handler para ${row.kind}`);
      await handler.run(JSON.parse(row.payload), { key: row.key, attemptId: row.attempt_id, attempt: row.attempts });
    } catch (error) {
      const max = this.opts.maxAttempts ?? 5, message = String((error as Error)?.message ?? error).slice(0, 1000);
      const delay = Math.min(this.opts.maxMs ?? 60_000, (this.opts.baseMs ?? 1000) * 2 ** (row.attempts - 1));
      const dead = row.attempts >= max || !handler;
      this.adm.tx(() => dead ? this.set(row.id, 'dead', message, undefined, row.attempt_id)
        : this.set(row.id, 'pending', message, this.adm.now() + delay, row.attempt_id));
      if (dead) alerts.push(this.alert(row, 'dead', message));
      alerts.forEach(a => this.opts.onAlert?.(a));
      return;
    }
    this.opts.crash?.('effect-ran');
    // Solo el intento que sigue vigente cierra la fila (fencing por attempt_id).
    this.adm.tx(() => this.set(row.id, 'done', null, undefined, row.attempt_id));
  }
}
