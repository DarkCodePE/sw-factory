import { isRunnerName, type Store, type Workstream } from './store.ts';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
type Runners = ReturnType<Store['listRunnerSummaries']>;
const kindLabel = (kind: Runners[number]['kind']) => kind === 'ssh' ? 'SSH' : 'Local';
const stateLabel = (enabled: boolean) => enabled ? 'Activado' : 'Pausado';
const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escape(value)}">`;

export function runnersPage(store: Store, csrf: string): { title: string; body: string } {
  const rows = store.listRunnerSummaries().map(r => {
    const check = r.kind === 'ssh' && r.enabled && isRunnerName(r.name)
      ? `<form action="/config/runners/${encodeURIComponent(r.name)}/comprobar" method="post">
           ${hidden('csrf', csrf)}<button aria-label="Comprobar ${escape(r.name)}">Comprobar</button>
         </form>` : '';
    return `<tr><th scope="row">${escape(r.name)}</th><td>${kindLabel(r.kind)}</td><td>${stateLabel(r.enabled)}</td>
      <td>${r.kind === 'ssh' ? 'Sin comprobar' : '—'}${check}</td></tr>`;
  });
  return { title: 'Runners', body: `<p><a href="/config">Volver a configuración</a></p>
    ${rows.length ? `<div class="table-wrap" role="region" aria-label="Inventario de runners" tabindex="0">
      <table><thead><tr><th scope="col">Nombre</th><th scope="col">Tipo</th><th scope="col">Configuración</th><th scope="col">Comprobación</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>` : '<p class="empty">No hay runners configurados.</p>'}
    <p class="muted">Para dar de alta, pausar o borrar runners, usa <code>fab runner</code>.</p>` };
}

export function workstreamRunner(w: Workstream, runners: Runners, csrf?: string): string {
  const current = runners.find(r => r.name === w.runner);
  const label = current ? `${escape(current.name)} (${stateLabel(current.enabled)})`
    : w.runner === null ? 'Predeterminado' : `${escape(w.runner)} (Fuera del inventario)`;
  const summary = `<p class="muted">Runner: ${label}</p>`;
  const available = runners.filter(r => r.enabled && isRunnerName(r.name));
  if (!csrf || w.state === 'archived' || (!available.length && w.runner === null)) return summary;
  const options = available.map(r =>
    `<option value="${escape(r.name)}"${r.name === w.runner ? ' selected' : ''}>${escape(r.name)} (${kindLabel(r.kind)})</option>`).join('');
  const unavailable = w.runner !== null && !available.some(r => r.name === w.runner)
    ? `<option value="${escape(w.runner)}" disabled selected>${label}</option>` : '';
  const ssh = available.some(r => r.kind === 'ssh')
    ? '<label><input type="checkbox" name="confirm_ssh" value="yes"> Si elijo SSH, acepto enviar código y prompt al runner remoto. La ejecución remota no admite <code>--live</code>.</label>' : '';
  return `${summary}<details><summary>Cambiar runner</summary>
    <form action="/workstreams/${encodeURIComponent(w.id)}/runner" method="post" class="web-action"><fieldset>
      <legend>Runner para próximos turnos</legend>${hidden('csrf', csrf)}${hidden('expected', w.runner ?? '')}
      <label>Runner<select name="runner"><option value=""${w.runner === null ? ' selected' : ''}>Predeterminado</option>${unavailable}${options}</select></label>
      <label><input type="checkbox" name="confirm" value="yes" required> Confirmo la selección del runner.</label>
      ${ssh}<button>Guardar runner</button>
    </fieldset></form></details>`;
}
