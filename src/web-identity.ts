/**
 * Login y cuenta del modo servidor (T119b): GitHub como proveedor (OAuth de usuario, aplicación confidencial),
 * sesiones web, página de cuenta e invitación por login. Diseño T118–T119 §3.1.
 *
 * No toca `src/web.ts`: `identityRoutes(...).handle(req, ip)` devuelve `null` si la ruta no es de identidad, y T119e lo encadena.
 * La IP la pone quien llama (el proxy autenticado); este módulo nunca lee `X-Forwarded-For` ni cabeceras parecidas.
 */
import { createHash, randomBytes } from 'node:crypto';
import { StoreError, type Store } from './store.ts';
import { acceptInvitation, audit, findUserByIdentity, inviteUser, issueSession, listSessions, listUserKeys, createUserKey, resolvePrincipal,
  revokeSession, revokeUserKey, type Principal, type Role } from './users.ts';
import { authorize } from './policy.ts';
import { WEB_STYLE } from './web-style.ts';
import { LIMITS, LOGIN_COOKIE, LoginTransactions, PRELOGIN_COOKIE, RateLimiter, SESSION_COOKIE, clearCookie, constantEqual, cookieValue, csrfToken,
  originOk, preloginToken, setCookie } from './web-auth.ts';

export const GITHUB_ISSUER = 'github';
const FORM_LIMIT = 4096;

// ---- conector de GitHub ----------------------------------------------------------------------------------------

export interface GithubConfig {
  clientId: string;
  /** Referencia al secreto: se lee al usarlo, no se guarda en la configuración ni en la base. */
  clientSecret: () => string;
  /** `https://<host>` canónico de fab: de aquí sale el redirect exacto. */
  publicOrigin: string;
  /** Hosts y rutas base fijos. Los tests los apuntan a un servidor local; producción usa los de GitHub. */
  authorizeUrl?: string; tokenUrl?: string; apiBase?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}
const GH = { authorizeUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token', apiBase: 'https://api.github.com' };

/** Un solo segmento de 1 a 39 caracteres ASCII alfanuméricos, con guiones simples internos (§2). */
export const validGithubLogin = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(v) && v.length <= 39;

export class GithubError extends Error {}

export class GithubConnector {
  readonly redirectUri: string;
  private urls: typeof GH;
  constructor(private cfg: GithubConfig) {
    this.redirectUri = `${cfg.publicOrigin}/auth/callback`;
    this.urls = { authorizeUrl: cfg.authorizeUrl ?? GH.authorizeUrl, tokenUrl: cfg.tokenUrl ?? GH.tokenUrl, apiBase: cfg.apiBase ?? GH.apiBase };
  }

  /** Scope vacío (el token no opera repositorios) y PKCE S256 como defensa adicional. */
  authorizeUrl(tx: { state: string; verifier: string }): string {
    const u = new URL(this.urls.authorizeUrl);
    u.search = new URLSearchParams({ client_id: this.cfg.clientId, redirect_uri: this.redirectUri, state: tx.state, scope: '',
      code_challenge: createHash('sha256').update(tx.verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    return u.toString();
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    // Sin redirecciones (un 3xx no se sigue con credenciales) y con timeout.
    const res = await (this.cfg.fetch ?? fetch)(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 5000) });
    if (res.status >= 300 && res.status < 400) throw new GithubError('redirección inesperada');
    return res;
  }

  private static id(v: unknown): string {
    const n = (v as { id?: unknown } | null)?.id;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw new GithubError('respuesta sin ID numérico');
    return String(n);
  }

  /** Canjea el código y consulta el usuario. El token se revoca SIEMPRE tras la consulta, incluso si se deniega el alta; `onRevokeFailure` no recibe el valor. */
  async identify(code: string, verifier: string, onRevokeFailure: () => void): Promise<{ subject: string; displayName: string }> {
    const tokenRes = await this.call(this.urls.tokenUrl, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret(), code, redirect_uri: this.redirectUri, code_verifier: verifier }) });
    const body = (tokenRes.ok ? await tokenRes.json() : null) as { access_token?: unknown } | null;
    const accessToken = body?.access_token;
    if (typeof accessToken !== 'string' || !accessToken) throw new GithubError('canje rechazado');
    try {
      const res = await this.call(`${this.urls.apiBase}/user`, { headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new GithubError('consulta de usuario rechazada');
      const user = await res.json() as { id?: unknown; login?: unknown };
      return { subject: GithubConnector.id(user), displayName: typeof user.login === 'string' && user.login ? user.login.slice(0, 100) : 'github' };
    } finally {
      await this.revoke(accessToken).catch(onRevokeFailure);
    }
  }

  private async revoke(accessToken: string): Promise<void> {
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret()}`).toString('base64');
    const res = await this.call(`${this.urls.apiBase}/applications/${encodeURIComponent(this.cfg.clientId)}/token`, { method: 'DELETE',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Basic ${basic}` }, body: JSON.stringify({ access_token: accessToken }) });
    if (res.status !== 204) throw new GithubError('revocación rechazada');
  }

  /** Resuelve un login visible a su ID numérico estable. El login debe haberse validado antes: no sale a red con otra cosa. */
  async resolveLogin(login: string): Promise<{ subject: string; login: string }> {
    if (!validGithubLogin(login)) throw new GithubError('login no válido');
    const res = await this.call(`${this.urls.apiBase}/users/${login}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new GithubError('usuario no encontrado');
    const user = await res.json() as { login?: unknown };
    return { subject: GithubConnector.id(user), login: typeof user.login === 'string' ? user.login : login };
  }
}

// ---- rutas -----------------------------------------------------------------------------------------------------

export interface IdentityOptions {
  store: Store;
  github: GithubConnector;
  /** `https://<host>` canónico: Host y Origin se validan contra él. */
  publicOrigin: string;
  /** `fab web --server --write`: sin él no se emiten ni revocan claves ni se invita (§3.1). Login, logout y sesiones propias valen siempre. */
  write: boolean;
  /** Secreto de servicio para CSRF y prelogin. Por defecto aleatorio por proceso: un reinicio invalida los formularios abiertos. */
  secret?: string;
}

const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string, status = 200, cookies: string[] = [], extraHead = ''): Response {
  // Con `no-referrer` el navegador manda `Origin: null` en los POST de formulario, también al mismo origen, y `originOk` los rechazaría:
  // una página con formulario usa `same-origin` (el referente no sale de fab). Sin formulario, `no-referrer`.
  const h = new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': body.includes('<form') ? 'same-origin' : 'no-referrer' });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title>${extraHead}<style>${WEB_STYLE}</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`, { status, headers: h });
}
const redirect = (to: string, cookies: string[] = []): Response => {
  const h = new Headers({ location: to, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(null, { status: 303, headers: h });
};
const plain = (status: number, text: string, extra: Record<string, string> = {}): Response =>
  new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...extra } });
