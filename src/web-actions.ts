// Adaptación HTTP: las transiciones, el cercado y los eventos siguen en los comandos existentes.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isRunnerName, Store, StoreError, WorkstreamBusyError } from './store.ts';
import { AGENT_NAMES } from './agents.ts';
import { AUTO_INSTRUCTIONS_MAX, isProfileDigest } from './profile.ts';
import { ANCESTOR_PATH_PREFIX, assertPrivateNoteDatabase, NOTE_ATTACHMENT_REMOTE, NOTE_ATTACHMENT_STATE, validateNoteAttachment, type NoteAttachment } from './note-attachments.ts';
import { linkTriagedSignal } from './admission/apply.ts';
import { removeWorktree } from './worktrees.ts';
import { SIGNAL_BODY_MAX, SIGNAL_TITLE_MAX } from './web-signals.ts';
import { REVIEWABLE_KINDS, type ReviewDecision } from './enums.ts';
import { redact } from './manifest.ts';
import { AdmissionDb, hasAdmission } from './admission/db.ts';
import { answerQuestion } from './admission/answers.ts';
import { resetSessionCap } from './admission/sessions.ts';
import { cancelBenchmark } from './bench.ts';
import { saveAutoImproveProfile } from './web-improve-auto.ts';
import { saveSuiteCandidate, suiteTaskForm } from './web-bench.ts';
import type { Split } from './improve.ts';
import { API_KEYS_PATH, API_KEY_CREATE_PATH, createApiKeyResponse, revokeApiKeyResponse, type ApiKeyUsage } from './web-api-keys.ts';
import { noteForm } from './web-note-form.ts';
import type { WebAuth } from './web-auth.ts';
import { PROFILE_BODY_LIMIT, ProfileInputError, checkProfileFields, profileAction } from './web-profile.ts';
import { enqueueBackfill, enqueueManual, ensureSchema, previewBackfill } from './scorers.ts';
import { archiveWorkstream, createWorkstream, workstreamSettings, workstreamState, wsFields } from './web-ws.ts';
import { result as inertPage, RUNNER_CHECK_PATH, type runnerCheckAction } from './web-runner-check.ts';

import { scheduleExpr } from './cron.ts';
import { automationEditor, automationEditorPath, automationErrorDocument } from './web-automations.ts';

