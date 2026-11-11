// Punta a punta en modo auto: issue etiquetado → change → turno que pregunta → comentario autorizado → reanudación → done → gates.
import { afterEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { marker } from '../src/admission/outbox.ts';
import type { RawComment } from './helpers/admission.ts';
import { rig } from './helpers/auto.ts';
import { fakeLive } from './helpers/live.ts';

let t: ReturnType<typeof rig>;
afterEach(() => t.close());

test('e2e auto: issue → change → pregunta → respuesta autorizada → reanudación → done → gates', async () => {
  const comments: RawComment[] = [];
  t = rig({ verify: ['true'], extra: { comments, roles: { alice: 'write' } } });
  t.issues.push(t.issue(7, '2026-01-07T10:00:00Z', { labels: [{ name: 'fab' }], title: 'Falla el login', body: 'Pasa al pulsar enter' }));
  const git = (cwd: string, ...a: string[]) => Bun.spawnSync(['git', '-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a]);
  const backend = fakeLive([
    { reports: [{ state: 'awaiting', summary: 'falta un dato', human_action: '¿qué color?' }] }, // investigación: pregunta
    { reports: [{ state: 'done', summary: 'spec lista' }], output: 'spec: pintar de rojo' },     // investigación reanudada: done
    { reports: [{ state: 'done', summary: 'implementado' }], output: 'hecho', before: turn => { // implementación: deja un commit
      writeFileSync(join(turn.cwd, 'color.txt'), 'rojo\n'); git(turn.cwd, 'add', '.'); git(turn.cwd, 'commit', '-qm', 'pinta de rojo'); } },
  ]);

  await t.cycle();                                                  // evento → admisión → change (unido al hilo)
  expect(t.store.db.query('SELECT COUNT(*) n FROM changes').get()).toEqual({ n: 1 });
  await t.pool(backend);                                            // turno 1: pregunta
  const [inv] = t.store.listActivities({}).filter(a => a.kind === 'investigation');
  expect(inv!.status).toBe('waiting_reply');
  expect(backend.turns[0]!.prompt).toContain('<<<UNTRUSTED');       // texto del issue delimitado
  await t.cycle();                                                  // Outbox publica la pregunta con marcador
  expect(t.run.posts).toHaveLength(1);
  expect(t.run.posts[0]!.body).toContain(marker(inv!.questionId!)); // marcador de la pregunta abierta
  comments.push({ id: 1, issue: 7, login: 'alice', created_at: '2026-01-11T00:00:00Z', body: 'rojo' });
  await t.cycle();                                                  // comentario autorizado → answerQuestion → reencola
  expect(t.store.getActivity(inv!.id).status).toBe('pending');
  await t.pool(backend);                                            // reanudación (misma sesión) → done → implementación → gates
  expect(backend.turns[1]!.prompt).toBe('rojo');
  expect(backend.turns[1]!.sessionId).toBe(backend.turns[0]!.newSessionId);
  const acts = t.store.listActivities({});
  expect(acts.find(a => a.kind === 'investigation')!.status).toBe('completed');
  expect(acts.find(a => a.kind === 'implementation')!.status).toBe('completed');
  const gates = acts.find(a => a.kind === 'gates')!;
  expect(gates.status).toBe('completed');
  expect(gates.result).toContain('VERDICT: pass');
  expect(t.store.db.query('SELECT status FROM changes').get()).not.toEqual({ status: 'failed' });
});