const tooMany = (retry: number): Response => plain(429, 'Demasiados intentos. Vuelve a intentarlo más tarde.', { 'retry-after': String(retry) });
/** Mismo mensaje para cuenta desconocida, dada de baja, invitación mala o proveedor caído. */
const loginDenied = (cookies: string[] = []): Response => page('No se pudo iniciar sesión', '<p>No se pudo iniciar sesión. <a href="/login">Volver a intentarlo</a>.</p>', 403, cookies);

async function formOf(req: Request): Promise<URLSearchParams | null> {
  if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers.get('content-type') ?? '')) return null;
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > FORM_LIMIT) return null;
  const text = await req.text();
  return text.length > FORM_LIMIT ? null : new URLSearchParams(text);
}

export function identityRoutes(opts: IdentityOptions) {
  const { store, github, publicOrigin } = opts;
  const host = new URL(publicOrigin).host;
  const secret = opts.secret ?? randomBytes(32).toString('hex');
  const clock = () => store.clock().getTime();
  const limiter = new RateLimiter(clock), logins = new LoginTransactions(clock);
  const system = { actor: 'service:login:github', userId: null, source: 'web' } as const;

  const session = (req: Request): Principal | null => {
    const t = cookieValue(req, SESSION_COOKIE);
    return t ? resolvePrincipal(store, t, 'web') : null;
  };
  const sessionCookie = (token: string, expiresAt: string) => setCookie(SESSION_COOKIE, token, 'Strict', Math.max(1, Math.floor((Date.parse(expiresAt) - clock()) / 1000)));

  /** Sesión + Origin + CSRF de un POST. `null` si falla, con la respuesta ya decidida. */
  async function guarded(req: Request): Promise<{ p: Principal; form: URLSearchParams } | Response> {
    const p = session(req);
    if (!p) return plain(401, 'Sesión no válida.');
    if (!originOk(req, publicOrigin)) return plain(403, 'Origen no permitido.');
    const form = await formOf(req);
    const csrf = form?.get('csrf');
    if (!form || !csrf || !constantEqual(csrf, csrfToken(secret, p.sessionId!))) return plain(403, 'Petición no válida.');
    return { p, form };
  }
  const refused = (e: unknown): Response => {
    const code = (e as StoreError).code;
    return code === 'unauthorized' ? plain(401, 'Sesión no válida.') : code === 'forbidden' ? plain(403, 'No autorizado.') : plain(code === 'conflict' || code === 'limit_reached' ? 409 : 400, 'No se pudo completar la operación.');
  };

  const csrfField = (p: Principal) => `<input type="hidden" name="csrf" value="${csrfToken(secret, p.sessionId!)}">`;

  function account(p: Principal, notice = '', extra = ''): Response {
    const sessions = listSessions(store, p);
    // D-2 A: viewer no ve ni tiene claves.
    const keys = p.role === 'viewer' ? null : listUserKeys(store, p);
    const rows = sessions.map(s => `<tr><td>${esc(s.class)}${s.current ? ' (esta)' : ''}</td><td>${esc(s.createdAt)}</td><td>${esc(s.expiresAt)}</td>
      <td><form method="post" action="/cuenta/sesiones/${esc(s.id)}/revocar">${csrfField(p)}<button>Cerrar</button></form></td></tr>`).join('');
    const keyRows = keys?.map(k => `<tr><td>${esc(k.name)}</td><td>${esc(k.scope)}</td><td>${esc(k.expiresAt ?? 'sin caducidad')}</td><td>${k.revokedAt ? 'revocada'
      : `<form method="post" action="/cuenta/claves/${esc(k.id)}/revocar">${csrfField(p)}<button>Revocar</button></form>`}</td></tr>`).join('');
    const keySection = keys === null ? '' : `<h2>Claves de API</h2>${opts.write ? `<form method="post" action="/cuenta/claves">${csrfField(p)}
      <label>Nombre <input name="name" required pattern="[a-z0-9][a-z0-9-]{0,40}"></label>
      <label>Ámbito <select name="scope"><option value="read">read</option><option value="decide">decide</option></select></label><button>Crear clave</button></form>` : '<p>El servidor corre sin <code>--write</code>: no se emiten claves.</p>'}
      <table><thead><tr><th>Nombre</th><th>Ámbito</th><th>Caduca</th><th></th></tr></thead><tbody>${keyRows}</tbody></table>`;
    return page('Cuenta', `${notice}<p>${esc(p.displayName)} · rol ${esc(p.role)}</p>
      <form method="post" action="/logout">${csrfField(p)}<button>Cerrar sesión</button></form>
      <h2>Sesiones</h2><table><thead><tr><th>Clase</th><th>Creada</th><th>Caduca</th><th></th></tr></thead><tbody>${rows}</tbody></table>${keySection}${extra}`);
  }

  async function handle(req: Request, ip: string): Promise<Response | null> {
    const url = new URL(req.url), path = url.pathname, method = req.method;
    const mine = path === '/login' || path === '/auth/start' || path === '/auth/callback' || path === '/logout' || path === '/cuenta' || (path === '/equipo/invitaciones' && req.method === 'POST')
      || /^\/cuenta\/(sesiones|claves)(\/|$)/.test(path);
    if (!mine) return null;
    if (req.headers.get('host') !== host) return plain(403, 'Host no permitido.');
    // `/auth?token=…` (el enlace de un solo uso local) no existe en servidor: no entra aquí.

    if (path === '/login' && method === 'GET') {
      const nonce = randomBytes(16).toString('hex');
      return page('Entrar', `<form method="post" action="/auth/start"><input type="hidden" name="pre" value="${preloginToken(secret, nonce)}">
        <label>Código de invitación (si tienes uno) <input name="invitation" maxlength="200" autocomplete="off"></label><button>Entrar con GitHub</button></form>`,
      200, [setCookie(PRELOGIN_COOKIE, nonce, 'Strict', 300)]);
    }

    if (path === '/auth/start' && method === 'POST') {
      if (!originOk(req, publicOrigin)) return plain(403, 'Origen no permitido.');
      const retry = limiter.hit(`ip:${ip}`, LIMITS.ipPerMin) || limiter.hit('starts', LIMITS.globalStartsPerMin);
      if (retry) return tooMany(retry);
      const form = await formOf(req), nonce = cookieValue(req, PRELOGIN_COOKIE), pre = form?.get('pre');
      if (!form || !nonce || !pre || !constantEqual(pre, preloginToken(secret, nonce))) return plain(403, 'Petición no válida.');
      const invitation = form.get('invitation')?.trim() || undefined;
      if (invitation && invitation.length > 200) return plain(400, 'Petición no válida.');
      const tx = logins.start(invitation);
      if (!tx) return tooMany(60);
      return redirect(github.authorizeUrl(tx), [setCookie(LOGIN_COOKIE, tx.bind, 'Lax', 300), clearCookie(PRELOGIN_COOKIE)]);
    }

    if (path === '/auth/callback' && method === 'GET') {
      const retry = limiter.hit(`ip:${ip}`, LIMITS.ipPerMin) || limiter.hit('exchanges', LIMITS.globalExchangesPerMin);
      if (retry) return tooMany(retry); // antes de gastar el código ni de salir a GitHub
      const gone = [clearCookie(LOGIN_COOKIE, 'Lax')];
      const code = url.searchParams.get('code');
      const tx = logins.consume(url.searchParams.get('state'), cookieValue(req, LOGIN_COOKIE));
      if (!tx || !code || code.length > 200 || url.searchParams.get('error')) return loginDenied(gone);
      let who: { subject: string; displayName: string };
      try {
        who = await github.identify(code, tx.verifier, () => audit(store, system, 'login.revoke-failed', null, undefined, 'error'));
      } catch { return loginDenied(gone); }
      try {
        let user = findUserByIdentity(store, GITHUB_ISSUER, who.subject);
        if (!user && tx.invitation) user = acceptInvitation(store, { code: tx.invitation, issuer: GITHUB_ISSUER, subject: who.subject, displayName: who.displayName });
        if (!user) return loginDenied(gone);
        // Rotación: una sesión que llegue al callback no se reutiliza; se revoca y se emite otra.
        const old = session(req);
        if (old) revokeSession(store, old, old.sessionId!);
        const s = issueSession(store, user.id, 'web');
        return page('Sesión iniciada', '<p><a href="/">Continuar al panel</a></p>', 200,
          [sessionCookie(s.token, s.expiresAt), ...gone], '<meta http-equiv="refresh" content="0;url=/">');
      } catch { return loginDenied(gone); }
    }

    if (path === '/logout' && method === 'POST') {
      const g = await guarded(req);
      if (g instanceof Response) return g;
      try { revokeSession(store, g.p, g.p.sessionId!); } catch (e) { return refused(e); }
      return redirect('/login', [clearCookie(SESSION_COOKIE)]);
    }

    if (path === '/cuenta' && method === 'GET') {
      const p = session(req);
      return p ? account(p) : redirect('/login');
    }

    const revoke = /^\/cuenta\/sesiones\/([a-f0-9]{12})\/revocar$/.exec(path);
    if (revoke && method === 'POST') {
      const g = await guarded(req);
      if (g instanceof Response) return g;
      try { revokeSession(store, g.p, revoke[1]!); } catch (e) { return refused(e); }
      return redirect(revoke[1] === g.p.sessionId ? '/login' : '/cuenta', revoke[1] === g.p.sessionId ? [clearCookie(SESSION_COOKIE)] : []);
    }

    if (path === '/cuenta/claves' && method === 'POST') {
      const g = await guarded(req);
      if (g instanceof Response) return g;
      try {
        const k = createUserKey(store, g.p, g.form.get('name') ?? '', g.form.get('scope') as 'read' | 'decide', { write: opts.write });
        return account(g.p, `<p>Clave creada. Cópiala ahora: no se vuelve a mostrar.</p><p><code>${esc(k.key)}</code></p>`);
      } catch (e) { return refused(e); }
    }

    const keyRevoke = /^\/cuenta\/claves\/([a-f0-9]{12})\/revocar$/.exec(path);
    if (keyRevoke && method === 'POST') {
      const g = await guarded(req);
      if (g instanceof Response) return g;
      try { revokeUserKey(store, g.p, keyRevoke[1]!, opts.write); } catch (e) { return refused(e); }
      return redirect('/cuenta');
    }

    if (path === '/equipo/invitaciones' && method === 'POST') {
      const g = await guarded(req);
      if (g instanceof Response) return g;
      const login = g.form.get('login') ?? '', role = g.form.get('role') as Role;
      // La política va antes de la red: quien no puede invitar no gasta cuota ni llama a GitHub.
      const d = authorize(g.p, 'user/invite', { via: 'web', write: opts.write, inviteRole: role });
      if (!d.ok) return plain(403, 'No autorizado.');
      if (!validGithubLogin(login)) return plain(400, 'Login no válido.');
      const retry = limiter.hit(`inviter:${g.p.userId}`, LIMITS.inviterPerMin) || limiter.hit('invites', LIMITS.globalInvitesPerMin);
      if (retry) return tooMany(retry);
      try {
        const who = await github.resolveLogin(login);
        const inv = inviteUser(store, g.p, { expectedIssuer: GITHUB_ISSUER, expectedSubject: who.subject, role });
        return page('Invitación creada', `<p>${esc(who.login)} · ID de GitHub ${esc(who.subject)} · rol ${esc(role)}. Caduca ${esc(inv.expiresAt)}.</p>
          <p>Código (se muestra una vez, entrégalo fuera de banda): <code>${esc(inv.code)}</code></p>`);
      } catch (e) { return e instanceof StoreError ? refused(e) : plain(502, 'No se pudo resolver el usuario.'); }
    }

    return plain(404, 'No encontrado.');
  }

  return { handle, principalOf: session };
}
