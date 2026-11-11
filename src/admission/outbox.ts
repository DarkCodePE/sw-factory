// Outbox: la fab publica la pregunta de un turno vivo en el hilo (T22, H-07). `human_action` es texto libre del agente y la
// fab lo publicaría con su identidad, así que la política es de la fab, no del agente:
//  - destino: sale del vínculo hilo → change guardado (como sa:src/core/replies.ts:84), nunca del agente ni del payload;
//  - plantilla fija y tope de longitud; una pregunta abierta por activity (índice único en adm_questions);
//  - se neutralizan menciones, enlaces, imágenes, HTML y marcadores falsos; el texto pasa por ThreatMonitor y, si salta, no se
//    publica: se publica la plantilla con un aviso y el texto queda en el inbox;
//  - el comentario lleva un marcador `<!-- fab:q:<id> -->`: antes de publicar y al reconciliar se busca, para no publicar dos veces.
import { runCommand, validateRepo, type CommandRunner } from '../connectors/github.ts';
import { defaultRules, ThreatMonitor } from '../threatmon/index.ts';
import type { AdmissionDb } from './db.ts';
import type { EffectHandler } from './effects.ts';
import { ThreadLinks, parseThread } from './links.ts';

export const MAX_QUESTION_CHARS = 1500;
const ZWSP = '​';
const SECRET = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/=-]{20,})/g;

export const marker = (questionId: string) => `<!-- fab:q:${questionId} -->`;

/** Texto del agente → texto seguro para publicar. `held`: la política lo retuvo (amenaza detectada). */
export function sanitizeQuestion(raw: string): { text: string; held: boolean } {
  const monitor = new ThreatMonitor(defaultRules(), 'HIGH');
  monitor.observe('stdout', raw);
  if (monitor.report().tripped) return { text: '', held: true };
  let text = raw.replace(/\r/g, '').trim().replace(SECRET, '[redactado]');
  text = text
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')            // sin HTML ni marcadores falsos
    .replace(/@(?=[A-Za-z0-9_])/g, `@${ZWSP}`)              // sin menciones (usuarios, equipos, bots)
    .replace(/:\/\//g, `:${ZWSP}//`).replace(/!\[/g, `!${ZWSP}[`) // sin enlaces automáticos ni imágenes (exfiltración por URL)
    .replace(/`{3,}/g, "'''");                              // no cierra el bloque de cita
  if (text.length > MAX_QUESTION_CHARS) text = `${text.slice(0, MAX_QUESTION_CHARS)}…`;
  return { text, held: false };
}

/** Plantilla fija: lo único que varía es la pregunta ya saneada, citada línea a línea (ninguna línea empieza por `/` ni por `@`). */
export function renderQuestion(q: { id: string; changeId: string; text: string }): string {
  const { text, held } = sanitizeQuestion(q.text);
  const quoted = held ? '> _El texto de la pregunta se retuvo por política; queda registrado en la fab._' : text.split('\n').map(l => `> ${l}`).join('\n');
  return `${marker(q.id)}\n**fab** necesita una respuesta para continuar el change \`${q.changeId}\`.\n\n${quoted}\n\nResponde en este hilo. Solo cuentan las respuestas de quien tenga rol de triage o superior.`;
}

type QuestionRow = { id: string; change_id: string; text: string; status: string };

export class Outbox {
  constructor(private readonly adm: AdmissionDb, private readonly opts: { selfLogin: string; run?: CommandRunner }) {}

  /** Hilo, y por tanto destino, de una pregunta: el primero que se unió al change. Nunca viene del agente. */
  private target(q: QuestionRow): { repo: string; number: number } {
    const thread = new ThreadLinks(this.adm).threadsOf(q.change_id)[0];
    if (!thread) throw new Error(`pregunta ${q.id}: el change ${q.change_id} no tiene hilo`);
    return parseThread(thread);
  }
  private question(id: string): QuestionRow {
    const q = this.adm.db.query('SELECT id, change_id, text, status FROM adm_questions WHERE id = ?').get(id) as QuestionRow | null;
    if (!q) throw new Error(`pregunta ${id} inexistente`);
    return q;
  }

  /** Si ya hay un comentario de la fab con el marcador de la pregunta en el hilo, su `created_at` (hora de GitHub). */
  private async posted(q: QuestionRow): Promise<string | undefined> {
    const { repo, number } = this.target(q);
    validateRepo(repo);
    const r = await (this.opts.run ?? runCommand)(['gh', 'api', '--paginate', '--slurp', `repos/${repo}/issues/${number}/comments?per_page=100`], process.cwd());
    if (r.code !== 0) throw new Error(`gh api falló al leer los comentarios del hilo (código ${r.code})`);
    const pages = JSON.parse(r.stdout) as { body?: unknown; user?: { login?: unknown }; created_at?: unknown }[][];
    const c = pages.flat().find(c => typeof c.body === 'string' && c.body.includes(marker(q.id)) && String(c.user?.login).toLowerCase() === this.opts.selfLogin.toLowerCase());
    return c ? this.stamp(c.created_at) : undefined;
  }

  /** Publica la pregunta (una vez): marcador primero, plantilla después. Una pregunta que ya no está abierta no se publica. */
  async send(questionId: string): Promise<'posted' | 'already-posted' | 'not-open'> {
    const q = this.question(questionId);
    if (q.status !== 'open') return 'not-open';
    const prior = await this.posted(q);
    if (prior) { this.markPosted(q.id, prior); return 'already-posted'; }
    const { repo, number } = this.target(q);
    const r = await (this.opts.run ?? runCommand)(['gh', 'api', '-X', 'POST', `repos/${repo}/issues/${number}/comments`, '-f', `body=${renderQuestion({ id: q.id, changeId: q.change_id, text: q.text })}`], process.cwd());
    if (r.code !== 0) throw new Error(`gh api falló al publicar la pregunta (código ${r.code})`);
    let created: unknown; try { created = (JSON.parse(r.stdout) as { created_at?: unknown }).created_at; } catch { /* sin JSON: se usa el reloj local */ }
    this.markPosted(q.id, this.stamp(created));
    return 'posted';
  }
  /** `created_at` de GitHub; solo si la respuesta no lo trae se usa el reloj local (con el desfase que eso implica). */
  private stamp(createdAt: unknown): string { return typeof createdAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(createdAt) ? createdAt : this.adm.iso().slice(0, 19) + 'Z'; }
  private markPosted(id: string, publishedAt: string): void {
    this.adm.tx(() => this.adm.db.query('UPDATE adm_questions SET posted_at = COALESCE(posted_at, ?), published_at = COALESCE(published_at, ?) WHERE id = ?').run(this.adm.iso(), publishedAt, id));
  }

  /**
   * Handler del efecto `reply`. No es reejecutable a ciegas (una caída entre publicar y cerrar el efecto no se distingue de
   * una caída antes de publicar), pero `reconcile` busca el marcador y decide: hecho o reintentar.
   */
  handler(): EffectHandler {
    return {
      rerunnable: false,
      run: async payload => { await this.send(payload.questionId); },
      reconcile: async payload => {
        const q = this.question(payload.questionId), at = await this.posted(q);
        if (at) this.markPosted(q.id, at);
        return at ? 'done' : 'retry';
      },
    };
  }
}
