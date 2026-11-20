// La web configura horarios y plantillas. Ejecutar solo crea una señal (D-D).
import { automationRevision, type Automation, type Store } from './store.ts';

const RESULTS: Record<string, string> = { created: 'Señal creada', skipped_open: 'Saltada: hay una señal o change abierto', skipped_inactive: 'Saltada: workstream no activo' };

export function automationsView(store: Store, escape: (v: unknown) => string, csrf?: string, ws?: string): { title: string; body: string } {
  const slugs = new Map(store.listWorkstreams().map(w => [w.id, w.slug]));
  const hidden = csrf ? `<input type="hidden" name="csrf" value="${csrf}">` : '';
  const form = (id: string, action: string, label: string) => `<form action="/automations/${id}/${action}" method="post" class="web-action">${hidden}<button>${label}</button></form>`;
  const create = `/automations/nueva${ws ? '?ws=' + encodeURIComponent(ws) : ''}`;
  const rows = store.listAutomations(ws).map(a => `<tr><td>${escape(a.name)}<br><small>${escape(a.title)}</small></td><td>${escape(slugs.get(a.workstreamId) ?? '')}</td><td><code>${escape(a.cron)}</code> UTC</td><td>${a.enabled ? 'Activa' : 'Pausada'}</td><td>${a.lastResult ? escape(RESULTS[a.lastResult] ?? a.lastResult) : 'Sin ejecutar'}${a.lastDueAt ? `<br><small>${escape(a.lastDueAt)}</small>` : ''}${a.lastSignalId ? `<br><small>señal ${escape(a.lastSignalId.slice(0, 8))}</small>` : ''}</td>${csrf ? `<td class="action-buttons"><a href="${automationEditorPath(a.id)}">Editar</a>${form(encodeURIComponent(a.id), 'run', 'Ejecutar ahora')}${form(encodeURIComponent(a.id), a.enabled ? 'disable' : 'enable', a.enabled ? 'Pausar' : 'Activar')}</td>` : ''}</tr>`).join('');
  return { title: 'Automations', body: `<p class="intro">Horarios que crean una señal con un texto fijo.</p>${csrf ? `<p><a href="${create}">Nueva automation</a></p><p class="muted">Ejecutar ahora crea una señal. No lanza trabajo: la señal espera tu triage.</p>` : '<p class="muted">Para ejecutar, activar o pausar, abre fab web --write con el enlace de la terminal.</p>'}${rows ? `<div class="table-wrap"><table><thead><tr><th>Nombre</th><th>Workstream</th><th>Horario</th><th>Estado</th><th>Último resultado</th>${csrf ? '<th>Acciones</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">No hay automations.</p>'}` };
}

const html = (value: string): string => value.replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]!);

const schedules = [
  ['hour', 'Cada hora'], ['day', 'Diario'], ['week', 'Semanal'], ['cron', 'Cron'],
] as const;
const weekdays = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

export const AUTOMATION_EDITOR_STYLE = `
#automation-cron,#automation-title{min-height:44px}
.automation-error{grid-column:1/-1}
`;

export const AUTOMATION_EDITOR_JS = `
const schedule = document.getElementById('automation-schedule');
if (schedule) {
  const sync = () => {
    for (const field of schedule.form.querySelectorAll('[data-schedule]')) {
      const active = field.dataset.schedule.split(' ').includes(schedule.value);
      field.hidden = !active;
      for (const control of field.querySelectorAll('input, select, textarea')) {
        control.disabled = !active;
        control.required = active;
      }
    }
    document.getElementById('automation-at-hint').textContent =
      schedule.value === 'hour' ? 'Minuto de cada hora, por ejemplo :30.' : 'Hora UTC, por ejemplo 07:30.';
  };
  schedule.addEventListener('change', sync);
  sync();
}
`;

type EditorOptions = {
  automation?: Automation;
  values?: Record<string, string | undefined>;
  error?: string;
};

export function automationEditor(store: Store, csrf: string, { automation, values, error }: EditorOptions = {}): { title: string; body: string } {
  const editing = !!automation;
  const url = automation && `/automations/${encodeURIComponent(automation.id)}`;
  const title = editing ? 'Editar automation' : 'Nueva automation';
  const fields = {
    schedule: automation ? 'cron' : 'day',
    name: automation?.name, cron: automation?.cron, title: automation?.title, body: automation?.body,
    at: '', weekday: '',
    ...values,
  };
  const value = (key: keyof typeof fields) => html(fields[key] ?? '');
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${html(value)}">`;
  const token = hidden('csrf', csrf);
  const revision = automation ? automationRevision(automation) : '';
  const select = (key: string, options: readonly (readonly [string, string])[], selected: string | undefined) =>
    `<select id="automation-${key}" name="${key}"${key === 'ws' ? ' required' : ''}>${options.map(([id, label]) =>
      `<option value="${html(id)}"${id === selected ? ' selected' : ''}>${html(label)}</option>`).join('')}</select>`;
  const workstreams = automation ? [] : store.listWorkstreams();
  const selected = workstreams.find(w => w.id === values?.ws || w.slug === values?.ws)?.id;
  const workstream = automation
    ? `<p>Workstream <strong>${html(store.getWorkstream(automation.workstreamId).slug)}</strong></p>`
    : `<label for="automation-ws">Workstream</label>${select('ws', [['', 'Elige un workstream'], ...workstreams.map(w => [w.id, w.slug] as const)], selected)}`;
  const confirm = (name: string, effect: string) =>
    `<label><input type="checkbox" name="confirm" value="yes" required> Confirmo ${effect} de <strong>${html(name)}</strong>.</label>`;
  // La primera línea en textarea se reserva para la normalización del parser HTML.
  const area = (key: 'title' | 'body' | 'cron', rows: number, required = true) =>
    `<textarea id="automation-${key}" name="${key}" rows="${rows}"${required ? ' required' : ''}>\n${value(key)}</textarea>`;
  const deleteForm = automation && !error
    ? `<form action="${url}/delete" method="post" class="web-action">${token}${hidden('revision', revision)}
        <fieldset><legend>Borrar automation</legend><p>Se cancelan los próximos vencimientos. Las señales históricas se conservan.</p>
        ${confirm(automation.name, 'el borrado')}<button>Borrar automation</button></fieldset></form>` : '';
  return {
    title,
    body: `<p><a href="/automations">Volver a automations</a></p>
      ${error ? `<p class="notice" role="alert">${html(error)}</p>${automation ? `<p><a href="${automationEditorPath(automation.id)}">Recargar formulario</a></p>` : ''}` : ''}
      <form action="${url ? url + '/update' : '/automations/create'}" method="post" class="web-action">
        ${token}${automation ? hidden('revision', values ? values.revision ?? '' : revision) : ''}
        <fieldset><legend>Configuración</legend>
          ${workstream}
          <label for="automation-name">Nombre</label>
          <input id="automation-name" type="text" name="name" value="${value('name')}" maxlength="41" required>
          <label for="automation-schedule">Frecuencia (UTC)</label>
          ${select('schedule', schedules, fields.schedule)}
          <div data-schedule="hour day week">
            <label for="automation-at">Hora o minuto</label>
            <input id="automation-at" type="text" name="at" value="${value('at')}" aria-describedby="automation-at-hint">
            <p class="muted" id="automation-at-hint">Usa :MM para cada hora o HH:MM para diario y semanal.</p>
          </div>
          <div data-schedule="week">
            <label for="automation-weekday">Día de la semana</label>
            ${select('weekday', [['', 'Elige un día'], ...weekdays.map((day, i) => [String(i), day] as const)], fields.weekday)}
          </div>
          <div data-schedule="cron">
            <label for="automation-cron">Expresión cron</label>
            ${area('cron', 1, false)}
          </div>
          <label for="automation-title">Título de la señal</label>
          ${area('title', 1)}
          <label for="automation-body">Cuerpo de la señal (máximo 8 KiB)</label>
          ${area('body', 5)}
          ${automation ? `<p>Si cambias el horario, se aplica a los próximos vencimientos.</p>${confirm(automation.name, 'la edición')}` : ''}
          <button>${editing ? 'Guardar cambios' : 'Crear automation'}</button>
        </fieldset>
      </form>${deleteForm}`,
  };
}

export const automationEditorPath = (id: string) => `/automations/${encodeURIComponent(id)}/editar`;
export const AUTOMATION_EDIT_ROUTE = /^\/automations\/([\w-]+)\/editar$/;

export function automationErrorDocument(message: string, reload: string, editor?: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Revisar automation · fab</title><link rel="stylesheet" href="/style.css"><script src="/automation-editor.js" defer></script></head>
    <body><main class="automation-error"><h1>Revisar automation</h1>
    ${editor ?? `<p class="notice" role="alert">${html(message)}</p><p><a href="${html(reload)}">${reload === '/automations' ? 'Volver a automations' : 'Recargar formulario'}</a></p>`}
    </main></body></html>`;
}
