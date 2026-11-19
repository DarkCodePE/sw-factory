import { randomBytes, timingSafeEqual } from 'node:crypto';

const token = () => randomBytes(32).toString('hex');
const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Credenciales efímeras del proceso; nunca se persisten ni se incluyen en eventos. */
export class WebAuth {
  private invitation: string | null = token();
  private session: string | null = null;
  private csrf: string | null = null;

  loginUrl(port: number): string { return `http://127.0.0.1:${port}/auth?token=${this.invitation}`; }

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

  validCsrf(req: Request, value: string): boolean {
    const expected = this.sessionCsrf(req);
    return !!expected && equal(value, expected);
  }
}
