// Pantalla de recuperación restringida (T119e, diseño T118–T119 §3.3 paso 2). Tras restaurar una copia, el único principal con sesión es el
// owner que el operador designó por consola; aquí confirma la lista completa de identidades y roles. Quien no confirme queda suspendido
// (`confirmRecovery`). La política (`policy.ts`) ya deniega todo lo demás en recuperación: este módulo solo sirve estas dos rutas.
import { Store, StoreError } from './store.ts';
import { confirmRecovery, recoveryUsers, type Principal, type Role } from './users.ts';
import { constantEqual, csrfToken, originOk } from './web-auth.ts';
import { esc, page, plain, redirect } from './web-identity.ts';

const FORM_LIMIT = 64 * 1024;
export const RECOVERY_PATHS = ['/recuperacion', '/recuperacion/confirmar'] as const;

export function recoveryRoutes(opts: { store: Store; publicOrigin: string; secret: string }) {
  const { store, publicOrigin, secret } = opts;

  const form = (p: Principal): Response => {
    let users;
    try { users = recoveryUsers(store, p); } catch (e) {
      return plain(e instanceof StoreError && e.code === 'forbidden' ? 403 : 409, 'La recuperación no está disponible para esta cuenta.');
    }
    const csrf = csrfToken(secret, p.sessionId!);
    const rows = users.map(u => `<tr><td><label><input type="checkbox" name="c" value="${esc(u.id)}:${esc(u.role)}" checked> ${esc(u.displayName)}</label></td>
      <td>${esc(u.issuer)}:${esc(u.subject)}</td><td>${esc(u.role)}</td></tr>`).join('');
    return page('Recuperación', `<p>Se restauró una copia. Confirma las identidades y roles que siguen vigentes; <strong>las que no marques quedan suspendidas</strong>.</p>
      <form method="post" action="/recuperacion/confirmar"><input type="hidden" name="csrf" value="${esc(csrf)}">
      <table><thead><tr><th>Usuario</th><th>Identidad</th><th>Rol</th></tr></thead><tbody>${rows}</tbody></table><button>Confirmar la lista</button></form>
      <form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button>Cerrar sesión</button></form>`);
  };

  async function confirm(req: Request, p: Principal): Promise<Response> {
    if (!originOk(req, publicOrigin)) return plain(403, 'Origen no permitido.');
    if (Number(req.headers.get('content-length') ?? 0) > FORM_LIMIT || !/^application\/x-www-form-urlencoded\b/i.test(req.headers.get('content-type') ?? '')) return plain(400, 'Petición no válida.');
    const body = new URLSearchParams(await req.text());
    const token = body.get('csrf');
    if (!token || !constantEqual(token, csrfToken(secret, p.sessionId!))) return plain(403, 'Petición no válida.');
    const list = body.getAll('c').map(v => { const i = v.lastIndexOf(':'); return { userId: v.slice(0, i), role: v.slice(i + 1) as Role }; });
    try { confirmRecovery(store, p, list); } catch (e) {
      if (!(e instanceof StoreError)) throw e;
      return plain(e.code === 'forbidden' ? 403 : e.code === 'conflict' ? 409 : 400, 'No se pudo confirmar la lista.');
    }
    return redirect('/');
  }

  /** `null` si la ruta no es de recuperación. `p` es una sesión web en recuperación restringida. */
  async function handle(req: Request, p: Principal): Promise<Response | null> {
    const path = new URL(req.url).pathname;
    if (path === '/recuperacion') return req.method === 'GET' || req.method === 'HEAD' ? form(p) : plain(405, 'Método no permitido.');
    if (path === '/recuperacion/confirmar') return req.method === 'POST' ? confirm(req, p) : plain(405, 'Método no permitido.');
    return null;
  }
  return { handle };
}
