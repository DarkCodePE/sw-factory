// Sesiones vivas (T17, H-02). Una fila por (change, tipo de activity, generación), escrita antes de lanzar el proceso.
// La clave NO es la activity: retryChange crea otra activity y la sesión no debe perderse. Cambiar de backend, de cwd o
// de modelo no reanuda: es una sesión perdida (T18), nunca una sesión nueva en silencio.
import { randomUUID } from 'node:crypto';
import type { AdmissionDb } from './db.ts';

export type SessionMeta = { backend: string; cwd: string; model?: string | null; profileDigest?: string | null };
export type SessionRow = { sessionId: string; generation: number; status: 'open' | 'lost' | 'closed'; launched: boolean } & SessionMeta & { changeId: string; kind: string };
type Raw = { change_id: string; kind: string; generation: number; session_id: string; backend: string; cwd: string; model: string | null; profile_digest: string | null; status: SessionRow['status']; launched_at: string | null };
const toRow = (r: Raw): SessionRow => ({ changeId: r.change_id, kind: r.kind, generation: r.generation, sessionId: r.session_id, backend: r.backend, cwd: r.cwd,
  model: r.model, profileDigest: r.profile_digest, status: r.status, launched: r.launched_at !== null });

/** La sesión abierta no coincide con lo que se pide (backend, cwd o modelo distintos): no se puede reanudar. */
export class SessionMismatchError extends Error {
  constructor(readonly sessionId: string, detail: string) { super(`session ${sessionId} cannot be resumed: ${detail}`); this.name = 'SessionMismatchError'; }
}

export class SessionStore {
  constructor(private readonly adm: AdmissionDb) {}

  current(changeId: string, kind: string): SessionRow | undefined {
    const r = this.adm.db.query('SELECT * FROM adm_sessions WHERE change_id = ? AND kind = ? ORDER BY generation DESC LIMIT 1').get(changeId, kind) as Raw | null;
    return r ? toRow(r) : undefined;
  }

  /**
   * La sesión para el próximo turno, creada y escrita antes de lanzar. Devuelve los campos de `LiveTurn` que le tocan:
   * `sessionId` si ya hubo un turno lanzado (reanudar exactamente esa), `newSessionId` si todavía no (empezar con ese id).
   * Lanza SessionMismatchError si la sesión abierta es de otro backend, cwd o modelo.
   */
  begin(changeId: string, kind: string, meta: SessionMeta): { session: SessionRow; turn: { sessionId: string } | { newSessionId: string } } {
    const row = this.adm.tx(() => {
      const cur = this.current(changeId, kind);
      if (cur && cur.status === 'open') return cur;
      const generation = (cur?.generation ?? 0) + 1;
      if (cur && cur.status === 'lost') throw new Error(`la sesión ${cur.sessionId} está perdida: usa supersede() antes de empezar la generación ${generation}`);
      this.adm.db.query('INSERT INTO adm_sessions(change_id, kind, generation, session_id, backend, cwd, model, profile_digest, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(changeId, kind, generation, randomUUID(), meta.backend, meta.cwd, meta.model ?? null, meta.profileDigest ?? null, this.adm.iso());
      return this.current(changeId, kind)!;
    });
    if (!row.launched) { // aún sin proceso: nada que reanudar, la fila toma los datos de este turno
      this.adm.tx(() => this.adm.db.query('UPDATE adm_sessions SET backend = ?, cwd = ?, model = ?, profile_digest = ? WHERE session_id = ? AND launched_at IS NULL')
        .run(meta.backend, meta.cwd, meta.model ?? null, meta.profileDigest ?? null, row.sessionId));
      return { session: { ...row, ...meta }, turn: { newSessionId: row.sessionId } };
    }
    for (const f of ['backend', 'cwd', 'model'] as const) {
      if (row.launched && (meta[f] ?? null) !== (row[f] ?? null)) throw new SessionMismatchError(row.sessionId, `${f} distinto (${String(row[f])} → ${String(meta[f] ?? null)})`);
    }
    return { session: row, turn: { sessionId: row.sessionId } };
  }

  /** Se llama al lanzar el proceso (`turn.onSpawn`): a partir de aquí el siguiente turno reanuda en vez de empezar. */
  markLaunched(sessionId: string): void {
    this.adm.tx(() => this.adm.db.query('UPDATE adm_sessions SET launched_at = COALESCE(launched_at, ?) WHERE session_id = ?').run(this.adm.iso(), sessionId));
  }
}
