import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

test('servidor: el origen de la señal es el usuario de sesión y no el que declara el llamante; se hereda al triar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fab-origen-'));
  const s = new Store(join(dir, 'f.db'));
  s.createWorkstream({ slug: 'w', goal: 'g', repo: '/tmp/r' });
  const sig = s.asActor({ actor: 'ana', userId: 'u-ana', source: 'web', role: 'O' }).addSignal('w', 't', 'b', { source: 'web', actorId: 'root' });
  const row = s.db.query('SELECT origin_actor_id a, origin_user_id u FROM signals WHERE id = ?').get(sig.id) as { a: string; u: string };
  expect(row).toEqual({ a: 'u-ana', u: 'u-ana' });
  const c = s.asActor(undefined).triageSignal(sig.id);
  expect(s.db.query('SELECT responsible_user_id r, origin_actor_id a, origin_source o FROM changes WHERE id = ?').get(c.id)).toEqual({ r: 'u-ana', a: 'u-ana', o: 'web' });
  const local = s.addSignal('w', 't2', 'b', { source: 'cli', actorId: 'orlando' });
  expect(s.db.query('SELECT origin_actor_id a, origin_user_id u FROM signals WHERE id = ?').get(local.id)).toEqual({ a: 'orlando', u: null });
  s.close(); rmSync(dir, { recursive: true, force: true });
});
