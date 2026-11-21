// Importar un perfil JSON o una definición empaquetada (.tar) desde la web (T105). Dos pasos sin estado en el servidor:
// 1) subida multipart → vista previa (Store de solo lectura, nada se escribe); 2) confirmación que reenvía el paquete en
// base64 y lo VUELVE a validar entero. El paquete es dato: se lee en memoria (definition-tar.ts), nunca se extrae ni se ejecuta.
// D-F: la web no da más poder que la CLI; un árbol que baje las aprobaciones o vacíe las rutas protegidas se rechaza aquí.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { applyDefinition, parseDefinition, type ParsedDefinition } from './definition.ts';
import { readTar, TAR_MAX_BYTES } from './definition-tar.ts';
import { redact } from './manifest.ts';
import { defaultProfile, DEFAULT_DIGEST, isProfileDigest, profileDigest, resolveProfile, saveProfile, validateProfile, type Profile } from './profile.ts';
import { Store, StoreError } from './store.ts';
import { DEFAULT_PROTECTED_PATHS } from './validators/integrity.ts';
import { repoProblem } from './web-ws.ts';

type Escape = (value: string) => string;
export const IMPORT_PROFILE_PATH = /^\/perfiles\/(importar)$/;
export const IMPORT_DEFINITION_PATH = /^\/definicion\/(importar)$/;
/** Subida: el tope del paquete más los campos y el marco multipart. */
export const IMPORT_UPLOAD_LIMIT = TAR_MAX_BYTES + 16 * 1024;
/** Confirmación urlencoded: base64 (4/3) y hasta 3 bytes por byte al codificar el formulario. */
export const IMPORT_FORM_LIMIT = 3 * Math.ceil(TAR_MAX_BYTES * 4 / 3) + 16 * 1024;
export type ImportKind = 'profile' | 'definition';
/** Campos de texto de cada formulario; `package` es el fichero, `payload` el paquete ya visto en la vista previa. */
export const IMPORT_FIELDS: Record<ImportKind, string[]> = { profile: ['csrf', 'ws'], definition: ['csrf', 'repo', 'slug'] };
const CONFIRM_FIELDS: Record<ImportKind, string[]> = { profile: ['csrf', 'ws', 'payload', 'digest', 'confirm'], definition: ['csrf', 'repo', 'slug', 'payload', 'digest', 'confirm'] };

// Sello de la vista previa (T105-H2): HMAC con un secreto por arranque sobre el paquete, el tipo y el destino. Sin estado:
// la confirmación solo vale para exactamente lo que este servidor previsualizó (hasta que se reinicie la web).
const SECRET = randomBytes(32);
const seal = (kind: ImportKind, bytes: Uint8Array, ...target: string[]) =>
  createHmac('sha256', SECRET).update(JSON.stringify([kind, createHash('sha256').update(bytes).digest('hex'), ...target])).digest('hex');
const sealOk = (given: string | undefined, expected: string) => !!given && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));

const bad = (m: string) => new StoreError('invalid_input', m);
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const enc = encodeURIComponent;
// Valor de un campo oculto: se escapa pero NO se redacta, o el paquete en base64 podría volverse «[REDACTED]» (como `attr` de web-ws).
const attr = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ---- validación: la misma en la vista previa y al confirmar ------------------------------------------------------
function parseProfileBytes(bytes: Uint8Array): { profile: Profile; digest: string } {
  if (!bytes.length || bytes.length > TAR_MAX_BYTES) throw bad(`el perfil debe ocupar entre 1 byte y ${TAR_MAX_BYTES} bytes`);
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw bad('el fichero no es JSON UTF-8 válido'); }
  let profile: Profile;
  try { profile = validateProfile(raw); } catch (e) { throw bad((e as Error).message); }
  return { profile, digest: profileDigest(profile) };
}

