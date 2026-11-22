/**
 * CLI remota, lado servidor (T119c, diseño §3.1, §4.2, §4.4): pareo de la terminal y despacho tipado `/cli/v1/commands`.
 * `cliRoutes(opts).handle(req, ip)` devuelve `null` si la ruta no es suya: T119e lo encadena junto a `identityRoutes`.
 *
 * Pareo: la CLI manda el SHA-256 de un verificador que solo ella guarda; el servidor devuelve un código visible de un uso. La persona lo teclea
 * en la URL fija y confirma en un segundo paso (sesión + Origin + CSRF); la URL nunca precarga ni aprueba un código. El canje exige el
 * verificador original y consume el pareo. Todo en memoria, con TTL y tope: un reinicio invalida los pareos pendientes.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Store, StoreError } from './store.ts';
import {
  createUserKey, inviteUser, issueSession, listInvitations, listSessions, listUserKeys, listUsers, resolvePrincipal, revokeInvitation, revokeSession,
  revokeUserKey, changeUserRole, disableUser, actorOf, runAs, type Principal, type Role,
} from './users.ts';
import { AdmissionDb, hasAdmission } from './admission/db.ts';
import { linkTriagedSignal } from './admission/apply.ts';
import { dismissCandidate } from './improve-auto.ts';
import { listProfiles } from './profile.ts';
import { VALIDATOR_KINDS, type ValidatorKind } from './connectors/types.ts';
import { authorize } from './policy.ts';
import { ACTIONS, InputError, performAction } from './web-actions.ts';
import { route } from './web-api.ts';
import { extraRoute } from './web-reads.ts';
import { constantEqual, cookieValue, csrfToken, originOk, RateLimiter, SESSION_COOKIE } from './web-auth.ts';
import { jiraImportAction } from './web-entrada.ts';
import { runnerCheckAction } from './web-runner-check.ts';
import { preauthorize } from './web-who.ts';
import { repoByAlias } from './web-server-guards.ts';
import { ProfileInputError, profileAction } from './web-profile.ts';
import { previewResolveWork, resolveWork } from './users-work.ts';
import { seal, IMPORT_UPLOAD_LIMIT } from './web-import.ts';
import { validateNoteAttachment } from './note-attachments.ts';
import { GITHUB_ISSUER, validGithubLogin, GithubQuotaError } from './web-identity.ts';
import { LIMITS } from './web-auth.ts';

export const PAIR_TTL_MS = 5 * 60_000;
export const IMPORT_SEAL_TTL_MS = 10 * 60_000;
export const PAIR_PENDING_MAX = 1000;
export const PAIR_ATTEMPTS_PER_CODE = 5;
export const PAIR_PER_FLOW_PER_MIN = 5;
const COMMAND_LIMIT = 128 * 1024;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

interface Pairing { code: string; challenge: string; ip: string; startedAt: number; expiresAt: number; approvedBy?: { userId: string; role: Role }; shownTo?: string; attempts: number; badExchanges: number }

/** Pareos pendientes: el código visible no es el comprobante secreto (el verificador no sale de la terminal). */
export class CliPairings {
  private pending = new Map<string, Pairing>();
  constructor(private clock: () => number) {}
  private sweep() { const now = this.clock(); for (const [k, v] of this.pending) if (v.expiresAt <= now) this.pending.delete(k); }
  start(challenge: string, ip: string): Pairing | null {
    this.sweep();
    if (this.pending.size >= PAIR_PENDING_MAX) return null;
    let code = '';
    do { const b = randomBytes(8); code = [...b].map(x => CODE_ALPHABET[x % CODE_ALPHABET.length]).join(''); } while (this.pending.has(code));
    const now = this.clock(), p: Pairing = { code, challenge, ip, startedAt: now, expiresAt: now + PAIR_TTL_MS, attempts: 0, badExchanges: 0 };
    this.pending.set(code, p);
    return p;
  }
  /** Busca un código tecleado por la persona; cada consulta cuenta contra el tope por código. */
  lookup(code: string): Pairing | null {
    this.sweep();
    const p = this.pending.get(code.toUpperCase().replace(/[^A-Z0-9]/g, ''));
    if (!p) return null;
    if (++p.attempts > PAIR_ATTEMPTS_PER_CODE) { this.pending.delete(p.code); return null; }
    return p;
  }
  /** Canje: exige aprobación y el verificador original. Un verificador ajeno da `'bad'` sin gastar nada: quien llama lo cuenta con `fail`
   *  (solo si no fue un 429). Los intentos de la página de aprobación (`lookup`) y los canjes ajenos tienen contadores separados. */
  exchange(code: string, verifier: string): Pairing | 'pending' | 'bad' | null {
    this.sweep();
    const p = this.pending.get(code);
    if (!p) return null;
    if (!constantEqual(sha(verifier), p.challenge)) return 'bad';
    if (!p.approvedBy) return 'pending';
    this.pending.delete(code);
    return p;
  }
  /** Cuenta un canje fallido; pasado el tope el pareo se descarta. */
  fail(code: string) {
    const p = this.pending.get(code);
    if (p && ++p.badExchanges > PAIR_ATTEMPTS_PER_CODE * 4) this.pending.delete(code);
  }
}

