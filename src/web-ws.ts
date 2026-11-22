// Ajustes, archivo y alta de workstreams desde la web (T60, T61). Solo llama al Store: las reglas son suyas.
// D-F: los flags de aprobación, las rutas protegidas y merge/gate allow no se leen aquí; siguen en la CLI.
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Store, StoreError, type ProfileRunnerConsent, type Workstream } from './store.ts';
import { AGENT_NAMES } from './agents.ts';
import { agentBinStatus, PINNED_AGENTS, type AgentBinVerdict } from './agents-verify.ts';
import { verifierArgv } from './agent/mission-evidence.ts';
import { listProfiles, profileRunnerNames, resolveProfile } from './profile.ts';
import { redact } from './manifest.ts';
import { profileRunnerConfirmation } from './web-profile.ts';
import { workstreamRunner } from './web-runners.ts';

const esc = (v: unknown) => redact(String(v ?? '')).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
// Valor de un campo editable: se escapa pero no se redacta, o guardar sin tocar el campo lo sobrescribiría con [REDACTED] (T60-H1).
const attr = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const enc = encodeURIComponent;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const binLabels: Record<AgentBinVerdict, string> = { ok: 'binario verificado', distinto: 'binario distinto del pin', no_instalado: 'no instalado', sin_pin: 'sin pin' };

const input = (m: string) => new StoreError('invalid_input', m);

// ---- alta (T61) ----------------------------------------------------------
const FIELDS = ['repo', 'slug', 'goal', 'agent', 'profile', 'verify'] as const;
type Values = Record<(typeof FIELDS)[number], string>;
const STEP_OF = { repo: 0, slug: 1, goal: 1, agent: 2, profile: 2, verify: 3 } as const;
const values = (get: (k: string) => string | null): Values => Object.fromEntries(FIELDS.map(k => [k, (get(k) ?? '').trim()])) as Values;

/** Mismo criterio de repositorio para el asistente y para importar una definición (T105). */
export function repoProblem(repo: string): string | null {
  if (!isAbsolute(repo)) return 'Escribe una ruta absoluta.';
  if (!existsSync(repo) || !statSync(repo).isDirectory()) return 'La ruta no existe o no es un directorio.';
  return existsSync(join(repo, '.git')) ? null : 'La ruta no es un repositorio git (falta .git).';
}

/** Un validador por paso; devuelve el mensaje de error o null. */
const STEPS: { title: string; check(v: Values, store: Store, stateDir: string): string | null }[] = [
  { title: 'Repositorio local', check: v => repoProblem(v.repo) },
  { title: 'Objetivo', check: (v, store) => {
    if (!v.goal || v.goal.length > 2000) return 'El objetivo debe tener entre 1 y 2000 caracteres.';
    if (!SLUG.test(v.slug)) return 'El slug usa a-z, 0-9 y guion (máximo 63).';
    return store.listWorkstreams().some(w => w.slug === v.slug) ? 'Ya existe un workstream con ese slug.' : null;
  } },
  { title: 'Adaptador y perfil', check: (v, _s, stateDir) => {
    if (!AGENT_NAMES.includes(v.agent)) return 'Elige un adaptador de la lista.';
    return !v.profile || listProfiles(stateDir).includes(v.profile) ? null : 'El perfil no está guardado.';
  } },
  { title: 'Comando de verificación', check: v => {
    if (v.verify) try { verifierArgv(v.verify); } catch (e) { return `Comando no válido: ${(e as Error).message}`; }
    return null;
  } },
];

function checklist(v: Pick<Values, 'agent' | 'verify'>): string {
  const rows: [boolean, string][] = [[true, 'Repositorio git comprobado.']];
  if (PINNED_AGENTS.includes(v.agent)) {
    const s = agentBinStatus(v.agent);
    rows.push([s.verdict === 'ok', `Adaptador ${v.agent}: ${binLabels[s.verdict]}${s.verdict === 'ok' ? '' : ' (fab agents verify --pin)'}.`]);
  } else rows.push([true, `Adaptador ${v.agent}: no usa binario externo.`]);
  rows.push([!!v.verify, v.verify ? 'Comando de verificación definido.' : 'Sin comando de verificación: los changes no se validarán con tests.']);
  rows.push([false, 'Activar el workstream es un paso explícito, después de estas comprobaciones.']);
  return `<ul class="checklist">${rows.map(([ok, t]) => `<li>${ok ? 'Hecho' : 'Pendiente'}: ${esc(t)}</li>`).join('')}</ul>`;
}