// Cancelar vale para todo change que no haya terminado bien o por decisión: igual que `fab reject`, también limpia failed, blocked y quarantined.
const FINAL_STATUSES = ['completed', 'canceled', 'declined'];
const escape = (s: string) => redact(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const messages: Record<string, string> = {
  ok: 'Acción registrada.', conflict: 'conflict: el estado cambió o la acción ya se aplicó. Revisa el estado actual.',
  invalid_transition: 'invalid_transition: esta acción no corresponde al estado actual.',
  limit_reached: 'limit_reached: el change alcanzó el límite de notas (20) o de adjuntos pendientes (64 KiB) o históricos (1 MiB).',
  skipped_open: 'Saltada: ya hay una señal o un change abierto de esta automation; no se creó ninguna señal.',
  skipped_inactive: 'Saltada: el workstream no está activo; no se creó ninguna señal.',
  not_found: 'not_found: no se encontró el registro.', invalid_input: 'invalid_input: revisa los datos de la acción.',
  workstream_busy: 'El workstream tiene trabajo vivo. Reintenta cuando termine el turno o se resuelva la espera o reanudación.',
  error: 'No se pudo registrar la acción. Revisa el estado antes de volver a intentarlo.',
};
const runnerErrors: Record<string, string> = {
  conflict: 'La selección cambió (runner pausado, cambiado o workstream archivado): recarga Workstreams y vuelve a elegir.',
  invalid_input: 'Falta confirmar el envío al runner SSH.',
  not_found: 'No se encontró el runner o el workstream.',
};
// Textos fijos del Store (sin datos de la petición) que la página enseña tal cual para que el dueño sepa qué corregir.
const FIXED_NOTICES = new Set<string>([NOTE_ATTACHMENT_REMOTE, ...Object.values(NOTE_ATTACHMENT_STATE)]);
// El aviso de ancestro añade la ruta que falla (T96-H10): solo se acepta ASCII visible sin marcado, y se escapa al mostrarla.
const ANCESTOR_NOTICE = new RegExp(`^${NOTE_ATTACHMENT_STATE.ancestor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${ANCESTOR_PATH_PREFIX}[\\w@%+=:,./ -]{1,300}$`);
const isFixedNotice = (text: string) => FIXED_NOTICES.has(text) || ANCESTOR_NOTICE.test(text);
export function actionNotice(result?: string): string {
  const message = messages[result ?? ''] ?? (isFixedNotice(result ?? '') ? escape(result!) : undefined);
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
      body += noteForm(id, hidden, planned, store.noteRunnerIsRemote(c.workstreamId), store.noteAttachmentStateProblem(), escape);
    }
    if (!FINAL_STATUSES.includes(c.status)) body += form(`/changes/${id}/cancel`, `<fieldset><legend>Cancelar change</legend><label><input type="checkbox" name="confirm" value="yes" required> Confirmo: cancela el change y borra su worktree (igual que fab reject)</label><button>Cancelar change</button></fieldset>`);
    return `<section aria-label="Decisiones">${body}${suiteTaskForm(c, store.stateDir, url, escape, csrf)}</section>`;
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
type Action = { path: RegExp; automationForm?: 'create' | 'update' | 'delete'; /** false: solo la web con sesión; la API con clave no la expone (decisión del dueño sobre H1). */ api?: false; httpErrors?: true; input: (raw: Raw) => Raw; run: (store: Store, id: string, input: Raw, out: Outcome, actor: string, stateDir: string, attachment?: NoteAttachment) => void };

type CheckAction = { path: RegExp; automationForm?: undefined; api: false; check: true };
type WebResponseAction = { path: RegExp; automationForm?: undefined; api: false; respond: (stateDir: string, id: string, form: URLSearchParams, usage: ApiKeyUsage) => Response };

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
const ADAPTER_FIELDS = ['agent', 'previous', 'profileExpected', 'confirm'] as const;
const findSignal = (store: Store, id: string) => {
  const s = [...store.listWorkstreams()].flatMap(w => store.listSignals(w.id)).find(s => s.id === id);
  if (!s) throw new StoreError('not_found', 'señal inexistente');
  if (s.status !== 'new') throw new StoreError('conflict', 'señal ya resuelta');
  return s;
};

// URL-encoded: cada LF puede convertirse en %0D%0A. Deja margen para los demás campos.
const AUTOMATION_FORM_LIMIT = 56 * 1024;
const AUTOMATION_BODY_LIMIT = 8 * 1024;
// T91-H3: el tope de las instrucciones cuenta bytes y URL-encoded cada byte no ASCII ocupa hasta 3 («ñ» = %C3%B1 = 6 bytes por 2 bytes).
const AUTOMEJORA_FORM_LIMIT = 3 * AUTO_INSTRUCTIONS_MAX + 4096;
const AUTOMATION_CRON_LIMIT = 256;
const automationFields = ['name', 'schedule', 'cron', 'at', 'weekday', 'title', 'body'];
const automationConfirmation = ['confirm', 'revision'];
const lf = (value: string) => value.replace(/\r\n?/g, '\n');

function automationInput(mode: NonNullable<Action['automationForm']>, raw: Raw): Raw {
  const allowed = mode === 'create' ? ['ws', ...automationFields]
    : mode === 'update' ? [...automationFields, ...automationConfirmation] : automationConfirmation;
  if (Object.keys(raw).some(key => !allowed.includes(key))) throw new InputError(400, 'El formulario contiene campos inesperados.');
  if (mode !== 'create') {
    if (raw.confirm !== 'yes') throw new InputError(400, mode === 'update' ? 'Confirma la edición.' : 'Confirma el borrado.');
    if (!/^[a-f0-9]{64}$/.test(raw.revision ?? '')) throw new InputError(400, 'Falta la revisión. Recarga el formulario.');
  }
  if (mode === 'delete') return { revision: raw.revision };
  if (mode === 'create' && !/^[\w-]{1,100}$/.test(raw.ws ?? '')) throw new InputError(400, 'Elige un workstream.');
  const body = lf(raw.body ?? '');
  limit(body, AUTOMATION_BODY_LIMIT);
  if (!raw.name || !raw.title || !body || !raw.schedule) throw new InputError(400, 'Completa el nombre, el horario, el título y el cuerpo.');
  if (Buffer.byteLength(lf(raw.cron ?? '')) > AUTOMATION_CRON_LIMIT) throw new InputError(400, 'La expresión cron supera 256 bytes.');
  const at = raw.at || undefined, weekday = raw.weekday || undefined;
  let cron: string;
  if (raw.schedule === 'cron') {
    if (at || weekday) throw new InputError(400, 'Para el modo cron, completa solo la expresión cron.');
    cron = lf(raw.cron ?? '');
  } else {
    if (raw.cron) throw new InputError(400, 'Para un horario fijo, deja vacía la expresión cron.');
    try {
      cron = scheduleExpr({ every: raw.schedule, at, weekday });
    } catch {
      throw new InputError(400, 'Revisa el horario UTC. Usa :MM para cada hora, HH:MM para diario y HH:MM y día para semanal.');
    }
  }
  return { ws: raw.ws, name: raw.name, title: lf(raw.title), body, cron, revision: raw.revision, schedule: raw.schedule };
}

// Registro único de acciones: los formularios de la web y, después, la API pasan por aquí.
export const ACTIONS: Record<string, Action | CheckAction | WebResponseAction> = {
  'api-keys/create': { api: false, path: new RegExp(`^${API_KEY_CREATE_PATH}$`), respond: createApiKeyResponse },
  'api-keys/revoke': { api: false, path: route(API_KEYS_PATH.slice(1), 'revocar'), respond: revokeApiKeyResponse },
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
  'automejora/save': {
    api: false,
    path: route('automejora', 'save'),
    input: raw => raw,
    run: (store, id, input, out, _actor, stateDir) => {
      out.destination = `/automejora?ws=${encodeURIComponent(id)}`;
      try { out.destination += `&digest=${saveAutoImproveProfile(store, stateDir, id, input)}`; }
      catch (error) {
        if (error instanceof StoreError && error.code === 'invalid_input') throw new InputError(400, error.message);
        throw error;
      }
    },
  },
  'benchmarks/cancel': {
    api: false,
    path: route('benchmarks', 'cancel'),
    input: raw => {
      if (raw.confirm !== 'yes') throw new InputError(400, 'Confirma la cancelación.');
      return {};
    },
    run: (store, id, _input, out) => {
      out.destination = `/benchmarks/${encodeURIComponent(id)}`;
      cancelBenchmark(store.db, id);
    },
  },
  'changes/suite-task': {
    api: false,
    path: route('changes', 'suite-task'),
    input: pick('task', 'split', 'verify'),
    run: (store, id, input, out, _actor, stateDir) => {
      out.destination = `/changes/${encodeURIComponent(id)}`;
      out.destination = saveSuiteCandidate(store, stateDir, id, {
        id: input.task!, split: input.split as Split,
        verify: input.verify?.trim() || undefined,
      });
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
    // El adjunto solo entra por multipart en la web; la API y el formulario antiguo lo rechazan.
    input: raw => { if ('attachment' in raw) throw new InputError(400, 'Esta vía no admite adjuntos.'); return pick('body')(raw); },
    run: (store, id, input, out, _actor, _stateDir, attachment) => {
      store.getChange(id); out.destination = `/changes/${id}`;
      store.addChangeNote(id, input.body!, attachment);
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
  'automations/create': {
    api: false, automationForm: 'create', path: /^\/(automations)\/create$/,
    input: raw => automationInput('create', raw),
    run: (store, _id, input, out) => {
      out.destination = '/automations';
      const { ws, name, cron, title, body } = input;
      try { store.createAutomation({ workstream: ws!, name: name!, cron: cron!, title: title!, body: body! }); }
      catch (error) {
        if (error instanceof StoreError && error.code === 'not_found') throw new InputError(400, 'Elige un workstream existente.');
        throw error;
      }
    },
  },
  'automations/update': {
    api: false, automationForm: 'update', path: route('automations', 'update'),
    input: raw => automationInput('update', raw),
    run: (store, id, input, out) => {
      out.destination = '/automations';
      const before = store.getAutomation(id);
      // HTML normaliza los saltos de línea. Si el texto visible coincide, conserva el original.
      const restore = (field: 'title' | 'body' | 'cron') => input[field] === lf(before[field]) ? before[field] : input[field]!;
      store.updateAutomation(id, input.revision!, {
        name: input.name!, title: restore('title'), body: restore('body'),
        cron: input.schedule === 'cron' ? restore('cron') : input.cron!,
      });
    },
  },
  'automations/delete': {
    api: false, automationForm: 'delete', path: route('automations', 'delete'),
    input: raw => automationInput('delete', raw),
    run: (store, id, input, out) => {
      out.destination = '/automations';
      store.deleteAutomation(id, input.revision!);
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
  'workstreams/adaptador': {
    path: route('workstreams', 'adaptador'),
    api: false,
    input: raw => {
      const input = pick(...ADAPTER_FIELDS)(raw);
      if (!AGENT_NAMES.includes(input.agent!) || !input.previous || !isProfileDigest(input.profileExpected!) || input.confirm !== 'yes') {
        throw new InputError(400, 'Revisa y confirma el cambio de adaptador del workstream.');
      }
      return input;
    },
    run: (store, id, input, out) => {
      out.destination = '/perfiles';
      const ws = store.getWorkstream(id);
      out.destination = `/perfiles?ws=${encodeURIComponent(ws.slug)}`;
      store.setWorkstreamAgent(ws.id, input.agent!, input.previous!, input.profileExpected!);
    },
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
    input: raw => {
      const { runner, expected, confirm, confirm_ssh } = raw;
      // «tipo alta»: lo que mostró el formulario de ese runner; `created_at` es ISO y no lleva espacios.
      const seen = runner ? raw[`seen.${runner}`] ?? '' : '';
      if (runner === undefined || (runner !== '' && !isRunnerName(runner)) || expected === undefined || confirm !== 'yes'
        || (runner !== '' && !/^(ssh|local) \S+$/.test(seen))) {
        throw new InputError(400, 'Elige un runner y confirma la selección.');
      }
      return { runner, expected, confirm_ssh, seen };
    },
    run: (store, id, { runner, expected, confirm_ssh, seen }, out) => {
      out.destination = '/workstreams';
      const [kind, createdAt] = seen!.split(' ');
      store.setWorkstreamRunner(id, runner || null, { expected: expected || null, confirmSsh: confirm_ssh === 'yes',
        seen: runner ? { kind: kind as 'ssh' | 'local', createdAt: createdAt! } : undefined });
    },
  },
  'runners/check': { path: RUNNER_CHECK_PATH, api: false, check: true },
};

/** Abre el Store escritor, fija el actor y ejecuta una acción. Lanza InputError si la entrada no vale; el resto de fallos van en `result`. */
export async function performAction(stateDir: string, name: string, id: string, rawInput: Raw, actor: string, attachment?: NoteAttachment): Promise<Outcome> {
  const action = ACTIONS[name];
  if (!action || !('run' in action)) throw new InputError(404, 'Acción no encontrada.');
  const input = action.input(rawInput);
  const out: Outcome = { destination: '/', result: 'ok' };
  if (attachment) {
    // T96-H4: un estado no apto se rechaza antes de abrir el escritor (que ya tocaría la base y su WAL).
    try { assertPrivateNoteDatabase(join(stateDir, 'fabrica.db')); }
    catch (error) { out.destination = `/changes/${id}`; out.result = (error as Error).message; return out; }
  }
  let store: Store | undefined;
  try {
    store = new Store(join(stateDir, 'fabrica.db'));
    const writer = store;
    // FAB_ACTOR es el patrón del Store. El tramo es síncrono: ningún await expone el actor a otra petición.
    const previous = process.env.FAB_ACTOR; process.env.FAB_ACTOR = actor;
    try { writer.withRetry(() => action.run(writer, id, input, out, actor, stateDir, attachment)); }
    finally { if (previous === undefined) delete process.env.FAB_ACTOR; else process.env.FAB_ACTOR = previous; }
    if (out.repo) { await writer.waitForRelease(id); await removeWorktree(out.repo, stateDir, id); }
  } catch (error) {
    if (error instanceof InputError) throw error;
    if (action.automationForm) {
      if (error instanceof StoreError) {
        if (error.code === 'not_found') throw new InputError(404, 'Automation no encontrada.');
        if (error.code === 'conflict' || error.code === 'limit_reached') throw new InputError(409, error.message);
        if (error.code === 'invalid_input') {
          const message = redact(error.message).replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 320);
          throw new InputError(400, message);
        }
      }
      throw new InputError(500, 'No se pudo registrar la acción.');
    }
    out.result = error instanceof StoreError && error.code === 'invalid_input' && isFixedNotice(error.message) ? error.message
      : error instanceof WorkstreamBusyError ? 'workstream_busy'
      : error instanceof StoreError && messages[error.code] ? error.code : 'error';
  } finally { store?.close(); }
  return out;
}

/** Lee el cuerpo contando bytes del stream: nunca materializa más de `limit`. */
async function readBody(req: Request, limit: number): Promise<Buffer> {
  const tooBig = () => new InputError(413, 'El cuerpo es demasiado grande.');
  if (Number(req.headers.get('content-length')) > limit) throw tooBig();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for await (const chunk of req.body ?? []) {
      total += chunk.byteLength;
      // Pasado el tope se descarta sin guardar; Bun acota el resto (maxRequestBodySize) y la conexión queda limpia.
      if (total <= limit) chunks.push(chunk);
    }
    if (total > limit) throw tooBig();
  } catch (error) {
    if (error instanceof InputError) throw error;
    if (error instanceof Error && error.name === 'RequestBodyTooLarge') throw tooBig();
    throw error;
  }
  return Buffer.concat(chunks);
}

/** ¿La parte `attachment` trae un filename no vacío en su cabecera? Las cabeceras acaban en la primera línea en blanco de cada parte. */
function attachmentPartNamed(body: Buffer, contentType: string): boolean {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!boundary) return false;
  return body.toString('latin1').split(`--${boundary[1] ?? boundary[2]}`).some(part => {
    const header = part.split('\r\n\r\n', 1)[0]!;
    return /^\r\ncontent-disposition:[^\r\n]*name="attachment"/i.test(header) && /filename="[^"]/i.test(header);
  });
}

const NOTE_REQUEST_LIMIT = 80 * 1024;
type RawFile = { name: string; bytes: Uint8Array };

async function readForm(req: Request, limit = 16384, multipart = false): Promise<{ form: URLSearchParams; file?: RawFile }> {
  const type = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type === 'multipart/form-data' && multipart) {
    const bytes = await readBody(req, NOTE_REQUEST_LIMIT);
    let data: FormData;
    try { data = await new Response(new Uint8Array(bytes), { headers: { 'content-type': req.headers.get('content-type')! } }).formData(); }
    catch { throw new InputError(400, 'Formulario multipart inválido.'); }
    const form = new URLSearchParams(); let file: RawFile | undefined; const seen = new Set<string>();
    for (const [key, value] of data.entries() as IterableIterator<[string, string | File]>) {
      // Una parte desconocida o repetida invalida todo el envío.
      if (seen.has(key) || !['csrf', 'body', 'attachment'].includes(key)) throw new InputError(400, 'Formulario multipart inválido.');
      seen.add(key);
      if (key === 'attachment') {
        if (typeof value === 'string') throw new InputError(400, 'El adjunto debe ser un archivo.');
        // El navegador manda una parte vacía sin nombre si no se eligió archivo. Bun pierde el nombre de un archivo vacío:
        // se mira la cabecera de la parte attachment (nunca el texto de otras partes).
        if (!value.name && value.size === 0) {
          if (attachmentPartNamed(bytes, req.headers.get('content-type')!)) throw new InputError(400, 'El adjunto debe ocupar entre 1 y 65 536 bytes.');
          continue;
        }
        file = { name: value.name ?? '', bytes: new Uint8Array(await value.arrayBuffer()) };
      } else if (typeof value !== 'string') throw new InputError(400, 'Formulario multipart inválido.');
      else form.set(key, value);
    }
    return { form, file };
  }
  if (type !== 'application/x-www-form-urlencoded') throw new InputError(415, multipart ? 'Solo se admite application/x-www-form-urlencoded o multipart/form-data.' : 'Solo se admite application/x-www-form-urlencoded.');
  return { form: new URLSearchParams((await readBody(req, limit)).toString('utf8')) };
}

function automationFailure(stateDir: string, mode: NonNullable<Action['automationForm']>, id: string, csrf: string, fields: Raw, error: InputError): Response {
  const reload = mode === 'create' ? '/automations/nueva' : automationEditorPath(id);
  let body: string | undefined;
  if (error.status === 400 && mode !== 'delete') {
    const reader = new Store(join(stateDir, 'fabrica.db'), { readonly: true });
    try {
      const automation = mode === 'update' ? reader.getAutomation(id) : undefined;
      body = automationEditor(reader, csrf, { automation, values: fields, error: error.message }).body;
    } catch (cause) {
      if (!(cause instanceof StoreError && cause.code === 'not_found')) throw cause;
      error = new InputError(404, 'Automation no encontrada.');
    } finally { reader.close(); }
  }
  return new Response(automationErrorDocument(error.message, error.status === 404 ? '/automations' : reload, body), {
    status: error.status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'same-origin' },
  });
}