export interface CliRoutesOptions {
  stateDir: string;
  publicOrigin: string;
  write: boolean;
  /** Secreto de servicio del CSRF (el mismo que `identityRoutes`). */
  secret: string;
  clock?: () => number;
  /** Compartido con `identityRoutes` si T119e lo quiere (mismas cuotas de invitación); si no, uno propio. */
  limiter?: RateLimiter;
  /** Resuelve un login de GitHub a su ID numérico (`GithubConnector.resolveLogin`). */
  resolveLogin?: (login: string) => Promise<{ login: string; subject: string }>;
  runnerCheck?: ReturnType<typeof runnerCheckAction>;
  jiraImport?: ReturnType<typeof jiraImportAction>;
}

const HEAD = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...HEAD, ...extra } });
const ok = (data: unknown) => json(200, { ok: true, data });
const fail = (status: number, code: string, message: string, extra: Record<string, string> = {}) => json(status, { ok: false, error: { code, message } }, extra);
const STATUS: Record<string, number> = { not_found: 404, invalid_input: 400, conflict: 409, invalid_transition: 409, limit_reached: 409, forbidden: 403, unauthorized: 401 };
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const page = (title: string, body: string, status = 200) => new Response(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': body.includes('<form') ? 'same-origin' : 'no-referrer' } });

async function readJson(req: Request, max: number): Promise<Record<string, unknown> | Response> {
  if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) return fail(415, 'unsupported_media_type', 'se exige application/json');
  if (Number(req.headers.get('content-length')) > max) return fail(413, 'payload_too_large', 'cuerpo demasiado grande');
  const reader = req.body?.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return fail(413, 'payload_too_large', 'cuerpo demasiado grande'); }
    chunks.push(value);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail(400, 'invalid_input', 'el cuerpo debe ser un objeto');
  } catch { return fail(400, 'invalid_input', 'JSON inválido'); }
}

/** Texto sin metadatos de otros: los viewers no reciben texto libre generado por workers (§4.2). */
const FREE_TEXT = new Set(['result', 'error', 'reviewComment', 'summary']);
/** Proyección por ruta: el mensaje de un evento lleva texto libre tras el primer «: » (motivo, comentario, título), que un viewer no recibe. */
export function viewerRead(path: string, v: unknown): unknown {
  const data = viewerProjection(v);
  return path === '/events' && Array.isArray(data) ? data.map(e => ({ ...e, message: String(e.message).split(': ')[0] })) : data;
}
export function viewerProjection(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(viewerProjection);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, FREE_TEXT.has(k) ? null : viewerProjection(x)]));
  return v;
}

