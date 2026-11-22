import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';

const token = () => randomBytes(32).toString('hex');
const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Credenciales efímeras del proceso; nunca se persisten ni se incluyen en eventos. */
export class WebAuth {
  /** Host único por arranque: la cookie es de este host y ningún otro servicio de loopback la recibe (F2 H1). */
  readonly host = `fab-${randomBytes(8).toString('hex')}.localhost`;
  private invitation: string | null = token();
  private session: string | null = null;
  private csrf: string | null = null;
  private notice?: { path: string; result: string };

  loginUrl(port: number): string { return `http://${this.host}:${port}/auth?token=${this.invitation}`; }

  exchange(value: string): Response {
    if (!this.invitation || !equal(value, this.invitation)) return new Response('Acceso rechazado: token inválido o utilizado.', { status: 401 });
    this.invitation = null;
    this.session = token(); this.csrf = token();
    return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': `fab_session=${this.session}; HttpOnly; SameSite=Strict; Path=/` } });
  }

  sessionCsrf(req: Request): string | undefined {
    const values = (req.headers.get('cookie') ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith('fab_session='));
    if (values.length !== 1 || !this.session || !equal(values[0]!.slice('fab_session='.length), this.session)) return;
    return this.csrf!;
  }

  rememberNotice(req: Request, path: string, result: string): void {
    if (this.sessionCsrf(req)) this.notice = { path, result };
  }

  takeNotice(req: Request, path: string): string | undefined {
    if (!this.sessionCsrf(req) || this.notice?.path !== path) return;
    const result = this.notice.result;
    this.notice = undefined;
    return result;
  }

  validCsrf(req: Request, value: string): boolean {
    const expected = this.sessionCsrf(req);
    return !!expected && equal(value, expected);
  }
}

/** Falla cerrado si el sistema no resuelve `host` a loopback: sin eso la sesión de escritura no puede servirse. */
export async function assertLoopback(host: string, resolve: (host: string) => Promise<{ address: string }[]> = h => lookup(h, { all: true })): Promise<void> {
  let addresses: { address: string }[] = [];
  try { addresses = await resolve(host); } catch { /* se informa abajo */ }
  if (!addresses.length || !addresses.every(a => a.address === '::1' || a.address.startsWith('127.')))
    throw new Error(`${host} no resuelve a loopback en este sistema; fab web --write no puede aislar la sesión.`);
}

// ---- modo servidor (T119b): cookies, CSRF, límites y transacciones de login ---------------------------------------

export const SESSION_COOKIE = '__Host-fab_session';
export const LOGIN_COOKIE = '__Host-fab_login';
export const PRELOGIN_COOKIE = '__Host-fab_pre';
export const LOGIN_TTL_MS = 5 * 60_000;
export const PENDING_LOGIN_MAX = 1000;
/** Valores iniciales de §6; cada uno cuenta por ventana fija de un minuto. */
export const LIMITS = { ipPerMin: 10, globalStartsPerMin: 60, globalExchangesPerMin: 60, inviterPerMin: 10, globalInvitesPerMin: 60 } as const;

const attrs = 'Secure; HttpOnly; Path=/';
/** `__Host-` exige Secure, Path=/ y ningún Domain. La de sesión es Strict; las de login cruzan una navegación externa y son Lax. */
export const setCookie = (name: string, value: string, sameSite: 'Strict' | 'Lax', maxAgeSec: number): string =>
  `${name}=${value}; ${attrs}; SameSite=${sameSite}; Max-Age=${maxAgeSec}`;
export const clearCookie = (name: string, sameSite: 'Strict' | 'Lax' = 'Strict'): string => setCookie(name, '', sameSite, 0);

/** Valor de una cookie solo si aparece exactamente una vez: un token ambiguo o repetido no vale. */
export function cookieValue(req: Request, name: string): string | undefined {
  const found = (req.headers.get('cookie') ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${name}=`));
  return found.length === 1 ? found[0]!.slice(name.length + 1) : undefined;
}

export const constantEqual = equal;
const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex');
/** Token CSRF derivado del ID de sesión y de un secreto de servicio: no se guarda y cambia con cada sesión. */
export const csrfToken = (secret: string, sessionId: string): string => hmac(secret, `csrf:${sessionId}`);
export const preloginToken = (secret: string, nonce: string): string => hmac(secret, `prelogin:${nonce}`);

/** ¿Origin exacto? Ausente o ajeno falla. */
export const originOk = (req: Request, publicOrigin: string): boolean => req.headers.get('origin') === publicOrigin;

/** Ventana fija de un minuto con el reloj inyectado. Devuelve 0 si pasa, o los segundos de `Retry-After`. */
export class RateLimiter {
  private windows = new Map<string, { window: number; count: number }>();
  constructor(private clock: () => number) {}
  hit(key: string, limit: number): number {
    const t = this.clock(), window = Math.floor(t / 60_000);
    const w = this.windows.get(key);
    if (!w || w.window !== window) {
      if (this.windows.size > 10_000) for (const [k, v] of this.windows) if (v.window !== window) this.windows.delete(k);
      this.windows.set(key, { window, count: 1 });
      return 0;
    }
    if (w.count >= limit) return Math.max(1, Math.ceil(((window + 1) * 60_000 - t) / 1000));
    w.count++;
    return 0;
  }
}

export interface LoginTransaction { state: string; verifier: string; bind: string; invitation?: string; expiresAt: number }

/** Transacciones de login pendientes: en memoria, acotadas, de un solo uso. Un reinicio las pierde (§3.1). */
export class LoginTransactions {
  private pending = new Map<string, LoginTransaction>();
  constructor(private clock: () => number) {}
  /** `null` si el almacén está lleno de transacciones vivas. */
  start(invitation?: string): LoginTransaction | null {
    const now = this.clock();
    for (const [k, v] of this.pending) if (v.expiresAt <= now) this.pending.delete(k);
    if (this.pending.size >= PENDING_LOGIN_MAX) return null;
    const tx = { state: token(), verifier: randomBytes(32).toString('base64url'), bind: token(), invitation, expiresAt: now + LOGIN_TTL_MS };
    this.pending.set(tx.state, tx);
    return tx;
  }
  /** Se borra siempre, sea o no válida: un `state` se presenta una sola vez. */
  consume(state: string | null, bind: string | undefined): LoginTransaction | null {
    const tx = state ? this.pending.get(state) : undefined;
    if (!tx) return null;
    this.pending.delete(tx.state);
    return tx.expiresAt > this.clock() && bind && equal(bind, tx.bind) ? tx : null;
  }
}
