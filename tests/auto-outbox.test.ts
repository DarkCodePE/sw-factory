import { afterEach, expect, test } from 'bun:test';
import { marker } from '../src/admission/outbox.ts';
import { once, rig } from './helpers/auto.ts';
import { fakeLive } from './helpers/live.ts';
import type { RawComment } from './helpers/admission.ts';

let t: ReturnType<typeof rig>;
afterEach(() => t.close());
const ASK = { reports: [{ state: 'awaiting' as const, summary: 's', human_action: '¿qué color?' }] };
const q = () => t.adm.db.query('SELECT id, status, posted_at, published_at FROM adm_questions').get() as { id: string; status: string; posted_at: string | null; published_at: string | null };
const effects = () => t.adm.db.query('SELECT kind, status FROM adm_effects WHERE kind = ? ORDER BY id').all('reply');

test('frontera 7: la espera confirmada deja el efecto reply pendiente; el residente publica la pregunta una sola vez, con marcador', async () => {
  t = rig();
  t.channelChange();
  await t.pool(fakeLive([ASK]));
  expect(effects()).toEqual([{ kind: 'reply', status: 'pending' }]); // esperar sin haber preguntado todavía: el efecto sobrevive hasta que alguien lo despache
  expect(t.run.posts).toHaveLength(0);
  await t.cycle();
  expect(t.run.posts).toHaveLength(1);
  expect(t.run.posts[0]!.body).toContain(marker(q().id));
  expect(q().published_at).toBe('2026-01-10T00:00:00Z');
  expect(effects()).toEqual([{ kind: 'reply', status: 'done' }]);
});

test('frontera 8: el residente muere tras publicar y antes de cerrar el efecto → se reconcilia por marcador y no se publica dos veces', async () => {
  t = rig();
  t.channelChange();
  await t.pool(fakeLive([ASK]));
  await expect(t.cycle({ crash: once('effect-ran') })).rejects.toThrow('caída inyectada');
  expect(t.run.posts).toHaveLength(1);
  await t.cycle(); // reinicio: recover → unknown → reconcile (marcador) → done
  expect(t.run.posts).toHaveLength(1);
  expect(effects()).toEqual([{ kind: 'reply', status: 'done' }]);
  expect(q().published_at).not.toBeNull();
});

test('A4: un comentario que llega entre publicar y guardar published_at no se descarta: se reconcilia por marcador y se acepta', async () => {
  const comments: RawComment[] = [];
  t = rig({ extra: { comments, roles: { alice: 'write' } } });
  t.channelChange();
  await t.pool(fakeLive([ASK]));
  await t.cycle();
  t.adm.db.query('UPDATE adm_questions SET published_at = NULL, posted_at = NULL').run(); // el residente murió entre publicar y guardar
  comments.push({ id: 1, issue: 7, login: 'alice', created_at: '2026-01-11T00:00:00Z', body: 'rojo' });
  await t.cycle();
  expect(t.adm.db.query('SELECT accept, reason FROM adm_comment_decisions').all()).toEqual([{ accept: 1, reason: 'role:write' }]);
  expect(q().status).toBe('answered');
});

test('A4: si la pregunta de verdad aún no se publicó, no se registra una decisión definitiva: el efecto reintenta', async () => {
  const comments: RawComment[] = [{ id: 1, issue: 7, login: 'alice', created_at: '2026-01-11T00:00:00Z', body: 'rojo' }];
  t = rig({ extra: { comments, roles: { alice: 'write' } } });
  t.channelChange();
  await t.pool(fakeLive([ASK]));
  t.adm.db.query("UPDATE adm_effects SET status = 'dead' WHERE kind = 'reply'").run(); // el reply no sale
  await t.cycle({ maxAttempts: 1 });
  expect(t.adm.db.query('SELECT * FROM adm_comment_decisions').all()).toEqual([]);
  expect(q().status).toBe('open');
});