function parseDefinitionBytes(bytes: Uint8Array): ParsedDefinition & { files: Map<string, string>; digest: string } {
  const files = readTar(bytes);
  const parsed = parseDefinition(files);
  const s = parsed.settings;
  // D-F: la web no da más poder que la CLI ni fija lo que el asistente web no ofrece. Valores por defecto y ausentes pasan; el resto va por la CLI.
  const cli = (what: string) => bad(`workstream.json: ${what} solo se fija con la CLI (fab definition import)`);
  if (s.requireApproval === false || s.requireChangeApproval === false) throw cli('bajar las aprobaciones');
  if (s.verify?.length || s.verifySetup?.length) throw cli('verify y verifySetup');
  if (s.protectedPaths?.some((p: string) => !DEFAULT_PROTECTED_PATHS.includes(p)) || s.protectedPaths?.length === 0) throw cli('protectedPaths distinto del valor por defecto');
  if ((s.workerConcurrency ?? 2) !== 2 || (s.taskLimit ?? 20) !== 20) throw cli('workerConcurrency y taskLimit distintos del valor por defecto');
  return { ...parsed, files, digest: profileDigest(parsed.profile) };
}

function decodePayload(payload: string | undefined): Uint8Array {
  if (!payload || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw bad('falta el paquete de la vista previa; vuelve a subirlo');
  return Buffer.from(payload, 'base64');
}

function checkDefinitionTarget(repo: string, slug: string | undefined): string {
  const problem = repoProblem(repo);
  if (problem) throw bad(`repositorio: ${problem}`);
  if (slug && !SLUG.test(slug)) throw bad('el slug usa a-z, 0-9 y guion (máximo 63)');
  return slug ?? '';
}

// ---- vista previa --------------------------------------------------------------------------------------------------
const doc = (title: string, body: string, back: string) => new Response(`<!doctype html><html lang="es"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · fab</title><link rel="stylesheet" href="/style.css"></head><body><aside>
  <a class="brand" href="/">fab<span>Fábrica local</span></a><nav aria-label="Importar"><a href="${back}">Volver</a></nav></aside>
  <main class="config"><h1>${title}</h1>${body}</main></body></html>`, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' } });

const flat = (p: Profile): Map<string, string> => {
  const out = new Map<string, string>();
  const { worker, validators, ...rest } = p;
  for (const [k, v] of Object.entries(worker)) out.set(`worker.${k}`, v);
  for (const [k, v] of Object.entries(validators)) out.set(`validators.${k}`, v);
  for (const [k, v] of Object.entries(rest)) out.set(k, JSON.stringify(v, null, 2));
  return out;
};

function diff(before: Profile, after: Profile, escape: Escape, title = 'Cambios respecto al perfil vigente'): string {
  const a = flat(before), b = flat(after);
  const rows = [...new Set([...a.keys(), ...b.keys()])].filter(k => a.get(k) !== b.get(k)).map(k =>
    `<details open><summary><code>${escape(k)}</code></summary><p class="muted">Vigente</p><pre><code>${a.has(k) ? escape(a.get(k)!) : '(sin valor)'}</code></pre><p class="muted">Importado</p><pre><code>${b.has(k) ? escape(b.get(k)!) : '(sin valor)'}</code></pre></details>`);
  return rows.length ? `<h2>${title} (${rows.length})</h2>${rows.join('')}` : '<p>Sin diferencias con el perfil de referencia.</p>';
}

const confirmForm = (action: string, csrf: string, hidden: Record<string, string>, label: string) =>
  `<form action="${action}" method="post" class="web-action"><input type="hidden" name="csrf" value="${attr(csrf)}">${Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${k}" value="${attr(v)}">`).join('')}<label><input type="checkbox" name="confirm" value="yes" required> ${label}</label><button>Confirmar importación</button></form>`;

/** Paso 1. Solo lee: el Store va en `readonly` y no se escribe nada hasta la confirmación. */
export function importPreview(kind: ImportKind, stateDir: string, form: URLSearchParams, file: Uint8Array, csrf: string, htmlEscape: Escape): Response {
  // T105-H6: lo que se ve es lo que se importa. Los caracteres de formato y de control se pintan como marcas visibles, y si el
  // escape redacta algo con forma de secreto se avisa de que se importa entero.
  let redacted = false;
  const escape: Escape = text => {
    const visible = text.replace(/[\p{Cc}\p{Cf}]/gu, c => /[\n\r\t]/.test(c) ? c : `⟦U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟧`);
    const out = htmlEscape(visible);
    if (out.split('[REDACTED]').length > visible.split('[REDACTED]').length) redacted = true; // T105-H11: cuenta apariciones; un literal ya presente no lo silencia
    return out;
  };
  const note = () => redacted ? '<p class="notice" role="alert">Se muestra redactado texto con forma de secreto, pero se importa entero tal como viene en el paquete.</p>' : '';
  const payload = Buffer.from(file).toString('base64');
  const store = new Store(join(stateDir, 'fabrica.db'), { readonly: true });
  try {
    if (kind === 'profile') {
      const ws = store.getWorkstream(form.get('ws') ?? '');
      const { profile, digest } = parseProfileBytes(file);
      const exists = digest === DEFAULT_DIGEST || (() => { try { resolveProfile(stateDir, digest); return true; } catch { return false; } })();
      const current = resolveProfile(stateDir, ws.profile).profile;
      const body = `<p>Workstream <code>${escape(ws.slug)}</code> · digest <code>${digest}</code> · ${exists ? 'Ya existe en el almacén' : 'Nuevo'}</p>
        ${diff(current, profile, escape)}<p>Guardar crea el perfil en el almacén; no se asigna al workstream (eso es un paso aparte en Perfiles).</p>
        ${confirmForm('/perfiles/importar', csrf, { ws: ws.slug, payload, digest: seal('profile', file, ws.slug) }, 'Confirmo guardar este perfil')}`;
      return doc('Importar perfil', note() + body, `/perfiles?ws=${enc(ws.slug)}`);
    }
    const parsed = parseDefinitionBytes(file);
    const repo = form.get('repo') ?? '', slugField = (form.get('slug') ?? '').trim();
    const slug = checkDefinitionTarget(repo, slugField || undefined) || parsed.settings.slug;
    if (!SLUG.test(slug)) throw bad('el slug usa a-z, 0-9 y guion (máximo 63)');
    const taken = store.listWorkstreams().some(w => w.slug === slug);
    const known = (() => { try { resolveProfile(stateDir, parsed.digest); return true; } catch { return false; } })();
    const settings = Object.entries(parsed.settings).map(([k, v]) => `<tr><th scope="row"><code>${escape(k)}</code></th><td><pre><code>${escape(typeof v === 'string' ? v : JSON.stringify(v))}</code></pre></td></tr>`).join('');
    const names = [...parsed.files.keys()].sort().map(p => `<li><code>${escape(p)}</code> · ${Buffer.byteLength(parsed.files.get(p)!)} bytes</li>`).join('');
    const body = `<p>Se creará el workstream <code>${escape(slug)}</code> en borrador sobre <code>${escape(repo)}</code> con el perfil <code>${parsed.digest}</code> (${known ? 'ya existe' : 'nuevo'}).</p>
      ${taken ? `<p class="notice" role="alert">Ya existe un workstream con el slug ${escape(slug)}: importar no lo modifica. Elige otro slug y vuelve a subir.</p>` : ''}
      <h2>Ajustes</h2><div class="table-wrap"><table><tbody>${settings}</tbody></table></div>
      <h2>Ficheros (${parsed.files.size})</h2><ul>${names}</ul>
      ${diff(defaultProfile(), parsed.profile, escape, 'Cambios del perfil respecto al perfil por defecto')}
      ${parsed.skills.length ? `<h2>Skills del paquete</h2><p class="muted">(no se escriben en el repo)</p>${parsed.skills.map(n => `<details open><summary><code>${escape(n)}</code></summary><pre><code>${escape(parsed.files.get(`skills/${n}/SKILL.md`)!)}</code></pre></details>`).join('')}` : ''}
      <p>Nada del paquete se ejecuta. Activar el workstream es un paso explícito aparte.</p>
      ${taken ? '' : confirmForm('/definicion/importar', csrf, { repo, slug: slugField, payload, digest: seal('definition', file, repo, slugField) }, 'Confirmo crear el workstream en borrador')}`;
    return doc('Importar definición', note() + body, '/definicion');
  } finally { store.close(); }
}

// ---- confirmación: la llama el registro ACTIONS con el Store de escritura y FAB_ACTOR=web ----------------------------
export function importInput(kind: ImportKind, raw: Record<string, string | undefined>): Record<string, string | undefined> {
  if (Object.keys(raw).some(k => !CONFIRM_FIELDS[kind].includes(k))) throw bad('El formulario contiene campos inesperados.');
  if (raw.confirm !== 'yes') throw bad('Confirma la importación.');
  if (!isProfileDigest(raw.digest ?? '')) throw bad('Falta el digest de la vista previa. Vuelve a subir el paquete.');
  if (kind === 'profile' && !SLUG.test(raw.ws ?? '')) throw bad('Falta el workstream.');
  return raw;
}

/** Devuelve el destino al que redirigir. */
export function importConfirm(kind: ImportKind, store: Store, stateDir: string, input: Record<string, string | undefined>): string {
  const bytes = decodePayload(input.payload);
  if (kind === 'profile') {
    const ws = store.getWorkstream(input.ws!);
    const { profile, digest } = parseProfileBytes(bytes);
    if (!sealOk(input.digest, seal('profile', bytes, ws.slug))) throw bad('El paquete no coincide con la vista previa. Vuelve a subirlo.');
    const { created } = saveProfile(stateDir, profile);
    store.event(ws.id, 'info', `perfil importado desde la web: ${digest}${created ? '' : ' (ya existía)'}`);
    return `/perfiles?ws=${enc(ws.slug)}&digest=${digest}&nuevo=${created ? 1 : 0}`;
  }
  const parsed = parseDefinitionBytes(bytes);
  const slug = (input.slug ?? '').trim();
  const repo = input.repo ?? '';
  if (!sealOk(input.digest, seal('definition', bytes, repo, input.slug ?? ''))) throw bad('El paquete no coincide con la vista previa. Vuelve a subirlo.');
  checkDefinitionTarget(repo, slug || undefined);
  const r = applyDefinition(store, stateDir, parsed, repo, slug || undefined);
  store.event(store.getWorkstream(r.slug).id, 'info', `definición importada desde la web: perfil ${r.digest.slice(0, 12)}, ${parsed.files.size} ficheros`);
  return `/workstreams`;
}

// ---- formularios de subida (los pinta cada página) --------------------------------------------------------------------
export function importProfileForm(csrf: string, wsSlug: string): string {
  return `<section><h2>Importar perfil</h2><form action="/perfiles/importar" method="post" enctype="multipart/form-data" class="web-action"><input type="hidden" name="csrf" value="${attr(csrf)}"><input type="hidden" name="ws" value="${attr(wsSlug)}">
    <label for="import-profile">Perfil JSON (como <code>fab profile import</code>)</label><input id="import-profile" type="file" name="package" accept=".json,application/json" required><button>Vista previa</button></form></section>`;
}

export function importDefinitionForm(csrf: string): string {
  return `<section><h2>Importar definición</h2><form action="/definicion/importar" method="post" enctype="multipart/form-data" class="web-action"><input type="hidden" name="csrf" value="${attr(csrf)}">
    <label for="import-repo">Ruta absoluta del repositorio</label><input id="import-repo" name="repo" type="text" required>
    <label for="import-slug">Slug (opcional, por defecto el del paquete)</label><input id="import-slug" name="slug" type="text" maxlength="63">
    <label for="import-def">Paquete .tar (<code>tar --format=ustar -cf def.tar -C &lt;dir&gt; .</code>)</label><input id="import-def" type="file" name="package" accept=".tar" required><button>Vista previa</button></form></section>`;
}
