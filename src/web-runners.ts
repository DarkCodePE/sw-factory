import { isRunnerName, runnerRevision, StoreError, type Runner, type Store, type Workstream } from './store.ts';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
type Runners = ReturnType<Store['listRunnerSummaries']>;
const kindLabel = (kind: Runners[number]['kind']) => kind === 'ssh' ? 'SSH' : 'Local';
const stateLabel = (enabled: boolean) => enabled ? 'Activado' : 'Pausado';
const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escape(value)}">`;

export const RUNNERS_PATH = '/config/runners';
export type RunnerAdminMode = 'create' | 'update' | 'delete';
export const runnerAdminFields = {
  create: ['csrf', 'name', 'kind', 'target', 'confine', 'maxBundleMb'],
  update: ['csrf', 'revision', 'target', 'confine', 'maxBundleMb'],
  delete: ['csrf', 'revision', 'confirm'],
} satisfies Record<RunnerAdminMode, string[]>;

type Fields = Record<string, string | undefined>;
export function runRunnerAdmin(store: Store, mode: RunnerAdminMode, id: string, fields: Fields): void {
  const name = mode === 'create' ? fields.name ?? '' : id;
  if (!isRunnerName(name)) throw new StoreError('invalid_input', 'Nombre de runner inválido.');
  if (mode !== 'create' && !/^[0-9a-f]{64}$/.test(fields.revision ?? '')) {
    throw new StoreError('invalid_input', 'Abre el editor del runner y revisa su configuración.');
  }
  if (mode === 'delete') {
    if (fields.confirm !== 'yes') throw new StoreError('invalid_input', 'Confirma la baja del runner.');
    store.deleteRunner(name, fields.revision);
    return;
  }
  if (fields.confine !== undefined && fields.confine !== 'yes') throw new StoreError('invalid_input', 'Revisa la opción de confinamiento.');
  const options: Record<string, unknown> = {};
  if (fields.confine) options.confine = true;
  if (fields.maxBundleMb) options.maxBundleMb = Number(fields.maxBundleMb);
  const config = { target: fields.target || null, options };
  if (mode === 'create') store.createRunner({ name, kind: fields.kind as Runner['kind'], ...config });
  else store.updateRunner(name, config, fields.revision);
}

function runnerConfigFields(r?: Runner): string {
  const local = r?.kind !== 'ssh';
  const ssh = r?.kind !== 'local';
  const target = r?.target ?? '';
  const bundle = typeof r?.options.maxBundleMb === 'number' ? String(r.options.maxBundleMb) : '';
  return `${local ? `<label><input type="checkbox" name="confine" value="yes"${r?.options.confine === true ? ' checked' : ''}> Confinar el turno (Local)</label>` : ''}
    ${ssh ? `<label>Alias de SSH<input name="target" maxlength="64" value="${escape(target)}"${r ? ' required' : ''}></label>
      <label>Límite de envío en MiB<input type="number" name="maxBundleMb" min="1" max="4096" value="${escape(bundle)}"></label>` : ''}`;
}

function runnerEditor(r: Runner, csrf: string): string {
  const url = `${RUNNERS_PATH}/${encodeURIComponent(r.name)}`;
  const fields = hidden('csrf', csrf) + hidden('revision', runnerRevision(r));
  return `<section><h2>Editar ${escape(r.name)}</h2>
    <form action="${url}/editar" method="post" class="web-action"><fieldset><legend>${kindLabel(r.kind)}</legend>
    ${fields}${runnerConfigFields(r)}<button>Guardar cambios</button></fieldset></form>
    <form action="${url}/borrar" method="post" class="web-action"><fieldset><legend>Dar de baja</legend>
    ${fields}<label><input type="checkbox" name="confirm" value="yes" required> Confirmo la baja de ${escape(r.name)}.</label>
    <button>Dar de baja</button></fieldset></form></section>`;
}

export function runnersPage(store: Store, csrf: string, edit?: string | null): { title: string; body: string } {
  const rows = store.listRunnerSummaries().map(r => {
    const check = r.kind === 'ssh' && r.enabled && isRunnerName(r.name)
      ? `<form action="/config/runners/${encodeURIComponent(r.name)}/comprobar" method="post">
           ${hidden('csrf', csrf)}<button aria-label="Comprobar ${escape(r.name)}">Comprobar</button>
         </form>` : '';
    return `<tr><th scope="row">${escape(r.name)}</th><td>${kindLabel(r.kind)}</td><td>${stateLabel(r.enabled)}</td>
      <td>${r.kind === 'ssh' ? 'Sin comprobar' : '—'}${check}</td><td>${isRunnerName(r.name)
      ? `<a href="${RUNNERS_PATH}?editar=${encodeURIComponent(r.name)}" aria-label="Editar ${escape(r.name)}">Editar</a>` : ''}</td></tr>`;
  });
  const selected = edit && isRunnerName(edit) ? store.runnerForEdit(edit) : null;
  return { title: 'Runners', body: `<p><a href="/config">Volver a configuración</a></p>
    ${rows.length ? `<div class="table-wrap" role="region" aria-label="Inventario de runners" tabindex="0">
      <table><thead><tr><th scope="col">Nombre</th><th scope="col">Tipo</th><th scope="col">Configuración</th><th scope="col">Comprobación</th><th scope="col">Acciones</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>` : '<p class="empty">No hay runners configurados.</p>'}
    ${selected ? runnerEditor(selected, csrf) : edit ? '<p class="notice">No se encontró el runner.</p>' : ''}
    <details><summary>Dar de alta un runner</summary>
    <form action="${RUNNERS_PATH}/alta" method="post" class="web-action"><fieldset><legend>Nuevo runner</legend>
    ${hidden('csrf', csrf)}<label>Nombre<input name="name" maxlength="41" pattern="[a-z0-9][a-z0-9-]{0,40}" required></label>
    <label>Tipo<select name="kind"><option value="local">Local</option><option value="ssh">SSH</option></select></label>
    ${runnerConfigFields()}<button>Crear runner</button></fieldset></form></details>` };
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
    ? `<option value="${escape(w.runner)}" disabled>${label}</option>` : '';
  const seen = available.map(r => hidden(`seen.${r.name}`, r.revision)).join('');
  const ssh = available.some(r => r.kind === 'ssh')
    ? '<label><input type="checkbox" name="confirm_ssh" value="yes"> Si elijo SSH, acepto enviar código y prompt al runner remoto. La ejecución remota no admite <code>--live</code>.</label>' : '';
  return `${summary}<details><summary>Cambiar runner</summary>
    <form action="/workstreams/${encodeURIComponent(w.id)}/runner" method="post" class="web-action"><fieldset>
      <legend>Runner para próximos turnos</legend>${hidden('csrf', csrf)}${hidden('expected', w.runner ?? '')}${seen}
      <label>Runner<select name="runner"><option value=""${w.runner === null ? ' selected' : ''}>Predeterminado</option>${unavailable}${options}</select></label>
      <label><input type="checkbox" name="confirm" value="yes" required> Confirmo la selección del runner.</label>
      ${ssh}<button>Guardar runner</button>
    </fieldset></form></details>`;
}
