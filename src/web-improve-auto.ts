// Editor de la política del perfil. La asignación sigue en Perfiles y el motor decide cuándo se ejecuta.
import { redact } from './manifest.ts';
import { getConfig } from './improve-auto.ts';
import { AUTO_INSTRUCTIONS_MAX, DEFAULT_AUTO_THRESHOLD, loadProfile, resolveProfile, saveProfile } from './profile.ts';
import { StoreError, type Store } from './store.ts';

const enc = encodeURIComponent;
const isDigest = (value: string) => /^[0-9a-f]{64}$/.test(value);

export function autoImprovePage(store: Store, stateDir: string, url: URL, escape: (value: unknown) => string, csrf?: string) {
  const title = 'Automejora';
  const workstreams = store.listWorkstreams();
  const slug = url.searchParams.get('ws');
  const ws = slug ? store.getWorkstream(slug) : workstreams[0];
  if (!ws) return { title, body: '<p class="empty">Crea un workstream para configurar la automejora.</p>' };
  const current = resolveProfile(stateDir, ws.profile);
  const legacy = getConfig(store, ws.id);
  const policy = current.profile.autoImprove;
  const thresholds = policy ?? legacy ?? DEFAULT_AUTO_THRESHOLD;
  const scorers = Object.entries(current.profile.scorers ?? {}).filter(([, def]) => def.scope !== 'change');
  const picker = `<form action="/automejora" method="get" class="filters"><label>Workstream<select name="ws">${workstreams.map(w => `<option value="${escape(w.slug)}"${w.id === ws.id ? ' selected' : ''}>${escape(w.slug)}</option>`).join('')}</select></label><button>Ver</button></form>`;
  const summary = `<p>Perfil vigente <code>${current.digest}</code></p><p>Automejora ${legacy?.enabled ? 'habilitada' : 'deshabilitada'} para este workstream. ${policy ? 'Se usa la política del perfil.' : 'Se usan los valores del workstream o sus valores por defecto.'}</p>`;
  const requested = url.searchParams.get('digest') ?? '';
  let saved = '';
  if (csrf && isDigest(requested)) {
    let profile;
    try { profile = loadProfile(stateDir, requested); } catch { saved = '<p class="notice">El perfil solicitado no está disponible.</p>'; }
    if (profile?.autoImprove) {
      saved = `<section><h2>Perfil guardado</h2><p><code>${requested}</code>${requested === current.digest ? ' · Vigente' : ''}</p>${requested === current.digest ? '' : `<p><a href="/perfiles?ws=${enc(ws.slug)}&amp;digest=${requested}">Revisar y asignar en Perfiles</a></p>`}</section>`;
    }
  }
  const instructions = policy?.instructions ?? '';
  if (!csrf) {
    const selected = scorers.filter(([name]) => !policy || policy.scorers.includes(name)).map(([name]) => name).join(', ');
    return { title, body: picker + summary + `<dl><dt>Umbral de fallos (0 a 1)</dt><dd>${escape(thresholds.threshold)}</dd><dt>Ventana de puntuaciones</dt><dd>${escape(thresholds.window)}</dd><dt>Mínimo de puntuaciones</dt><dd>${escape(thresholds.minScores)}</dd><dt>Jueces que cuentan</dt><dd>${escape(selected || 'Ninguno')}</dd><dt>Instrucciones adicionales</dt><dd>${instructions ? `<pre>${escape(instructions)}</pre>` : 'Sin instrucciones adicionales'}</dd></dl><p class="muted">Para editar, abre fab web con --write y entra desde su enlace de acceso.</p>` };
  }
  const checks = scorers.map(([name, def]) => `<label><input type="checkbox" name="scorer.${escape(name)}" value="yes"${!policy || policy.scorers.includes(name) ? ' checked' : ''}> ${escape(name)} · ${escape(def.scope)}</label>`).join('');
  const masked = redact(instructions) !== instructions;
  const form = `<form action="/automejora/${enc(ws.slug)}/save" method="post" class="web-action"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="previous" value="${current.digest}"><fieldset><legend>Política de automejora</legend>
    <label>Umbral de fallos (mayor que 0 y hasta 1)<input type="number" name="threshold" value="${escape(thresholds.threshold)}" step="any" min="0" max="1" required></label>
    <label>Ventana de puntuaciones<input type="number" name="window" value="${escape(thresholds.window)}" min="1" step="1" required></label>
    <label>Mínimo de puntuaciones<input type="number" name="minScores" value="${escape(thresholds.minScores)}" min="1" step="1" required></label>
    <fieldset><legend>Jueces que cuentan</legend>${checks || '<p>El perfil no define jueces para los roles.</p>'}</fieldset>
    <label>Instrucciones adicionales para el agente proponente<textarea name="instructions" rows="5" maxlength="${AUTO_INSTRUCTIONS_MAX}">
${escape(instructions)}</textarea></label>
    ${masked ? '<p class="notice">Se ocultó texto con aspecto de secreto. Si dejas el campo como está, se conservan las instrucciones guardadas.</p>' : ''}
    <p class="muted">Para activar esta política, asigna el perfil desde Perfiles después de guardarlo.</p><button>Guardar como perfil nuevo</button></fieldset></form>`;
  return { title, body: picker + summary + saved + form };
}

export function saveAutoImproveProfile(store: Store, stateDir: string, ws: string, input: Record<string, string | undefined>): string {
  const workstream = store.getWorkstream(ws);
  const current = resolveProfile(stateDir, workstream.profile);
  if (input.previous !== current.digest) throw new StoreError('conflict', 'El perfil vigente cambió.');
  const scorers = Object.keys(input).filter(key => key.startsWith('scorer.') && input[key] === 'yes')
    .map(key => key.slice('scorer.'.length)).sort();
  const original = current.profile.autoImprove?.instructions ?? '';
  const submitted = (input.instructions ?? '').replace(/\r\n?/g, '\n');
  const autoImprove = {
    threshold: Number(input.threshold),
    window: Number(input.window),
    minScores: Number(input.minScores),
    scorers,
    instructions: submitted === redact(original) ? original : submitted,
  };
  try { return saveProfile(stateDir, { ...current.profile, autoImprove }).digest; }
  catch (error) { throw new StoreError('invalid_input', (error as Error).message); }
}
