// Adaptación HTTP: las transiciones, el cercado y los eventos siguen en los comandos existentes.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Store, StoreError } from './store.ts';
import { REVIEWABLE_KINDS, type ReviewDecision } from './enums.ts';
import { redact } from './manifest.ts';
import { AdmissionDb, hasAdmission } from './admission/db.ts';
import { answerQuestion } from './admission/answers.ts';
import { resetSessionCap } from './admission/sessions.ts';
import type { WebAuth } from './web-auth.ts';

const escape = (s: string) => redact(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const messages: Record<string, string> = {
  ok: 'Acción registrada.', conflict: 'conflict: el estado cambió o la acción ya se aplicó. Revisa el estado actual.',
  invalid_transition: 'invalid_transition: esta acción no corresponde al estado actual.',
  limit_reached: 'limit_reached: el change ya tiene 20 notas sin entregar.',
  not_found: 'not_found: no se encontró el registro.', invalid_input: 'invalid_input: revisa los datos de la acción.',
  error: 'No se pudo registrar la acción. Revisa el estado antes de volver a intentarlo.',
};
export function actionNotice(result?: string): string {
  const message = messages[result ?? ''];
  return message ? `<p class="notice" role="status">${message}</p>` : '';
}

function retryRevision(store: Store, id: string): string {
  const c = store.getChange(id);
  return createHash('sha256').update(JSON.stringify([c.status, store.listActivities({ changeId: id }).map(a => [a.id, a.status, a.reviewStatus, a.questionId])])).digest('hex');
}

export function actionForms(store: Store, url: URL, csrf?: string): string {
  if (!csrf) return '';
  const match = /^\/(activities|changes)\/([\w-]+)$/.exec(url.pathname);
  if (!match) return '';
  const id = match[2]!;
  const hidden = `<input type="hidden" name="csrf" value="${csrf}">`;
  const form = (path: string, body: string) => `<form action="${path}" method="post" class="web-action">${hidden}${body}</form>`;
  if (match[1] === 'changes') {
    const c = store.getChange(id);
    const activities = store.listActivities({ changeId: id });
    const waiting = activities.some(a => a.status === 'waiting_reply');
    let out = '';
    if (waiting || ['failed', 'blocked', 'quarantined', 'implemented'].includes(c.status)) out += form(`/changes/${id}/retry`, `<input type="hidden" name="revision" value="${retryRevision(store, id)}"><button>Reintentar change</button><p class="muted">Reencola la última activity fallida; si espera una respuesta, abandona esa espera.</p>`);
    if (!store.isTerminalChange(c.status)) {
      const planned = activities.some(a => ['pending', 'in_progress', 'waiting_reply'].includes(a.status));
      out += form(`/changes/${id}/note`, `<fieldset><legend>Nota para el agente</legend><label for="note-body">Nota (máximo 8 KiB)</label><textarea id="note-body" name="body" rows="4" maxlength="8192" required></textarea><button>Guardar nota</button><p class="muted">No lanza ni interrumpe nada. Se entrega al empezar el siguiente turno de trabajo, una sola vez.${planned ? '' : ' Ahora no hay ningún turno previsto.'} Enviar dos veces crea dos notas.</p></fieldset>`);
    }
    return out ? `<section aria-label="Decisiones">${out}</section>` : '';
  }
  const a = store.getActivity(id);
  let body = '';
  if (a.reviewStatus === 'awaiting' && REVIEWABLE_KINDS.some(kind => kind === a.kind)) body += form(`/activities/${id}/review`, `<fieldset><legend>Resolver revisión</legend><label for="review-comment">Comentario (obligatorio para pedir cambios o rechazar, máximo 8 KiB)</label><textarea id="review-comment" name="comment" rows="4" maxlength="8192"></textarea><div class="action-buttons"><button name="decision" value="approve">Aprobar</button><button name="decision" value="comment">Pedir cambios</button><button name="decision" value="decline">Rechazar</button></div></fieldset>`);
  if (a.status === 'waiting_reply' && a.questionId && hasAdmission(store)) {
    const q = store.db.query("SELECT id, text FROM adm_questions WHERE id=? AND activity_id=? AND status='open'").get(a.questionId, a.id) as { id: string; text: string } | null;
    if (q && /^[\w-]+$/.test(q.id)) body += form(`/questions/${q.id}/answer`, `<fieldset><legend>Responder pregunta</legend><p>${escape(q.text)}</p><label for="question-answer">Respuesta (máximo 8 KiB)</label><textarea id="question-answer" name="answer" rows="4" maxlength="8192" required></textarea><button>Enviar respuesta</button></fieldset>`);
  }
  return body ? `<section aria-label="Decisiones">${body}</section>` : '';
}

class InputError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function readForm(req: Request): Promise<URLSearchParams> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') throw new InputError(415, 'Solo se admite application/x-www-form-urlencoded.');
  if (Number(req.headers.get('content-length')) > 16384) throw new InputError(413, 'El cuerpo supera 16 KiB.');
  // Bun limita la recepción a 16 KiB antes de materializar el cuerpo (startWeb).
  let body: ArrayBuffer;
  try { body = await req.arrayBuffer(); }
  catch (error) {
    if (error instanceof Error && error.name === 'RequestBodyTooLarge') throw new InputError(413, 'El cuerpo supera 16 KiB.');
    throw error;
  }
  if (body.byteLength > 16384) throw new InputError(413, 'El cuerpo supera 16 KiB.');
  return new URLSearchParams(Buffer.from(body).toString('utf8'));
}

