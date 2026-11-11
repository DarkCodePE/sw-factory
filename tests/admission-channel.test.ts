import { expect, test } from 'bun:test';
import { ChannelBackendError, isChannelChange, runLiveTurn } from '../src/admission/channel.ts';
import { ThreadLinks } from '../src/admission/links.ts';
import type { LiveBackend, LiveTurn } from '../src/live/contract.ts';
import { REPO } from './helpers/admission.ts';
import { claimed } from './helpers/live.ts';

const seen: LiveTurn[] = [];
const backend = (name: string, confinable: boolean): LiveBackend => ({ name, confinable, run: async turn => { seen.push(turn); return { sessionId: 's', attemptId: turn.attemptId, reports: [] } as never; } });
const turn: LiveTurn = { prompt: 'p', cwd: '/w', attemptId: 'a', confine: false };

function channelChange() {
  const t = claimed(), T = `github:${REPO}#1`;
  t.adm.db.query('INSERT INTO adm_threads(id, source, first_seen) VALUES (?,?,?)').run(T, `github:${REPO}`, 'x');
  new ThreadLinks(t.adm).link(T, t.change.id);
  return t;
}

test('un change de canal rechaza un backend no confinable y no lanza nada', () => {
  const t = channelChange(); seen.length = 0;
  expect(isChannelChange(t.adm, t.change.id)).toBe(true);
  expect(() => runLiveTurn(t.adm, backend('native', false), t.change.id, turn)).toThrow(ChannelBackendError);
  expect(seen.length).toBe(0);
});

test('con un backend confinable corre siempre confinado, aunque se pida lo contrario', async () => {
  const t = channelChange(); seen.length = 0;
  await runLiveTurn(t.adm, backend('claude', true), t.change.id, turn);
  expect(seen[0]!.confine).toBe(true);
});

test('un change creado a mano no cambia: native sigue valiendo y el turno no se toca', async () => {
  const t = claimed(); seen.length = 0;
  expect(isChannelChange(t.adm, t.change.id)).toBe(false);
  await runLiveTurn(t.adm, backend('native', false), t.change.id, turn);
  expect(seen[0]).toEqual(turn);
});
