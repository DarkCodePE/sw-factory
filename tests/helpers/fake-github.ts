/** GitHub falso (T119b): servidor local que imita OAuth de usuario, `/user`, `/users/:login` y la revocación del token. Ni red real ni credenciales. */
export interface FakeAccount { id: number; login: string }
export interface FakeGithub {
  url: string;
  /** código de autorización → cuenta. `grant` lo registra y devuelve el código. */
  grant(account: FakeAccount): string;
  users: Map<string, FakeAccount>;
  calls: { method: string; path: string; auth?: string; body?: Record<string, unknown> }[];
  /** Modos de fallo para un solo test. */
  fail: { revoke?: boolean; user?: boolean; token?: boolean; redirectUser?: boolean; userId?: unknown };
  tokensRevoked: string[];
  stop(): void;
}
export const CLIENT_ID = 'fab-client';
export const CLIENT_SECRET = 'fab-secret-sintetico';

export function startFakeGithub(): FakeGithub {
  const codes = new Map<string, FakeAccount>(), tokens = new Map<string, FakeAccount>();
  const g: FakeGithub = { url: '', grant, users: new Map(), calls: [], fail: {}, tokensRevoked: [], stop: () => server.stop(true) };
  let n = 0;
  function grant(a: FakeAccount) { const c = `code-${++n}`; codes.set(c, a); return c; }
  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url), auth = req.headers.get('authorization') ?? undefined;
      const body = req.method === 'POST' || req.method === 'DELETE' ? await req.json().catch(() => undefined) as Record<string, unknown> | undefined : undefined;
      g.calls.push({ method: req.method, path: u.pathname, auth, body });
      if (u.pathname === '/login/oauth/access_token') {
        const a = codes.get(String(body?.code));
        if (g.fail.token || !a || body?.client_id !== CLIENT_ID || body?.client_secret !== CLIENT_SECRET || !body?.code_verifier || !body?.redirect_uri) return Response.json({ error: 'bad_verification_code' });
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
      if (m) { const a = g.users.get(m[1]!.toLowerCase()); return a ? Response.json(a) : new Response('no', { status: 404 }); }
      return new Response('no', { status: 404 });
    },
  });
  g.url = `http://127.0.0.1:${server.port}`;
  return g;
}