type Fields = Record<string, string>;
interface Command { op: string; id: string; fields: Fields; confirm?: string; opId?: string; file?: { name: string; base64: string } }

function parseCommand(body: Record<string, unknown>): Command | string {
  const allowed = ['op', 'id', 'fields', 'confirm', 'opId', 'file'];
  if (Object.keys(body).some(k => !allowed.includes(k))) return 'campos inesperados';
  const { op, id, fields, confirm, opId, file } = body;
  if (typeof op !== 'string' || !/^[a-z0-9/-]{1,60}$/.test(op)) return 'op inválida';
  if (id !== undefined && (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id))) return 'id inválido';
  if (fields !== undefined && (typeof fields !== 'object' || fields === null || Array.isArray(fields) || Object.values(fields).some(x => typeof x !== 'string'))) return 'fields debe ser un objeto de textos';
  if (confirm !== undefined && typeof confirm !== 'string') return 'confirm inválido';
  if (opId !== undefined && typeof opId !== 'string') return 'opId inválido';
  if (file !== undefined && !(typeof file === 'object' && file && typeof (file as { name?: unknown }).name === 'string' && typeof (file as { base64?: unknown }).base64 === 'string')) return 'file inválido';
  return { op, id: (id as string) ?? '', fields: { ...(fields as Fields | undefined) }, confirm: confirm as string | undefined, opId: opId as string | undefined, file: file as Command['file'] };
}

export const IMPORT_OPS = { 'perfiles/importar': 'profile', 'definicion/importar': 'definition' } as const;
/** Operaciones remotas: las acciones de la tabla ACTIONS (menos las claves, que van por `api-key/*`) y las de identidad, lectura y cuenta. */
export const REMOTE_ACTION_OPS = (): string[] => [...Object.keys(ACTIONS).filter(n => !n.startsWith('api-keys/')), 'perfiles/guardar', 'perfiles/asignar'];
export const REMOTE_VERB_OPS = ['triage/all', 'validate/run', 'improve/dismiss', 'runner/enable', 'runner/disable', 'config/read'] as const;
export const REMOTE_IDENTITY_OPS = ['api-key/create', 'api-key/list', 'api-key/revoke', 'session/list', 'session/revoke', 'session/logout', 'user/list', 'user/invite', 'user/revoke-invite', 'user/role', 'user/disable', 'user/resolve-work', 'ops/read'] as const;

