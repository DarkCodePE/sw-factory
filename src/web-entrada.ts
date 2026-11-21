// T107: entrada por etiqueta de GitHub (resident.json) y por Jira, desde la web. Sin credenciales: Jira sale del entorno del proceso
// (JIRA_HOSTNAME/USERNAME/API_TOKEN, nunca de un formulario ni de un .env) y el secreto del webhook sigue en el entorno.
import { checkResidentConfig, INTERVAL_MAX, loadResidentConfig, type ResidentConfig } from './admission/config.ts';
import { createJiraGateway, jiraConfiguredInEnv, validateJiraKey } from './connectors/jira.ts';
import { importIssue } from './connectors/intake.ts';
import { ChangeLinkStore } from './connectors/links.ts';
import type { TicketGateway } from './connectors/types.ts';
import { Store, StoreError, type Workstream } from './store.ts';
import { join } from 'node:path';

type Escape = (value: unknown) => string;
export const JIRA_IMPORT_PATH = /^\/config\/jira\/importar$/;
/** Tope de importaciones solicitadas desde la web por hora y base: protege a Jira y a la cola de señales. */
export const JIRA_HOURLY_CAP = 10;
export const JIRA_MESSAGES: Record<string, string> = {
  jira_ok: 'HU de Jira importada.', jira_reused: 'La HU ya estaba importada: se reutilizó.', jira_invalid: 'Revisa la clave (PROYECTO-123), el workstream y la confirmación.',
  jira_unconfigured: 'Jira no está configurada en el entorno de fab web (JIRA_HOSTNAME, JIRA_USERNAME y JIRA_API_TOKEN).',
  jira_cap: `Tope alcanzado: como máximo ${JIRA_HOURLY_CAP} importaciones por hora desde la web. Usa fab jira import o espera.`,
  jira_busy: 'Ya hay una importación en curso.', jira_limit: 'El workstream alcanzó su tope de changes: la HU quedó como señal sin triage o no se importó.',
  jira_error: 'No se pudo importar la HU. Comprueba la clave, el acceso a Jira y el estado del workstream.',
};

/** Campos del formulario de resident.json; vacío = no cambiar. Mensajes fijos de `checkResidentConfig`. */
export function residentInput(raw: Record<string, string | undefined>): Record<string, string> {
  const interval = (raw.interval ?? '').trim();
  const clean = (k: string) => (raw[k] ?? '').trim();
  try {
    checkResidentConfig({ repo: clean('repo') || undefined, label: clean('label') || undefined, mode: clean('mode') || undefined,
      intervalSec: interval ? (/^\d{1,6}$/.test(interval) ? Number(interval) : NaN) : undefined });
  } catch (e) { throw new StoreError('invalid_input', (e as Error).message); }
  return { repo: clean('repo'), label: clean('label'), interval, mode: clean('mode') };
}
export const residentChanges = (input: Record<string, string | undefined>): ResidentConfig => ({
  ...(input.repo ? { repo: input.repo } : {}), ...(input.label ? { label: input.label } : {}),
  ...(input.interval ? { intervalSec: Number(input.interval) } : {}), ...(input.mode ? { mode: input.mode as 'off' | 'observe' } : {}),
});

export function entradaSection(stateDir: string, workstreams: Workstream[], escape: Escape, csrf?: string): string {
  let cfg: ResidentConfig = {}, problem = '';
  try { cfg = loadResidentConfig(stateDir); } catch (e) { problem = `<p class="notice">${escape((e as Error).message)}</p>`; }
  const v = (value: string | number | undefined, unit = '') => value === undefined ? 'Sin fijar' : `<code>${escape(value)}</code>${unit}`;
  const resident = csrf ? `<form action="/config/entrada" method="post" class="web-action"><input type="hidden" name="csrf" value="${escape(csrf)}"><fieldset><legend>Editar el residente</legend>
    <label>Repositorio (owner/name)<input name="repo" maxlength="140" value="${escape(cfg.repo ?? '')}"></label>
    <label>Etiqueta de disparo<input name="label" maxlength="50" value="${escape(cfg.label ?? '')}" placeholder="fab"></label>
    <label>Intervalo (segundos, 1–${INTERVAL_MAX})<input name="interval" inputmode="numeric" maxlength="6" value="${escape(cfg.intervalSec ?? '')}" placeholder="60"></label>
    <label>Modo<select name="mode"><option value="">Sin fijar (observe)</option>${(['observe', 'off'] as const).map(m => `<option value="${m}"${cfg.mode === m ? ' selected' : ''}>${m}</option>`).join('')}</select></label>
    <p class="muted">Un campo vacío no cambia lo guardado. El modo auto no se fija desde aquí.</p><button>Guardar configuración del residente</button></fieldset></form>` : '';
  const jira = csrf ? `<form action="/config/jira/importar" method="post" class="web-action"><input type="hidden" name="csrf" value="${escape(csrf)}"><fieldset><legend>Importar una HU de Jira</legend>
    <label>Workstream<select name="ws" required>${workstreams.map(w => `<option value="${escape(w.slug)}">${escape(w.slug)}</option>`).join('')}</select></label>
    <label>Clave de la HU<input name="key" required maxlength="40" pattern="[A-Z][A-Z0-9]+-[0-9]+" placeholder="PROYECTO-123"></label>
    <label><input type="checkbox" name="triage" value="yes"> Triar la señal a change (cuenta contra el tope del workstream)</label>
    <label><input type="checkbox" name="confirm" value="yes" required> Confirmo la importación (una HU, máximo ${JIRA_HOURLY_CAP} por hora)</label>
    <button>Importar HU</button></fieldset></form>` : '';
  return `<section><h2>Entrada: etiqueta de GitHub y Jira</h2>${problem}
    <dl class="config-facts"><div><dt>Repositorio</dt><dd>${v(cfg.repo)}</dd></div><div><dt>Etiqueta de disparo</dt><dd>${v(cfg.label)}</dd></div>
    <div><dt>Intervalo</dt><dd>${v(cfg.intervalSec, ' s')}</dd></div><div><dt>Modo</dt><dd>${v(cfg.mode)}</dd></div>
    <div><dt>Última edición</dt><dd>${cfg.updatedAt ? `<time>${escape(cfg.updatedAt)}</time> · ${escape(cfg.updatedBy ?? '')}` : 'Sin editar'}</dd></div></dl>
    <p class="muted">Se aplica al próximo arranque de <code>fab resident</code>; los flags de la línea de comandos mandan. El secreto del webhook y las credenciales de Jira solo viven en el entorno: la web no los pide ni los muestra.</p>
    ${resident}${jira}</section>`;
}

