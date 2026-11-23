// Modo servidor completo para pruebas (T119e): equipo de `cloud()`, GitHub falso y `startWeb --server` sobre un socket Unix.
// Las peticiones llevan el Host canónico y la IP que pondría el proxy autenticado, como Caddy.
import { join } from 'node:path';
import { startWeb } from '../../src/web.ts';
import { GithubConnector } from '../../src/web-identity.ts';
import { SESSION_COOKIE, csrfToken } from '../../src/web-auth.ts';
import { CLIENT_ID, CLIENT_SECRET, startFakeGithub, type FakeGithub } from './fake-github.ts';
import { cloud, ORIGIN, SECRET, type Cloud } from './cloud.ts';
import type { Role } from '../../src/users.ts';

export const HOST = new URL(ORIGIN).host;
export const CANARIO_ACTIVITY = 'canario-comentario-de-revision';
export const CANARIO_EVENT = 'canario-evento-del-worker';

export interface CloudServer {
  c: Cloud; gh: FakeGithub; socket: string; ws: { id: string; slug: string }; changeId: string; activityId: string;
  /** Petición por el socket. `as`: rol con sesión web de `cloud()`, o ninguna. */
  call(path: string, init?: RequestInit & { as?: Role; ip?: string; headers?: Record<string, string> }): Promise<Response>;
  csrf(role: Role): string;
  /** POST de formulario con sesión, Origin y CSRF correctos. */
  post(role: Role, path: string, fields: Record<string, string>, headers?: Record<string, string>): Promise<Response>;
  stop(): void;
}

export function cloudServer(options: { write?: boolean; clock?: () => Date } = {}): CloudServer {
  const c = cloud();
  const socket = join(c.dir, 'fab.sock');
  const gh = startFakeGithub(`${ORIGIN}/auth/callback`);
  const github = new GithubConnector({ clientId: CLIENT_ID, clientSecret: () => CLIENT_SECRET, publicOrigin: ORIGIN,
    authorizeUrl: `${gh.url}/login/oauth/authorize`, tokenUrl: `${gh.url}/login/oauth/access_token`, apiBase: `${gh.url}/api` });
  const ws = c.store.createWorkstream({ slug: 'nube', goal: 'objetivo', repo: join(c.dir, 'repo-canario'), requireChangeApproval: false });
  const change = c.store.createChange(ws.id, 'cambio uno', 'descripción');
  const act = c.store.listActivities({ changeId: change.id })[0]!;
  c.store.db.query("UPDATE activities SET review_comment = ? WHERE id = ?").run(CANARIO_ACTIVITY, act.id);
  c.store.event(ws.id, 'info', CANARIO_EVENT, change.id);
  const server = startWeb(c.stateDir, 0, { server: true, write: options.write ?? true, publicOrigin: ORIGIN, socketPath: socket, github, secret: SECRET, clock: options.clock });
  const call: CloudServer['call'] = (path, { as, ip, headers, ...init } = {}) => fetch(`http://localhost${path}`, {
    redirect: 'manual', unix: socket, ...init,
    headers: { host: HOST, 'x-fab-client-ip': ip ?? '203.0.113.9', ...(as ? { cookie: `${SESSION_COOKIE}=${c.tokens.web[as]}` } : {}), ...headers },
  } as RequestInit);
  const csrf = (role: Role) => csrfToken(SECRET, c.web[role].sessionId!);
  return {
    c, gh, socket, ws, changeId: change.id, activityId: act.id, call, csrf,
    post: (role, path, fields, headers = {}) => call(path, { method: 'POST', as: role, body: new URLSearchParams({ csrf: csrf(role), ...fields }),
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...headers } }),
    stop() { server.stop(true); gh.stop(); c.close(); },
  };
}