export function cliRoutes(opts: CliRoutesOptions) {
  const clock = opts.clock ?? (() => Date.now());
  const host = new URL(opts.publicOrigin).host;
  const limiter = opts.limiter ?? new RateLimiter(clock), pairings = new CliPairings(clock);
  const runnerCheck = opts.runnerCheck ?? runnerCheckAction(opts.stateDir);
  const jira = opts.jiraImport ?? jiraImportAction(opts.stateDir);
  /** Revisiones de importación ya gastadas, hasta su caducidad (§4: confirmación de un uso). En memoria: un reinicio del servidor ya las invalida por la caducidad corta. */
  const spent = new Map<string, number>();
  const open = () => new Store(join(opts.stateDir, 'fabrica.db'), { clock: () => new Date(clock()) });

  const webSession = (store: Store, req: Request): Principal | null => { const t = cookieValue(req, SESSION_COOKIE); return t ? resolvePrincipal(store, t, 'web') : null; };

  async function pairStart(req: Request, ip: string): Promise<Response> {
    const retry = limiter.hit(`pair-ip:${ip}`, LIMITS.ipPerMin) || limiter.hit('pair-start', LIMITS.globalStartsPerMin);
    if (retry) return fail(429, 'rate_limited', 'demasiados intentos', { 'retry-after': String(retry) });
    const body = await readJson(req, 1024);
    if (body instanceof Response) return body;
    if (typeof body.challenge !== 'string' || !/^[0-9a-f]{64}$/.test(body.challenge)) return fail(400, 'invalid_input', 'desafío inválido');
    const p = pairings.start(body.challenge, ip);
    if (!p) return fail(429, 'rate_limited', 'demasiados pareos pendientes', { 'retry-after': '60' });
    return ok({ code: `${p.code.slice(0, 4)}-${p.code.slice(4)}`, url: `${opts.publicOrigin}/cuenta/cli/autorizar`, expiresIn: PAIR_TTL_MS / 1000 });
  }

  function pairExchange(store: Store, req: Request, ip: string, body: Record<string, unknown>): Response {
    const code = typeof body.code === 'string' ? body.code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '', verifier = body.verifier;
    if (!/^[A-Z0-9]{8}$/.test(code) || typeof verifier !== 'string' || verifier.length < 32 || verifier.length > 200) return fail(400, 'invalid_input', 'petición inválida');
    const r = pairings.exchange(code, verifier);
    if (r === 'pending') return fail(409, 'conflict', 'el pareo aún no está aprobado');
    if (!r || r === 'bad' || !r.approvedBy) {
      // El tope protege contra verificadores ajenos: solo los canjes fallidos lo gastan, y un 429 no cuenta.
      const retry = limiter.hit(`pair-ip:${ip}`, LIMITS.ipPerMin) || limiter.hit(`pair-code:${code}`, PAIR_PER_FLOW_PER_MIN);
      if (r === 'bad' && !retry) pairings.fail(code);
      return retry ? fail(429, 'rate_limited', 'demasiados intentos', { 'retry-after': String(retry) }) : fail(403, 'forbidden', 'pareo no válido');
    }
    try {
      const s = issueSession(store, r.approvedBy.userId, 'cli');
      return ok({ token: s.token, expiresAt: s.expiresAt });
    } catch { return fail(403, 'forbidden', 'pareo no válido'); }
  }

  async function authorizePage(req: Request, ip: string): Promise<Response> {
    const store = open();
    try {
      const p = webSession(store, req);
      if (!p) return new Response(null, { status: 303, headers: { location: '/login', 'cache-control': 'no-store' } });
      const csrf = csrfToken(opts.secret, p.sessionId!);
      const hidden = `<input type="hidden" name="csrf" value="${csrf}">`;
      if (req.method === 'GET') {
        // Nunca precarga ni aprueba un código de la URL.
        return page('Autorizar la CLI', `<form method="post" action="/cuenta/cli/autorizar">${hidden}<label>Código de la terminal <input name="code" required maxlength="12" autocomplete="off"></label><button>Continuar</button></form>`);
      }
      if (!originOk(req, opts.publicOrigin)) return new Response('Origen no permitido.', { status: 403 });
      const retry = limiter.hit(`ip:${ip}`, LIMITS.ipPerMin);
      if (retry) return fail(429, 'rate_limited', 'demasiados intentos', { 'retry-after': String(retry) });
      const form = new URLSearchParams(await req.text());
      if (!constantEqual(form.get('csrf') ?? '', csrf)) return new Response('Petición no válida.', { status: 403 });
      const pairing = pairings.lookup(form.get('code') ?? '');
      if (!pairing) return page('Código no válido', '<p>El código no es válido o caducó. Vuelve a empezar desde la terminal.</p>', 400);
      // Un pareo ya aprobado no se reaprueba (otra persona no puede quedarse la sesión).
      if (pairing.approvedBy) return page('Código ya usado', '<p>Este código ya se aprobó.</p>', 409);
      // La confirmación solo vale si esta persona vio antes el paso 1: un POST directo con `confirm=yes` no aprueba.
      if (form.get('confirm') !== 'yes' || pairing.shownTo !== p.userId) {
        pairing.shownTo = p.userId;
        return page('Confirma la terminal', `<p>Se pedirá una sesión de CLI para <strong>${esc(p.displayName)}</strong>, rol <strong>${esc(p.role)}</strong>.</p>
          <dl><dt>Servidor</dt><dd>${esc(host)}</dd><dt>Origen de la solicitud</dt><dd>${esc(pairing.ip)}</dd><dt>Hora</dt><dd>${esc(new Date(pairing.startedAt).toISOString())}</dd>
          <dt>Alcance</dt><dd>sesión de CLI de 1 hora; ${opts.write ? 'lecturas y mutaciones según tu rol' : 'solo lectura (el servidor corre sin --write)'}</dd></dl>
          <p>Confirma solo si el código lo mostró <em>tu</em> terminal.</p>
          <form method="post" action="/cuenta/cli/autorizar">${hidden}<input type="hidden" name="code" value="${esc(pairing.code)}"><input type="hidden" name="confirm" value="yes"><button>Sí, es mi terminal</button></form>`);
      }
      pairing.approvedBy = { userId: p.userId, role: p.role };
      return page('Terminal autorizada', '<p>Vuelve a la terminal: el pareo continúa solo.</p>');
    } finally { store.close(); }
  }

  const principalOf = (store: Store, req: Request): Principal | null => {
    const m = /^Bearer (fabs_\S+)$/.exec(req.headers.get('authorization') ?? '');
    return m ? resolvePrincipal(store, m[1]!, 'cli') : null;
  };

  async function command(req: Request, ip: string): Promise<Response> {
    const store = open();
    try {
      const p = principalOf(store, req);
      if (!p) return fail(401, 'unauthorized', 'sesión de CLI ausente o inválida');
      const raw = await readJson(req, Math.ceil(IMPORT_UPLOAD_LIMIT * 4 / 3) + COMMAND_LIMIT);
      if (raw instanceof Response) return raw;
      const cmd = parseCommand(raw);
      if (typeof cmd === 'string') return fail(400, 'invalid_input', cmd);
      try { return ok(await dispatch(store, p, cmd, ip)); }
      catch (e) {
        if (e instanceof StoreError) return fail(STATUS[e.code] ?? 500, e.code, e.code === 'forbidden' || e.code === 'unauthorized' ? 'no autorizado' : e.message);
        if (e instanceof Response) return e;
        // Un campo que falta o una confirmación ausente es del cliente: 4xx con su explicación, no un 500.
        if (e instanceof InputError) return fail(e.status >= 400 && e.status < 500 ? e.status : 400, 'invalid_input', e.message);
        return fail(500, 'error', 'error interno');
      }
    } finally { store.close(); }
  }

  const gate = (p: Principal, capability: string, ctx: { target?: 'own' | 'other'; inviteRole?: Role } = {}) => {
    const d = authorize(p, capability, { via: 'cli', write: opts.write, ...ctx });
    if (!d.ok) throw new StoreError('forbidden', `no autorizado (${d.reason})`);
  };

  async function dispatch(store: Store, p: Principal, cmd: Command, ip: string): Promise<unknown> {
    const who = { principal: p, write: opts.write };
    const { op, id, fields } = cmd;
    if (op === 'perfiles/guardar' || op === 'perfiles/asignar') {
      preauthorize(opts.stateDir, who, op);
      try { return result(profileAction(opts.stateDir, op === 'perfiles/guardar' ? 'guardar' : 'asignar', new URLSearchParams(fields), who)); }
      catch (e) { if (e instanceof ProfileInputError) throw new StoreError('invalid_input', e.message); throw e; }
    }
    if (Object.hasOwn(ACTIONS, op) && !op.startsWith('api-keys/')) {
      // La política va antes de resolver objetos, de la red y de validar campos (§4.1).
      preauthorize(opts.stateDir, who, op);
      if (op === 'jira/import') return jira(new URLSearchParams(fields), who);
      if (op === 'runners/check') { const r = await runnerCheck(id, () => {}); return { status: r.status, text: (await r.text()).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000) }; }
      let attachment;
      if (cmd.file) {
        if (op !== 'changes/note' && !Object.hasOwn(IMPORT_OPS, op)) throw new StoreError('invalid_input', 'esta operación no admite fichero');
        attachment = { name: cmd.file.name, bytes: new Uint8Array(Buffer.from(cmd.file.base64, 'base64')) };
        // Los límites de una nota no valen para un paquete de importación: lo valida su propio parser.
        const invalid = op === 'changes/note' ? validateNoteAttachment(attachment) : null;
        if (invalid) throw new StoreError('invalid_input', invalid);
      }
      if (Object.hasOwn(IMPORT_OPS, op)) {
        // Vista previa y confirmación: sin `confirm` devuelve la revisión del paquete; con ella repetida se importa.
        const kind = IMPORT_OPS[op as keyof typeof IMPORT_OPS];
        if (!cmd.file) throw new StoreError('invalid_input', 'falta el paquete');
        if (kind === 'definition') fields.repo = repoByAlias(opts.stateDir, fields.repo ?? ''); // alias del inventario → ruta real
        const target = kind === 'profile' ? [fields.ws ?? ''] : [fields.repo ?? '', fields.slug ?? ''];
        // La revisión se liga al usuario y a la sesión y caduca; `base` es el sello que la acción comprueba al importar.
        const base = seal(kind, attachment!.bytes, ...target);
        const bound = (exp: number) => seal(kind, attachment!.bytes, 'cli', p.userId, p.sessionId ?? '', String(exp), ...target);
        if (cmd.confirm === undefined) { const exp = clock() + IMPORT_SEAL_TTL_MS; return { preview: { kind, bytes: attachment!.bytes.byteLength, target }, revision: `${exp}.${bound(exp)}` }; }
        const [exp, given] = cmd.confirm.split('.'), expNum = Number(exp);
        if (!Number.isSafeInteger(expNum) || expNum <= clock() || !given || !constantEqual(given, bound(expNum))) throw new StoreError('conflict', 'la revisión no coincide o caducó: repite la vista previa');
        for (const [k, until] of spent) if (until <= clock()) spent.delete(k);
        if (spent.has(cmd.confirm)) throw new StoreError('conflict', 'la revisión ya se usó: repite la vista previa');
        spent.set(cmd.confirm, expNum);
        const input = { ...fields, payload: Buffer.from(attachment!.bytes).toString('base64'), digest: base, confirm: 'yes' };
        return result(await performAction(opts.stateDir, op, id, input, who, undefined, { server: true }));
      }
      return result(await performAction(opts.stateDir, op, id, fields, who, attachment, { server: true }));
    }
    switch (op) {
      case 'ops/read': {
        gate(p, 'ops/read');
        const path = fields.path ?? '';
        if (!/^\/[\w/?=&.-]{0,200}$/.test(path)) throw new StoreError('invalid_input', 'ruta de lectura inválida');
        const url = new URL(`http://x${path}`);
        const data = route(store, url, url.pathname) ?? extraRoute(store, url, url.pathname);
        if (data === undefined) throw new StoreError('not_found', 'ruta no encontrada');
        return p.role === 'viewer' ? viewerRead(url.pathname, data) : data;
      }
      case 'triage/all': return verb(store, p, 'triage/all', () => {
        // Lote: sin `confirm` solo cuenta las señales (ids, no títulos) y da la revisión del lote; con ella repetida se tria.
        const batch = store.listSignals(fields.ws ?? '', 'new');
        const revision = createHmac('sha256', opts.secret).update(JSON.stringify(['triage/all', p.userId, fields.ws, batch.map(s => s.id)])).digest('hex');
        if (cmd.confirm === undefined) return { preview: { count: batch.length, signals: batch.map(s => s.id) }, revision };
        if (!constantEqual(cmd.confirm, revision)) throw new StoreError('conflict', 'el lote cambió o la revisión no coincide: repite la vista previa');
        const done = batch.map(sig => {
          const c = store.triageSignal(sig.id);
          if (hasAdmission(store)) linkTriagedSignal(new AdmissionDb(store), sig.id, c.id);
          return { signal: sig.id, change: c.id };
        });
        return { triaged: done };
      });
      case 'validate/run': return verb(store, p, 'validate/run', () => {
        const only = fields.only ? fields.only.split(',').map(x => x.trim()) : [...VALIDATOR_KINDS];
        const bad = only.find(k => !VALIDATOR_KINDS.includes(k as ValidatorKind));
        if (bad) throw new StoreError('invalid_input', `validador desconocido «${bad}»`);
        return { queued: store.requestValidation(id, only as ValidatorKind[]).map(a => a.id) };
      });
      case 'improve/dismiss': return verb(store, p, 'improve/dismiss', () => { dismissCandidate(store, id); return {}; });
      case 'runner/enable': case 'runner/disable': return verb(store, p, op, () => { const r = store.setRunnerEnabled(id, op === 'runner/enable'); return { name: r.name, enabled: r.enabled }; });
      case 'config/read': {
        gate(p, 'config/read');
        // Nombres, no destinos ni secretos: el destino SSH del runner es del operador.
        const what = fields.what ?? '';
        if (what === 'runner list') return store.listRunners().map(r => ({ name: r.name, kind: r.kind, enabled: r.enabled }));
        if (what === 'profile list') return listProfiles(opts.stateDir);
        if (what === 'ws access') { const w = store.getWorkstream(id); return { slug: w.slug, env: w.envAllow, mcp: w.mcpAllow }; }
        throw new StoreError('invalid_input', 'lectura de configuración desconocida');
      }
      case 'api-key/list': gate(p, 'api-key/list', { target: fields.all === 'yes' ? 'other' : 'own' }); return listUserKeys(store, p, { all: fields.all === 'yes' });
      case 'api-key/create': gate(p, 'api-key/create'); return createUserKey(store, p, fields.name ?? '', fields.scope as 'read' | 'decide', { write: opts.write });
      case 'api-key/revoke': gate(p, 'api-key/revoke', { target: fields.target === 'other' ? 'other' : 'own' }); revokeUserKey(store, p, id, opts.write); return {};
      case 'session/list': gate(p, 'session/list'); return listSessions(store, p);
      case 'session/revoke': gate(p, 'session/revoke'); revokeSession(store, p, id); return {};
      case 'session/logout': gate(p, 'session/logout'); revokeSession(store, p, p.sessionId!); return {};
      case 'user/list': gate(p, 'user/list'); return [listUsers(store, p).map(u => ({ id: u.id, displayName: u.displayName, role: u.role, issuer: u.issuer, disabled: !!u.disabledAt })), listInvitations(store, p).filter(i => !i.consumedAt && !i.revokedAt)];
      case 'user/revoke-invite': gate(p, 'user/revoke-invite', { inviteRole: 'member' }); revokeInvitation(store, p, id); return {};
      case 'user/role': gate(p, 'user/role'); return changeUserRole(store, p, id, fields.role as Role);
      case 'user/disable': gate(p, 'user/disable'); disableUser(store, p, id); return {};
      case 'user/invite': return invite(store, p, fields, ip);
      case 'user/resolve-work': return resolve(store, p, id, fields, cmd);
      default: throw new StoreError('not_found', 'operación desconocida');
    }
  }

  /** Verbos de §4.2 sin acción web: política y revalidación en la transacción, con el usuario de la sesión como actor de los eventos. */
  const verb = <T>(store: Store, p: Principal, capability: string, fn: () => T): T => runAs(store, p, capability, { write: opts.write }, me => {
    store.asActor({ ...actorOf(me), role: me.role });
    try { return fn(); } finally { store.asActor(undefined); }
  });

  const CONFLICTS = ['conflict', 'invalid_transition', 'limit_reached', 'workstream_busy'];
  const result = (out: { destination: string; result: string }) => {
    if (out.result === 'ok' || out.result.startsWith('skipped_')) return { destination: out.destination, result: out.result };
    if (out.result === 'forbidden' || out.result === 'unauthorized' || out.result === 'not_found' || out.result === 'invalid_input') throw new StoreError(out.result, out.result === 'forbidden' || out.result === 'unauthorized' ? 'no autorizado' : out.result === 'invalid_input' ? 'revisa los campos de la acción (alguno falta o no es válido)' : out.result);
    if (CONFLICTS.includes(out.result)) throw new StoreError('conflict', out.result);
    throw new Error(out.result);
  };

  async function invite(store: Store, p: Principal, f: Fields, ip: string) {
    const role = f.role as Role;
    gate(p, 'user/invite', { inviteRole: role }); // la política va antes de la cuota y de la red
    if (!['admin', 'member', 'viewer'].includes(role)) throw new StoreError('invalid_input', 'rol no válido');
    if (!validGithubLogin(f.login)) throw new StoreError('invalid_input', 'login no válido');
    const retry = limiter.hit(`inviter:${p.userId}`, LIMITS.inviterPerMin) || limiter.hit('invites', LIMITS.globalInvitesPerMin);
    if (retry) throw json(429, { ok: false, error: { code: 'rate_limited', message: 'demasiadas invitaciones' } }, { 'retry-after': String(retry) });
    if (!opts.resolveLogin) throw new StoreError('conflict', 'el servidor no resuelve logins de GitHub');
    let who: { login: string; subject: string };
    try { who = await opts.resolveLogin(f.login!); }
    catch (e) { throw e instanceof GithubQuotaError ? json(503, { ok: false, error: { code: 'unavailable', message: 'GitHub no responde ahora' } }, { 'retry-after': '60' }) : new StoreError('conflict', 'no se pudo resolver el usuario'); }
    const inv = inviteUser(store, p, { expectedIssuer: GITHUB_ISSUER, expectedSubject: who.subject, role });
    return { login: who.login, subject: who.subject, role, code: inv.code, expiresAt: inv.expiresAt };
  }

  async function resolve(store: Store, p: Principal, userId: string, f: Fields, cmd: Command) {
    gate(p, 'user/resolve-work');
    if (!userId) throw new StoreError('invalid_input', 'falta el usuario');
    const modes = (f.reassignTo ? 1 : 0) + (f.cancel === 'yes' ? 1 : 0);
    if (modes > 1) throw new StoreError('invalid_input', 'elige un único modo');
    if (cmd.confirm === undefined) return previewResolveWork(store, p, userId, opts.write);
    if (modes !== 1) throw new StoreError('invalid_input', 'elige --reassign-to o --cancel');
    return resolveWork(store, p, userId, f.reassignTo ? { reassignTo: f.reassignTo } : { cancel: true }, f.reason ?? '', cmd.confirm, cmd.opId ?? '', opts.write);
  }

  async function handle(req: Request, ip: string): Promise<Response | null> {
    const url = new URL(req.url), path = url.pathname;
    const mine = path === '/cli/v1/pair/start' || path === '/cli/v1/pair/exchange' || path === '/cli/v1/commands' || path === '/cuenta/cli/autorizar';
    if (!mine) return null;
    if (req.headers.get('host') !== host) return new Response('Host no permitido.', { status: 403 });
    if (path === '/cuenta/cli/autorizar') return req.method === 'GET' || req.method === 'POST' ? authorizePage(req, ip) : new Response('Método no permitido.', { status: 405 });
    if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'método no permitido');
    if (path === '/cli/v1/pair/start') return pairStart(req, ip);
    if (path === '/cli/v1/pair/exchange') {
      const body = await readJson(req, 2048);
      if (body instanceof Response) return body;
      const store = open();
      try { return pairExchange(store, req, ip, body); } finally { store.close(); }
    }
    return command(req, ip);
  }

  return { handle, pairings };
}
