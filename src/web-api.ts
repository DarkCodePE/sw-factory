// API local de lectura (/api/v1). Solo habla con el Store, abierto en readonly; la autenticación es la clave `fabk_…`.
import { Store, StoreError } from './store.ts';
import { redact } from './evidence.ts';
import { ACTIONS, InputError, performAction, retryRevision } from './web-actions.ts';

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
const STATUS: Record<string, number> = { not_found: 404, invalid_input: 400, conflict: 409, invalid_transition: 409, limit_reached: 409 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const fail = (status: number, code: string, message: string) => json(status, { ok: false, error: { code, message } });
const rd = <T extends string | null>(s: T): T => (s === null ? s : redact(s)) as T;

export const isApiPath = (pathname: string) => /^\/api\/v1(\/|$)/.test(pathname);

function route(store: Store, url: URL, path: string): unknown {
  if (path === '/workstreams') return store.listWorkstreams().map(({ repo: _repo, protectedPaths: _p, verify: _v, verifySetup: _s, ...w }) => ({ ...w, goal: rd(w.goal) }));
  if (path === '/inbox') return store.inbox(url.searchParams.get('ws') || undefined).map(redactActivity);
  if (path === '/changes') {
    const raw = url.searchParams.get('limit') ?? '50';
    const limit = /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
    if (limit < 1 || limit > 200) throw new StoreError('invalid_input', 'limit debe ser un entero entre 1 y 200');
    const ws = url.searchParams.get('ws') || undefined;
    const status = url.searchParams.get('status');
    return (ws ? [store.getWorkstream(ws)] : store.listWorkstreams())
      .flatMap(w => store.listChanges(w.id)).filter(c => !status || c.status === status).slice(0, limit).map(redactChange);
  }
  const m = /^\/(changes|activities)\/([^/]+)$/.exec(path);
  if (!m) return undefined;
  if (!/^[\w-]+$/.test(m[2]!)) throw new StoreError('invalid_input', 'identificador inválido');
  if (m[1] === 'activities') return redactActivity(store.getActivity(m[2]!));
  return { ...redactChange(store.getChange(m[2]!)), revision: retryRevision(store, m[2]!), activities: store.listActivities({ changeId: m[2]! }).map(redactActivity) };
}

const redactChange = <T extends { title: string; description: string }>(c: T): T => ({ ...c, title: rd(c.title), description: rd(c.description) });
const redactActivity = <T extends { result: string | null; error: string | null; reviewComment: string | null }>(a: T): T => ({ ...a, result: rd(a.result), error: rd(a.error), reviewComment: rd(a.reviewComment) });

const apiAction = (path: string) => Object.keys(ACTIONS).find(n => ACTIONS[n]!.api !== false && ACTIONS[n]!.path.test(path));
const BODY_MAX = 16384;
const tooBig = () => fail(413, 'payload_too_large', 'el cuerpo supera 16 KiB');

/** Mutación: las rutas salen de ACTIONS (K2), no hay lista aparte. Devuelve undefined si la ruta no es de mutación. */
async function mutate(req: Request, path: string, stateDir: string, actor: string): Promise<Response> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail(415, 'unsupported_media_type', 'se exige application/json');
  if (Number(req.headers.get('content-length')) > BODY_MAX) return tooBig();
  let buf: ArrayBuffer;
  try { buf = await req.arrayBuffer(); } catch (e) { return e instanceof Error && e.name === 'RequestBodyTooLarge' ? tooBig() : fail(400, 'invalid_input', 'cuerpo ilegible'); }
  if (buf.byteLength > BODY_MAX) return tooBig();
  let body: unknown;
  try { body = JSON.parse(Buffer.from(buf).toString('utf8')); } catch { return fail(400, 'invalid_input', 'JSON inválido'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.values(body).some(v => typeof v !== 'string')) return fail(400, 'invalid_input', 'el cuerpo debe ser un objeto con valores de texto');
  const name = apiAction(path)!;
  const id = name.endsWith('/create') ? '' : ACTIONS[name]!.path.exec(path)![1]!;
  if (id && !/^[\w-]+$/.test(id)) return fail(400, 'invalid_input', 'identificador inválido');
  try {
    const out = await performAction(stateDir, name, id, body as Record<string, string>, actor);
    if (out.result === 'ok') return json(200, { ok: true, data: { destination: out.destination } });
    return out.result === 'error' ? fail(500, 'error', 'error interno') : fail(STATUS[out.result] ?? 500, out.result, 'la acción no se pudo aplicar');
  } catch (e) {
    if (e instanceof InputError) return fail(e.status, e.status === 413 ? 'payload_too_large' : 'invalid_input', e.message);
    return fail(500, 'error', 'error interno');
  }
}

/** Orden de comprobaciones de T71 §3.3 (el filtro de Host lo hace el servidor antes de llamar). `write` solo existe con `fab web --write`. */
export async function handleApi(req: Request, url: URL, openStore: () => Store, write?: { stateDir: string }): Promise<Response> {
  if (req.method === 'OPTIONS') return fail(405, 'method_not_allowed', 'método no permitido');
  const bearer = /^Bearer (fabk_\S+)$/.exec(req.headers.get('authorization') ?? '');
  let store: Store | undefined;
  let key: { name: string; scope: string } | null = null;
  try {
    store = openStore();
    key = bearer ? store.verifyApiKey(bearer[1]!) : null;
    if (!key) return fail(401, 'unauthorized', 'clave ausente o inválida');
    const path = url.pathname.slice('/api/v1'.length);
    if (req.method === 'POST') {
      if (!apiAction(path)) return fail(404, 'not_found', 'ruta no encontrada');
      if (!write) return fail(405, 'method_not_allowed', 'el servidor está en solo lectura');
      if (key.scope !== 'decide') return fail(403, 'forbidden', 'la clave no tiene ámbito decide');
    } else {
      const data = req.method === 'GET' ? route(store, url, path) : undefined;
      return data === undefined ? fail(req.method === 'GET' ? 404 : 405, req.method === 'GET' ? 'not_found' : 'method_not_allowed', req.method === 'GET' ? 'ruta no encontrada' : 'método no permitido') : json(200, { ok: true, data });
    }
  } catch (e) {
    if (e instanceof StoreError) return fail(STATUS[e.code] ?? 500, e.code, e.message);
    return fail(500, 'error', 'error interno');
  } finally { store?.close(); }
  return mutate(req, url.pathname.slice('/api/v1'.length), write!.stateDir, `api:${key.name}`);
}
