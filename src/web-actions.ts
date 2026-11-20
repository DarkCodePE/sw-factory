// Adaptación HTTP: las transiciones, el cercado y los eventos siguen en los comandos existentes.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isRunnerName, Store, StoreError } from './store.ts';
import { linkTriagedSignal } from './admission/apply.ts';
import { removeWorktree } from './worktrees.ts';
import { SIGNAL_BODY_MAX, SIGNAL_TITLE_MAX } from './web-signals.ts';
import { REVIEWABLE_KINDS, type ReviewDecision } from './enums.ts';
import { redact } from './manifest.ts';
import { AdmissionDb, hasAdmission } from './admission/db.ts';
import { answerQuestion } from './admission/answers.ts';
import { resetSessionCap } from './admission/sessions.ts';
import type { WebAuth } from './web-auth.ts';
import { PROFILE_BODY_LIMIT, ProfileInputError, profileAction } from './web-profile.ts';
import { enqueueBackfill, enqueueManual, ensureSchema, previewBackfill } from './scorers.ts';
import { archiveWorkstream, createWorkstream, workstreamSettings, workstreamState, wsFields } from './web-ws.ts';
import { RUNNER_CHECK_PATH, type runnerCheckAction } from './web-runner-check.ts';

// Cancelar vale para todo change que no haya terminado bien o por decisión: igual que `fab reject`, también limpia failed, blocked y quarantined.
const FINAL_STATUSES = ['completed', 'canceled', 'declined'];
const escape = (s: string) => redact(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const messages: Record<string, string> = {
  ok: 'Acción registrada.', conflict: 'conflict: el estado cambió o la acción ya se aplicó. Revisa el estado actual.',
  invalid_transition: 'invalid_transition: esta acción no corresponde al estado actual.',
  limit_reached: 'limit_reached: el change ya tiene 20 notas sin entregar.',
  skipped_open: 'Saltada: ya hay una señal o un change abierto de esta automation; no se creó ninguna señal.',
  skipped_inactive: 'Saltada: el workstream no está activo; no se creó ninguna señal.',
  not_found: 'not_found: no se encontró el registro.', invalid_input: 'invalid_input: revisa los datos de la acción.',
  error: 'No se pudo registrar la acción. Revisa el estado antes de volver a intentarlo.',
};
export function actionNotice(result?: string): string {
  const message = messages[result ?? ''];
  return message ? `<p class="notice" role="status">${message}</p>` : '';
}

export function retryRevision(store: Store, id: string): string {
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
    }
    if (!FINAL_STATUSES.includes(c.status)) body += form(`/changes/${id}/cancel`, `<fieldset><legend>Cancelar change</legend><label><input type="checkbox" name="confirm" value="yes" required> Confirmo: cancela el change y borra su worktree (igual que fab reject)</label><button>Cancelar change</button></fieldset>`);
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

export class InputError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type Raw = Record<string, string | undefined>;
type Outcome = { destination: string; result: string; repo?: string };
type StoreAction = { path: RegExp; /** false: solo la web con sesión. */ api?: false; httpErrors?: true; input: (raw: Raw) => Raw; run: (store: Store, id: string, input: Raw, out: Outcome, actor: string, stateDir: string) => void };
type Action = StoreAction | { path: RegExp; api: false; check: true };

const text = (raw: Raw, key: string) => raw[key] ?? '';
const limit = (value: string, max = 8192) => { if (Buffer.byteLength(value) > max) throw new InputError(413, 'El texto supera 8 KiB.'); };
const titleOf = (raw: Raw) => {
  const title = text(raw, 'title').trim();
  if (!title || title.length > SIGNAL_TITLE_MAX) throw new InputError(400, `El título debe tener entre 1 y ${SIGNAL_TITLE_MAX} caracteres.`);
  return title;
};
// Valida y normaliza los campos de una acción; el orden de las comprobaciones es el de F2.
const pick = (...keys: string[]) => (raw: Raw): Raw => { for (const k of keys) limit(text(raw, k)); return Object.fromEntries(keys.map(k => [k, text(raw, k)])); };
const route = (entity: string, verb: string) => new RegExp(`^/${entity}/([^/]+)/${verb}$`);
const findSignal = (store: Store, id: string) => {
  const s = [...store.listWorkstreams()].flatMap(w => store.listSignals(w.id)).find(s => s.id === id);
  if (!s) throw new StoreError('not_found', 'señal inexistente');
  if (s.status !== 'new') throw new StoreError('conflict', 'señal ya resuelta');
  return s;
};

// Registro único de acciones: los formularios de la web y, después, la API pasan por aquí.
export const ACTIONS: Record<string, Action> = {
  'activities/review': {
    path: route('activities', 'review'),
    input: raw => {
      const comment = text(raw, 'comment'), decision = text(raw, 'decision');
      limit(comment);
      if (!['approve', 'comment', 'decline'].includes(decision) || decision !== 'approve' && !comment.trim()) throw new InputError(400, 'Elige una decisión y escribe un comentario para pedir cambios o rechazar.');
      return { comment, decision };
    },
    run: (store, id, input, out) => {
      const a = store.getActivity(id); out.destination = `/activities/${id}`;
      if (a.reviewStatus !== 'awaiting' && ['approved', 'commented', 'declined'].includes(a.reviewStatus ?? '')) throw new StoreError('conflict', 'revisión resuelta');
      store.resolveReview(id, input.decision as ReviewDecision, input.comment!);
    },
  },
  'changes/retry': {
    path: route('changes', 'retry'),
    input: raw => ({ revision: text(raw, 'revision') }),
    run: (store, id, input, out) => {
      store.getChange(id); out.destination = `/changes/${id}`;
      if (input.revision !== retryRevision(store, id)) throw new StoreError('conflict', 'change actualizado');
      for (const a of store.listActivities({ changeId: id }).filter(a => a.status === 'waiting_reply')) store.abandonWait(a.id);
      store.retryChange(id);
      if (hasAdmission(store)) resetSessionCap(store, new AdmissionDb(store), id);
    },
  },
  'changes/note': {
    path: route('changes', 'note'),
    input: pick('body'),
    run: (store, id, input, out) => {
      store.getChange(id); out.destination = `/changes/${id}`;
      store.addChangeNote(id, input.body!);
    },
  },
  'changes/rename': {
    path: route('changes', 'rename'),
    input: raw => (limit(text(raw, 'body'), SIGNAL_BODY_MAX), { title: titleOf(raw) }),
    run: (store, id, input, out) => {
      store.getChange(id); out.destination = `/changes/${id}`;
      store.renameChange(id, input.title!);
    },
  },
  'changes/cancel': {
    path: route('changes', 'cancel'),
    input: raw => { if (raw.confirm !== 'yes') throw new InputError(400, 'Confirma la cancelación.'); return {}; },
    run: (store, id, _input, out) => {
      const c = store.getChange(id); out.destination = `/changes/${id}`;
      if (FINAL_STATUSES.includes(c.status)) throw new StoreError('invalid_transition', 'change terminal');
      store.event(c.workstreamId, 'warning', 'reject solicitado', id);
      store.closeChange(id, 'canceled'); out.repo = store.getWorkstream(c.workstreamId).repo;
    },
  },
  // T65: los jueces son un aviso (D-G). Estas acciones solo encolan filas en `scores`; no tocan estados.
  'activities/score': {
    path: route('activities', 'score'),
    input: raw => { if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(text(raw, 'scorer'))) throw new InputError(400, 'Elige un juez.'); return { scorer: text(raw, 'scorer') }; },
    run: (store, id, input, out, _actor, stateDir) => {
      out.destination = `/activities/${id}`;
      ensureSchema(store.db);
      if (store.db.query("SELECT 1 FROM scores WHERE scorer = ? AND subject_activity_id = ? AND status IN ('pending','running')").get(input.scorer!, id)) throw new StoreError('conflict', 'ya hay una puntuación en cola');
      enqueueManual(store, stateDir, id, input.scorer!, 'manual');
      store.event(store.getActivity(id).workstreamId, 'info', `puntuación encolada: ${input.scorer} sobre ${id}`, store.getActivity(id).changeId);
    },
  },
  // Puntuar un rango pasado: `expected` es el número de la vista previa; si ya no coincide no se encola nada.
  'scorers/backfill': {
    path: /^\/(scorers)\/backfill$/,
    input: raw => {
      const since = text(raw, 'since'), scorer = text(raw, 'scorer');
      if (!/^[\w-]+$/.test(text(raw, 'ws')) || !/^\d{1,6}$/.test(text(raw, 'expected')) || (since && (since.length > 40 || Number.isNaN(Date.parse(since)))) || (scorer && !/^[a-z0-9][a-z0-9-]{0,40}$/.test(scorer))) throw new InputError(400, 'Revisa la vista previa y vuelve a confirmar.');
      return { ws: text(raw, 'ws'), since, scorer, expected: text(raw, 'expected'), skip: text(raw, 'skip') };
    },
    run: (store, _id, input, out, _actor, stateDir) => {
      const ws = store.getWorkstream(input.ws!);
      out.destination = `/metricas?tab=jueces&ws=${encodeURIComponent(ws.slug)}`;
      const opts = { since: input.since || undefined, scorer: input.scorer || undefined, rescore: input.skip !== 'yes' };
      ensureSchema(store.db);
      if (previewBackfill(store, stateDir, ws.id, opts).runs !== Number(input.expected)) throw new StoreError('conflict', 'la vista previa cambió');
      enqueueBackfill(store, stateDir, ws.id, opts);
      store.event(ws.id, 'info', `${input.expected} puntuaciones encoladas (rango pasado${input.scorer ? `, juez ${input.scorer}` : ''})`);
    },
  },
  'questions/answer': {
    path: route('questions', 'answer'),
    input: raw => {
      const answer = text(raw, 'answer'); limit(answer);
      if (!answer.trim()) throw new InputError(400, 'Escribe una respuesta.');
      return { answer };
    },
    run: (store, id, input, out, actor) => {
      if (!hasAdmission(store)) throw new StoreError('not_found', 'sin preguntas');
      const adm = new AdmissionDb(store);
      const q = adm.db.query('SELECT activity_id FROM adm_questions WHERE id=?').get(id) as { activity_id: string } | null;
      if (!q) throw new StoreError('not_found', 'pregunta inexistente');
      out.destination = `/activities/${q.activity_id}`;
      if (answerQuestion(store, adm, { questionId: id, answer: input.answer!, by: actor }) !== 'answered') out.result = 'conflict';
    },
  },
  'signals/create': {
    path: /^\/(signals)$/,
    input: raw => { limit(text(raw, 'body'), SIGNAL_BODY_MAX); return { title: titleOf(raw), body: text(raw, 'body'), workstream: text(raw, 'workstream') }; },
    run: (store, _id, input, out) => {
      out.destination = '/signals';
      const s = store.addSignal(input.workstream!, input.title!, input.body || input.title!);
      store.event(s.workstreamId, 'info', `signal creada desde la web: ${input.title}`);
    },
  },
  'signals/triage': {
    path: route('signals', 'triage'),
    input: raw => (limit(text(raw, 'body'), SIGNAL_BODY_MAX), {}),
    run: (store, id, _input, out) => {
      out.destination = '/signals';
      findSignal(store, id);
      const c = store.triageSignal(id);
      if (hasAdmission(store)) linkTriagedSignal(new AdmissionDb(store), id, c.id);
      out.destination = `/changes/${c.id}`;
    },
  },
  'signals/ignore': {
    path: route('signals', 'ignore'),
    input: raw => (limit(text(raw, 'body'), SIGNAL_BODY_MAX), {}),
    run: (store, id, _input, out) => {
      out.destination = '/signals';
      const s = findSignal(store, id);
      store.ignoreSignal(id); store.event(s.workstreamId, 'info', `signal ignorada: ${s.title}`);
    },
  },
  // Las automations ignoran title y body: la señal lleva el texto que guardó el dueño (A5).
  'automations/run': {
    path: route('automations', 'run'),
    input: raw => (limit(text(raw, 'body'), SIGNAL_BODY_MAX), {}),
    run: (store, id, _input, out) => {
      out.destination = '/automations';
      // T68e-H1: una vez saltada no se creó señal, y el aviso no puede decir «Acción registrada».
      const r = store.runAutomationNow(id).result;
      if (r !== 'created') out.result = r;
    },
  },
  'automations/enable': {
    path: route('automations', 'enable'),
    input: raw => (limit(text(raw, 'body'), SIGNAL_BODY_MAX), {}),
    run: (store, id, _input, out) => { out.destination = '/automations'; store.setAutomationEnabled(id, true); },
  },
  'automations/disable': {
    path: route('automations', 'disable'),
    input: raw => (limit(text(raw, 'body'), SIGNAL_BODY_MAX), {}),
    run: (store, id, _input, out) => { out.destination = '/automations'; store.setAutomationEnabled(id, false); },
  },
  // T60/T61: ajustes, estado, archivo y alta de workstreams. Mismo Store, actor y validación que antes de T71c.
  'workstreams/create': {
    api: false,
    path: /^\/(workstreams)\/nuevo$/,
    input: wsFields,
    run: (store, _id, input, out, _actor, stateDir) => {
      out.destination = '/workstreams';
      try { createWorkstream(store, stateDir, input as ReturnType<typeof wsFields>); }
      catch (e) {
        // T60-H4: un dato inválido devuelve al asistente, que muestra el paso que falla con lo escrito.
        if (e instanceof StoreError && e.code === 'invalid_input') out.destination = `/workstreams/nuevo?${new URLSearchParams({ ...(input as Record<string, string>), paso: '5' })}`;
        throw e;
      }
    },
  },
  'workstreams/settings': {
    path: route('workstreams', 'settings'),
    input: raw => ({ goal: raw.goal, concurrency: raw.concurrency, task_limit: raw.task_limit }),
    run: (store, id, input, out) => { out.destination = '/workstreams'; workstreamSettings(store, id, input); },
  },
  'workstreams/state': {
    api: false,
    path: route('workstreams', 'state'),
    input: raw => ({ state: raw.state }),
    run: (store, id, input, out) => { out.destination = '/workstreams'; workstreamState(store, id, input.state); },
  },
  'workstreams/archive': {
    path: route('workstreams', 'archive'),
    input: raw => ({ confirm: raw.confirm }),
    run: (store, id, input, out) => { out.destination = '/workstreams'; archiveWorkstream(store, id, input.confirm); },
  },
  'workstreams/runner': {
    api: false,
    httpErrors: true,
    path: route('workstreams', 'runner'),
    input: ({ runner, expected, confirm, confirm_ssh }) => {
      if (runner === undefined || (runner !== '' && !isRunnerName(runner)) || expected === undefined || confirm !== 'yes') {
        throw new InputError(400, 'Elige un runner y confirma la selección.');
      }
      return { runner, expected, confirm_ssh };
    },
    run: (store, id, { runner, expected, confirm_ssh }, out) => {
      out.destination = '/workstreams';
      store.setWorkstreamRunner(id, runner || null, { expected: expected || null, confirmSsh: confirm_ssh === 'yes' });
    },
  },
  'runners/check': { path: RUNNER_CHECK_PATH, api: false, check: true },
};

