// Perfiles inmutables: la vista anticipa la resolución del pool y la asignación es una decisión aparte.
import { join } from 'node:path';
import { AGENT_NAMES } from './agents.ts';
import { redact } from './manifest.ts';
import { DEFAULT_DIGEST, ROLES, isProfileDigest, resolveProfile, resolveRole, saveProfile, type Profile, type Role } from './profile.ts';
import { CONFINABLE_AGENTS } from './sandbox/confine.ts';
import { Store, StoreError, WorkstreamBusyError } from './store.ts';

type Escape = (value: unknown) => string;
/** Siete plantillas de hasta 32 KiB y los campos de configuración, codificados como formulario. */
export const PROFILE_BODY_LIMIT = 1024 * 1024;
export class ProfileInputError extends Error {}

const ROLE_LABELS: Record<Role, string> = {
  investigate: 'Investigación', implement: 'Implementación', code_review: 'Revisión de código',
  security_audit: 'Auditoría de seguridad', qa: 'QA',
};
const TEMPLATES = [
  ['worker', 'rules', 'Reglas de workers'], ['worker', 'investigate', ROLE_LABELS.investigate],
  ['worker', 'implement', ROLE_LABELS.implement], ['validators', 'rules', 'Reglas de validadores'],
  ['validators', 'code_review', ROLE_LABELS.code_review], ['validators', 'security_audit', ROLE_LABELS.security_audit],
  ['validators', 'qa', ROLE_LABELS.qa],
] as const;
const roleFields = ROLES.flatMap(role => [`roles.${role}.harness`, `roles.${role}.model`]);
const roleFormFields = ['model', ...roleFields];
// T103: nombres de variables y de servidores MCP por rol; opcionales en el formulario (un POST antiguo sin ellos los conserva).
const roleAccessFields = ROLES.flatMap(role => [`roles.${role}.env`, `roles.${role}.mcp`]);
const saveFields = ['csrf', 'ws', 'base', 'expectedAgent', 'mode', ...TEMPLATES.map(([group, key]) => `${group}.${key}`)];
const ASSIGN_FIELDS = ['csrf', 'ws', 'previous', 'expectedAgent', 'digest', 'confirm'];
const MASK = '[REDACTED]';
const masked = (value: string) => redact(value) !== value;
// Adaptadores que la web ofrece: confinables y sin el de pruebas; el Store sigue siendo quien decide.
const OFFERED = AGENT_NAMES.filter(agent => CONFINABLE_AGENTS.includes(agent) && agent !== 'fake');

function adapterOptions(agents: readonly string[], current: string | undefined, escape: Escape) {
  return agents.map(agent => `<option value="${escape(agent)}"${agent === current ? ' selected' : ''}>${escape(agent)}</option>`).join('');
}

