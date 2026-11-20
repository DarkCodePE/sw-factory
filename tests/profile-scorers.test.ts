import { expect, test } from 'bun:test';
import { defaultProfile, DEFAULT_DIGEST, profileDigest, validateProfile } from '../src/profile.ts';
import { CONFINABLE_AGENTS } from '../src/sandbox/confine.ts';

const scorer = (extra: Record<string, unknown> = {}) => ({
  scope: 'investigate', rubric: 'Evalúa la spec.', passing: 0.5, sampling: 0.1,
  classes: [{ label: 'completa', score: 1 }, { label: 'vaga', score: 0 }], ...extra,
});
const v2 = (scorers: unknown = { 'spec-clara': scorer() }, extra: Record<string, unknown> = {}) =>
  ({ ...defaultProfile(), schemaVersion: 2, harness: 'claude', scorers, ...extra }) as any;
const bad = (raw: unknown, msg: RegExp) => expect(() => validateProfile(raw)).toThrow(msg);

test('CONFINABLE_AGENTS es la lista de assertConfinement', () => {
  expect([...CONFINABLE_AGENTS]).toEqual(['claude', 'codex', 'fake', 'simulated']);
});

test('v2 con scorers válido; harness y model opcionales', () => {
  expect(validateProfile(v2()).schemaVersion).toBe(2);
  expect(() => validateProfile(v2({ a: scorer({ harness: 'codex', model: 'gpt-6.1-sol' }), b: scorer({ scope: 'change', sampling: 0, passing: 0 }) }))).not.toThrow();
  expect(() => validateProfile(v2({}))).not.toThrow();
});

test('cada rechazo nombra el campo', () => {
  bad(v2('x'), /scorers/);
  bad(v2([]), /scorers/);
  bad(v2({ 'Mal-Nombre': scorer() }), /scorers\.Mal-Nombre/);
  bad(v2({ '-a': scorer() }), /scorers\.-a/);
  bad(v2({ ['a' + 'b'.repeat(41)]: scorer() }), /scorers\./);
  expect(() => validateProfile(v2({ ['a' + 'b'.repeat(40)]: scorer() }))).not.toThrow();
  bad(v2(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`j${i}`, scorer()]))), /scorers.*8/);
  expect(() => validateProfile(v2(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`j${i}`, scorer()]))))).not.toThrow();
  bad(v2({ a: 'x' }), /scorers\.a/);
  bad(v2({ a: scorer({ scope: 'merge' }) }), /scorers\.a\.scope/);
  bad(v2({ a: scorer({ rubric: '  ' }) }), /scorers\.a\.rubric/);
  bad(v2({ a: scorer({ rubric: 5 }) }), /scorers\.a\.rubric/);
  bad(v2({ a: scorer({ rubric: 'x'.repeat(32 * 1024 + 1) }) }), /scorers\.a\.rubric/);
  bad(v2({ a: scorer({ classes: [{ label: 'a', score: 1 }] }) }), /scorers\.a\.classes/);
  bad(v2({ a: scorer({ classes: Array.from({ length: 8 }, (_, i) => ({ label: `c${i}`, score: 0 })) }) }), /scorers\.a\.classes/);
  bad(v2({ a: scorer({ classes: 'x' }) }), /scorers\.a\.classes/);
  bad(v2({ a: scorer({ classes: [{ label: 'a', score: 1 }, { label: 'a', score: 0 }] }) }), /scorers\.a\.classes.*repet/);
  bad(v2({ a: scorer({ classes: [{ label: 'A B', score: 1 }, { label: 'b', score: 0 }] }) }), /scorers\.a\.classes\[0\]\.label/);
  bad(v2({ a: scorer({ classes: [{ label: 'a'.repeat(25), score: 1 }, { label: 'b', score: 0 }] }) }), /scorers\.a\.classes\[0\]\.label/);
  bad(v2({ a: scorer({ classes: [{ label: 'a', score: 1.5 }, { label: 'b', score: 0 }] }) }), /scorers\.a\.classes\[0\]\.score/);
  bad(v2({ a: scorer({ classes: [{ label: 'a', score: 1 }, { label: 'b', score: '0' }] }) }), /scorers\.a\.classes\[1\]\.score/);
  bad(v2({ a: scorer({ classes: [{ label: 'a', score: 1 }, { label: 'b', score: 0, x: 1 }] }) }), /scorers\.a\.classes\[1\]\.x/);
  bad(v2({ a: scorer({ passing: 2 }) }), /scorers\.a\.passing/);
  bad(v2({ a: scorer({ passing: undefined }) }), /scorers\.a\.passing/);
  bad(v2({ a: scorer({ sampling: -0.1 }) }), /scorers\.a\.sampling/);
  bad(v2({ a: scorer({ sampling: NaN }) }), /scorers\.a\.sampling/);
  bad(v2({ a: scorer({ harness: 'agy' }) }), /scorers\.a\.harness/);
  bad(v2({ a: scorer({ harness: 'nope' }) }), /scorers\.a\.harness/);
  for (const harness of [null, 7, {}]) bad(v2({ a: scorer({ harness }) }), /scorers\.a\.harness/); // null no es «ausente»: daría otro digest
  bad(v2({ a: scorer({ model: '-x', harness: 'claude' }) }), /scorers\.a\.model/);
  bad(v2({ a: scorer({ model: 'm', harness: 'agy' }) }), /scorers\.a\.harness/);
  bad(v2({ a: scorer({ temperature: 1 }) }), /scorers\.a\.temperature/);
});

test('sin harness propio, profile.harness debe ser confinable', () => {
  bad(v2({ a: scorer() }, { harness: 'native' }), /scorers\.a\.harness/);
  expect(() => validateProfile(v2({ a: scorer({ harness: 'claude' }) }, { harness: 'native' }))).not.toThrow();
});

test('scorers en v1 se rechaza; digests v1 no cambian', () => {
  bad({ ...defaultProfile(), scorers: {} }, /clave desconocida scorers/);
  expect(DEFAULT_DIGEST).toBe('2dff534e629bba57f035f8c59aa154664a6f1b8e7dd149d585fab524af7bb1b6');
});

test('una rúbrica distinta es un digest distinto', () => {
  const d = (rubric: string) => profileDigest(validateProfile(v2({ a: scorer({ rubric }) })));
  expect(d('uno')).not.toBe(d('dos'));
  expect(d('uno')).toBe(d('uno'));
});