export async function webAction(req: Request, stateDir: string, port: number, auth: WebAuth, usage: ApiKeyUsage,
  runnerCheck: ReturnType<typeof runnerCheckAction>, extendCheckTimeout: () => void): Promise<Response> {
  const csrf = auth.sessionCsrf(req);
  if (!csrf) return new Response('Se necesita una sesión local.', { status: 401 });
  if (req.headers.get('origin') !== `http://${auth.host}:${port}`) return new Response('Origin rechazado.', { status: 403 });
  let destination = '/'; let result = 'ok'; let id = '';
  const pathname = new URL(req.url).pathname;
  const profilePath = /^\/perfiles\/(guardar|asignar)$/.exec(pathname);
  const name = Object.keys(ACTIONS).find(n => ACTIONS[n]!.path.test(pathname));
  const action = name ? ACTIONS[name] : undefined;
  const fields: Raw = Object.create(null);
  try {
    const { form, file } = await readForm(req, profilePath ? PROFILE_BODY_LIMIT : action?.automationForm ? AUTOMATION_FORM_LIMIT : name === 'automejora/save' ? AUTOMEJORA_FORM_LIMIT : 16384, name === 'changes/note');
    if (!auth.validCsrf(req, form.get('csrf') ?? '')) return new Response('CSRF rechazado.', { status: 403 });
    const invalid = file && validateNoteAttachment(file);
    if (invalid) throw new InputError(400, invalid);
    if (profilePath) {
      ({ destination, result } = profileAction(stateDir, profilePath[1] as 'guardar' | 'asignar', form));
      auth.rememberNotice(req, destination.split('?')[0]!, result);
      return new Response(null, { status: 303, headers: { Location: destination } });
    }
    if (!name || !action) return new Response('Acción no encontrada.', { status: 404 });
    const raw = action.path.exec(pathname)![1] ?? '';
    if ('respond' in action) {
      const response = action.respond(stateDir, raw, form, usage);
      const location = response.headers.get('location');
      if (response.status === 303 && location) auth.rememberNotice(req, location, 'ok');
      return response;
    }
    id = name.endsWith('/create') ? '' : decodeURIComponent(raw);
    if ('check' in action) return await runnerCheck(id, extendCheckTimeout);
    if (id && !/^[\w-]+$/.test(id)) return new Response('Identificador inválido.', { status: 400 });
    if (name === 'workstreams/adaptador') checkProfileFields(form, ['csrf', ...ADAPTER_FIELDS]);
    let repeated = false;
    // Las acciones anteriores conservan el primer valor. En los editores importa cada campo.
    for (const [k, v] of form) {
      if (k in fields) repeated = true;
      else fields[k] = v;
    }
    if (action.automationForm) {
      delete fields.csrf;
      if (repeated) throw new InputError(400, 'El formulario contiene campos repetidos.');
    }
    ({ destination, result } = await performAction(stateDir, name, id, fields, 'web', file));
    if (action.httpErrors && result !== 'ok') {
      const status = result === 'conflict' ? 409 : result === 'not_found' ? 404 : result === 'invalid_input' ? 400 : 500;
      return inertPage(runnerErrors[result] ?? 'No se pudo guardar el runner', status, '', { href: '/workstreams', text: 'Volver a workstreams' });
    }
  } catch (error) {
    if (error instanceof InputError) {
      if (action?.automationForm && (id || action.automationForm === 'create') && [400, 404, 409].includes(error.status))
        return automationFailure(stateDir, action.automationForm, id, csrf, fields, error);
      return new Response(error.message, { status: error.status, headers: error.status === 413 ? { Connection: 'close' } : {} });
    }
    if (error instanceof ProfileInputError) return new Response(error.message, { status: 400 });
    if (error instanceof URIError) return new Response('Identificador inválido.', { status: 400 });
    result = 'error';
  }
  auth.rememberNotice(req, destination.split('?')[0]!, result);
  return new Response(null, { status: 303, headers: { Location: destination } });
}
