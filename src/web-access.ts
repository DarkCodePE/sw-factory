// T103: secretos y MCP por nombre, nunca por valor (D-K). Muestra y edita el tope del workstream (env_allow / mcp_allow)
// y lo que declara cada rol del perfil. El entorno del proceso no se lee en ningún punto de este módulo: ni valores ni «definida».
import { MCP_OUTSIDE, McpRegistryError, loadMcpRegistry, registeredMcpNames, unregisteredMcp } from './mcp-registry.ts';
import { ROLES, resolveProfile, type Role } from './profile.ts';
import { StoreError, type Store, type Workstream } from './store.ts';

type Escape = (value: unknown) => string;
export const ACCESS_KINDS = ['env', 'mcp'] as const;
type Kind = (typeof ACCESS_KINDS)[number];
const ROLE_LABELS: Record<Role, string> = {
  investigate: 'Investigación', implement: 'Implementación', code_review: 'Revisión de código', security_audit: 'Auditoría de seguridad', qa: 'QA',
};
const NAMES_LIMIT = 2048;
const REJECT = 'Escribe solo nombres, uno por línea: un valor pegado se rechaza y no se guarda.';

/** Valida el formulario. Cualquier línea con `=`, espacios internos o más de 64 caracteres parece un valor y aborta sin repetirla. */
export function accessInput(raw: Record<string, string | undefined>): Record<string, string> {
  const kind = raw.kind as Kind, mode = raw.mode ?? '';
  if (!ACCESS_KINDS.includes(kind) || (mode !== 'declared' && mode !== 'legacy')) throw new StoreError('invalid_input', 'Elige env o mcp y un modo válido.');
  const text = raw.names ?? '';
  if (Buffer.byteLength(text) > NAMES_LIMIT) throw new StoreError('invalid_input', REJECT);
  const names = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (names.some(n => n.length > 64 || /[\s=]/.test(n))) throw new StoreError('invalid_input', REJECT);
  // T103-H3: con «modo anterior» los nombres no se guardan; avisar en vez de responder «Acción registrada» sin haber restringido nada.
  if (mode === 'legacy' && names.length) throw new StoreError('invalid_input', 'Con modo anterior no se guardan nombres: elige Declarado o vacía la lista.');
  return { kind, mode, names: names.join('\n'), confirm: raw.confirm === 'yes' ? 'yes' : '' };
}

/** Mismas guardas que `fab ws env|mcp`: el Store valida los nombres; para MCP además deben estar en el registro. */
export function setAccess(store: Store, stateDir: string, id: string, input: Record<string, string | undefined>): void {
  const names = input.mode === 'legacy' ? null : (input.names ? input.names.split('\n') : []);
  // T103-H13: desde el modo anterior, «Declarado» vacío corta todas las variables o MCP de los workers: se pide confirmación.
  const ws = store.getWorkstream(id), current = input.kind === 'env' ? ws.envAllow : ws.mcpAllow;
  if (current === null && names?.length === 0 && input.confirm !== 'yes') throw new StoreError('invalid_input', 'Una lista vacía no permite nada a los workers: marca la confirmación para guardarla.');
  if (input.kind === 'mcp' && names?.length) {
    let unknown: string[];
    try { unknown = unregisteredMcp(stateDir, names); }
    catch (e) { if (e instanceof McpRegistryError) throw new StoreError('invalid_input', 'El registro MCP (mcp-servers.json) no es válido.'); throw e; }
    // Se cuenta, no se nombra: un valor corto en minúsculas también cumple el formato de un nombre MCP.
    if (unknown.length) throw new StoreError('invalid_input', `${unknown.length} nombre(s) no están en el registro MCP (mcp-servers.json).`);
  }
  if (input.kind === 'env') store.setWorkstreamEnvAllow(id, names); else store.setWorkstreamMcpAllow(id, names);
}

const list = (names: string[] | null, escape: Escape) => names === null ? 'Modo anterior (sin tope declarado)'
  : names.length ? names.map(n => `<code>${escape(n)}</code>`).join(', ') : 'Vacía: no se permite nada';

function roleRows(stateDir: string, ws: Workstream, escape: Escape): string {
  let roles: Record<string, { env?: string[]; mcp?: string[] } | undefined>;
  try { roles = resolveProfile(stateDir, ws.profile).profile.roles ?? {}; }
  catch { return '<p class="notice">El perfil asignado no está disponible: no se pueden mostrar los nombres por rol.</p>'; }
  const registered = registeredMcpNames(stateDir);
  const cell = (names: string[] | undefined, allow: string[] | null, isMcp = false) => !names?.length ? '—'
    : names.map(n => isMcp && !registered.has(n) ? `<em>${MCP_OUTSIDE}</em>` : `<code>${escape(n)}</code>${allow?.includes(n) ? '' : ' <em>(fuera del tope: se bloquea)</em>'}`).join(', ');
  return `<div class="table-wrap" role="region" aria-label="Nombres por rol" tabindex="0"><table><thead><tr><th scope="col">Rol</th><th scope="col">Variables</th><th scope="col">MCP</th></tr></thead><tbody>${
    ROLES.map(r => `<tr><th scope="row">${ROLE_LABELS[r]}</th><td>${cell(roles[r]?.env, ws.envAllow)}</td><td>${cell(roles[r]?.mcp, ws.mcpAllow, true)}</td></tr>`).join('')}</tbody></table></div>
    <p class="muted">Los nombres por rol se editan en <a href="/perfiles?ws=${escape(ws.slug)}">Perfiles</a>; el tope del workstream manda sobre ellos.</p>`;
}

export function accessSection(stateDir: string, ws: Workstream, escape: Escape, csrf?: string): string {
  let registry = '<p class="muted">No hay servidores en el registro MCP.</p>';
  try { const names = Object.keys(loadMcpRegistry(stateDir)); if (names.length) registry = `<p>Registro MCP: ${names.map(n => `<code>${escape(n)}</code>`).join(', ')}</p>`; }
  catch { registry = '<p class="notice">El registro MCP (mcp-servers.json) no es válido.</p>'; }
  const form = (kind: Kind, label: string, current: string[] | null) => !csrf ? '' : `<form action="/workstreams/${encodeURIComponent(ws.id)}/acceso" method="post" class="web-action">
    <input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="kind" value="${kind}">
    <fieldset><legend>Editar ${label}</legend>
    <label>Modo<select name="mode"><option value="declared" selected>Declarado (solo estos nombres)</option><option value="legacy">Modo anterior (sin tope)</option></select></label>
    <label for="acceso-${kind}">Nombres, uno por línea (nunca valores)</label>
    <textarea id="acceso-${kind}" name="names" rows="4" maxlength="${NAMES_LIMIT}">\n${escape((current ?? []).join('\n'))}</textarea>
    ${current === null ? '<label><input type="checkbox" name="confirm" value="yes"> Confirmo: una lista vacía no permite nada a los workers</label>' : ''}
    <button>Guardar ${label}</button></fieldset></form>`;
  return `<section><h2>Secretos y MCP del workstream</h2>
    <p class="muted">Solo nombres: la fábrica nunca guarda ni muestra valores. Si una variable está definida en el entorno del pool, es No medido desde la web.</p>
    <dl class="config-facts"><div><dt>Variables permitidas</dt><dd>${list(ws.envAllow, escape)}</dd></div><div><dt>Servidores MCP permitidos</dt><dd>${list(ws.mcpAllow, escape)}</dd></div></dl>
    ${registry}${roleRows(stateDir, ws, escape)}${form('env', 'variables', ws.envAllow)}${form('mcp', 'servidores MCP', ws.mcpAllow)}</section>`;
}