export async function webAction(req: Request, stateDir: string, port: number, auth: WebAuth): Promise<Response> {
  if (!auth.sessionCsrf(req)) return new Response('Se necesita una sesión local.', { status: 401 });
  if (![ `http://127.0.0.1:${port}`, `http://localhost:${port}` ].includes(req.headers.get('origin') ?? '')) return new Response('Origin rechazado.', { status: 403 });
  let store: Store | undefined;
  let destination = '/'; let result = 'ok';
  try {
    const form = await readForm(req);
    if (!auth.validCsrf(req, form.get('csrf') ?? '')) return new Response('CSRF rechazado.', { status: 403 });
    const match = /^\/(activities|changes|questions)\/([^/]+)\/(review|retry|answer|note)$/.exec(new URL(req.url).pathname);
    if (!match || !['activities/review', 'changes/retry', 'changes/note', 'questions/answer'].includes(`${match[1]}/${match[3]}`)) return new Response('Acción no encontrada.', { status: 404 });
    const id = decodeURIComponent(match[2]!);
    if (!/^[\w-]+$/.test(id)) throw new InputError(400, 'Identificador inválido.');
    const action = match[3]!;
    const comment = form.get('comment') ?? '', answer = form.get('answer') ?? '', noteBody = form.get('body') ?? '';
    if (Buffer.byteLength(comment) > 8192 || Buffer.byteLength(answer) > 8192 || Buffer.byteLength(noteBody) > 8192) throw new InputError(413, 'El texto supera 8 KiB.');
    const decision = form.get('decision') ?? '';
    if (action === 'review' && (!['approve', 'comment', 'decline'].includes(decision) || decision !== 'approve' && !comment.trim())) throw new InputError(400, 'Elige una decisión y escribe un comentario para pedir cambios o rechazar.');
    if (action === 'answer' && !answer.trim()) throw new InputError(400, 'Escribe una respuesta.');
    store = new Store(join(stateDir, 'fabrica.db'));
    const writer = store;
    // FAB_ACTOR es el patrón del Store. El tramo es síncrono: ningún await expone el actor a otra petición.
    const previous = process.env.FAB_ACTOR; process.env.FAB_ACTOR = 'web';
    try {
      writer.withRetry(() => {
        if (action === 'review') {
          const a = writer.getActivity(id); destination = `/activities/${id}`;
          if (a.reviewStatus !== 'awaiting' && ['approved', 'commented', 'declined'].includes(a.reviewStatus ?? '')) throw new StoreError('conflict', 'revisión resuelta');
          writer.resolveReview(id, decision as ReviewDecision, comment);
        } else if (action === 'note') {
          writer.getChange(id); destination = `/changes/${id}`;
          writer.addChangeNote(id, noteBody);
        } else if (action === 'retry') {
          writer.getChange(id); destination = `/changes/${id}`;
          if (form.get('revision') !== retryRevision(writer, id)) throw new StoreError('conflict', 'change actualizado');
          for (const a of writer.listActivities({ changeId: id }).filter(a => a.status === 'waiting_reply')) writer.abandonWait(a.id);
          writer.retryChange(id);
          if (hasAdmission(writer)) resetSessionCap(writer, new AdmissionDb(writer), id);
        } else {
          if (!hasAdmission(writer)) throw new StoreError('not_found', 'sin preguntas');
          const adm = new AdmissionDb(writer);
          const q = adm.db.query('SELECT activity_id FROM adm_questions WHERE id=?').get(id) as { activity_id: string } | null;
          if (!q) throw new StoreError('not_found', 'pregunta inexistente');
          destination = `/activities/${q.activity_id}`;
          if (answerQuestion(writer, adm, { questionId: id, answer, by: 'web' }) !== 'answered') result = 'conflict';
        }
      });
    } finally { if (previous === undefined) delete process.env.FAB_ACTOR; else process.env.FAB_ACTOR = previous; }
  } catch (error) {
    if (error instanceof InputError) return new Response(error.message, { status: error.status, headers: error.status === 413 ? { Connection: 'close' } : {} });
    if (error instanceof URIError) return new Response('Identificador inválido.', { status: 400 });
    result = error instanceof StoreError && messages[error.code] ? error.code : 'error';
  } finally { store?.close(); }
  auth.rememberNotice(req, destination, result);
  return new Response(null, { status: 303, headers: { Location: destination } });
}