function roleResolution(profile: Profile, agent: string, escape: Escape) {
  const origins = { role: 'Rol del perfil', profile: 'Perfil', workstream: 'Workstream', adapter: 'Predeterminado del adaptador' };
  const reasons = {
    incompatible: 'El modelo declarado pertenece a otro adaptador.',
    undeclared: 'No hay modelo declarado.',
    legacy: 'El modelo histórico de v1 no se usa en ejecución.',
  };
  const code = (value: string | undefined | null, empty: string) => value == null ? empty : `<code>${escape(value)}</code>`;
  const rows = ROLES.map(role => {
    const cfg = profile.roles?.[role];
    const resolved = resolveRole(profile, role, agent);
    const reason = resolved.modelDefaultReason ? `<br><small>${reasons[resolved.modelDefaultReason]}</small>` : '';
    const modelOrigin = resolved.model === null ? origins.adapter : `${code(resolved.model, '')} · ${origins[resolved.modelSource]}`;
    return `<tr><th scope="row">${ROLE_LABELS[role]}</th><td>${code(cfg?.harness, 'Heredar del workstream')}</td><td>${code(resolved.adapter, '')} · ${origins[resolved.source === 'role' ? 'role' : 'workstream']}</td><td>${code(cfg?.model, 'Heredar si es compatible')}</td><td>${modelOrigin}${reason}</td></tr>`;
  }).join('');
  const model = profile.schemaVersion === 1
    ? profile.model === undefined ? '' : ` · Modelo histórico de v1: ${code(profile.model, '')} (inactivo)`
    : ` · Modelo predeterminado del perfil: ${code(profile.model, 'Heredar del adaptador')}`;
  return `<p>Perfil v${profile.schemaVersion} · Adaptador del perfil: ${code(profile.harness, '')}${model}</p>
    <p class="muted">Resolución sin override de CLI</p>
    <div class="table-wrap"><table><thead><tr><th scope="col">Rol</th><th scope="col">Adaptador declarado</th><th scope="col">Adaptador efectivo y origen</th><th scope="col">Modelo declarado</th><th scope="col">Modelo efectivo y origen</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function profileEditor(profile: Profile, hidden: string, escape: Escape) {
  const modelInput = (name: string, label: string, value?: string) =>
    `<label>${label}<input type="text" name="${name}" maxlength="128" value="${value && masked(value) ? MASK : escape(value ?? '')}" placeholder="Heredar"></label>`;
  const roleInputs = ROLES.map(role => {
    const cfg = profile.roles?.[role];
    return `<fieldset><legend>${ROLE_LABELS[role]}</legend>
      <label>Adaptador<select name="roles.${role}.harness"><option value="">Heredar del workstream</option>${adapterOptions(Array.from(new Set([...OFFERED, ...(cfg?.harness ? [cfg.harness] : [])])), cfg?.harness, escape)}</select></label>
      ${modelInput(`roles.${role}.model`, 'Modelo del rol', cfg?.model)}
      <label>Variables permitidas (nombres, separados por coma; nunca valores)<input type="text" name="roles.${role}.env" maxlength="1024" value="${escape((cfg?.env ?? []).join(', '))}" placeholder="Ninguna"></label>
      <label>Servidores MCP (nombres del registro, separados por coma)<input type="text" name="roles.${role}.mcp" maxlength="512" value="${escape((cfg?.mcp ?? []).join(', '))}" placeholder="Ninguno"></label></fieldset>`;
  }).join('');
  let hasMasked = false;
  const areas = TEMPLATES.map(([group, key, label]) => {
    const value = template(profile, group, key);
    const hide = masked(value);
    hasMasked ||= hide;
    // HTML descarta el primer salto tras <textarea>; el salto añadido conserva uno original.
    return `<label for="f-${group}.${key}">${label}</label><textarea id="f-${group}.${key}" name="${group}.${key}" rows="8"${hide ? ' placeholder="Deja vacío para conservar la plantilla"' : ''}>\n${hide ? '' : escape(value)}</textarea>`;
  }).join('');
  const promotion = profile.schemaVersion === 1
    ? '<p>El perfil se convierte a v2 si declaras un adaptador o modelo por rol, o un modelo predeterminado. Deja el modelo predeterminado vacío para heredar del adaptador.</p>'
    : '<p>Deja un modelo vacío para heredar. Los modelos declarados solo se aplican a su adaptador.</p>';
  return `<form action="/perfiles/guardar" method="post" class="web-action">${hidden}<input type="hidden" name="mode" value="roles">
    ${promotion}${modelInput('model', 'Modelo predeterminado del perfil', profile.schemaVersion === 2 ? profile.model : undefined)}
    ${roleInputs}<details><summary>Plantillas</summary>
    ${hasMasked ? '<p class="notice">Se ocultó texto con aspecto de secreto. Deja la plantilla vacía para conservarla o escribe un reemplazo completo.</p>' : ''}
    ${areas}</details><p>Guardar crea una copia para revisar y asignar al workstream.</p><button>Guardar como perfil nuevo</button></form>`;
}

export function profilesPage(store: Store, stateDir: string, url: URL, escape: Escape, csrf?: string) {
  const workstreams = store.listWorkstreams();
  const ws = url.searchParams.get('ws');
  const selected = ws ? store.getWorkstream(ws) : workstreams[0];
  if (!selected) return { title: 'Perfiles', body: '<p class="empty">No hay workstreams.</p>' };
  const picker = `<form class="filters" action="/perfiles" method="get"><label>Workstream<select name="ws">${workstreams.map(w => `<option value="${escape(w.slug)}"${w.id === selected.id ? ' selected' : ''}>${escape(w.slug)}</option>`).join('')}</select></label><button>Ver</button></form>`;
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="ws" value="${escape(selected.slug)}"><input type="hidden" name="expectedAgent" value="${escape(selected.agent)}">`;
  const confirmForm = (digest: string, previous: string, label: string) => `<form action="/perfiles/asignar" method="post" class="web-action">${hidden}<input type="hidden" name="digest" value="${digest}"><input type="hidden" name="previous" value="${previous}"><label><input type="checkbox" name="confirm" value="yes" required> Confirmo el cambio de perfil de <b>${escape(selected.slug)}</b></label><button>${label}</button></form>`;
  const restoreForm = (previous: string) => csrf && previous !== DEFAULT_DIGEST && isProfileDigest(previous) ? `<section><h2>Valores por defecto</h2>${confirmForm(DEFAULT_DIGEST, previous, 'Restaurar valores por defecto')}</section>` : '';
  let current: ReturnType<typeof resolveProfile>;
  try { current = resolveProfile(stateDir, selected.profile); }
  catch {
    return { title: 'Perfiles', body: `${picker}<p class="notice">El perfil asignado no está disponible o no supera la verificación de integridad.</p>${restoreForm(selected.profile ?? DEFAULT_DIGEST)}` };
  }
  const d = url.searchParams.get('digest') ?? '';
  let saved = '';
  if (isProfileDigest(d)) {
    try {
      const { profile } = resolveProfile(stateDir, d);
      const status = d === current.digest ? 'Es el vigente' : url.searchParams.get('nuevo') === '1' ? 'Nuevo' : 'Ya existía';
      // T91-H4: asignar un perfil con otra política de automejora cambia el umbral que decide cuándo se propone y se experimenta (gasto).
      const policyChange = JSON.stringify(profile.autoImprove ?? null) !== JSON.stringify(current.profile.autoImprove ?? null)
        ? '<p class="notice">Este perfil trae una política de automejora distinta de la vigente: cambia el umbral que decide cuándo se propone y se experimenta (gasto) si la automejora está habilitada.</p>' : '';
      const assign = csrf && d !== current.digest ? policyChange + confirmForm(d, current.digest, 'Asignar al workstream') : '';
      saved = `<section><h2>Perfil guardado</h2><p><code>${d}</code> · ${status}</p>${d !== current.digest ? roleResolution(profile, selected.agent, escape) : ''}${assign}</section>`;
    } catch { saved = '<p class="notice">El perfil guardado no está disponible.</p>'; }
  }
  // Solo lectura: sin plantillas (T58), pero cada rol lleva el ancla a la que apunta el enlace de la activity (T94).
  const edit = csrf ? `<section><h2>Editar perfil</h2>${profileEditor(current.profile, `${hidden}<input type="hidden" name="base" value="${current.digest}">`, escape)}</section>`
    : `<section><h2>Plantillas</h2><p class="muted">Escritura no habilitada: abre fab web con --write.</p><ul class="roles">${TEMPLATES.map(([group, key, label]) => `<li id="f-${group}.${key}">${label}</li>`).join('')}</ul></section>`;
  const agents = Array.from(new Set([selected.agent, ...OFFERED]));
  const adapterForm = csrf ? `<form action="/workstreams/${encodeURIComponent(selected.id)}/adaptador" method="post" class="web-action">
    <input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="previous" value="${escape(selected.agent)}">
    <input type="hidden" name="profileExpected" value="${current.digest}">
    <label>Nuevo adaptador<select name="agent" required>${adapterOptions(agents, selected.agent, escape)}</select></label>
    
    <label><input type="checkbox" name="confirm" value="yes" required> Confirmo el cambio de adaptador de <b>${escape(selected.slug)}</b></label>
    <button>Cambiar adaptador</button></form>` : '';
  return { title: 'Perfiles', body: `${picker}${saved}<section><h2>Perfil vigente</h2><p><code>${current.digest}</code> · ${selected.profile ? 'Fijado' : 'Por defecto'}</p>
    ${roleResolution(current.profile, selected.agent, escape)}</section>${edit}
    <section><h2>Adaptador del workstream</h2><p>Actual: <code>${escape(selected.agent)}</code></p>${adapterForm}</section>${restoreForm(current.digest)}` };
}

