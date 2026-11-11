import { expect, test } from 'bun:test';
import { Resident } from '../src/admission/resident.ts';
import { Store } from '../src/store.ts';
import { POLICY, REPO } from './helpers/admission.ts';

// T24 (H-09): el pool ejecuta los turnos; el residente solo hace poll, Outbox y reencolado. La cola de efectos es serie:
// un efecto `launch` de 20 minutos pararía el poll y el Outbox. Parar un turno ya funciona porque el latido rechaza un change terminal.
const kinds = (r: Resident) => Object.keys((r.effects as unknown as { handlers: object }).handlers).sort();

test('el residente no tiene efectos launch/deliver/stop: solo admisión, entrada de comentarios y (opt-in) reply', () => {
  const store = new Store(':memory:');
  expect(kinds(new Resident(store, { repo: REPO, policy: POLICY, mode: 'observe' }))).toEqual(['admit', 'inbound']);
  expect(kinds(new Resident(store, { repo: REPO, policy: POLICY, mode: 'observe', selfLogin: 'fab-bot', outbox: true }))).toEqual(['admit', 'inbound', 'reply']);
  store.close();
});
