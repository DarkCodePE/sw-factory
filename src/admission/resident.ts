// Residente en modo observe: poll de GitHub → Trigger/Thread → efecto `admit` → gate → registro de would_admit.
// No crea signals ni changes ni lanza agentes, y no lee ni escribe tablas de la fab.
import { createHash } from 'node:crypto';
import { runCommand, type CommandRunner } from '../connectors/github.ts';
import type { Store } from '../store.ts';
import { AdmissionDb } from './db.ts';
import { Effects, type CrashPoint } from './effects.ts';
import { commentGate, gate, type GateDecision, type GateInput, type GatePolicy } from './gate.ts';
import { collaboratorRole, issueContent, labeler, pollComments, pollIssues, type CommentEvent, type IssueEvent } from './github.ts';
import { ThreadLinks } from './links.ts';
import { ResidentLock } from './lock.ts';

export type Mode = 'off' | 'observe';
export type ResidentConfig = {
  repo: string; policy: GatePolicy; mode: Mode;
  /** Login con el que la fab publica (T23): sus eventos se descartan para no dispararse a sí misma. */
  selfLogin?: string;
  /** Lee también los comentarios (opt-in, T21): cada uno es un Trigger con su actor y se decide si podría responder una pregunta abierta. */
  comments?: boolean; run?: CommandRunner; intervalMs?: number;
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
    if (cfg.comments && !cfg.selfLogin) throw new Error('--comments exige --self <login>: sin la identidad de la fab no se puede filtrar su propio comentario');
    this.adm = new AdmissionDb(store);
    this.lock = new ResidentLock(this.adm, { ttlMs: cfg.lockTtlMs });
    this.source = `github:${cfg.repo}`;
    this.effects = new Effects(this.adm, { admit: { run: payload => this.admit(payload.triggerKey), rerunnable: true },
      inbound: { run: payload => this.inbound(payload.triggerKey), rerunnable: true } },
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
    const link = new ThreadLinks(this.adm).changeOf(triggerKey.slice(0, triggerKey.lastIndexOf('@')));
    const skip = link ? ['thread-already-admitted', `change:${link}`]
      : this.cfg.selfLogin && event.author.toLowerCase() === this.cfg.selfLogin.toLowerCase() ? ['self-authored'] : undefined;
    if (skip) { this.record(triggerKey, { would_admit: false, strength: 'inferred', scope_max: 'none', reasons: skip }); return; }
    const input: GateInput = { repo: event.repo, labels: event.labels, author: event.author, authorAssociation: event.authorAssociation, state: event.state };
    // Solo se consulta quién puso la etiqueta cuando el resto del gate la dejaría pasar: evita llamadas inútiles a la API.
    const label = this.cfg.policy.triggerLabel.toLowerCase();
    if (event.state === 'open' && event.labels.some(l => l.toLowerCase() === label) && this.cfg.policy.repos.some(r => r.toLowerCase() === event.repo.toLowerCase()))
      input.labeler = await labeler(event.repo, event.number, this.cfg.policy.triggerLabel, this.cfg.run ?? runCommand);
    let d = gate(input, this.cfg.policy);
    if (d.would_admit) d = await this.bindContent(triggerKey, event, input);
    this.record(triggerKey, d);
  }

  /** INSERT OR IGNORE: reejecutar tras una caída no cambia el registro (el efecto es `rerunnable`). */
  private record(triggerKey: string, d: GateDecision): void {
    this.adm.db.query('INSERT OR IGNORE INTO adm_decisions(trigger_key, would_admit, strength, scope_max, reasons, policy, decided_at) VALUES (?,?,?,?,?,?,?)')
      .run(triggerKey, d.would_admit ? 1 : 0, d.strength, d.scope_max, JSON.stringify(d.reasons), JSON.stringify(this.cfg.policy), this.adm.iso());
  }

  /**
   * T20: la etiqueta prueba quién autorizó, no qué. Se lee el contenido (título + cuerpo) solo cuando el gate ya admitiría;
   * si se editó después de etiquetar, o difiere de la copia admitida bajo esa misma etiqueta, se deniega (`edited-after-label`)
   * y hay que volver a etiquetar. La copia admitida (texto + hash) queda en `adm_content`; el prompt usará solo esa.
   */
  private async bindContent(triggerKey: string, event: IssueEvent, input: GateInput) {
    const thread = triggerKey.slice(0, triggerKey.lastIndexOf('@')), labeledAt = input.labeler!.at;
    const content = await issueContent(event.repo, event.number, this.cfg.run ?? runCommand);
    const hash = createHash('sha256').update(`${content.title}\0${content.body}`).digest('hex');
    const prior = this.adm.db.query('SELECT hash, labeled_at FROM adm_content WHERE thread_id = ?').get(thread) as { hash: string; labeled_at: string } | null;
    const d = gate({ ...input, contentEditedAt: content.lastEditedAt, contentChanged: !!prior && prior.labeled_at === labeledAt && prior.hash !== hash }, this.cfg.policy);
    // Una etiqueta más reciente que la copia guardada la reemplaza (se volvió a etiquetar tras editar).
    if (d.would_admit && labeledAt && (!prior || prior.labeled_at < labeledAt))
      this.adm.db.query(`INSERT INTO adm_content(thread_id, title, body, hash, labeled_at, edited_at, captured_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(thread_id) DO UPDATE SET title=excluded.title, body=excluded.body, hash=excluded.hash, labeled_at=excluded.labeled_at, edited_at=excluded.edited_at, captured_at=excluded.captured_at`)
        .run(thread, content.title, content.body, hash, labeledAt, content.lastEditedAt, this.adm.iso());
    return d;
  }

  /** Un Trigger por comentario: la identidad es su id, y editarlo no crea otro (el texto queda fijado al registrarlo). */
  private registerComments(events: CommentEvent[]): number {
    let added = 0;
    this.adm.tx(() => {
      const db = this.adm.db, iso = this.adm.iso(), source = `${this.source}/comments`;
      for (const e of events) {
        const thread = `${this.source}#${e.number}`, key = `${thread}!c${e.id}`;
        db.query('INSERT OR IGNORE INTO adm_threads(id, source, first_seen) VALUES (?,?,?)').run(thread, this.source, iso);
        const { repo, number, id, url, author, authorType, authorAssociation, createdAt, updatedAt } = e;
        const inserted = db.query('INSERT OR IGNORE INTO adm_triggers(key, thread_id, event, observed_at) VALUES (?,?,?,?)')
          .run(key, thread, JSON.stringify({ kind: 'comment', repo, number, commentId: id, url, author, authorType, authorAssociation, createdAt, updatedAt }), iso).changes === 1;
        if (!inserted) continue;
        added++;
        db.query('INSERT INTO adm_comments(trigger_key, body, hash) VALUES (?,?,?)').run(key, e.body, createHash('sha256').update(e.body).digest('hex'));
        this.effects.enqueue('inbound', `inbound:${key}`, { triggerKey: key });
      }
      const last = events.at(-1), cursor = db.query('SELECT value FROM adm_cursors WHERE source = ?').get(source) as { value: string } | null;
      if (last && (!cursor || last.updatedAt > cursor.value)) db.query('INSERT INTO adm_cursors(source, value) VALUES (?,?) ON CONFLICT(source) DO UPDATE SET value=excluded.value').run(source, last.updatedAt);
    });
    return added;
  }

  /** ¿Podría este comentario responder la pregunta abierta del hilo? En modo observe solo se registra la decisión. */
  private async inbound(triggerKey: string): Promise<void> {
    const row = this.adm.db.query('SELECT thread_id, event FROM adm_triggers WHERE key = ?').get(triggerKey) as { thread_id: string; event: string } | null;
    if (!row) throw new Error(`Trigger ${triggerKey} inexistente`);
    const c = JSON.parse(row.event) as { repo: string; author: string; authorType: string; createdAt: string };
    const change = new ThreadLinks(this.adm).changeOf(row.thread_id);
    const q = change ? this.adm.db.query("SELECT id, asked_at FROM adm_questions WHERE change_id = ? AND status = 'open' ORDER BY asked_at DESC LIMIT 1").get(change) as { id: string; asked_at: string } | null : null;
    const input = { author: c.author, authorType: c.authorType, self: this.cfg.selfLogin!, createdAt: c.createdAt, question: q ? { askedAt: q.asked_at } : undefined };
    let v = commentGate(input);
    if (v.reason === 'role-unchecked') v = commentGate({ ...input, role: await collaboratorRole(c.repo, c.author, this.cfg.run ?? runCommand) });
    this.adm.db.query('INSERT OR IGNORE INTO adm_comment_decisions(trigger_key, accept, reason, question_id, decided_at) VALUES (?,?,?,?,?)')
      .run(triggerKey, v.accept ? 1 : 0, v.reason, v.accept ? q!.id : null, this.adm.iso());
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
    let comments = 0;
    if (this.cfg.comments) {
      const ccursor = (this.adm.db.query('SELECT value FROM adm_cursors WHERE source = ?').get(`${this.source}/comments`) as { value: string } | null)?.value;
      comments = this.registerComments(await pollComments(this.cfg.repo, ccursor ?? since, this.cfg.run ?? runCommand));
    }
    return { triggers: triggers + comments, effects: await this.effects.dispatch() };
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
