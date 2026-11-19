// Receptor de avisos de GitHub (T69): una entrega firmada solo despierta el sondeo del residente (`wake`). Nunca aporta contenido ni autoridad.
// El aviso nunca aporta contenido ni autoridad: el residente vuelve a leerlo todo por la API (H1).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AdmissionDb } from './db.ts';

// `X-Hub-Signature-256`: `sha256=` + 64 hex del HMAC-SHA256 del cuerpo en bruto. Cualquier otra forma, false y sin lanzar.
export const verifySignature = (secret: string, body: Uint8Array, header: string | null): boolean => {
  if (!secret || header === null || !/^sha256=[0-9a-fA-F]{64}$/.test(header)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(header.slice(7), 'hex'));
};

export const MAX_BODY = 64 * 1024;
export const COALESCE_MS = 5000;
export const KEEP_DELIVERIES = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT = /^[a-z_]{1,40}$/;
const empty = (status: number) => new Response(null, { status });

// Del cuerpo (ya autenticado) solo se lee `repository.full_name`; cualquier otra forma cuenta como otro repo.
const repoOf = (body: Uint8Array): string | null => {
  try { const name = (JSON.parse(new TextDecoder().decode(body)) as { repository?: { full_name?: unknown } })?.repository?.full_name; return typeof name === 'string' ? name : null; }
  catch { return null; }
};

export type HookOptions = { port: number; secret: string; repo: string; adm: AdmissionDb; wake: () => void; now: () => number; log?: (line: string) => void };

/** Escucha solo en 127.0.0.1 (H4). La entrega solo escribe `adm_hook_deliveries` y llama a `wake()` (H1). */
export function startHook(o: HookOptions): { port: number; hostname: string; stop(): void } {
  const handle = async (req: Request): Promise<Response> => {
    if (new URL(req.url).pathname !== '/github') return empty(404);
    if (req.method !== 'POST') return empty(405);
    if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return empty(413);
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.length > MAX_BODY) return empty(413);
    if (!verifySignature(o.secret, body, req.headers.get('x-hub-signature-256'))) return empty(401);
    const id = req.headers.get('x-github-delivery') ?? '', event = req.headers.get('x-github-event') ?? '';
    if (!UUID.test(id) || !EVENT.test(event)) return empty(400);
    const result = o.adm.tx(() => {
      if (o.adm.db.query('SELECT 1 FROM adm_hook_deliveries WHERE delivery_id = ?').get(id)) return null;
      const now = o.now();
      const last = (o.adm.db.query("SELECT MAX(received_at) AS at FROM adm_hook_deliveries WHERE result = 'woke'").get() as { at: string | null }).at;
      const result = !['issues', 'issue_comment'].includes(event) ? 'ignored_event'
        : repoOf(body)?.toLowerCase() !== o.repo.toLowerCase() ? 'ignored_repo'
        : last && now - Date.parse(last) < COALESCE_MS ? 'coalesced' : 'woke';
      o.adm.db.query('INSERT INTO adm_hook_deliveries (delivery_id, event, received_at, bytes, result) VALUES (?, ?, ?, ?, ?)')
        .run(id, event, new Date(now).toISOString(), body.length, result);
      o.adm.db.query('DELETE FROM adm_hook_deliveries WHERE rowid <= (SELECT MAX(rowid) FROM adm_hook_deliveries) - ?').run(KEEP_DELIVERIES);
      return result;
    });
    if (result) o.log?.(`aviso ${id} ${event} ${result}`);
    if (result === 'woke') o.wake();
    return new Response(null, { status: 202 });
  };
  const server = Bun.serve({ hostname: '127.0.0.1', port: o.port, maxRequestBodySize: MAX_BODY,
    fetch: req => handle(req).catch(() => empty(500)) }); // H2: un fallo del receptor no toca la admisión
  return { port: server.port!, hostname: server.hostname!, stop: () => void server.stop(true) };
}
