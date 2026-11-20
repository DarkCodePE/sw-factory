// Sección «Turnos» del detalle de un change y ruta del log por turno (T54c). Solo lectura: usa la conexión `readonly`
// del Store y nunca construye `AdmissionDb`. Todo texto de agentes o terceros pasa por `ui.escape`.
import type { Database } from 'bun:sqlite';
import { evidencePath, readEvidence } from './evidence.ts';
import { changeTimeline, type Segment, type TurnView } from './admission/timeline.ts';
import type { Ui } from './web-changes.ts';
import type { ChangeNote } from './store.ts';

const PLAN: Record<string, string> = { fresh: 'Primer turno', answer: 'Respuesta a una pregunta', retry: 'Reintento con motivo', orphan: 'Continuación tras una caída', reconstructed: 'Sesión reconstruida' };
const SEGMENT: Record<Segment['kind'], string> = { trabajo: 'Trabajo', espera_persona: 'Espera de una persona', cola: 'En cola', bloqueo: 'Bloqueo', interrumpido: 'Interrumpido' };
const OUTCOME: Record<string, string> = { done: 'Hecho', blocked: 'Bloqueado', awaiting: 'Espera respuesta', no_report: 'Sin report', error: 'Error', session_lost: 'Sesión perdida' };
const NOT_MEASURED = 'No medido';

const finite = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const span = (ms: number) => ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60000)} min`;

export function turnsSection(db: Database, changeId: string, ui: Ui): string {
  const t = changeTimeline(db, changeId), e = ui.escape;
  const head = '<h2>Turnos</h2>';
  if (t.state === 'sin_tablas') return `${head}<p class="empty">Sin turnos vivos</p>`;
  if (t.state === 'sin_turnos') {
    // «Anteriores a esta versión» solo vale sin la tabla adm_turns; con la tabla vacía el primer turno aún no se registró (T54c-H5).
    const hasTurns = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'adm_turns'").get();
    return `${head}<p class="empty">${!t.sessions.length ? 'Sin turnos vivos' : hasTurns ? 'Aún no hay turnos registrados en esta sesión' : 'Los turnos anteriores a esta versión no se midieron'}</p>`;
  }
  const lost = new Map(t.sessions.map(s => [s.generation, s.lostReason]));
  const rows = t.turns.map((u: TurnView, i) => {
    const prev = t.turns[i - 1], next = t.turns[i + 1];
    const warn = prev && u.generation !== prev.generation ? `<li class="turn-warn">Sesión perdida: ${e(lost.get(prev.generation) ?? NOT_MEASURED)}. Generación ${e(u.generation)}.</li>` : '';
    const between = t.segments.filter(s => s.kind !== 'trabajo' && s.from >= u.startedAt && (!next || s.from < next.startedAt)).map(s => {
      const ms = s.to ? Date.parse(s.to) - Date.parse(s.from) : null;
      const dur = !s.to ? 'en curso' : finite(ms) ? span(ms) : NOT_MEASURED;
      return `<li class="turn-segment"><time>${e(s.from)}</time> ${e(SEGMENT[s.kind])} · ${e(dur)}</li>`;
    }).join('');
    const q = u.question;
    const detail = [
      u.report ? `<p><strong>Report</strong> (${e(u.report.state)}): ${e(u.report.summary)}</p>` : '',
      q ? `<p><strong>Pregunta</strong> (${e(q.status)}): ${e(q.text)}</p><p><strong>Respuesta</strong>: ${q.answer == null ? e('Sin respuesta') : `${e(q.answer)} · ${e(q.answeredBy ?? NOT_MEASURED)}`}</p>` : '',
      u.notes.length ? `<p><strong>Notas entregadas</strong></p><ul>${u.notes.map(n => `<li>${e(n.body)} · ${e(n.actor)}</li>`).join('')}</ul>` : '',
      u.log ? `<p><a href="/changes/${encodeURIComponent(changeId)}/turns/${encodeURIComponent(u.attemptId)}/log">Log del turno</a></p>` : `<p class="muted">Log: ${NOT_MEASURED}</p>`,
    ].join('');
    return `${warn}<li class="turn"><details><summary>#${t.omitted + i + 1} · ${e(u.kind)} · gen. ${e(u.generation)} · ${e(PLAN[u.plan] ?? u.plan)} · ${e(u.outcome ? OUTCOME[u.outcome] ?? u.outcome : 'En curso')} · ${e(finite(u.durationMs) ? span(u.durationMs) : NOT_MEASURED)} · ${e(finite(u.costUsd) ? `${u.costUsd.toFixed(2)} USD` : NOT_MEASURED)}</summary>${detail}</details></li>${between}`;
  });
  return `${head}${t.omitted ? `<p class="notice">Se omiten ${t.omitted} turnos anteriores.</p>` : ''}<ol class="turns">${rows.join('')}</ol>`;
}

/** `GET /changes/<id>/turns/<attemptId>/log`. `null` si la ruta no es esta; lanza URIError si un id no es `[\w-]+`. */
export function turnLogRoute(db: Database, stateDir: string, pathname: string): { status: number; body: string } | null {
  const m = /^\/changes\/([^/]+)\/turns\/([^/]+)\/log$/.exec(pathname);
  if (!m) return null;
  const [changeId, attemptId] = [decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)];
  if (!/^[\w-]+$/.test(changeId) || !/^[\w-]+$/.test(attemptId)) throw new URIError('Identificador inválido');
  const none = { status: 404, body: 'Log no disponible' };
  const hasTable = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'adm_turns'").get();
  const row = !hasTable ? null : (db.query('SELECT activity_id, log FROM adm_turns WHERE attempt_id = ? AND change_id = ?').get(attemptId, changeId) as { activity_id: string; log: string | null } | null);
  if (!row || !row.log) return none;
  try {
    const value = readEvidence(stateDir, evidencePath(changeId, `${row.activity_id}.t-${attemptId}.log`));
    return value ? { status: 200, body: value.truncated ? `${value.text}\n[log recortado a 256 KiB]` : value.text } : none;
  } catch { return none; }
}

/** Lista de notas del dueño: el cuerpo se escapa y la entrega se lee de `delivered_at`. */
export function notesSection(notes: ChangeNote[], changeStatus: string, ui: Ui): string {
  const e = ui.escape, head = '<h2>Notas</h2>';
  if (!notes.length) return `${head}<p class="empty">Sin notas</p>`;
  const stuck = changeStatus === 'implemented' && notes.some(n => !n.deliveredAt) ? '<p class="notice">Este change espera merge: puede que no haya más turnos de trabajo y la nota no llegue a entregarse.</p>' : '';
  const attachmentPending = notes.some(n => n.attachment && !n.deliveredAt)
    ? '<p class="muted">Las notas con archivo esperan un turno local confinado con entrada apta.</p>' : '';
  return `${head}${stuck}${attachmentPending}<ul class="notes">${notes.map(n => `<li><p>${e(n.body)}</p>${n.attachment ? `<small>Adjunto: ${e(n.attachment.name)} · ${e(n.attachment.size)} bytes</small>` : ''}<small>${e(n.actor)} · <time>${e(n.createdAt)}</time> · ${n.deliveredAt ? `Entregada <time>${e(n.deliveredAt)}</time>` : 'Pendiente de entrega'}</small></li>`).join('')}</ul>`;
}
