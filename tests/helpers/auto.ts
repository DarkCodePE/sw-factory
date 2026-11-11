// Costura completa (T12): residente en modo auto + pool vivo sobre la misma base, con `gh` y backend falsos.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdmissionDb } from '../../src/admission/db.ts';
import { CrashInjected, type CrashPoint } from '../../src/admission/effects.ts';
import { ThreadLinks } from '../../src/admission/links.ts';
import { Resident, type ResidentConfig } from '../../src/admission/resident.ts';
import { runPool } from '../../src/pool.ts';
import { Store } from '../../src/store.ts';
import { fakeGh, issue, POLICY, REPO, type FakeExtra, type RawIssue } from './admission.ts';
import type { FakeLive } from './live.ts';

export const SELF = 'fab-bot';
export const once = (point: CrashPoint) => { let fired = false; return (p: CrashPoint) => { if (p === point && !fired) { fired = true; throw new CrashInjected(p); } }; };
export const future = () => new Date(Date.now() + 3_600_000).toISOString();

export function rig(opts: { issues?: RawIssue[]; extra?: FakeExtra; verify?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fab-auto-')), repo = join(dir, 'repo');
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  for (const args of [['add', '.'], ['commit', '-qm', 'init']]) Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);
  const store = new Store(join(dir, 'f.db'));
  const ws = store.createWorkstream({ slug: 'p', goal: 'g', repo, agent: 'fake', requireChangeApproval: false, requireApproval: false, ...(opts.verify ? { verify: opts.verify } : {}) });
  store.setWorkstreamState(ws.id, 'active');
  const issues = opts.issues ?? [], run = fakeGh(issues, { self: SELF, ...opts.extra });
  const adm = new AdmissionDb(store);
  // baseMs 0: el reintento de un efecto vence ya y entra en el mismo ciclo; con 1 ms dependía de la velocidad de la máquina (CI).
  const resident = (over: Partial<ResidentConfig> = {}) => new Resident(store, { repo: REPO, policy: POLICY, mode: 'auto', workstream: 'p', selfLogin: SELF, comments: true, run, baseMs: 0,
    since: '2026-01-01T00:00:00Z', ...over });
  /** Un ciclo del residente (adquiere y suelta el lock, como un proceso que arranca). */
  const cycle = async (over: Partial<ResidentConfig> = {}) => { const r = resident(over); await r.run({ once: true }); return r; };
  const pool = (backend: FakeLive, extra: object = {}) => runPool(store, { workstream: ws.id, stateDir: dir, untilIdle: true, log: () => {}, live: true, liveBackends: { fake: backend }, ...extra });
  /** Change manual unido a un hilo (como si la admisión ya lo hubiera creado). */
  const channelChange = (n = 7) => {
    const c = store.createChange(ws.id, `issue ${n}`, 'cuerpo');
    adm.db.query('INSERT OR IGNORE INTO adm_threads(id, source, first_seen) VALUES (?,?,?)').run(`github:${REPO}#${n}`, `github:${REPO}`, 'x');
    new ThreadLinks(adm).link(`github:${REPO}#${n}`, c.id);
    return c;
  };
  const close = () => { store.close(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, repo, store, ws, adm, run, resident, cycle, pool, channelChange, close, issue, issues };
}
