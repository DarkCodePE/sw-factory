import { createHash } from 'node:crypto';
/** GitHub falso (T119b): servidor local que imita OAuth de usuario, `/user`, `/users/:login` y la revocación del token. Ni red real ni credenciales. */
export interface FakeAccount { id: number; login: string }
export interface FakeGithub {
  url: string;
  /** Código sin enlace a ningún `authorize`: el canje lo rechaza (sin PKCE). Sirve para los tests que no deben llegar a canjear. */
  grant(account: FakeAccount): string;
  /** Hace lo que haría el navegador en GitHub: visita la URL de `authorize` (con las comprobaciones del real) y devuelve el código del redirect. */
  authorize(authorizeUrl: string, account: FakeAccount): Promise<string>;
  users: Map<string, FakeAccount>;
  calls: { method: string; path: string; auth?: string; body?: Record<string, unknown> }[];
  /** Modos de fallo para un solo test. */
  fail: { revoke?: boolean; user?: boolean; token?: boolean; redirectUser?: boolean; userId?: unknown; quota?: boolean; hangToken?: boolean };
  tokensRevoked: string[];
  stop(): void;
}
export const CLIENT_ID = 'fab-client';
export const CLIENT_SECRET = 'fab-secret-sintetico';

/** `redirectUri`: el único registrado en la aplicación, como en GitHub real. */
export function startFakeGithub(redirectUri: string): FakeGithub {
  interface Grant { account: FakeAccount; challenge?: string; redirectUri?: string }
  const codes = new Map<string, Grant>(), tokens = new Map<string, FakeAccount>();
  const g: FakeGithub = { url: '', grant, authorize, users: new Map(), calls: [], fail: {}, tokensRevoked: [], stop: () => server.stop(true) };
  let n = 0;
  function grant(a: FakeAccount) { const c = `code-${++n}`; codes.set(c, { account: a }); return c; }
  async function authorize(authorizeUrl: string, a: FakeAccount) {
    const res = await fetch(authorizeUrl, { redirect: 'manual' });
    const code = res.status === 302 ? new URL(res.headers.get('location')!).searchParams.get('code') : null;
    if (!code) throw new Error(`authorize rechazado: ${res.status}`);
    codes.get(code)!.account = a;
    return code;
  }
  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url), auth = req.headers.get('authorization') ?? undefined;
      const body = req.method === 'POST' || req.method === 'DELETE' ? await req.json().catch(() => undefined) as Record<string, unknown> | undefined : undefined;
      g.calls.push({ method: req.method, path: u.pathname, auth, body });
      if (u.pathname === '/login/oauth/authorize') {
        const q = u.searchParams;
        if (q.get('client_id') !== CLIENT_ID || q.get('redirect_uri') !== redirectUri || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state')) return new Response('bad request', { status: 400 });
        const code = `code-${++n}`; codes.set(code, { account: { id: 0, login: '' }, challenge: q.get('code_challenge')!, redirectUri });
        return new Response(null, { status: 302, headers: { location: `${redirectUri}?code=${code}&state=${q.get('state')}` } });
      }
      if (u.pathname === '/login/oauth/access_token') {
        if (g.fail.hangToken) return new Promise<Response>(() => {}); // no responde nunca
        const grant = codes.get(String(body?.code));
        // Como GitHub: PKCE S256 y redirect_uri idéntico al de la autorización.
        const pkce = !!grant?.challenge && typeof body?.code_verifier === 'string' && createHash('sha256').update(body.code_verifier).digest('base64url') === grant.challenge;
        if (g.fail.token || !grant || !pkce || grant.redirectUri !== body?.redirect_uri || body?.client_id !== CLIENT_ID || body?.client_secret !== CLIENT_SECRET) return Response.json({ error: 'bad_verification_code' });
        const a = grant.account;
        codes.delete(String(body.code)); // un código se canjea una vez
        const t = `gho_${++n}`; tokens.set(t, a);
        return Response.json({ access_token: t, token_type: 'bearer', scope: '' });
      }
      if (u.pathname === '/api/user') {
        if (g.fail.redirectUser) return new Response(null, { status: 302, headers: { location: `${g.url}/elsewhere` } });
        const a = tokens.get((auth ?? '').replace(/^Bearer /, ''));
        if (g.fail.user || !a) return new Response('no', { status: 401 });
        return Response.json({ id: 'userId' in g.fail ? g.fail.userId : a.id, login: a.login });
      }
      if (u.pathname === `/api/applications/${CLIENT_ID}/token` && req.method === 'DELETE') {
        if (auth !== `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`) return new Response('no', { status: 401 });
        if (g.fail.revoke) return new Response('boom', { status: 500 });
        g.tokensRevoked.push(String(body?.access_token)); tokens.delete(String(body?.access_token));
        return new Response(null, { status: 204 });
      }
      const m = /^\/api\/users\/([^/]+)$/.exec(u.pathname);
      if (m) { if (auth !== `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`) return new Response('no', { status: 401 }); if (g.fail.quota) return new Response('rate limit', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }); const a = g.users.get(m[1]!.toLowerCase()); return a ? Response.json(a) : new Response('no', { status: 404 }); }
      return new Response('no', { status: 404 });
    },
  });
  g.url = `http://127.0.0.1:${server.port}`;
  return g;
}
