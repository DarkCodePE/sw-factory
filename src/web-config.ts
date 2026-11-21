import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configuredMcpNames } from './agent/settings.ts';
import { AGENT_NAMES } from './agents.ts';
import { agentBinStatus, loadAgentVersions, PINNED_AGENTS, sha256Of, type AgentBinStatus, type AgentBinVerdict } from './agents-verify.ts';
import { jiraConfiguredInEnv } from './connectors/jira.ts';
import { activityMetadata, redact } from './evidence.ts';
import { loadMcpRegistry, McpRegistryError } from './mcp-registry.ts';
import { listProfiles, resolveProfile } from './profile.ts';
import { detectSandbox } from './sandbox/detect.ts';
import { accessSection } from './web-access.ts';
import { API_KEYS_PATH } from './web-api-keys.ts';
import { entradaSection } from './web-entrada.ts';
import type { Store, Workstream } from './store.ts';
import pkg from '../package.json' with { type: 'json' };

type Escape = (value: unknown) => string;

const yesNo = (value: boolean) => value ? 'Sí' : 'No';
const configured = (value: boolean) => value ? 'Configurada' : 'No configurada';
const limit = (value: number) => Number.isSafeInteger(value) ? value : 'No medido';
const binLabels: Record<AgentBinVerdict, string> = {
  ok: 'Coincide con el pin', distinto: 'Distinto del pin', no_instalado: 'No instalado', sin_pin: 'Sin pin',
};

