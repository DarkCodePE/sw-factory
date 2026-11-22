import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import https from 'node:https';
import { Store, StoreError } from '../src/store.ts';
import { startWeb, webMain } from '../src/web.ts';
import { accessInput, setAccess } from '../src/web-access.ts';
import { validateServerConfig, isAuthorizedHost, isAuthorizedOrigin } from '../src/web-server.ts';

describe('T118a: Modo servidor, frontera HTTP y arranque', () => {
  let tempDir: string;
  let stateDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `fab-t118-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    stateDir = join(tempDir, 'state');
    mkdirSync(stateDir, { recursive: true });
    // Crea una base inicial
    const store = new Store(join(stateDir, 'fabrica.db'));
    const ws = store.createWorkstream({ slug: 'ws-test', goal: 'Servidor', repo: 'test/repo' });
    store.createChange(ws.id, 'Change inicial', 'Descripción');
    store.close();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  test('Sin TLS, el modo servidor no arranca (publicOrigin obligatorio y HTTPS)', () => {
    // 1. Sin publicOrigin
    expect(() => {
      startWeb(stateDir, 0, { server: true });
    }).toThrow('El modo servidor requiere publicOrigin con HTTPS');

    // 2. Con publicOrigin HTTP inseguro
    expect(() => {
      startWeb(stateDir, 0, { server: true, publicOrigin: 'http://inseguro.ejemplo.com' });
    }).toThrow('requiere HTTPS canónico');

    // 3. Con URL inválida
    expect(() => {
      startWeb(stateDir, 0, { server: true, publicOrigin: 'no-es-una-url' });
    }).toThrow('publicOrigin inválido');

    // 4. Con HTTPS válido arranca correctamente
    const server = startWeb(stateDir, 0, { server: true, publicOrigin: 'https://fab.ejemplo.com' });
    expect(server.canonicalHost).toBe('fab.ejemplo.com');
    expect(server.publicOrigin).toBe('https://fab.ejemplo.com');
    server.stop(true);
  });

  test('Host ajeno da 403', async () => {
    const server = startWeb(stateDir, 0, {
      server: true,
      publicOrigin: 'https://fab.ejemplo.com',
    });
    const port = server.port;

    // 1. Petición con Host ajeno atacante.com -> 403
    const resEvil = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { Host: 'atacante.com' },
    });
    expect(resEvil.status).toBe(403);
    const textEvil = await resEvil.text();
    expect(textEvil).toContain('Acceso denegado');

    // 2. Petición con Host loopback en modo servidor -> 403
    const resLoopback = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(resLoopback.status).toBe(403);

    // 3. Petición con Host canónico exacto -> 200
    const resOk = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { Host: 'fab.ejemplo.com' },
    });
    expect(resOk.status).toBe(200);
    expect(await resOk.text()).toBe('ok');

    server.stop(true);
  });

  test('Ruta /healthz devuelve 200 OK y cabeceras de seguridad HSTS', async () => {
    const server = startWeb(stateDir, 0, {
      server: true,
      publicOrigin: 'https://fab.ejemplo.com',
    });
    const port = server.port;

    // GET /healthz
    const resGet = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { Host: 'fab.ejemplo.com' },
    });
    expect(resGet.status).toBe(200);
    expect(await resGet.text()).toBe('ok');
    // Cabeceras estrictas
    expect(resGet.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
    expect(resGet.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(resGet.headers.get('Cache-Control')).toBe('no-store');
    expect(resGet.headers.get('Referrer-Policy')).toBe('no-referrer');

    // HEAD /healthz
    const resHead = await fetch(`http://127.0.0.1:${port}/healthz`, {
      method: 'HEAD',
      headers: { Host: 'fab.ejemplo.com' },
    });
    expect(resHead.status).toBe(200);
    expect(resHead.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');

    // POST /healthz -> 405 Method Not Allowed
    const resPost = await fetch(`http://127.0.0.1:${port}/healthz`, {
      method: 'POST',
      headers: { Host: 'fab.ejemplo.com', Origin: 'https://fab.ejemplo.com' },
    });
    expect(resPost.status).toBe(405);

    server.stop(true);
  });

  test('Fixture inerte /_test/origin comprueba Origin exacto, ausente y ajeno (T118a)', async () => {
    const server = startWeb(stateDir, 0, {
      server: true,
      publicOrigin: 'https://fab.ejemplo.com',
      fixtureTestOrigin: true,
    });
    const port = server.port;

    // 1. Origin exacto -> 204 No Content
    const resExact = await fetch(`http://127.0.0.1:${port}/_test/origin`, {
      method: 'POST',
      headers: {
        Host: 'fab.ejemplo.com',
        Origin: 'https://fab.ejemplo.com',
      },
    });
    expect(resExact.status).toBe(204);
    expect(resExact.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');

    // 2. Origin ausente -> 403
    const resMissing = await fetch(`http://127.0.0.1:${port}/_test/origin`, {
      method: 'POST',
      headers: {
        Host: 'fab.ejemplo.com',
      },
    });
    expect(resMissing.status).toBe(403);
    expect(await resMissing.text()).toContain('Origin ausente o ajeno');

    // 3. Origin ajeno -> 403
    const resEvil = await fetch(`http://127.0.0.1:${port}/_test/origin`, {
      method: 'POST',
      headers: {
        Host: 'fab.ejemplo.com',
        Origin: 'https://evil-phishing.com',
      },
    });
    expect(resEvil.status).toBe(403);
    expect(await resEvil.text()).toContain('Origin ausente o ajeno');

    // 4. Método GET -> 405
    const resGet = await fetch(`http://127.0.0.1:${port}/_test/origin`, {
      method: 'GET',
      headers: { Host: 'fab.ejemplo.com' },
    });
    expect(resGet.status).toBe(405);

    server.stop(true);

    // 5. En servidor de producción (fixtureTestOrigin = false), la ruta no está abierta
    const prodServer = startWeb(stateDir, 0, {
      server: true,
      publicOrigin: 'https://fab.ejemplo.com',
      fixtureTestOrigin: false,
    });
    const resProd = await fetch(`http://127.0.0.1:${prodServer.port}/_test/origin`, {
      method: 'POST',
      headers: {
        Host: 'fab.ejemplo.com',
        Origin: 'https://fab.ejemplo.com',
      },
    });
    // Debe requerir sesión o no encontrarse
    expect(resProd.status).toBe(401);
    prodServer.stop(true);
  });

  test('GET/HEAD sin credencial no obtienen datos de negocio en modo servidor', async () => {
    const server = startWeb(stateDir, 0, {
      server: true,
      publicOrigin: 'https://fab.ejemplo.com',
    });
    const port = server.port;

    // Rutas de negocio: exigen sesión
    const rutas = ['/', '/changes', '/workstreams', '/signals', '/automations', '/metricas', '/config'];
    for (const r of rutas) {
      const res = await fetch(`http://127.0.0.1:${port}${r}`, {
        headers: { Host: 'fab.ejemplo.com' },
      });
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).toContain('Se requiere sesión autenticada en modo servidor');
      // No contiene datos del Store (títulos ni workstreams sembrados)
      expect(text).not.toContain('ws-test');
      expect(text).not.toContain('Change inicial');
    }

    // Archivos estáticos públicos (CSS/JS) responden 200 sin filtrar datos
    const resCss = await fetch(`http://127.0.0.1:${port}/style.css`, {
      headers: { Host: 'fab.ejemplo.com' },
    });
    expect(resCss.status).toBe(200);

    server.stop(true);
  });

  test('Transporte D-4 Opción A: socket Unix con permisos 0660 y limpieza', async () => {
    const socketPath = join(tempDir, 'fab.sock');

    const server = startWeb(stateDir, 0, {
      server: true,
      publicOrigin: 'https://fab.ejemplo.com',
      socketPath,
    });

    // 1. El socket existe y tiene permisos 0660
    expect(existsSync(socketPath)).toBe(true);
    const mode = statSync(socketPath).mode & 0o777;
    expect(mode.toString(8)).toBe('660');

    // 2. Conexión HTTP sobre el socket Unix con Host canónico
    const res = await fetch('http://localhost/healthz', {
      unix: socketPath,
      headers: { Host: 'fab.ejemplo.com' },
    } as any);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');

    // 3. Conexión con Host ajeno sobre socket Unix -> 403
    const resBadHost = await fetch('http://localhost/healthz', {
      unix: socketPath,
      headers: { Host: 'otro-host.com' },
    } as any);
    expect(resBadHost.status).toBe(403);

    // 4. server.stop() elimina el socket
    server.stop(true);
    expect(existsSync(socketPath)).toBe(false);
  });

  test('Transporte D-4 Opción A: mTLS en Docker rechaza clientes sin cert y admite cert de CA', async () => {
    const tlsDir = join(tempDir, 'tls');
    mkdirSync(tlsDir, { recursive: true });

    // CA válida
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tlsDir}/ca.key -out ${tlsDir}/ca.crt -days 30 -subj "/CN=FabInternalCA"`, { stdio: 'ignore' });
    // Servidor cert
    execSync(`openssl req -newkey rsa:2048 -nodes -keyout ${tlsDir}/server.key -out ${tlsDir}/server.csr -subj "/CN=fab-backend"`, { stdio: 'ignore' });
    execSync(`openssl x509 -req -in ${tlsDir}/server.csr -CA ${tlsDir}/ca.crt -CAkey ${tlsDir}/ca.key -CAcreateserial -out ${tlsDir}/server.crt -days 30`, { stdio: 'ignore' });
    // Cliente Caddy cert (firmado por la CA válida)
    execSync(`openssl req -newkey rsa:2048 -nodes -keyout ${tlsDir}/client.key -out ${tlsDir}/client.csr -subj "/CN=caddy"`, { stdio: 'ignore' });
    execSync(`openssl x509 -req -in ${tlsDir}/client.csr -CA ${tlsDir}/ca.crt -CAkey ${tlsDir}/ca.key -CAcreateserial -out ${tlsDir}/client.crt -days 30`, { stdio: 'ignore' });

    // CA no autorizada (rogue)
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tlsDir}/rogue-ca.key -out ${tlsDir}/rogue-ca.crt -days 30 -subj "/CN=RogueCA"`, { stdio: 'ignore' });
    execSync(`openssl req -newkey rsa:2048 -nodes -keyout ${tlsDir}/rogue.key -out ${tlsDir}/rogue.csr -subj "/CN=rogue"`, { stdio: 'ignore' });
    execSync(`openssl x509 -req -in ${tlsDir}/rogue.csr -CA ${tlsDir}/rogue-ca.crt -CAkey ${tlsDir}/rogue-ca.key -CAcreateserial -out ${tlsDir}/rogue.crt -days 30`, { stdio: 'ignore' });

    const server = startWeb(stateDir, 0, {
      server: true,
      publicOrigin: 'https://fab.ejemplo.com',
      tls: {
        cert: `${tlsDir}/server.crt`,
        key: `${tlsDir}/server.key`,
        ca: `${tlsDir}/ca.crt`,
        requestCert: true,
        rejectUnauthorized: true,
      },
    });

    const port = server.port;

    const requestHttps = (options: https.RequestOptions) => new Promise<{ status?: number; data?: string; error?: string }>(resolve => {
      const req = https.request({
        hostname: 'localhost',
        port,
        path: '/healthz',
        method: 'GET',
        headers: { Host: 'fab.ejemplo.com' },
        ca: readFileSync(`${tlsDir}/ca.crt`),
        checkServerIdentity: () => undefined,
        ...options,
      }, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode, data: body }));
      });
      req.on('error', err => resolve({ error: err.message }));
      req.end();
    });

    // 1. Cliente sin certificado -> rechazado en handshake
    const resSinCert = await requestHttps({});
    expect(resSinCert.error).toBeDefined();

    // 2. Cliente con certificado de CA no autorizada -> rechazado en handshake
    const resRogueCert = await requestHttps({
      cert: readFileSync(`${tlsDir}/rogue.crt`),
      key: readFileSync(`${tlsDir}/rogue.key`),
    });
    expect(resRogueCert.error).toBeDefined();

    // 3. Cliente con certificado válido firmado por la CA del dueño -> aceptado 200 OK
    const resValido = await requestHttps({
      cert: readFileSync(`${tlsDir}/client.crt`),
      key: readFileSync(`${tlsDir}/client.key`),
    });
    expect(resValido.status).toBe(200);
    expect(resValido.data).toBe('ok');

    server.stop(true);
  });

  test('mTLS falla cerrado si el certificado está caducado o falta CA', () => {
    const tlsDir = join(tempDir, 'tls-expired');
    mkdirSync(tlsDir, { recursive: true });

    // CA
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tlsDir}/ca.key -out ${tlsDir}/ca.crt -days 30 -subj "/CN=CA"`, { stdio: 'ignore' });
    execSync(`openssl req -newkey rsa:2048 -nodes -keyout ${tlsDir}/expired.key -out /dev/null -subj "/CN=expired"`, { stdio: 'ignore' });

    // Certificado estático precomputado con validez 2020-01-01 a 2020-01-02 (caducado)
    const expiredPem = `-----BEGIN CERTIFICATE-----
MIICyDCCAbCgAwIBAgIUXAgkgknEYDo+qUh12t43S0Ide78wDQYJKoZIhvcNAQEL
BQAwHjEcMBoGA1UEAwwTZXhwaXJlZC5leGFtcGxlLmNvbTAeFw0yMDAxMDEwMDAw
MDBaFw0yMDAxMDIwMDAwMDBaMB4xHDAaBgNVBAMME2V4cGlyZWQuZXhhbXBsZS5j
b20wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDM40rGfa2m59meNNeD
3lVfcBHHnDBn4xxz8rISTrXQ5PkyyDZ0j8VAVdVpSuDIGSxQ8kakhoPLoL16pLqW
LrQr7zxHgzWGbVjZ8sixwK+h/+jvSAI6l2VS8aHPNdCSVkhsAwrkW1v0TtH3UOuz
YwNAKH49astMn7QAEXmtjWbYd6QU8y8Y7y3COQ4s1Kdry409hJyUuJRV3kQDJ2Jl
/x7i1Wo8UuH5++Yt8nAlVmIW7b9LJOzTia8jJCQgwk0MQmybv8S2VyyaevICfcJv
eZRPXxZRjHBBri3AvwLfGDFT3jKboYiUz0PNJ1EI+9uuIeq94NG/hFJYErFGDm39
0Gv5AgMBAAEwDQYJKoZIhvcNAQELBQADggEBAL3aVBTLedQwWLgcBnojMxt8vIH3
5WHyEoTKQGA+yHAs9GachRJG/nXR1A69PcCCIXJSKFIAA96zclL17UtmI+qLTw6M
CHOTBYsrL46awyYvtiCPcJ1/FtY7/RZHEGgJ/NlZ4QToRuWNKnmcEh4ki13JgEQl
6sJJjPzL+vDE0xsrv02Rn3M3gDO2C8iNV+CNEp+s3VYE9THxMt2k28/p28TqKWGC
uV6Jp/KhT6NRB4TFjGMIGUxZDdM3j5Fr0W4PRRG/Tjn82r9v1KD3OEFpvXkllBQS
uQAwb1guU1AUR6nVZtdFNQM9kVZ98hOcE9GUPLNEWYbELrBmbFfLChpyQQU=
-----END CERTIFICATE-----
`;
    writeFileSync(`${tlsDir}/expired.crt`, expiredPem);

    // Falla si el certificado está caducado
    expect(() => {
      validateServerConfig({
        server: true,
        publicOrigin: 'https://fab.ejemplo.com',
        tls: {
          cert: `${tlsDir}/expired.crt`,
          key: `${tlsDir}/expired.key`,
          ca: `${tlsDir}/ca.crt`,
        },
      });
    }).toThrow('El certificado TLS ha caducado');

    // Falla si falta CA
    expect(() => {
      validateServerConfig({
        server: true,
        publicOrigin: 'https://fab.ejemplo.com',
        tls: {
          cert: `${tlsDir}/expired.crt`,
          key: `${tlsDir}/expired.key`,
          ca: `${tlsDir}/ca-inexistente.crt`,
        },
      });
    }).toThrow('CA interna de mTLS requerida');
  });

  test('web-access rechaza modo legacy en servidor y lo mantiene en local', () => {
    const store = new Store(join(stateDir, 'fabrica.db'));
    const ws = store.createWorkstream({ slug: 'ws-access', goal: 'G', repo: 'R' });

    // 1. En servidor, rechaza legacy
    expect(() => {
      accessInput({ kind: 'env', mode: 'legacy', names: '' }, { server: true });
    }).toThrow(StoreError);

    expect(() => {
      setAccess(store, stateDir, ws.id, { kind: 'env', mode: 'legacy', names: '' }, { server: true });
    }).toThrow(StoreError);

    // 2. En servidor, acepta declared
    const declared = accessInput({ kind: 'env', mode: 'declared', names: 'API_KEY' }, { server: true });
    expect(declared.mode).toBe('declared');
    expect(declared.names).toBe('API_KEY');

    // 3. En local, mantiene legacy sin error
    const local = accessInput({ kind: 'env', mode: 'legacy', names: '' });
    expect(local.mode).toBe('legacy');

    store.close();
  });

  test('T118-H1: /api/v1/* se cierra en modo servidor (401 con HSTS) y no autentica claves locales sin usuario', async () => {
    const store = new Store(join(stateDir, 'fabrica.db'));
    const ws = store.createWorkstream({ slug: 'ws-api', goal: 'G', repo: 'R' });
    store.setWorkstreamState(ws.id, 'active');
    const ch = store.createChange(ws.id, 'Change API', 'Desc');
    const { key: readKey } = store.createApiKey('k-read', 'read');
    const { key: decideKey } = store.createApiKey('k-decide', 'decide');
    store.close();

    const socketPath = join(tempDir, 'fab-h1.sock');
    const server = startWeb(stateDir, 0, {
      server: true,
      write: true,
      publicOrigin: 'https://fab.ejemplo.com',
      socketPath,
    });

    // 1. GET /api/v1/workstreams con clave local 'read' -> 401 con HSTS
    const resGet = await fetch('http://localhost/api/v1/workstreams', {
      unix: socketPath,
      headers: {
        Host: 'fab.ejemplo.com',
        Authorization: `Bearer ${readKey}`,
      },
    } as any);
    expect(resGet.status).toBe(401);
    expect(resGet.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
    const textGet = await resGet.text();
    expect(textGet).toContain('Se requiere autenticación de usuario en modo servidor');
    expect(textGet).not.toContain('ws-api');

    // 2. POST /api/v1/changes/:id/note con clave local 'decide' -> 401 con HSTS y cero escrituras
    const resPost = await fetch(`http://localhost/api/v1/changes/${ch.id}/note`, {
      method: 'POST',
      unix: socketPath,
      headers: {
        Host: 'fab.ejemplo.com',
        Origin: 'https://fab.ejemplo.com',
        Authorization: `Bearer ${decideKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: 'Nota no autorizada en servidor' }),
    } as any);
    expect(resPost.status).toBe(401);
    expect(resPost.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');

    // Verificar que no se escribió nada en la base de datos
    const verifyStore = new Store(join(stateDir, 'fabrica.db'), { readonly: true });
    expect(verifyStore.listChangeNotes(ch.id).length).toBe(0);
    verifyStore.close();

    server.stop(true);
  });

  test('CLI webMain valida banderas y argumentos de modo servidor', async () => {
    // 1. --help retorna 0
    const codeHelp = await webMain(['--help'], stateDir);
    expect(codeHelp).toBe(0);

    // 2. --server sin publicOrigin retorna 1
    const codeNoOrigin = await webMain(['--server'], stateDir);
    expect(codeNoOrigin).toBe(1);

    // 3. --server con publicOrigin sin HTTPS retorna 1
    const codeHttp = await webMain(['--server', '--public-origin', 'http://insecure.example.com'], stateDir);
    expect(codeHttp).toBe(1);
  });
});
