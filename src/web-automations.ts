// Automations en la web: lista y tres acciones. Alta y edición van por CLI (A5); ejecutar solo crea una señal (D-D).
import type { Store } from './store.ts';

const RESULTS: Record<string, string> = { created: 'Señal creada', skipped_open: 'Saltada: hay una señal o change abierto', skipped_inactive: 'Saltada: workstream no activo' };

export function automationsView(store: Store, escape: (v: unknown) => string, csrf?: string, ws?: string): { title: string; body: string } {
  const slugs = new Map(store.listWorkstreams().map(w => [w.id, w.slug]));
  const hidden = csrf ? `<input type="hidden" name="csrf" value="${csrf}">` : '';
  const form = (id: string, action: string, label: string) => `<form action="/automations/${id}/${action}" method="post" class="web-action">${hidden}<button>${label}</button></form>`;
  const rows = store.listAutomations(ws).map(a => `<tr><td>${escape(a.name)}<br><small>${escape(a.title)}</small></td><td>${escape(slugs.get(a.workstreamId) ?? '')}</td><td><code>${escape(a.cron)}</code> UTC</td><td>${a.enabled ? 'Activa' : 'Pausada'}</td><td>${a.lastResult ? escape(RESULTS[a.lastResult] ?? a.lastResult) : 'Sin ejecutar'}${a.lastDueAt ? `<br><small>${escape(a.lastDueAt)}</small>` : ''}${a.lastSignalId ? `<br><small>señal ${escape(a.lastSignalId.slice(0, 8))}</small>` : ''}</td>${csrf ? `<td class="action-buttons">${form(a.id, 'run', 'Ejecutar ahora')}${form(a.id, a.enabled ? 'disable' : 'enable', a.enabled ? 'Pausar' : 'Activar')}</td>` : ''}</tr>`).join('');
  return { title: 'Automations', body: `<p class="intro">Horarios que crean una señal con un texto fijo. Alta y edición: fab automation.</p>${csrf ? '<p class="muted">Ejecutar ahora crea una señal. No lanza trabajo: la señal espera tu triage.</p>' : '<p class="muted">Para ejecutar, activar o pausar, abre fab web --write con el enlace de la terminal.</p>'}${rows ? `<div class="table-wrap"><table><thead><tr><th>Nombre</th><th>Workstream</th><th>Horario</th><th>Estado</th><th>Último resultado</th>${csrf ? '<th>Acciones</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">No hay automations. Crea una con fab automation add.</p>'}` };
}
