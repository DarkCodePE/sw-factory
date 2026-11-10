// Lock exclusivo del residente sobre la misma base. Una fila `adm_lock`; el dueño la renueva con un latido.
// Un lock es recuperable si su proceso murió (mismo host) o si el latido caducó (otro host o proceso colgado).
// Cada claim de efecto comprueba el dueño (`assertOwned`), así que un residente desplazado no sigue despachando.
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { AdmissionDb } from './db.ts';

export const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

type LockRow = { owner: string; pid: number; host: string; heartbeat_at: number };

export class ResidentLock {
  readonly owner = randomUUID();
  constructor(private readonly adm: AdmissionDb, private readonly opts: { ttlMs?: number; alive?: (pid: number) => boolean } = {}) {}

  acquire(): void {
    const ttl = this.opts.ttlMs ?? 30_000, alive = this.opts.alive ?? pidAlive, host = hostname();
    this.adm.tx(() => {
      const row = this.adm.db.query('SELECT * FROM adm_lock WHERE id = 1').get() as LockRow | null;
      if (row) {
        const stale = this.adm.now() - row.heartbeat_at > ttl || (row.host === host && !alive(row.pid));
        if (!stale) throw new Error(`Ya hay un residente activo sobre esta base (pid ${row.pid} en ${row.host})`);
      }
      this.adm.db.query(`INSERT INTO adm_lock(id, owner, pid, host, heartbeat_at) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, pid=excluded.pid, host=excluded.host, heartbeat_at=excluded.heartbeat_at`)
        .run(this.owner, process.pid, host, this.adm.now());
    });
  }

  /** Renueva el latido; falla si otro residente tomó el lock. */
  assertOwned(): void {
    const { changes } = this.adm.db.query('UPDATE adm_lock SET heartbeat_at = ? WHERE id = 1 AND owner = ?').run(this.adm.now(), this.owner);
    if (changes !== 1) throw new Error('Lock del residente perdido: otra instancia lo tomó');
  }

  release(): void { this.adm.tx(() => this.adm.db.query('DELETE FROM adm_lock WHERE id = 1 AND owner = ?').run(this.owner)); }
}
