import { createHmac } from 'node:crypto';
import { expect, test } from 'bun:test';
import { verifySignature } from '../src/admission/hook.ts';

// Vector de la documentación de GitHub, recalculado con `openssl dgst -sha256 -hmac`.
const SECRET = "It's a Secret to Everybody";
const BODY = new TextEncoder().encode('Hello, World!');
const SIG = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
const sign = (secret: string, body: Uint8Array) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

test('vector conocido y firma propia válidos', () => {
  expect(verifySignature(SECRET, BODY, SIG)).toBe(true);
  expect(verifySignature(SECRET, BODY, SIG.toUpperCase().replace('SHA256=', 'sha256='))).toBe(true);
  expect(verifySignature('otro-secreto-largo-1', BODY, sign('otro-secreto-largo-1', BODY))).toBe(true);
});

test('B2: los cinco casos inválidos devuelven false', () => {
  const hex = SIG.slice(7);
  const tampered = new TextEncoder().encode('Hello, World?');
  expect(verifySignature(SECRET, BODY, null)).toBe(false); // sin cabecera
  expect(verifySignature(SECRET, BODY, `sha1=${hex.slice(0, 40)}`)).toBe(false); // otro algoritmo
  expect(verifySignature(SECRET, BODY, `sha256=${hex}00`)).toBe(false); // hex de otra longitud
  expect(verifySignature(SECRET, BODY, sign('otro-secreto', BODY))).toBe(false); // otro secreto
  expect(verifySignature(SECRET, tampered, SIG)).toBe(false); // cuerpo alterado en un byte
});

test('nunca lanza con cabeceras raras', () => {
  for (const h of ['', 'sha256=', 'sha256=zz', `sha256=${'g'.repeat(64)}`, `SHA256=${SIG.slice(7)}x`, '\u0000', 'sha256=é'.repeat(40), ' ' + SIG]) {
    expect(verifySignature(SECRET, BODY, h)).toBe(false);
  }
  expect(verifySignature('', BODY, SIG)).toBe(false);
});
