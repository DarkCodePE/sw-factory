// Señales desde la web: crear y triar son dos pasos del dueño, como `fab signal add` y `fab triage`.
import type { Store } from './store.ts';

export const SIGNAL_TITLE_MAX = 200;
export const SIGNAL_BODY_MAX = 8192;

export function signalsView(store: Store, escape: (v: unknown) => string, csrf?: string): { title: string; body: string } {
  const workstreams = store.listWorkstreams();
  const hidden = csrf ? `<input type="hidden" name="csrf" value="${csrf}">` : '';
  const form = (path: string, body: string) => `<form action="${path}" method="post" class="web-action">${hidden}${body}</form>`;
  const create = !csrf ? '' : workstreams.length ? form('/signals', `<fieldset><legend>Nueva señal</legend><label for="signal-ws">Workstream</label><select id="signal-ws" name="workstream">${workstreams.map(w => `<option value="${escape(w.slug)}">${escape(w.slug)}</option>`).join('')}</select><label for="signal-title">Título (máximo ${SIGNAL_TITLE_MAX} caracteres)</label><input id="signal-title" name="title" maxlength="${SIGNAL_TITLE_MAX}" required><label for="signal-body">Descripción (máximo 8 KiB)</label><textarea id="signal-body" name="body" rows="4" maxlength="${SIGNAL_BODY_MAX}"></textarea><button>Crear señal</button><p class="muted">Crear una señal no lanza ningún turno: hasta que la tríes no pasa nada.</p></fieldset>`) : '<p class="empty">No hay workstreams. Crea uno desde fab ws create.</p>';
  const signals = workstreams.flatMap(w => store.listSignals(w.id, 'new').map(s => ({ s, slug: w.slug })));
  const rows = signals.map(({ s, slug }) => `<li><h2>${escape(s.title)}</h2><p class="muted">${escape(slug)} · ${escape(s.createdAt)}</p><pre tabindex="0">${escape(s.body)}</pre>${csrf ? `<div class="action-buttons">${form(`/signals/${s.id}/triage`, '<button>Triar</button>')}${form(`/signals/${s.id}/ignore`, '<button>Ignorar</button>')}</div>` : ''}</li>`).join('');
  return { title: 'Señales', body: `<p class="intro">Entradas nuevas a la espera de triaje. Triar crea el change.</p>${csrf ? '' : '<p class="muted">Para crear o triar, abre fab web --write con el enlace de la terminal.</p>'}${create}<h2>Señales nuevas</h2>${rows ? `<ul class="workstreams">${rows}</ul>` : '<p class="empty">No hay señales nuevas.</p>'}` };
}
