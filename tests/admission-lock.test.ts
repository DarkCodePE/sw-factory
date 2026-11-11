import { expect, test } from 'bun:test';
import { AdmissionDb } from '../src/admission/db.ts';
import { ResidentLock } from '../src/admission/lock.ts';
import { Store } from '../src/store.ts';
import { dbPath } from './helpers/admission.ts';

const mk = () => { const store = new Store(dbPath()); return { store, adm: new AdmissionDb(store) }; };

test('una segunda instancia sobre la misma base se niega con un error claro', () => {
  const { adm } = mk();
  new ResidentLock(adm).acquire();
  expect(() => new ResidentLock(adm).acquire()).toThrow(/Ya hay un residente activo/);
});

test('el lock de un proceso muerto se recupera, y el desplazado deja de poder despachar', () => {
  const { adm } = mk();
  const dead = new ResidentLock(adm, { alive: () => false });
  dead.acquire();
  const fresh = new ResidentLock(adm, { alive: () => false });
  fresh.acquire();
  expect(() => dead.assertOwned()).toThrow(/perdido/);
  fresh.assertOwned();
});

test('un latido caducado también permite recuperar el lock', () => {
  let t = 0;
  const store = new Store(dbPath(), { clock: () => new Date(t) });
  const adm = new AdmissionDb(store);
  new ResidentLock(adm, { ttlMs: 1000 }).acquire();
  t = 999; expect(() => new ResidentLock(adm, { ttlMs: 1000 }).acquire()).toThrow();
  t = 1001; new ResidentLock(adm, { ttlMs: 1000 }).acquire();
});

test('release libera, y solo el dueño', () => {
  const { adm } = mk();
  const a = new ResidentLock(adm); a.acquire();
  new ResidentLock(adm).release(); // no es el dueño: no borra
  expect(() => new ResidentLock(adm).acquire()).toThrow();
  a.release();
  new ResidentLock(adm).acquire();
});

test('un pid real muerto (proceso terminado) se detecta', async () => {
  const child = Bun.spawn(['true']); await child.exited;
  const { adm } = mk();
  adm.db.query("INSERT INTO adm_lock(id, owner, pid, host, heartbeat_at) VALUES (1,'x',?,?,?)").run(child.pid, require('node:os').hostname(), adm.now());
  new ResidentLock(adm).acquire();
});
