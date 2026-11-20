// Receptor de avisos de GitHub (T69). Aquí solo la verificación de la firma (T69a); el servidor llega en T69b.
// El aviso nunca aporta contenido ni autoridad: el residente vuelve a leerlo todo por la API (H1).
import { createHmac, timingSafeEqual } from 'node:crypto';

// `X-Hub-Signature-256`: `sha256=` + 64 hex del HMAC-SHA256 del cuerpo en bruto. Cualquier otra forma, false y sin lanzar.
export const verifySignature = (secret: string, body: Uint8Array, header: string | null): boolean => {
  if (!secret || header === null || !/^sha256=[0-9a-fA-F]{64}$/.test(header)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(header.slice(7), 'hex'));
};
