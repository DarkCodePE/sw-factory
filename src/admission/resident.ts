// Residente en modo observe: poll de GitHub → Trigger/Thread → efecto `admit` → gate → registro de would_admit.
// No crea signals ni changes ni lanza agentes, y no lee ni escribe tablas de la fab.
import { runCommand, type CommandRunner } from '../connectors/github.ts';
import type { Store } from '../store.ts';
import { AdmissionDb } from './db.ts';
import { Effects, type CrashPoint } from './effects.ts';
import { gate, type GateInput, type GatePolicy } from './gate.ts';
import { labeler, pollIssues, type IssueEvent } from './github.ts';
import { ResidentLock } from './lock.ts';

export type Mode = 'off' | 'observe';
export type ResidentConfig = {
  repo: string; policy: GatePolicy; mode: Mode; run?: CommandRunner; intervalMs?: number;
  /** Desde dónde leer cuando aún no hay cursor (ISO). Por defecto, el último día (D3). */
  since?: string;
  maxAttempts?: number; baseMs?: number; lockTtlMs?: number; crash?: (point: CrashPoint) => void;
};

export class Resident {
  readonly adm: AdmissionDb;
  readonly lock: ResidentLock;
  readonly effects: Effects;
  private readonly source: string;
  private stopped = false;
  private wake?: () => void;

  constructor(store: Store, private readonly cfg: ResidentConfig) {
    if ((cfg.mode as string) !== 'off' && (cfg.mode as string) !== 'observe') throw new Error(`Modo "${cfg.mode}" no admitido en la fase 1: usa off|observe`);
    this.adm = new AdmissionDb(store);
    this.lock = new ResidentLock(this.adm, { ttlMs: cfg.lockTtlMs });
    this.source = `github:${cfg.repo}`;
    this.effects = new Effects(this.adm, { admit: { run: payload => this.admit(payload.triggerKey), rerunnable: true } },
      { maxAttempts: cfg.maxAttempts, baseMs: cfg.baseMs, fence: () => this.lock.assertOwned(), crash: cfg.crash });
  }

  /** Un trigger por (issue, updated_at): repetir el poll o caerse entre leer y registrar no duplica nada. */
  private register(events: IssueEvent[]): number {
    let added = 0;
    this.adm.tx(() => {
      const db = this.adm.db, iso = this.adm.iso();
      for (const e of events) {
        const thread = `${this.source}#${e.number}`, key = `${thread}@${e.updatedAt}`;
        db.query('INSERT OR IGNORE INTO adm_threads(id, source, first_seen) VALUES (?,?,?)').run(thread, this.source, iso);
        const { labels, state, author, authorAssociation, url, updatedAt } = e; // el texto del issue no se guarda ni se usa
        const inserted = db.query('INSERT OR IGNORE INTO adm_triggers(key, thread_id, event, observed_at) VALUES (?,?,?,?)')
          .run(key, thread, JSON.stringify({ repo: e.repo, number: e.number, url, state, updatedAt, author, authorAssociation, labels }), iso).changes === 1;
        if (inserted) { added++; this.effects.enqueue('admit', `admit:${key}`, { triggerKey: key }); }
      }
      const last = events.at(-1);
      const cursor = db.query('SELECT value FROM adm_cursors WHERE source = ?').get(this.source) as { value: string } | null;
      if (last && (!cursor || last.updatedAt > cursor.value)) db.query('INSERT INTO adm_cursors(source, value) VALUES (?,?) ON CONFLICT(source) DO UPDATE SET value=excluded.value').run(this.source, last.updatedAt);
    });
    return added;
  }

  private async admit(triggerKey: string): Promise<void> {
    const row = this.adm.db.query('SELECT event FROM adm_triggers WHERE key = ?').get(triggerKey) as { event: string } | null;
    if (!row) throw new Error(`Trigger ${triggerKey} inexistente`);
    const event = JSON.parse(row.event) as IssueEvent;
    const input: GateInput = { repo: event.repo, labels: event.labels, author: event.author, authorAssociation: event.authorAssociation, state: event.state };
    // Solo se consulta quién puso la etiqueta cuando el resto del gate la dejaría pasar: evita llamadas inútiles a la API.
    const label = this.cfg.policy.triggerLabel.toLowerCase();
    if (event.state === 'open' && event.labels.some(l => l.toLowerCase() === label) && this.cfg.policy.repos.some(r => r.toLowerCase() === event.repo.toLowerCase()))
      input.labeler = await labeler(event.repo, event.number, this.cfg.policy.triggerLabel, this.cfg.run ?? runCommand);
    const d = gate(input, this.cfg.policy);
    // INSERT OR IGNORE: reejecutar tras una caída no cambia el registro (el efecto es `rerunnable`).
    this.adm.db.query('INSERT OR IGNORE INTO adm_decisions(trigger_key, would_admit, strength, scope_max, reasons, policy, decided_at) VALUES (?,?,?,?,?,?,?)')
      .run(triggerKey, d.would_admit ? 1 : 0, d.strength, d.scope_max, JSON.stringify(d.reasons), JSON.stringify(this.cfg.policy), this.adm.iso());
  }

  /** Un ciclo: poll de la fuente y despacho de efectos. Exige el lock tomado. */
  async cycle(): Promise<{ triggers: number; effects: number }> {
    if (this.cfg.mode === 'off') return { triggers: 0, effects: 0 };
    this.lock.assertOwned();
    const cursor = (this.adm.db.query('SELECT value FROM adm_cursors WHERE source = ?').get(this.source) as { value: string } | null)?.value;
    const since = cursor ?? this.cfg.since ?? new Date(this.adm.now() - 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const events = await pollIssues(this.cfg.repo, since, this.cfg.run ?? runCommand);
    this.cfg.crash?.('after-read');
    const triggers = this.register(events);
    this.cfg.crash?.('after-register');
    return { triggers, effects: await this.effects.dispatch() };
  }

  stop(): void { this.stopped = true; this.wake?.(); }

  async run(opts: { once?: boolean; log?: (line: string) => void } = {}): Promise<void> {
    const log = opts.log ?? (() => {});
    if (this.cfg.mode === 'off') { log('modo off: no se consulta ninguna fuente'); return; }
    this.lock.acquire();
    const beat = setInterval(() => { try { this.lock.assertOwned(); } catch (error) { log(String(error)); this.stop(); } }, 10_000);
    try {
      log(`recuperados ${this.effects.recover()} efectos interrumpidos`);
      do {
        try { log(`ciclo: ${JSON.stringify(await this.cycle())}`); }
        catch (error) { if (opts.once) throw error; log(`ciclo fallido: ${(error as Error).message}`); }
        if (opts.once || this.stopped) break;
        await new Promise<void>(resolve => { this.wake = resolve; setTimeout(resolve, this.cfg.intervalMs ?? 60_000); });
      } while (!this.stopped);
    } finally { clearInterval(beat); this.lock.release(); }
  }
}
