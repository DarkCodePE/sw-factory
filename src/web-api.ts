// API local de lectura (/api/v1). Solo habla con el Store, abierto en readonly; la autenticación es la clave `fabk_…`.
import { Store, StoreError } from './store.ts';
import { redact } from './evidence.ts';

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
  return { ...redactChange(store.getChange(m[2]!)), activities: store.listActivities({ changeId: m[2]! }).map(redactActivity) };
}

const redactChange = <T extends { title: string; description: string }>(c: T): T => ({ ...c, title: rd(c.title), description: rd(c.description) });
const redactActivity = <T extends { result: string | null; error: string | null; reviewComment: string | null }>(a: T): T => ({ ...a, result: rd(a.result), error: rd(a.error), reviewComment: rd(a.reviewComment) });

/** Orden de comprobaciones de T71 §3.3 (el filtro de Host lo hace el servidor antes de llamar). */
export function handleApi(req: Request, url: URL, openStore: () => Store): Response {
  if (req.method === 'OPTIONS') return fail(405, 'method_not_allowed', 'método no permitido');
  const bearer = /^Bearer (fabk_\S+)$/.exec(req.headers.get('authorization') ?? '');
  let store: Store | undefined;
  try {
    store = openStore();
    if (!bearer || !store.verifyApiKey(bearer[1]!)) return fail(401, 'unauthorized', 'clave ausente o inválida');
    const data = req.method === 'GET' ? route(store, url, url.pathname.slice('/api/v1'.length)) : undefined;
    return data === undefined ? fail(404, 'not_found', 'ruta no encontrada') : json(200, { ok: true, data });
  } catch (e) {
    if (e instanceof StoreError) return fail(STATUS[e.code] ?? 500, e.code, e.message);
    return fail(500, 'error', 'error interno');
  } finally { store?.close(); }
}