/** Una instancia por servidor: un solo import a la vez. `gateway` solo lo inyectan los tests. */
export function jiraImportAction(stateDir: string, gateway?: TicketGateway) {
  let busy = false;
  return async (form: URLSearchParams): Promise<{ destination: string; result: string }> => {
    const out = (result: string, slug?: string) => ({ destination: slug ? `/config?ws=${encodeURIComponent(slug)}` : '/config', result });
    const keys = [...form.keys()];
    const key = form.get('key') ?? '', slug = form.get('ws') ?? '';
    // T107-H7: la clave de Jira real cabe en 40 caracteres; más largo no debe llegar a la auditoría ni al tope.
    try { if (key.length > 40) throw new Error(); validateJiraKey(key); } catch { return out('jira_invalid'); }
    if (new Set(keys).size !== keys.length || keys.some(k => !['csrf', 'ws', 'key', 'triage', 'confirm'].includes(k)) || form.get('confirm') !== 'yes'
      || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return out('jira_invalid');
    if (!gateway && !jiraConfiguredInEnv()) return out('jira_unconfigured', slug);
    if (busy) return out('jira_busy', slug);
    busy = true;
    let store: Store | undefined;
    try {
      store = new Store(join(stateDir, 'fabrica.db'));
      const writer = store;
      let ws: Workstream;
      try { ws = writer.getWorkstream(slug); } catch { return out('jira_invalid'); }
      const audit = (severity: 'info' | 'warning', message: string) => {
        const previous = process.env.FAB_ACTOR; process.env.FAB_ACTOR = 'web';
        try { writer.event(ws.id, severity, message); } finally { if (previous === undefined) delete process.env.FAB_ACTOR; else process.env.FAB_ACTOR = previous; }
      };
      // El tope cuenta las solicitudes (también las que fallen), leídas de la propia auditoría.
      const since = new Date(Date.parse(writer.now()) - 3_600_000).toISOString();
      const used = (writer.db.query("SELECT COUNT(*) AS n FROM events WHERE message LIKE 'Jira: importación solicitada desde la web%' AND created_at > ?").get(since) as { n: number }).n;
      if (used >= JIRA_HOURLY_CAP) return out('jira_cap', slug);
      const triage = form.get('triage') === 'yes';
      audit('info', `Jira: importación solicitada desde la web: ${key}${triage ? ' (con triage)' : ''}`);
      try {
        const tickets = gateway ?? createJiraGateway({ host: process.env.JIRA_HOSTNAME!, user: process.env.JIRA_USERNAME!, token: process.env.JIRA_API_TOKEN! });
        const r = await importIssue(writer, new ChangeLinkStore(writer.db), tickets, { key, workstream: ws.slug, triage });
        audit('info', `Jira: HU ${key} ${r.reused ? 'reutilizada' : 'importada'} desde la web: signal ${r.signalId.slice(0, 8)}${r.changeId ? ` → change ${r.changeId.slice(0, 8)}` : ''}`);
        return out(r.reused ? 'jira_reused' : 'jira_ok', ws.slug);
      } catch (e) {
        const limit = e instanceof StoreError && e.code === 'limit_reached';
        audit('warning', `Jira: importación de ${key} fallida desde la web${limit ? ' (tope de changes)' : ''}`); // sin el texto del error: puede traer datos de Jira
        return out(limit ? 'jira_limit' : 'jira_error', ws.slug);
      }
    } catch { return out('jira_error', slug); }
    finally { busy = false; store?.close(); }
  };
}
