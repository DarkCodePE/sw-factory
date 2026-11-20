// Editor web de perfiles (T58): guardar crea un perfil nuevo (digest nuevo); asignarlo es otra acción con evento.
import { join } from 'node:path';
import { redact } from './manifest.ts';
import { DEFAULT_DIGEST, loadProfile, resolveProfile, saveProfile, type Profile } from './profile.ts';
import { Store, StoreError } from './store.ts';

type Escape = (value: unknown) => string;
/** 7 plantillas de ≤32 KiB, codificadas como formulario (hasta ×3 por %XX). */
export const PROFILE_BODY_LIMIT = 1024 * 1024;
export class ProfileInputError extends Error {}

const FIELDS: [string, string][] = [
  ['worker.rules', 'Reglas de workers'], ['worker.investigate', 'Investigación'], ['worker.implement', 'Implementación'],
  ['validators.rules', 'Reglas de validadores'], ['validators.code_review', 'Revisión de código'],
  ['validators.security_audit', 'Auditoría de seguridad'], ['validators.qa', 'QA'],
];
const get = (p: Profile, field: string) => (p as unknown as Record<string, Record<string, string>>)[field.split('.')[0]!]![field.split('.')[1]!]!;
const isDigest = (s: string) => /^[0-9a-f]{64}$/.test(s);

export function profilesPage(store: Store, stateDir: string, url: URL, escape: Escape, csrf?: string) {
  const workstreams = store.listWorkstreams();
  const ws = url.searchParams.get('ws');
  const selected = ws ? store.getWorkstream(ws) : workstreams[0];
  if (!selected) return { title: 'Perfiles', body: '<p class="empty">No hay workstreams.</p>' };
  const hidden = `<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="ws" value="${escape(selected.slug)}">`;
  const confirmForm = (digest: string, previous: string, label: string, text: string) => `<form action="/perfiles/asignar" method="post" class="web-action">${hidden}<input type="hidden" name="digest" value="${digest}"><input type="hidden" name="previous" value="${previous}"><p>${text}</p><label><input type="checkbox" name="confirm" value="yes" required> Confirmo el cambio de perfil de <b>${escape(selected.slug)}</b></label><button>${label}</button></form>`;
  let current: { digest: string; profile: Profile };
  try { current = resolveProfile(stateDir, selected.profile); }
  catch {
    // T58-H2: con el perfil roto la única salida desde la web es volver al de por defecto, con el digest asignado como «anterior».
    const restore = csrf && selected.profile && isDigest(selected.profile) ? `<section><h2>Valores por defecto</h2>${confirmForm(DEFAULT_DIGEST, selected.profile, 'Restaurar valores por defecto', 'Vuelve al perfil por defecto de fab.')}</section>` : '';
    return { title: 'Perfiles', body: `<p class="notice">El perfil asignado no está disponible o no supera la verificación de integridad.</p>${restore}` };
  }
  let masked = false;
  const areas = FIELDS.map(([name, label]) => {
    const text = get(current.profile, name);
    if (redact(text) !== text) masked = true;
    return `<label for="f-${name}">${label}</label><textarea id="f-${name}" name="${name}" rows="8">${escape(text)}</textarea>`;
  }).join('');
  const picker = `<form class="filters" action="/perfiles" method="get"><label>Workstream<select name="ws">${workstreams.map(w => `<option value="${escape(w.slug)}"${w.id === selected.id ? ' selected' : ''}>${escape(w.slug)}</option>`).join('')}</select></label><button>Ver</button></form>`;
  let saved = '';
  const d = url.searchParams.get('digest') ?? '';
  if (isDigest(d)) {
    try {
      loadProfile(stateDir, d);
      saved = `<section><h2>Perfil guardado</h2><p><code>${d}</code> · ${url.searchParams.get('nuevo') === '1' ? 'Nuevo' : 'Ya existía'}${d === current.digest ? ' · Es el vigente' : ''}</p>${csrf && d !== current.digest ? confirmForm(d, current.digest, 'Asignar al workstream', 'Las activities futuras usarán este perfil; las que ya están en curso conservan el suyo.') : ''}</section>`;
    } catch { saved = '<p class="notice">El perfil guardado no está disponible.</p>'; }
  }
  const write = csrf ? `<form action="/perfiles/guardar" method="post" class="web-action">${hidden}${areas}<button>Guardar como perfil nuevo</button><p class="muted">No modifica el perfil vigente ni los ficheros existentes: crea otro con su propio digest. Adaptador, modelo y roles se conservan; las aprobaciones no se editan aquí.</p></form>`
    // Solo lectura: no se muestra ninguna plantilla (T58), pero cada rol lleva el ancla a la que apunta el enlace de la activity.
    : `<p class="muted">Escritura no habilitada: abre fab web con --write.</p><ul class="roles">${FIELDS.map(([name, label]) => `<li id="f-${name}">${label}</li>`).join('')}</ul>`;
  const restore = csrf && current.digest !== DEFAULT_DIGEST ? `<section><h2>Valores por defecto</h2>${confirmForm(DEFAULT_DIGEST, current.digest, 'Restaurar valores por defecto', 'Vuelve al perfil por defecto de fab.')}</section>` : '';
  return { title: 'Perfiles', body: `${picker}<p>Perfil vigente: <code>${escape(current.digest)}</code> · ${selected.profile ? 'Fijado' : 'Por defecto'}</p>${masked ? '<p class="notice">Se ocultó texto con aspecto de secreto; reescríbelo antes de guardar.</p>' : ''}${saved}<section><h2>Plantillas</h2>${write}</section>${restore}` };
}

/** Ejecuta guardar/asignar. Devuelve destino y resultado para el aviso; lanza ProfileInputError con el motivo si la entrada es inválida. */
export function profileAction(stateDir: string, kind: 'guardar' | 'asignar', form: URLSearchParams): { destination: string; result: string } {
  const slug = form.get('ws') ?? '';
  const store = new Store(join(stateDir, 'fabrica.db'));
  const previous = process.env.FAB_ACTOR; process.env.FAB_ACTOR = 'web';
  try {
    const ws = store.getWorkstream(slug);
    const to = (extra = '') => `/perfiles?ws=${encodeURIComponent(ws.slug)}${extra}`;
    if (kind === 'guardar') {
      const profile: Profile = JSON.parse(JSON.stringify(resolveProfile(stateDir, ws.profile).profile));
      for (const [name] of FIELDS) {
        // Los navegadores envían saltos CRLF: sin normalizar, una plantilla sin editar cambiaría de digest.
        const text = (form.get(name) ?? '').replace(/\r\n?/g, '\n');
        (profile as unknown as Record<string, Record<string, string>>)[name.split('.')[0]!]![name.split('.')[1]!] = text;
      }
      try {
        const { digest, created } = saveProfile(stateDir, profile);
        return { destination: to(`&digest=${digest}&nuevo=${created ? 1 : 0}`), result: 'ok' };
      } catch (e) { throw new ProfileInputError((e as Error).message); }
    }
    const digest = form.get('digest') ?? '', expected = form.get('previous') ?? '';
    if (!isDigest(digest) || !isDigest(expected) || form.get('confirm') !== 'yes') throw new ProfileInputError('Confirma el cambio de perfil.');
    try { store.assignProfile(ws.id, digest, expected); return { destination: to(), result: 'ok' }; }
    catch (e) { if (e instanceof StoreError) return { destination: to(), result: e.code }; throw e; }
  } finally { if (previous === undefined) delete process.env.FAB_ACTOR; else process.env.FAB_ACTOR = previous; store.close(); }
}