function facts(rows: [string, string | number][]) {
  return `<dl class="config-facts">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
}

/** Resumen SHA-256 por ruta, tamaño y mtime: GET /config no relee GB de binarios en cada petición. */
const digestCache = new Map<string, { size: number; mtimeMs: number; digest: string }>();
function cachedSha256(path: string): string {
  const { size, mtimeMs } = statSync(path);
  const hit = digestCache.get(path);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.digest;
  const digest = sha256Of(path);
  digestCache.set(path, { size, mtimeMs, digest });
  return digest;
}


/** La sonda de egress se busca solo entre las activities más recientes del workstream. */
export const EGRESS_SCAN_LIMIT = 200;

const TEMPLATE_NOTICE = 'Las plantillas se muestran casi íntegras: la redacción solo reconoce formas conocidas de credencial (cabeceras, URLs, prefijos de tokens y cadenas largas de aspecto aleatorio). Un secreto en texto libre no se puede detectar.';

function templateText(text: string): string {
  return redact(text)
    // El usuario de una URL, sus parámetros y su fragmento pueden llevar credenciales; un enlace con ancla simple se conserva.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, url => {
      const authority = url.slice(url.indexOf('://') + 3).split('/', 1)[0]!;
      if (authority.includes('@')) return '[REDACTED]';
      return url.replace(/\?[^#]*/, '?[REDACTED]').replace(/#(?![\w-]{1,40}$).*/, '#[REDACTED]');
    })
    .replace(/\bBasic\s+[A-Za-z0-9+/=._~-]{8,}/gi, 'Basic [REDACTED]')
    .replace(/(\s(?:-u|--user)[\s=]+)\S+/g, '$1[REDACTED]')
    .replace(/\b(?:glpat|npm|pypi|hf|dop_v1|shpat)[-_][A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    // Cadena larga con letras y dígitos: aspecto de secreto, también en la ruta de una URL.
    .replace(/(?<![\w-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}(?![\w-])/g, '[REDACTED]')
    .replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*$/g, '[REDACTED]');
}

function profileView(stateDir: string, workstream: Workstream, escape: Escape): string {
  try {
    const { digest, profile } = resolveProfile(stateDir, workstream.profile);
    const templates = (rows: [string, string][]) => rows.map(([role, text]) =>
      `<details><summary>${role}</summary><pre tabindex="0">${escape(templateText(text))}</pre></details>`,
    ).join('');
    return `<p>Digest <code>${escape(digest)}</code> · ${workstream.profile ? 'Fijado' : 'Por defecto'}</p>
      <p class="muted">${TEMPLATE_NOTICE}</p>
      <h3>Workers</h3>${templates([
        ['Reglas de workers', profile.worker.rules], ['Investigación', profile.worker.investigate], ['Implementación', profile.worker.implement],
      ])}
      <h3>Validadores</h3>${templates([
        ['Reglas de validadores', profile.validators.rules], ['Revisión de código', profile.validators.code_review],
        ['Auditoría de seguridad', profile.validators.security_audit], ['QA', profile.validators.qa],
      ])}`;
  } catch {
    return '<p class="notice">El perfil asignado no está disponible o no supera la verificación de integridad.</p>';
  }
}

function savedProfiles(stateDir: string, escape: Escape): string {
  try {
    const digests = listProfiles(stateDir);
    return digests.length
      ? `<ul>${digests.map(digest => `<li><code>${escape(digest)}</code></li>`).join('')}</ul>`
      : '<p class="muted">No hay perfiles guardados.</p>';
  } catch { return '<p class="notice">No se pudo leer el inventario de perfiles.</p>'; }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function credentialStatus(agent: string): string {
  let found: boolean;
  if (agent === 'claude') {
    found = !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN)
      || isFile(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json'));
  } else if (agent === 'codex') {
    found = !!process.env.OPENAI_API_KEY || isFile(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'));
  } else return 'No medido';
  return found ? 'Detectada' : 'No detectada';
}

function adapters(stateDir: string, escape: Escape): string {
  const versionsFromRecord = loadAgentVersions(stateDir);
  const rows = AGENT_NAMES.map(agent => {
    const isPinned = PINNED_AGENTS.includes(agent);
    let status: AgentBinStatus | undefined;
    let verdict: string;
    let isMismatch = false;

    if (!isPinned) {
      verdict = agent === 'native' ? 'Integrado' : 'De prueba';
    } else {
      try {
        status = agentBinStatus(agent, stateDir, cachedSha256);
        verdict = binLabels[status.verdict];
        isMismatch = status.verdict === 'distinto';
      } catch {
        verdict = 'No medido';
      }
    }

    const cred = credentialStatus(agent);

    // Binario / Ruta
    const binPath = !isPinned
      ? (agent === 'native' ? 'src/agent/exec.ts' : 'De prueba')
      : (status?.path ? status.path : '—');

    // Versión
    let version: string;
    if (agent === 'native') {
      version = pkg.version;
    } else if (agent === 'fake') {
      version = '—';
    } else if (!status?.path || status.verdict === 'no_instalado') {
      version = '—';
    } else if (status.verdict === 'ok') {
      const rec = versionsFromRecord[agent];
      const raw = typeof rec === 'string' ? rec : rec?.version;
      const recSha = typeof rec === 'object' && rec !== null ? rec.sha256 : undefined;
      if (raw && (!recSha || recSha === status.pin)) {
        const cleaned = raw.replace(/[\x00-\x1f\x7f\p{Cf}]/gu, '').trim();
        version = cleaned ? cleaned.slice(0, 40) : 'No medido';
      } else {
        version = 'No medido';
      }
    } else {
      version = 'No medido';
    }

    // Pin guardado
    const pin = isPinned && status?.pin ? `${status.pin.slice(0, 12)}…` : '—';

    // Marcado si no coincide con su pin
    const statusCell = isMismatch
      ? `${verdict} <mark class="alerta">(no coincide)</mark>`
      : verdict;

    return `<tr${isMismatch ? ' class="pin-mismatch"' : ''}>`
      + `<td>${escape(agent)}</td>`
      + `<td>${statusCell}</td>`
      + `<td>${cred}</td>`
      + `<td>${escape(binPath)}</td>`
      + `<td>${escape(version)}</td>`
      + `<td><code>${escape(pin)}</code></td>`
      + `</tr>`;
  }).join('');

  return `<div class="table-wrap" role="region" aria-label="Adaptadores" tabindex="0"><table class="config-adapters">
    <thead><tr><th scope="col">Adaptador</th><th scope="col">Binario</th><th scope="col">Credencial local</th><th scope="col">Ruta</th><th scope="col">Versión</th><th scope="col">Pin guardado</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function latestEgress(store: Store, stateDir: string, workstream: Workstream, escape: Escape): string {
  let latest: { timestamp: number; result: string } | undefined;
  for (const activity of store.listActivities({ workstream: workstream.id }).slice(-EGRESS_SCAN_LIMIT)) {
    try {
      const probe = activityMetadata(stateDir, activity)?.egressProbe as Record<string, unknown> | null | undefined;
      if (!probe || typeof probe.probedAt !== 'string' || typeof probe.decided !== 'boolean'
        || typeof probe.positiveControl !== 'boolean' || typeof probe.reachable !== 'boolean') continue;
      const timestamp = Date.parse(probe.probedAt);
      if (!Number.isFinite(timestamp) || latest && timestamp <= latest.timestamp) continue;
      latest = { timestamp, result: probe.decided && probe.positiveControl
        ? (probe.reachable ? 'Alcanzable' : 'Bloqueado')
        : 'No medido' };
    } catch { /* La evidencia de una activity puede faltar o ser ilegible. */ }
  }
  return latest
    ? `${latest.result} · <time>${escape(new Date(latest.timestamp).toISOString())}</time>`
    : 'No medido';
}

function buildMcpUsageMap(workstreams: Workstream[], stateDir: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const add = (name: string, usage: string) => {
    let list = map.get(name);
    if (!list) { list = []; map.set(name, list); }
    if (!list.includes(usage)) list.push(usage);
  };
  for (const ws of workstreams) {
    const allowed = ws.mcpAllow ?? [];
    if (!allowed.length) continue;
    const usedInRoles = new Set<string>();
    try {
      const { profile } = resolveProfile(stateDir, ws.profile);
      if (profile.roles) {
        for (const [role, cfg] of Object.entries(profile.roles)) {
          if (cfg?.mcp) {
            for (const name of cfg.mcp) {
              if (allowed.includes(name)) {
                usedInRoles.add(name);
                add(name, `${ws.slug} (${role})`);
              }
            }
          }
        }
      }
    } catch {}
    for (const name of allowed) {
      if (!usedInRoles.has(name)) {
        add(name, `permitido: ${ws.slug}`);
      }
    }
  }
  return map;
}

function mcpRegistrySection(store: Store, stateDir: string, escape: Escape, workstreams: Workstream[]): string {
  try {
    const registry = loadMcpRegistry(stateDir);
    const entries = Object.entries(registry);
    if (!entries.length) {
      return '<p class="muted">Sin servidores en el registro MCP.</p>';
    }
    const usageMap = buildMcpUsageMap(workstreams, stateDir);
    const rows = entries.map(([name, s]) => {
      const req = s.required.length
        ? s.required.map(n => `${escape(n)} (${process.env[n] !== undefined ? 'definida en fab web' : 'no definida en fab web'})`).join(', ')
        : '—';
      const usages = usageMap.get(name) ?? [];
      const usageText = usages.length ? usages.map(u => escape(u)).join(', ') : '—';
      return `<tr><td><code>${escape(name)}</code></td><td>${escape(s.kind)}</td><td>${req}</td><td>${usageText}</td></tr>`;
    }).join('');
    return `<div class="table-wrap" role="region" aria-label="Registro MCP" tabindex="0"><table class="config-mcp">
      <thead><tr><th scope="col">Servidor</th><th scope="col">Tipo</th><th scope="col">Variables requeridas</th><th scope="col">Dónde se usa</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  } catch (e) {
    if (e instanceof McpRegistryError) return '<p class="notice">Registro MCP no disponible o inválido.</p>';
    throw e;
  }
}

async function mcpInventory(escape: Escape): Promise<string> {
  try {
    const names = await configuredMcpNames(process.env.FABRICA_AGENT_SETTINGS);
    return names.length
      ? `<ul>${names.map(name => `<li><code>${escape(name)}</code></li>`).join('')}</ul>`
      : '<p class="muted">No hay servidores MCP declarados para el adaptador native.</p>';
  } catch { return '<p class="notice">Configuración MCP no disponible.</p>'; }
}

export async function configPage(store: Store, stateDir: string, url: URL, escape: Escape, csrf?: string) {
  const workstreams = store.listWorkstreams();
  const ws = url.searchParams.get('ws');
  const selected = ws ? store.getWorkstream(ws) : workstreams[0];
  const workstream = selected ? `
    <form class="filters" action="/config" method="get">
      <label>Workstream<select name="ws">${workstreams.map(w =>
        `<option value="${escape(w.slug)}"${w.id === selected.id ? ' selected' : ''}>${escape(w.slug)}</option>`,
      ).join('')}</select></label>
      <button>Ver configuración</button>
    </form>
    <section><h2>Workstream</h2>${facts([
      ['Adaptador', escape(selected.agent)],
      ['Concurrencia de workers', limit(selected.workerConcurrency)],
      ['Tope de changes abiertos', limit(selected.taskLimit)],
      ['Aprobación de change', yesNo(selected.requireChangeApproval)],
      ['Aprobación de spec', yesNo(selected.requireApproval)],
    ])}</section>
    ${accessSection(stateDir, selected, escape, csrf)}
    <section><h2>Perfil vigente</h2>${profileView(stateDir, selected, escape)}</section>
    <section><h2>Definición</h2>
      <p>El árbol de definición agrupa la configuración, el perfil y las skills en ficheros versionables.</p>
      <p><a href="/definicion?ws=${escape(selected.slug)}">Ver árbol de definición (${escape(selected.slug)})</a></p>
    </section>`
    : '<p class="empty">No hay workstreams.</p>';
  const egress = selected ? latestEgress(store, stateDir, selected, escape) : 'No medido';
  const [sandbox, mcp] = await Promise.all([detectSandbox(), mcpInventory(escape)]);
  return { title: 'Configuración', body: `<div class="config">
    ${csrf ? '<p><a href="/config/runners">Runners</a></p>' : ''}
    ${workstream}
    <section><h2>Perfiles guardados</h2>${savedProfiles(stateDir, escape)}</section>
    <section><h2>Adaptadores</h2>${adapters(stateDir, escape)}</section>
    <section><h2>Sandbox y red</h2>${facts([
      ['Sandbox local', escape(sandbox.available ? sandbox.backend : 'No disponible')],
      ['Aislamiento de red disponible', yesNo(sandbox.network)],
      [`Última sonda de egress del workstream (últimas ${EGRESS_SCAN_LIMIT} activities)`, egress],
    ])}</section>
    <section><h2>Integraciones</h2><p><a href="${API_KEYS_PATH}">Claves API</a></p>${facts([
      ['Jira (entorno)', configured(jiraConfiguredInEnv())],
      ['GitHub (entorno)', configured(!!(process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim()))],
    ])}</section>
    ${entradaSection(stateDir, workstreams, escape, csrf)}
    <section><h2>Servidores MCP</h2>${mcpRegistrySection(store, stateDir, escape, workstreams)}${mcp}</section>
  </div>` };
}
