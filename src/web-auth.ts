import { randomBytes, timingSafeEqual } from 'node:crypto';
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
