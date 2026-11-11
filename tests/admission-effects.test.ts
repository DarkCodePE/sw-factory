import { expect, test } from 'bun:test';
import { AdmissionDb } from '../src/admission/db.ts';
import { Effects, type EffectHandler } from '../src/admission/effects.ts';
import { Store } from '../src/store.ts';
import { dbPath } from './helpers/admission.ts';

function setup(handlers: Record<string, EffectHandler>, opts: ConstructorParameters<typeof Effects>[2] = {}) {
  let t = Date.parse('2026-01-01T00:00:00Z');
  const store = new Store(dbPath(), { clock: () => new Date(t) });
  const adm = new AdmissionDb(store);
  const effects = new Effects(adm, handlers, { baseMs: 1000, ...opts });
  const rows = () => adm.db.query('SELECT kind, key, status, attempts, last_error FROM adm_effects ORDER BY id').all() as any[];
  return { adm, effects, rows, advance: (ms: number) => { t += ms; } };
}

test('encolar exige la transacción del cambio de estado, y un rollback no deja efecto', () => {
  const { adm, effects, rows } = setup({});
  expect(() => effects.enqueue('x', 'k', {})).toThrow(/transacción/);
  expect(() => adm.tx(() => { adm.db.query("INSERT INTO adm_cursors(source, value) VALUES ('s','v')").run(); effects.enqueue('x', 'k', {}); throw new Error('boom'); })).toThrow('boom');
  expect(rows()).toEqual([]);
  expect(adm.db.query('SELECT * FROM adm_cursors').all()).toEqual([]);
  adm.tx(() => { adm.db.query("INSERT INTO adm_cursors(source, value) VALUES ('s','v')").run(); effects.enqueue('x', 'k', {}); });
  expect(rows().length).toBe(1);
  expect(adm.db.query('SELECT * FROM adm_cursors').all().length).toBe(1);
});

test('una misma key nunca produce dos efectos, ni siquiera tras completarse', async () => {
  const seen: string[] = [];
  const { adm, effects, rows } = setup({ x: { rerunnable: true, run: (_p, ctx) => { seen.push(ctx.key); } } });
  expect(adm.tx(() => effects.enqueue('x', 'k', { n: 1 }))).toBe(true);
  expect(adm.tx(() => effects.enqueue('x', 'k', { n: 2 }))).toBe(false);
  await effects.dispatch();
  expect(adm.tx(() => effects.enqueue('x', 'k', { n: 3 }))).toBe(false);
  await effects.dispatch();
  expect(seen).toEqual(['k']);
  expect(rows().map(r => r.status)).toEqual(['done']);
});

test('reintenta con espera creciente y al llegar al tope queda muerto con su error', async () => {
  let calls = 0;
  const { adm, effects, rows, advance } = setup({ x: { rerunnable: true, run: () => { calls++; throw new Error('falla'); } } }, { maxAttempts: 3 });
  adm.tx(() => effects.enqueue('x', 'k', {}));
  expect(await effects.dispatch()).toBe(1);
  expect(rows()[0]).toMatchObject({ status: 'pending', attempts: 1, last_error: 'falla' });
  expect(await effects.dispatch()).toBe(0); // aún no vence la espera (1000 ms)
  advance(999); expect(await effects.dispatch()).toBe(0);
  advance(1); expect(await effects.dispatch()).toBe(1);
  advance(1999); expect(await effects.dispatch()).toBe(0); // la segunda espera es el doble
  advance(1); expect(await effects.dispatch()).toBe(1);
  expect(rows()[0]).toMatchObject({ status: 'dead', attempts: 3, last_error: 'falla' });
  advance(1e9); expect(await effects.dispatch()).toBe(0);
  expect(calls).toBe(3);
});

test('tras una caída a mitad de efecto: el rerunnable se reanuda, el que no lo es queda "unknown"', async () => {
  const ran: string[] = [];
  const handlers: Record<string, EffectHandler> = {
    safe: { rerunnable: true, run: (_p, ctx) => { ran.push(`${ctx.key}#${ctx.attempt}`); } },
    risky: { rerunnable: false, run: (_p, ctx) => { ran.push(`${ctx.key}#${ctx.attempt}`); } },
  };
  const first = setup(handlers, { crash: point => { if (point === 'effect-claimed') throw new Error('crash'); } });
  first.adm.tx(() => { first.effects.enqueue('safe', 'a', {}); first.effects.enqueue('risky', 'b', {}); });
  await expect(first.effects.dispatch()).rejects.toThrow('crash'); // 'a' queda running
  expect(first.rows()[0]!.status).toBe('running');
  // "reinicio": otra instancia de Effects sobre la misma base
  const second = new Effects(first.adm, handlers, { baseMs: 1000 });
  expect(second.recover()).toBe(1);
  await second.dispatch();
  expect(ran).toEqual(['a#2', 'b#1']); // 'a' reanuda con otro intento; 'b' nunca había empezado
  expect(first.rows().map(r => r.status)).toEqual(['done', 'done']);
  // un efecto no rerunnable interrumpido a mitad NO se reejecuta
  first.adm.tx(() => first.effects.enqueue('risky', 'c', {}));
  const third = new Effects(first.adm, handlers, { crash: point => { if (point === 'effect-claimed') throw new Error('crash'); } });
  await expect(third.dispatch()).rejects.toThrow('crash');
  expect(second.recover()).toBe(1);
  expect(first.rows()[2]).toMatchObject({ key: 'c', status: 'unknown' });
  expect(first.rows()[2]!.last_error).toMatch(/resultado desconocido/);
  await second.dispatch();
  expect(ran).toEqual(['a#2', 'b#1']);
});

test('un intento antiguo no cierra la fila de un intento nuevo (fencing por attempt_id)', async () => {
  let release!: () => void;
  const gateP = new Promise<void>(r => { release = r; });
  const { adm, effects, rows } = setup({ x: { rerunnable: true, run: async () => { await gateP; } } });
  adm.tx(() => effects.enqueue('x', 'k', {}));
  const running = effects.dispatch();
  await Promise.resolve();
  adm.db.query("UPDATE adm_effects SET attempt_id = 'otro'").run(); // otro intento tomó la fila
  release(); await running;
  expect(rows()[0]!.status).toBe('running');
});