type TemplateGroup = (typeof TEMPLATES)[number][0];
const template = (p: Profile, group: TemplateGroup, key: string) => (p[group] as unknown as Record<string, string>)[key]!;
const normalizeLines = (s: string) => s.replace(/\r\n?/g, '\n');

export function checkProfileFields(form: URLSearchParams, allowed: readonly string[]) {
  const seen = new Set<string>();
  for (const name of form.keys()) {
    if (!allowed.includes(name) || seen.has(name)) throw new ProfileInputError('El formulario contiene campos desconocidos o repetidos.');
    seen.add(name);
  }
}

function editProfile(profile: Profile, form: URLSearchParams, editRoles: boolean): Profile {
  for (const [group, key] of TEMPLATES) {
    const input = form.get(`${group}.${key}`);
    if (input === null) continue;
    const original = template(profile, group, key);
    const value = normalizeLines(input);
    if (value === normalizeLines(original) || (!value && masked(original))) continue;
    if (masked(original) && value.includes(MASK)) throw new ProfileInputError('Escribe un reemplazo completo para la plantilla enmascarada.');
    (profile[group] as unknown as Record<string, string>)[key] = value;
  }
  if (!editRoles) return profile;
  if (profile.schemaVersion === 1 && roleFormFields.every(name => form.get(name) === '') && roleAccessFields.every(name => !form.get(name))) return profile;
  const modelValue = (name: string, original?: string) => {
    const value = form.get(name)!;
    return value === MASK && original && masked(original) ? original : value;
  };
  const model = modelValue('model', profile.schemaVersion === 2 ? profile.model : undefined);
  profile.schemaVersion = 2;
  if (model) profile.model = model;
  else delete profile.model;

  const roles: NonNullable<Profile['roles']> = {};
  for (const role of ROLES) {
    const cfg = { ...profile.roles?.[role] };
    const harness = form.get(`roles.${role}.harness`)!;
    const model = modelValue(`roles.${role}.model`, cfg.model);
    if (harness) cfg.harness = harness;
    else delete cfg.harness;
    if (model) cfg.model = model;
    else delete cfg.model;
    for (const key of ['env', 'mcp'] as const) {
      const input = form.get(`roles.${role}.${key}`);
      if (input === null) continue;
      const names = input.split(/[\s,]+/).filter(Boolean);
      // Un `=` delata un valor pegado: se rechaza sin repetirlo.
      if (names.some(n => n.includes('='))) throw new ProfileInputError('Escribe solo nombres: un valor pegado se rechaza y no se guarda.');
      if (names.length) cfg[key] = names; else delete cfg[key];
    }
    if (Object.keys(cfg).length) roles[role] = cfg;
  }
  if (Object.keys(roles).length) profile.roles = roles;
  else delete profile.roles;
  return profile;
}

