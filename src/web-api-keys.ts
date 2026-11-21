// Administración de credenciales del dueño. El Store valida y persiste las claves.
import { join } from 'node:path';
import { API_KEY_ACTIVE_LIMIT, Store, StoreError } from './store.ts';

export const API_KEYS_PATH = '/config/claves-api';
export const API_KEY_CREATE_PATH = `${API_KEYS_PATH}/crear`;
const validId = (id: string) => /^[a-f0-9]{12}$/.test(id);

export class ApiKeyUsage {
  private readonly observed = new Map<string, string>();
  private readonly pending = new Map<string, { count: number; revoked: boolean }>();

  constructor(private readonly clock = () => new Date()) {}

  observe(id: string, response: Response): Response {
    if (!response.ok) return response;
    const time = this.clock().toISOString();
    this.observed.delete(id);
    this.observed.set(id, time);
    if (this.observed.size > API_KEY_ACTIVE_LIMIT) this.observed.delete(this.observed.keys().next().value!);
    return response;
  }

  async observeMutation(id: string, mutate: () => Promise<Response>): Promise<Response> {
    const pending = this.pending.get(id) ?? { count: 0, revoked: false };
    pending.count++;
    this.pending.set(id, pending);
    try {
      const response = await mutate();
      return pending.revoked ? response : this.observe(id, response);
    } finally {
      if (--pending.count === 0) this.pending.delete(id);
    }
  }

  lastUse(id: string): string | undefined {
    return this.observed.get(id);
  }

  forget(id: string): void {
    this.observed.delete(id);
    // Una mutación autorizada en curso puede terminar después de la revocación.
    const pending = this.pending.get(id);
    if (pending) pending.revoked = true;
  }
}

export function apiKeysPage(store: Store, escape: (value: unknown) => string, csrf: string, usage: ApiKeyUsage) {
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
  const rows = store.listApiKeys().map(({ id, name, scope, createdAt, revokedAt }) => {
    const revoke = revokedAt === null && validId(id)
      ? `<form class="web-action" method="post" action="${API_KEYS_PATH}/${id}/revocar">${hidden}
          <label><input type="checkbox" name="confirm" value="yes" required> Confirmo revocar ${escape(name)}</label>
          <button>Revocar</button>
        </form>` : '';
    if (revokedAt !== null) usage.forget(id); // También detecta revocaciones hechas desde la CLI.
    const last = usage.lastUse(id);
    return `<tr><td>${escape(name)}</td><td><code>${escape(scope)}</code></td>
      <td><time>${escape(createdAt)}</time></td>
      <td>${revokedAt === null ? 'Activa' : `Revocada · <time>${escape(revokedAt)}</time>`}</td>
      <td>${last ? `<time>${escape(last)}</time>` : 'No medido'}</td><td>${revoke}</td></tr>`;
  }).join('');
  return { title: 'Claves API', body: `<p><a href="/config">Volver a Configuración</a></p>
    ${rows ? `<div class="table-wrap"><table><thead><tr>
      <th scope="col">Nombre</th><th scope="col">Ámbito</th><th scope="col">Creación</th>
      <th scope="col">Estado</th><th scope="col">Último uso en este arranque</th><th scope="col">Acciones</th>
    </tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">No hay claves API.</p>'}
    <section><h2>Crear clave API</h2>
      <form class="web-action" method="post" action="${API_KEY_CREATE_PATH}">${hidden}
        <label>Nombre <input name="name" required maxlength="41" pattern="[a-z0-9][a-z0-9\\-]{0,40}"></label>
        <label>Ámbito <select name="scope"><option value="read">read · lectura</option><option value="decide">decide · lectura y decisiones</option></select></label>
        <button>Crear clave</button>
      </form>
    </section>` };
}

// Escapado HTML sin redacción: este documento es el único lugar donde se entrega la clave.
const escapeHtml = (value: string) => value.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

function keyDocument(status: number, title: string, body: string): Response {
  return new Response(`<!doctype html><html lang="es"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · fab</title></head>
    <body><main><h1>${title}</h1>${body}<p><a href="${API_KEYS_PATH}">Volver a Claves API</a></p></main></body></html>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

const problem = (status: number, message: string) => keyDocument(status, 'Claves API', `<p>${escapeHtml(message)}</p>`);

const keyErrorStatus: Record<string, number> = { invalid_input: 400, not_found: 404, conflict: 409, limit_reached: 409 };
function withKeyWriter(stateDir: string, action: (store: Store) => Response): Response {
  let store: Store | undefined;
  try {
    store = new Store(join(stateDir, 'fabrica.db'));
    return action(store);
  } catch (error) {
    if (error instanceof StoreError && keyErrorStatus[error.code]) return problem(keyErrorStatus[error.code]!, error.message);
    return problem(500, 'No se pudo registrar la acción. Revisa el estado de las claves antes de reintentar.');
  } finally { store?.close(); }
}

export function createApiKeyResponse(stateDir: string, _id: string, form: URLSearchParams): Response {
  return withKeyWriter(stateDir, store => {
    const { key } = store.createApiKey(form.get('name') ?? '', form.get('scope') as 'read' | 'decide');
    return keyDocument(200, 'Clave API creada', `<p>Copia la clave ahora. Esta es la única vez que fab la muestra.</p>
      <p><code>${escapeHtml(key)}</code></p>`);
  });
}

export function revokeApiKeyResponse(stateDir: string, id: string, form: URLSearchParams, usage: ApiKeyUsage): Response {
  if (!validId(id)) return problem(400, 'Identificador de clave API inválido.');
  if (form.get('confirm') !== 'yes') return problem(400, 'Confirma la revocación.');
  return withKeyWriter(stateDir, store => {
    store.revokeApiKey({ id });
    usage.forget(id);
    return new Response(null, { status: 303, headers: { Location: API_KEYS_PATH } });
  });
}
