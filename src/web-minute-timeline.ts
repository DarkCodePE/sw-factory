import type { TurnView } from './admission/timeline.ts';
import type { Activity } from './store.ts';
import type { Ui } from './web-changes.ts';

type Mark = { at: number; activityId: string | null; text: string };
const MINUTE_MS = 60_000;
// La tabla es densa. Conserva su presupuesto aunque se amplíen las consultas de eventos o turnos.
const ENTRIES_PER_SOURCE = 200;

// Las fechas de Store son ISO UTC. Rechaza fechas ambiguas y desbordes que Date.parse normaliza.
function utcTime(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 19) === value.slice(0, 19) ? millis : NaN;
}

export function minuteTimeline(activities: Activity[], events: Record<string, unknown>[], turns: TurnView[], ui: Ui): string {
  const marks: Mark[] = [];
  let unmeasured = 0;
  const add = (activityId: string | null, date: unknown, text: string) => {
    const at = utcTime(date);
    if (Number.isFinite(at)) marks.push({ activityId, at, text });
    else unmeasured++;
  };
  for (const event of events.slice(-ENTRIES_PER_SOURCE)) {
    const activityId = typeof event.activity_id === 'string' && event.activity_id ? event.activity_id : null;
    add(activityId, event.created_at, typeof event.message === 'string' ? event.message : 'Evento');
  }
  for (const turn of turns.slice(-ENTRIES_PER_SOURCE)) {
    add(turn.activityId, turn.startedAt, 'Inicio de turno');
    if (turn.endedAt !== null) add(turn.activityId, turn.endedAt, 'Fin de turno');
  }

  const omitted = Math.max(0, events.length - ENTRIES_PER_SOURCE) + Math.max(0, turns.length - ENTRIES_PER_SOURCE);
  const head = `<section aria-labelledby="timeline-minutos"><h2 id="timeline-minutos">Timeline por minuto</h2>${omitted ? `<p class="notice">Se omiten ${omitted} registros anteriores en esta tabla.</p>` : ''}`;
  if (!marks.length) return `${head}<p class="empty">No medido</p></section>`;

  const lanes = new Set(marks.map(mark => mark.activityId));
  const activityIds = [...lanes].filter(id => id !== null).sort();
  const columns = lanes.has(null) ? [null, ...activityIds] : activityIds;
  const byId = new Map(activities.map(activity => [activity.id, activity]));
  const headings = columns.map(id => {
    if (id === null) return '<th scope="col">Change</th>';
    const activity = byId.get(id);
    const label = ui.escape(`${activity?.validator ?? activity?.kind ?? 'Activity'} · ${id.slice(0, 8)}`);
    return `<th scope="col">${activity ? `<a href="/activities/${encodeURIComponent(activity.id)}">${label}</a>` : label}</th>`;
  }).join('');

  const minutes = new Map<number, Map<string | null, Mark[]>>();
  for (const mark of marks.sort((a, b) => a.at - b.at)) {
    const minute = Math.floor(mark.at / MINUTE_MS) * MINUTE_MS;
    let cells = minutes.get(minute);
    if (!cells) minutes.set(minute, cells = new Map());
    const cell = cells.get(mark.activityId);
    if (cell) cell.push(mark);
    else cells.set(mark.activityId, [mark]);
  }
  const rows = [...minutes].map(([minute, cells]) => {
    const timestamp = new Date(minute).toISOString();
    const label = timestamp.slice(0, 16).replace('T', ' ');
    const data = columns.map(id => {
      const items = cells.get(id);
      return items ? `<td><ul>${items.map(mark => `<li>${ui.escape(mark.text)}</li>`).join('')}</ul></td>` : '<td></td>';
    }).join('');
    return `<tr><th scope="row"><time datetime="${timestamp}">${label}</time></th>${data}</tr>`;
  }).join('');
  return `${head}${unmeasured ? '<p class="muted">Hora en algunos registros · No medido</p>' : ''}
    <div class="table-wrap minute-timeline" tabindex="0" role="region" aria-labelledby="timeline-minutos">
      <table><thead><tr><th scope="col">Minuto (UTC)</th>${headings}</tr></thead><tbody>${rows}</tbody></table>
    </div></section>`;
}