/** Guardar lee el perfil de origen y sus dos precondiciones en una sola transacción. */
export function profileAction(stateDir: string, kind: 'guardar' | 'asignar', form: URLSearchParams): { destination: string; result: string } {
  const editRoles = kind === 'guardar' && form.get('mode') === 'roles';
  checkProfileFields(form, kind === 'asignar' ? ASSIGN_FIELDS : editRoles ? [...saveFields, ...roleFormFields, ...roleAccessFields] : saveFields);
  if (kind === 'guardar' && ((form.has('mode') && !editRoles) || (editRoles && roleFormFields.some(name => !form.has(name))))) {
    throw new ProfileInputError('Completa la configuración de todos los roles y del modelo predeterminado.');
  }
  const expectedAgent = form.get('expectedAgent');
  const expected = form.get(kind === 'guardar' ? 'base' : 'previous') ?? '';
  if (!expectedAgent || !isProfileDigest(expected)) throw new ProfileInputError('Vuelve a abrir Perfiles y revisa la configuración vigente.');
  const store = new Store(join(stateDir, 'fabrica.db'));
  const previous = process.env.FAB_ACTOR;
  process.env.FAB_ACTOR = 'web';
  try {
    const ws = store.getWorkstream(form.get('ws') ?? '');
    const destination = `/perfiles?ws=${encodeURIComponent(ws.slug)}`;
    try {
      if (kind === 'guardar') {
        return store.withRetry(() => {
          const current = store.getWorkstream(ws.id);
          if ((current.profile ?? DEFAULT_DIGEST) !== expected || current.agent !== expectedAgent) {
            throw new StoreError('conflict', 'la configuración vigente cambió');
          }
          let snapshot: Profile;
          try { snapshot = resolveProfile(stateDir, current.profile).profile; }
          catch { throw new ProfileInputError('El perfil de origen no está disponible o es corrupto.'); }
          const profile = editProfile(snapshot, form, editRoles);
          try {
            const { digest, created } = saveProfile(stateDir, profile);
            return { destination: `${destination}&digest=${digest}&nuevo=${created ? 1 : 0}`, result: 'ok' };
          } catch (e) { throw new ProfileInputError(redact((e as Error).message)); }
        });
      }
      const digest = form.get('digest') ?? '';
      if (!isProfileDigest(digest) || form.get('confirm') !== 'yes') throw new ProfileInputError('Confirma el cambio de perfil.');
      store.assignProfile(ws.id, digest, expected, expectedAgent);
      return { destination, result: 'ok' };
    } catch (e) {
      if (e instanceof WorkstreamBusyError) return { destination, result: 'workstream_busy' };
      if (e instanceof StoreError && e.code === 'invalid_input') throw new ProfileInputError(e.message);
      if (e instanceof StoreError) return { destination, result: e.code };
      throw e;
    }
  } finally {
    if (previous === undefined) delete process.env.FAB_ACTOR; else process.env.FAB_ACTOR = previous;
    store.close();
  }
}
