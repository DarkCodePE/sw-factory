// Adaptación HTTP: las transiciones, el cercado y los eventos siguen en los comandos existentes.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Store, StoreError } from './store.ts';
import { linkTriagedSignal } from './admission/apply.ts';
import { removeWorktree } from './worktrees.ts';
import { SIGNAL_BODY_MAX, SIGNAL_TITLE_MAX } from './web-signals.ts';
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
    let body = form(`/changes/${id}/rename`, `<fieldset><legend>Renombrar change</legend><label for="rename-title">Título (máximo ${SIGNAL_TITLE_MAX} caracteres)</label><input id="rename-title" name="title" maxlength="${SIGNAL_TITLE_MAX}" value="${escape(c.title)}" required><button>Renombrar</button></fieldset>`);
    if (waiting || ['failed', 'blocked', 'quarantined', 'implemented'].includes(c.status)) body += form(`/changes/${id}/retry`, `<input type="hidden" name="revision" value="${retryRevision(store, id)}"><button>Reintentar change</button><p class="muted">Reencola la última activity fallida; si espera una respuesta, abandona esa espera.</p>`);
    if (!store.isTerminalChange(c.status)) {
      const planned = activities.some(a => ['pending', 'in_progress', 'waiting_reply'].includes(a.status));
      body += form(`/changes/${id}/note`, `<fieldset><legend>Nota para el agente</legend><label for="note-body">Nota (máximo 8 KiB)</label><textarea id="note-body" name="body" rows="4" maxlength="8192" required></textarea><button>Guardar nota</button><p class="muted">No lanza ni interrumpe nada. Se entrega al empezar el siguiente turno de trabajo, una sola vez.${planned ? '' : ' Ahora no hay ningún turno previsto.'} Enviar dos veces crea dos notas.</p></fieldset>`);
      body += form(`/changes/${id}/cancel`, `<fieldset><legend>Cancelar change</legend><label><input type="checkbox" name="confirm" value="yes" required> Confirmo: cancela el change y borra su worktree (igual que fab reject)</label><button>Cancelar change</button></fieldset>`);
    }
    return `<section aria-label="Decisiones">${body}</section>`;
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
  let destination = '/'; let result = 'ok'; let repo: string | undefined;
  try {
    const form = await readForm(req);
    if (!auth.validCsrf(req, form.get('csrf') ?? '')) return new Response('CSRF rechazado.', { status: 403 });
    const pathname = new URL(req.url).pathname;
    const match = pathname === '/signals' ? ['', 'signals', '', 'create'] : /^\/(activities|changes|questions|signals|automations)\/([^/]+)\/(review|retry|answer|note|triage|ignore|cancel|rename|run|enable|disable)$/.exec(pathname);
    if (!match || !['activities/review', 'changes/retry', 'changes/note', 'questions/answer', 'signals/create', 'signals/triage', 'signals/ignore', 'changes/cancel', 'changes/rename', 'automations/run', 'automations/enable', 'automations/disable'].includes(`${match[1]}/${match[3]}`)) return new Response('Acción no encontrada.', { status: 404 });
    const id = match[2] ? decodeURIComponent(match[2]) : '';
    if (id && !/^[\w-]+$/.test(id)) throw new InputError(400, 'Identificador inválido.');
    const action = match[3]!;
    const title = (form.get('title') ?? '').trim(), body = form.get('body') ?? '';
    if (Buffer.byteLength(body) > SIGNAL_BODY_MAX) throw new InputError(413, 'El texto supera 8 KiB.');
    if (['create', 'rename'].includes(action) && (!title || title.length > SIGNAL_TITLE_MAX)) throw new InputError(400, `El título debe tener entre 1 y ${SIGNAL_TITLE_MAX} caracteres.`);
    if (action === 'cancel' && form.get('confirm') !== 'yes') throw new InputError(400, 'Confirma la cancelación.');
    const comment = form.get('comment') ?? '', answer = form.get('answer') ?? '';
    if (Buffer.byteLength(comment) > 8192 || Buffer.byteLength(answer) > 8192) throw new InputError(413, 'El texto supera 8 KiB.');
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
          writer.addChangeNote(id, body);
        } else if (action === 'create') {
          destination = '/signals';
          const s = writer.addSignal(form.get('workstream') ?? '', title, body || title);
          writer.event(s.workstreamId, 'info', `signal creada desde la web: ${title}`);
        } else if (action === 'triage' || action === 'ignore') {
          destination = '/signals';
          const s = [...writer.listWorkstreams()].flatMap(w => writer.listSignals(w.id)).find(s => s.id === id);
          if (!s) throw new StoreError('not_found', 'señal inexistente');
          if (s.status !== 'new') throw new StoreError('conflict', 'señal ya resuelta');
          if (action === 'ignore') { writer.ignoreSignal(id); writer.event(s.workstreamId, 'info', `signal ignorada: ${s.title}`); }
          else {
            const c = writer.triageSignal(id);
            if (hasAdmission(writer)) linkTriagedSignal(new AdmissionDb(writer), id, c.id);
            destination = `/changes/${c.id}`;
          }
        } else if (match[1] === 'automations') {
          // Ignora title y body del formulario: la señal lleva el texto que guardó el dueño (A5).
          destination = '/automations';
          if (action === 'run') writer.runAutomationNow(id); else writer.setAutomationEnabled(id, action === 'enable');
        } else if (action === 'rename') {
          writer.getChange(id); destination = `/changes/${id}`;
          writer.renameChange(id, title);
        } else if (action === 'cancel') {
          const c = writer.getChange(id); destination = `/changes/${id}`;
          if (writer.isTerminalChange(c.status)) throw new StoreError('invalid_transition', 'change terminal');
          writer.event(c.workstreamId, 'warning', 'reject solicitado', id);
          writer.closeChange(id, 'canceled'); repo = writer.getWorkstream(c.workstreamId).repo;
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
    if (repo) { await writer.waitForRelease(id); await removeWorktree(repo, stateDir, id); }
  } catch (error) {
    if (error instanceof InputError) return new Response(error.message, { status: error.status, headers: error.status === 413 ? { Connection: 'close' } : {} });
    if (error instanceof URIError) return new Response('Identificador inválido.', { status: 400 });
    result = error instanceof StoreError && messages[error.code] ? error.code : 'error';
  } finally { store?.close(); }
  auth.rememberNotice(req, destination, result);
  return new Response(null, { status: 303, headers: { Location: destination } });
}
