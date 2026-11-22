import { existsSync, readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

export interface ServerTlsConfig {
  cert: string;
  key: string;
  ca?: string;
}

export interface ServerConfig {
  server?: boolean;
  publicOrigin?: string;
  socketPath?: string;
  tls?: ServerTlsConfig;
  fixtureTestOrigin?: boolean;
}

export const SERVER_SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
};

export interface ValidatedServerConfig {
  canonicalHost: string;
  publicOrigin: string;
}

/**
 * Valida la configuración del modo servidor (T118a, D-4).
 * Falla cerrado si falta TLS en publicOrigin, si el host no es canónico o si las credenciales son inválidas/caducadas.
 */
export function validateServerConfig(config: ServerConfig): ValidatedServerConfig {
  if (!config.publicOrigin || typeof config.publicOrigin !== 'string') {
    throw new Error('El modo servidor requiere publicOrigin con HTTPS (ej. https://fab.ejemplo.com)');
  }

  let parsed: URL;
  try {
    parsed = new URL(config.publicOrigin);
  } catch {
    throw new Error(`publicOrigin inválido: «${config.publicOrigin}». Debe ser una URL HTTPS canónica.`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`El modo servidor requiere HTTPS canónico en publicOrigin; se recibió «${config.publicOrigin}»`);
  }

  if (config.publicOrigin !== parsed.origin) {
    throw new Error(`publicOrigin no canónico: «${config.publicOrigin}». Debe ser exactamente «${parsed.origin}» (sin ruta, barra final, puerto :443 redundante, credenciales, query ni mayúsculas).`);
  }

  if (
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1' ||
    parsed.hostname === '[::1]' ||
    parsed.hostname === '0.0.0.0' ||
    parsed.hostname === '[::]'
  ) {
    throw new Error(`publicOrigin inválido para modo servidor: «${config.publicOrigin}». No se permite loopback ni comodín en modo servidor.`);
  }

  if (parsed.hostname.endsWith('.')) {
    throw new Error(`publicOrigin no canónico: «${config.publicOrigin}». No se permite punto final en el nombre de host.`);
  }

  const canonicalHost = parsed.host; // incluye puerto si no es estándar (ej. fab.example.com o fab.example.com:8443)

  // Validación de mTLS para Docker (D-4 Opción A)
  if (config.tls) {
    if (!config.tls.cert || !existsSync(config.tls.cert)) {
      throw new Error(`Certificado TLS no encontrado o no legible: ${config.tls.cert}`);
    }
    if (!config.tls.key || !existsSync(config.tls.key)) {
      throw new Error(`Clave privada TLS no encontrada o no legible: ${config.tls.key}`);
    }
    if (!config.tls.ca || !existsSync(config.tls.ca)) {
      throw new Error(`CA interna de mTLS requerida en modo Docker: no encontrada en ${config.tls.ca}`);
    }

    try {
      const certBytes = readFileSync(config.tls.cert);
      const x509 = new X509Certificate(certBytes);
      const validToMs = new Date(x509.validTo).getTime();
      const now = Date.now();
      if (validToMs < now) {
        throw new Error(`El certificado TLS ha caducado (${x509.validTo}). Salto autenticado interrumpido.`);
      }
      const daysRemaining = Math.floor((validToMs - now) / (1000 * 60 * 60 * 24));
      if (daysRemaining < 7) {
        console.warn(`[T118 mTLS] ALERTA: el certificado TLS vence en ${daysRemaining} días (${x509.validTo}). Rote las credenciales.`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('caducado')) throw err;
      throw new Error(`Error al verificar certificado TLS: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    canonicalHost,
    publicOrigin: config.publicOrigin.replace(/\/+$/, ''), // sin barra final
  };
}

/** Comprueba que la cabecera Host coincida exactamente con el host canónico configurado. */
export function isAuthorizedHost(reqHost: string | null | undefined, canonicalHost: string): boolean {
  if (!reqHost) return false;
  return reqHost.trim().toLowerCase() === canonicalHost.toLowerCase();
}

/** Comprueba que la cabecera Origin coincida exactamente con el publicOrigin canónico. */
export function isAuthorizedOrigin(reqOrigin: string | null | undefined, publicOrigin: string): boolean {
  if (!reqOrigin) return false;
  return reqOrigin.trim() === publicOrigin;
}