/** Abre el Store escritor, fija el actor y ejecuta una acción. Lanza InputError si la entrada no vale; el resto de fallos van en `result`. */
export async function performAction(stateDir: string, name: string, id: string, rawInput: Raw, actor: string): Promise<Outcome> {
  const action = ACTIONS[name];
  if (!action || !('run' in action)) throw new InputError(404, 'Acción no encontrada.');
  const input = action.input(rawInput);
  const out: Outcome = { destination: '/', result: 'ok' };
  let store: Store | undefined;
  try {
    store = new Store(join(stateDir, 'fabrica.db'));
    const writer = store;
    // FAB_ACTOR es el patrón del Store. El tramo es síncrono: ningún await expone el actor a otra petición.
    const previous = process.env.FAB_ACTOR; process.env.FAB_ACTOR = actor;
    try { writer.withRetry(() => action.run(writer, id, input, out, actor, stateDir)); }
    finally { if (previous === undefined) delete process.env.FAB_ACTOR; else process.env.FAB_ACTOR = previous; }
    if (out.repo) { await writer.waitForRelease(id); await removeWorktree(out.repo, stateDir, id); }
  } catch (error) {
    out.result = error instanceof StoreError && messages[error.code] ? error.code : 'error';
  } finally { store?.close(); }
  return out;
}

