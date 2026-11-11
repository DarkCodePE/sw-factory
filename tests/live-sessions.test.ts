import { expect, test } from 'bun:test';
import { SessionMismatchError, SessionStore } from '../src/admission/sessions.ts';
import { claimed } from './helpers/live.ts';

const meta = { backend: 'claude', cwd: '/w/a', model: 'm1', profileDigest: 'p1' };

test('la sesión se escribe antes de lanzar y el primer turno empieza con ese id', () => {
  const { adm, change } = claimed(), s = new SessionStore(adm);
  const { session, turn } = s.begin(change.id, 'implementation', meta);
  expect(turn).toEqual({ newSessionId: session.sessionId });
  expect(session).toMatchObject({ generation: 1, launched: false, status: 'open', backend: 'claude', cwd: '/w/a', model: 'm1' });
  expect(s.current(change.id, 'implementation')?.sessionId).toBe(session.sessionId);
});

test('tras lanzar, el siguiente turno reanuda exactamente esa sesión, aunque cambie la activity (retryChange) o el pool caiga', () => {
  const { store, adm, change, claim } = claimed(), s = new SessionStore(adm);
  const first = s.begin(change.id, 'implementation', meta);
  s.markLaunched(first.session.sessionId);
  // el pool muere, el huérfano vuelve a pending y el siguiente claim es otra activity de la misma clase
  const a = claim();
  store.failActivity(a.id, 'w1', 'x'); store.failActivity(claim('w2').id, 'w2', 'x'); store.failActivity(claim('w3').id, 'w3', 'x');
  store.retryChange(change.id);
  expect(new SessionStore(adm).begin(change.id, 'implementation', meta).turn).toEqual({ sessionId: first.session.sessionId });
});

test('otro tipo de activity del mismo change tiene su propia sesión', () => {
  const { adm, change } = claimed(), s = new SessionStore(adm);
  const a = s.begin(change.id, 'implementation', meta).session, b = s.begin(change.id, 'investigation', meta).session;
  expect(a.sessionId).not.toBe(b.sessionId);
});

test('cambiar backend, cwd o modelo de una sesión lanzada no reanuda: SessionMismatchError', () => {
  const { adm, change } = claimed(), s = new SessionStore(adm);
  s.markLaunched(s.begin(change.id, 'implementation', meta).session.sessionId);
  for (const over of [{ cwd: '/w/b' }, { backend: 'native' }, { model: 'm2' }]) {
    expect(() => s.begin(change.id, 'implementation', { ...meta, ...over })).toThrow(SessionMismatchError);
  }
  expect(s.current(change.id, 'implementation')?.generation).toBe(1); // no se creó otra en silencio
});

test('una sesión sin lanzar toma los datos del turno actual', () => {
  const { adm, change } = claimed(), s = new SessionStore(adm);
  s.begin(change.id, 'implementation', meta);
  expect(s.begin(change.id, 'implementation', { ...meta, cwd: '/w/b' }).session.cwd).toBe('/w/b');
});

test('caída entre escribir la sesión y lanzar: la fila sigue y se reutiliza sin duplicar', () => {
  const { adm, change } = claimed();
  const first = new SessionStore(adm).begin(change.id, 'implementation', meta); // el proceso muere aquí, antes de markLaunched
  const second = new SessionStore(adm).begin(change.id, 'implementation', meta);
  expect(second.session.sessionId).toBe(first.session.sessionId);
  expect(adm.db.query('SELECT COUNT(*) n FROM adm_sessions').get()).toEqual({ n: 1 });
});

test('el backend claude arranca la sesión nueva con el id que escribió la fab', async () => {
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const { claudeLive } = await import('../src/live/claude.ts');
  const dir = mkdtempSync(join(tmpdir(), 'live-sid-'));
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\necho '{"type":"result","result":"ok","session_id":"x"}'`);
  chmodSync(join(dir, 'claude'), 0o755);
  const saved = process.env.PATH; process.env.PATH = `${dir}:${saved}`;
  try {
    const { adm, change } = claimed(), { session, turn } = new SessionStore(adm).begin(change.id, 'implementation', meta);
    const r = await claudeLive.run({ ...turn, prompt: 'x', cwd: dir, attemptId: 'a' });
    expect(r.sessionId).toBe(session.sessionId);
    const argv = readFileSync(join(dir, 'argv'), 'utf8').split('\n');
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(session.sessionId);
  } finally { process.env.PATH = saved; }
});

test('A8: cambiar el perfil tras lanzar es otra sesión (profile_digest se compara, no solo se guarda)', () => {
  const { adm, change } = claimed(), s = new SessionStore(adm);
  s.markLaunched(s.begin(change.id, 'implementation', meta).session.sessionId);
  expect(() => s.begin(change.id, 'implementation', { ...meta, profileDigest: 'p2' })).toThrow(SessionMismatchError);
  expect(s.begin(change.id, 'implementation', meta).turn).toHaveProperty('sessionId'); // el mismo perfil reanuda
});