function field(step: number, v: Values, stateDir: string): string {
  const val = (k: keyof Values) => attr(v[k]);
  switch (step) {
    case 0: return `<label for="f-repo">Ruta absoluta del repositorio</label><input id="f-repo" name="repo" type="text" value="${val('repo')}" required>`;
    case 1: return `<label for="f-goal">Objetivo</label><textarea id="f-goal" name="goal" rows="3" maxlength="2000" required>${val('goal')}</textarea><label for="f-slug">Slug</label><input id="f-slug" name="slug" type="text" value="${val('slug')}" pattern="[a-z0-9][a-z0-9-]*" required>`;
    case 2: return `<label for="f-agent">Adaptador</label><select id="f-agent" name="agent">${AGENT_NAMES.map(a => `<option${a === (v.agent || 'native') ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select><label for="f-profile">Perfil</label><select id="f-profile" name="profile"><option value="">Por defecto</option>${listProfiles(stateDir).map(p => `<option value="${esc(p)}"${p === v.profile ? ' selected' : ''}>${esc(p.slice(0, 12))}…</option>`).join('')}</select>`;
    default: return `<label for="f-verify">Comando de verificación (opcional)</label><input id="f-verify" name="verify" type="text" value="${val('verify')}">`;
  }
}

/** Asistente por GET: cada paso es un formulario que arrastra lo anterior y revalida los pasos previos. Solo el último escribe. */
export function wizardPage(store: Store, stateDir: string, url: URL, csrf?: string): { title: string; body: string } {
  const title = 'Nuevo workstream';
  if (!csrf) return { title, body: '<p class="notice">Crear workstreams requiere fab web --write y el enlace de acceso de la terminal.</p>' };
  const v = values(k => url.searchParams.get(k));
  const requested = Math.min(Math.max(Number(url.searchParams.get('paso')) || 1, 1), STEPS.length + 1);
  let step = 1, error: string | null = null;
  for (; step < requested; step++) if ((error = STEPS[step - 1]!.check(v, store, stateDir))) break;
  const hidden = (skip: number[]) => FIELDS.filter(k => !skip.includes(STEP_OF[k])).map(k => `<input type="hidden" name="${k}" value="${attr(v[k])}">`).join('');
  const nav = `<p class="muted">Paso ${step} de ${STEPS.length + 1}${step > 1 ? ` · <a href="/workstreams/nuevo?${new URLSearchParams({ paso: String(step - 1), ...v })}">Atrás</a>` : ''}</p>`;
  const err = error ? `<p class="notice" role="alert">${esc(error)}</p>` : '';
  if (step <= STEPS.length) return { title, body: `${nav}${err}<form action="/workstreams/nuevo" method="get" class="web-action"><fieldset><legend>${STEPS[step - 1]!.title}</legend><input type="hidden" name="paso" value="${step + 1}">${hidden([step - 1])}${field(step - 1, v, stateDir)}<button>Siguiente</button></fieldset></form>` };
  let runnerConsent = '';
  if (v.profile) {
    try { runnerConsent = profileRunnerConfirmation(store, resolveProfile(stateDir, v.profile).profile, esc); }
    catch { return { title, body: `${nav}<p class="notice">El perfil ya no está disponible.</p>` }; }
  }
  return { title, body: `${nav}<form action="/workstreams/nuevo" method="post" class="web-action"><fieldset><legend>Revisar y crear en borrador</legend><input type="hidden" name="csrf" value="${esc(csrf)}">${hidden([])}<dl><dt>Repositorio</dt><dd>${esc(v.repo)}</dd><dt>Slug</dt><dd>${esc(v.slug)}</dd><dt>Objetivo</dt><dd>${esc(v.goal)}</dd><dt>Adaptador</dt><dd>${esc(v.agent)}</dd><dt>Verificación</dt><dd>${esc(v.verify || 'Ninguna')}</dd></dl><h2>Antes de activar</h2>${checklist(v)}${runnerConsent}<button>Crear en borrador</button></fieldset></form>` };
}

// ---- lista, ajustes y archivo (T60) -----------------------------------------
function cardForms(w: Workstream, csrf: string, inProgress: number): string {
  const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  const base = `/workstreams/${enc(w.slug)}`;
  const state = (next: string, label: string) => `<form action="${base}/state" method="post" class="web-action">${hidden}<input type="hidden" name="state" value="${next}"><button>${label}</button></form>`;
  const settings = `<form action="${base}/settings" method="post" class="web-action"><fieldset><legend>Ajustes</legend>${hidden}<label for="g-${esc(w.slug)}">Objetivo</label><textarea id="g-${esc(w.slug)}" name="goal" rows="3" maxlength="2000">${attr(w.goal)}</textarea><label for="c-${esc(w.slug)}">Concurrencia de workers (1–16)</label><input id="c-${esc(w.slug)}" name="concurrency" type="number" min="1" max="16" value="${w.workerConcurrency}"><label for="t-${esc(w.slug)}">Tope de tareas (1–1000)</label><input id="t-${esc(w.slug)}" name="task_limit" type="number" min="1" max="1000" value="${w.taskLimit}"><button>Guardar ajustes</button><p class="muted">Los flags de aprobación y las rutas protegidas solo se cambian con la CLI.</p></fieldset></form>`;
  const archive = w.state === 'archived' ? '' : `<details><summary>Archivar workstream</summary><form action="${base}/archive" method="post" class="web-action">${hidden}<p>Archivar usa la misma transición que <code>fab ws state ${esc(w.slug)} archived</code>; no borra datos y se puede reabrir.${inProgress ? ` Hay ${inProgress} changes en curso.` : ''}</p><label for="a-${esc(w.slug)}">Escribe «${esc(w.slug)}» para confirmar</label><input id="a-${esc(w.slug)}" name="confirm" type="text" autocomplete="off" required><button>Archivar</button></form></details>`;
  return `<div class="ws-forms">${w.state === 'active' ? state('paused', 'Pausar') : w.state === 'archived' ? state('paused', 'Reabrir (pausado)') : state('active', 'Activar')}${settings}${archive}</div>`;
}

export function workstreamsBody(store: Store, ui: { badge(s: string): string }, csrf?: string, hideRepo = false): string {
  const list = store.listWorkstreams();
  const runners = store.listRunnerSummaries();
  const items = list.map(w => {
    let roleRunners = false;
    if (w.profile) {
      try { roleRunners = profileRunnerNames(resolveProfile(store.stateDir, w.profile).profile).length > 0; }
      catch { /* El detalle de Perfiles diagnostica perfiles ilegibles. */ }
    }
    const running = csrf ? store.changeIndex(w.slug).filter(c => c.status === 'in_progress').length : 0;
    const finish = csrf && w.state === 'draft' ? `<h3>Antes de activar</h3>${checklist({ agent: w.agent, verify: w.verify?.length ? 'definido' : '' })}` : '';
    return `<li><h2><a href="/changes?ws=${enc(w.slug)}">${esc(w.slug)}</a> ${ui.badge(w.state)}</h2><p>${esc(w.goal)}</p><p class="muted">Agente: ${esc(w.agent)} ${hideRepo ? '' : ` · ${esc(w.repo)}`} · Workers: ${w.workerConcurrency} · Tope: ${w.taskLimit}</p>${workstreamRunner(w, runners, csrf, roleRunners)}${finish}${csrf ? cardForms(w, csrf, running) : ''}</li>`;
  });
  return `<p class="intro">Frentes de trabajo y su objetivo.</p>${csrf ? '<p><a href="/workstreams/nuevo">Nuevo workstream</a></p>' : ''}<ul class="workstreams">${items.join('')}</ul>${!list.length ? '<p class="empty">No hay workstreams. Crea uno desde fab ws create.</p>' : ''}`;
}

// ---- mutaciones: las llama el registro ACTIONS (web-actions.ts), con el Store de escritura y FAB_ACTOR=web ----
export const wsFields = (raw: Record<string, string | undefined>): Values => values(k => raw[k] ?? null);

export function createWorkstream(store: Store, stateDir: string, v: Values, runnerConsent: ProfileRunnerConsent): void {
  for (const s of STEPS) { const e = s.check(v, store, stateDir); if (e) throw input(e); }
  // Mismos valores y mismos valores por defecto que `fab ws create`, sin flags de aprobación ni rutas protegidas.
  store.createWorkstream({ slug: v.slug, goal: v.goal, repo: v.repo, agent: v.agent, profile: v.profile || undefined, verify: v.verify ? [v.verify] : undefined }, runnerConsent);
}

export function workstreamSettings(store: Store, slug: string, raw: Record<string, string | undefined>): void {
  if (!SLUG.test(slug)) throw input('slug inválido');
  const num = (k: string) => raw[k] !== undefined ? Number(raw[k]) : undefined;
  store.updateWorkstreamSettings(slug, { goal: raw.goal, workerConcurrency: num('concurrency'), taskLimit: num('task_limit') });
}

export function workstreamState(store: Store, slug: string, next: string | undefined): void {
  if (!SLUG.test(slug)) throw input('slug inválido');
  if (next !== 'active' && next !== 'paused') throw input('estado no permitido');
  store.setWorkstreamState(slug, next);
}

export function archiveWorkstream(store: Store, slug: string, confirm: string | undefined): void {
  if (!SLUG.test(slug)) throw input('slug inválido');
  if (confirm !== store.getWorkstream(slug).slug) throw input('escribe el slug para confirmar');
  store.setWorkstreamState(slug, 'archived');
}