async function readForm(req: Request, limit = 16384): Promise<URLSearchParams> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') throw new InputError(415, 'Solo se admite application/x-www-form-urlencoded.');
  if (Number(req.headers.get('content-length')) > limit) throw new InputError(413, 'El cuerpo es demasiado grande.');
  // Bun limita la recepción a 16 KiB antes de materializar el cuerpo (startWeb).
  let body: ArrayBuffer;
  try { body = await req.arrayBuffer(); }
  catch (error) {
    if (error instanceof Error && error.name === 'RequestBodyTooLarge') throw new InputError(413, 'El cuerpo es demasiado grande.');
    throw error;
  }
  if (body.byteLength > limit) throw new InputError(413, 'El cuerpo es demasiado grande.');
  return new URLSearchParams(Buffer.from(body).toString('utf8'));
}

export async function webAction(req: Request, stateDir: string, port: number, auth: WebAuth,
  runnerCheck: ReturnType<typeof runnerCheckAction>, extendCheckTimeout: () => void): Promise<Response> {
  if (!auth.sessionCsrf(req)) return new Response('Se necesita una sesión local.', { status: 401 });
  if (req.headers.get('origin') !== `http://${auth.host}:${port}`) return new Response('Origin rechazado.', { status: 403 });
  let destination = '/'; let result = 'ok';
  try {
    const profilePath = /^\/perfiles\/(guardar|asignar)$/.exec(new URL(req.url).pathname);
    const form = await readForm(req, profilePath ? PROFILE_BODY_LIMIT : 16384);
    if (!auth.validCsrf(req, form.get('csrf') ?? '')) return new Response('CSRF rechazado.', { status: 403 });
    if (profilePath) {
      ({ destination, result } = profileAction(stateDir, profilePath[1] as 'guardar' | 'asignar', form));
      auth.rememberNotice(req, destination.split('?')[0]!, result);
      return new Response(null, { status: 303, headers: { Location: destination } });
    }
    const pathname = new URL(req.url).pathname;
    const name = Object.keys(ACTIONS).find(n => ACTIONS[n]!.path.test(pathname));
    if (!name) return new Response('Acción no encontrada.', { status: 404 });
    const action = ACTIONS[name]!;
    const raw = action.path.exec(pathname)![1]!;
    const id = name.endsWith('/create') ? '' : decodeURIComponent(raw);
    if ('check' in action) return await runnerCheck(id, extendCheckTimeout);
    if (id && !/^[\w-]+$/.test(id)) throw new InputError(400, 'Identificador inválido.');
    // Con claves repetidas gana la primera, como form.get.
    const fields: Raw = {};
    for (const [k, v] of form) if (!(k in fields)) fields[k] = v;
    ({ destination, result } = await performAction(stateDir, name, id, fields, 'web'));
    if (action.httpErrors && result !== 'ok') {
      const status = result === 'conflict' ? 409 : result === 'not_found' ? 404 : result === 'invalid_input' ? 400 : 500;
      return new Response(messages[result], { status });
    }
  } catch (error) {
    if (error instanceof InputError) return new Response(error.message, { status: error.status, headers: error.status === 413 ? { Connection: 'close' } : {} });
    if (error instanceof ProfileInputError) return new Response(error.message, { status: 400 });
    if (error instanceof URIError) return new Response('Identificador inválido.', { status: 400 });
    result = 'error';
  }
  auth.rememberNotice(req, destination.split('?')[0]!, result);
  return new Response(null, { status: 303, headers: { Location: destination } });
}
