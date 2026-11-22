import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import https from 'node:https';
import { Store, StoreError } from '../src/store.ts';
import { startWeb, webMain } from '../src/web.ts';
import { accessInput, setAccess } from '../src/web-access.ts';
import { performAction } from '../src/web-actions.ts';
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

    // 4. Sin socket ni mTLS se niega a arrancar
    expect(() => {
      startWeb(stateDir, 0, { server: true, publicOrigin: 'https://fab.ejemplo.com' });
    }).toThrow('requiere socket Unix');

    // 5. Con socket Unix arranca correctamente
    const socketPath = join(tempDir, 'init.sock');
    const server = startWeb(stateDir, 0, { server: true, publicOrigin: 'https://fab.ejemplo.com', socketPath });
    expect(server.canonicalHost).toBe('fab.ejemplo.com');
    expect(server.publicOrigin).toBe('https://fab.ejemplo.com');
    server.stop(true);
  });

  test('Host ajeno da 403', async () => {
    const socketPath = join(tempDir, 'fab-host.sock');
    const server = startWeb(stateDir, 0, {
      server: true,
      publicOrigin: 'https://fab.ejemplo.com',
      socketPath,
    });

    // 1. Petición con Host ajeno atacante.com -> 403
    const resEvil = await fetch('http://localhost/healthz', {
      unix: socketPath,
      headers: { Host: 'atacante.com' },
    } as any);
    expect(resEvil.status).toBe(403);
    const textEvil = await resEvil.text();
    expect(textEvil).toContain('Acceso denegado');

    // 2. Petición con Host loopback en modo servidor -> 403
    const resLoopback = await fetch('http://localhost/healthz', {
      unix: socketPath,
      headers: { Host: '127.0.0.1:4310' },
    } as any);
    expect(resLoopback.status).toBe(403);

    // 3. Petición con Host canónico exacto -> 200
    const resOk = await fetch('http://localhost/healthz', {
      unix: socketPath,
      headers: { Host: 'fab.ejemplo.com' },
    } as any);
    expect(resOk.status).toBe(200);
    expect(await resOk.text()).toBe('ok');

    server.stop(true);
  });

  test('Ruta /healthz devuelve 200 OK y cabeceras de seguridad HSTS', async () => {
    const socketPath = join(tempDir, 'fab-health.sock');
    const server = startWeb(stateDir, 0, {
      server: true,
      publicOrigin: 'https://fab.ejemplo.com',
      socketPath,
    });

    // GET /healthz
    const resGet = await fetch('http://localhost/healthz', {
      unix: socketPath,
      headers: { Host: 'fab.ejemplo.com' },
    } as any);
    expect(resGet.status).toBe(200);
    expect(await resGet.text()).toBe('ok');
    // Cabeceras estrictas
    expect(resGet.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
    expect(resGet.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(resGet.headers.get('Cache-Control')).toBe('no-store');
    expect(resGet.headers.get('Referrer-Policy')).toBe('no-referrer');

    // HEAD /healthz
    const resHead = await fetch('http://localhost/healthz', {
      method: 'HEAD',
      unix: socketPath,
      headers: { Host: 'fab.ejemplo.com' },
    } as any);
    expect(resHead.status).toBe(200);
    expect(resHead.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');

    // POST /healthz -> 405 Method Not Allowed
    const resPost = await fetch('http://localhost/healthz', {
      method: 'POST',
      unix: socketPath,
      headers: { Host: 'fab.ejemplo.com', Origin: 'https://fab.ejemplo.com' },
    } as any);
    expect(resPost.status).toBe(405);

    server.stop(true);
  });

  test('Fixture inerte /_test/origin comprueba Origin exacto, ausente y ajeno (T118a)', async () => {
    const socketPath = join(tempDir, 'fab-origin.sock');
    const server = startWeb(stateDir, 0, {
      server: true,
      publicOrigin: 'https://fab.ejemplo.com',
      socketPath,
      fixtureTestOrigin: true,
    });

    // 1. Origin exacto -> 204 No Content
    const resExact = await fetch('http://localhost/_test/origin', {
      method: 'POST',
      unix: socketPath,
      headers: {
        Host: 'fab.ejemplo.com',
        Origin: 'https://fab.ejemplo.com',
      },
    } as any);
    expect(resExact.status).toBe(204);
    expect(resExact.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');

    // 2. Origin ausente -> 403
    const resMissing = await fetch('http://localhost/_test/origin', {
      method: 'POST',
      unix: socketPath,
      headers: {
        Host: 'fab.ejemplo.com',
      },
    } as any);
    expect(resMissing.status).toBe(403);
    expect(await resMissing.text()).toContain('Origin ausente o ajeno');

    // 3. Origin ajeno -> 403 (incluyendo sufijo malicioso / M04)
    for (const evilOrigin of ['https://evil-phishing.com', 'https://fab.ejemplo.com.evil.com', 'http://fab.ejemplo.com', 'null']) {
      const resEvil = await fetch('http://localhost/_test/origin', {
        method: 'POST',
        unix: socketPath,
        headers: {
          Host: 'fab.ejemplo.com',
          Origin: evilOrigin,
        },
      } as any);
      expect(resEvil.status).toBe(403);
      expect(await resEvil.text()).toContain('Origin ausente o ajeno');
    }

    // 4. Método GET -> 405
    const resGet = await fetch('http://localhost/_test/origin', {
      method: 'GET',
      unix: socketPath,
      headers: { Host: 'fab.ejemplo.com' },
    } as any);
    expect(resGet.status).toBe(405);

    server.stop(true);

    // 5. En servidor de producción (fixtureTestOrigin = false), la ruta no está abierta
    const prodSocket = join(tempDir, 'fab-prod.sock');
    const prodServer = startWeb(stateDir, 0, {
      server: true,
      publicOrigin: 'https://fab.ejemplo.com',
      socketPath: prodSocket,
      fixtureTestOrigin: false,
    });
    const resProd = await fetch('http://localhost/_test/origin', {
      method: 'POST',
      unix: prodSocket,
      headers: {
        Host: 'fab.ejemplo.com',
        Origin: 'https://fab.ejemplo.com',
      },
    } as any);
    // Debe requerir sesión o no encontrarse
    expect(resProd.status).toBe(401);
    prodServer.stop(true);
  });

  test('GET/HEAD sin credencial no obtienen datos de negocio en modo servidor', async () => {
    const socketPath = join(tempDir, 'fab-biz.sock');
    const server = startWeb(stateDir, 0, {
      server: true,
      publicOrigin: 'https://fab.ejemplo.com',
      socketPath,
    });

    // Rutas de negocio: exigen sesión
    const rutas = ['/', '/changes', '/workstreams', '/signals', '/automations', '/metricas', '/config'];
    for (const r of rutas) {
      const res = await fetch(`http://localhost${r}`, {
        unix: socketPath,
        headers: { Host: 'fab.ejemplo.com' },
      } as any);
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).toContain('Se requiere sesión autenticada en modo servidor');
      // No contiene datos del Store (títulos ni workstreams sembrados)
      expect(text).not.toContain('ws-test');
      expect(text).not.toContain('Change inicial');
    }

    // Archivos estáticos públicos (CSS/JS) responden 200 sin filtrar datos
    const resCss = await fetch('http://localhost/style.css', {
      unix: socketPath,
      headers: { Host: 'fab.ejemplo.com' },
    } as any);
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

  test('T118-H4: Validación estricta de directorio, permisos y rechazo de socket usurpado', async () => {
    // 1. Directorio con permisos 0777 (world-writable) debe ser rechazado
    const insecureDir = join(tempDir, 'insecure-run');
    mkdirSync(insecureDir);
    chmodSync(insecureDir, 0o777);
    const sockInsecure = join(insecureDir, 'fab.sock');
    expect(() => {
      startWeb(stateDir, 0, {
        server: true,
        publicOrigin: 'https://fab.ejemplo.com',
        socketPath: sockInsecure,
      });
    }).toThrow('Directorio de socket inseguro');

    // 2. Fichero regular existente no se sobrescribe ni se destruye
    const victimFile = join(tempDir, 'archivo-importante.txt');
    writeFileSync(victimFile, 'contenido-critico');
    expect(() => {
      startWeb(stateDir, 0, {
        server: true,
        publicOrigin: 'https://fab.ejemplo.com',
        socketPath: victimFile,
      });
    }).toThrow('ya existe un archivo regular');
    expect(existsSync(victimFile)).toBe(true);
    expect(readFileSync(victimFile, 'utf8')).toBe('contenido-critico');

    // 3. Directorio creado automáticamente por fab tiene permisos restringidos (0770)
    const autoDir = join(tempDir, 'auto-created', 'nested');
    const sockAuto = join(autoDir, 'fab.sock');
    const serverAuto = startWeb(stateDir, 0, {
      server: true,
      publicOrigin: 'https://fab.ejemplo.com',
      socketPath: sockAuto,
    });
    expect(statSync(sockAuto).isSocket()).toBe(true);
    expect((statSync(autoDir).mode & 0o777).toString(8)).toBe('770');
    serverAuto.stop(true);

    // 4. Segunda instancia no puede usurpar un socket activo de otra instancia viva
    const liveDir = join(tempDir, 'live-sock-dir');
    mkdirSync(liveDir, { mode: 0o770 });
    const liveSock = join(liveDir, 'live.sock');
    const server1 = startWeb(stateDir, 0, {
      server: true,
      publicOrigin: 'https://fab.ejemplo.com',
      socketPath: liveSock,
    });

    expect(() => {
      startWeb(stateDir, 0, {
        server: true,
        publicOrigin: 'https://fab.ejemplo.com',
        socketPath: liveSock,
      });
    }).toThrow('Socket Unix en uso: ya existe una instancia activa');

    // La primera instancia sigue funcionando
    const resLive = await fetch('http://localhost/healthz', {
      unix: liveSock,
      headers: { Host: 'fab.ejemplo.com' },
    } as any);
    expect(resLive.status).toBe(200);

    server1.stop(true);
  });

  test('Transporte D-4 Opción A: mTLS en Docker rechaza clientes sin cert y admite cert de CA (T118-H3)', async () => {
    const tlsDir = join(tempDir, 'tls');
    mkdirSync(tlsDir, { recursive: true });

    // CA dedicada para clientes (Caddy)
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tlsDir}/client-ca.key -out ${tlsDir}/client-ca.crt -days 30 -subj "/CN=FabClientCA"`, { stdio: 'ignore' });
    // CA dedicada para servidores backend y workers internos
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tlsDir}/server-ca.key -out ${tlsDir}/server-ca.crt -days 30 -subj "/CN=FabServerCA"`, { stdio: 'ignore' });

    // Servidor cert (firmado por server-ca, con serverAuth)
    execSync(`openssl req -newkey rsa:2048 -nodes -keyout ${tlsDir}/server.key -out ${tlsDir}/server.csr -subj "/CN=fab-backend"`, { stdio: 'ignore' });
    execSync(`openssl x509 -req -in ${tlsDir}/server.csr -CA ${tlsDir}/server-ca.crt -CAkey ${tlsDir}/server-ca.key -CAcreateserial -out ${tlsDir}/server.crt -days 30`, { stdio: 'ignore' });

    // Cliente Caddy cert (firmado por client-ca, con clientAuth)
    execSync(`openssl req -newkey rsa:2048 -nodes -keyout ${tlsDir}/client.key -out ${tlsDir}/client.csr -subj "/CN=caddy"`, { stdio: 'ignore' });
    execSync(`openssl x509 -req -in ${tlsDir}/client.csr -CA ${tlsDir}/client-ca.crt -CAkey ${tlsDir}/client-ca.key -CAcreateserial -out ${tlsDir}/client.crt -days 30`, { stdio: 'ignore' });

    // Identidad ajena / worker (firmado por server-ca, no por client-ca)
    execSync(`openssl req -newkey rsa:2048 -nodes -keyout ${tlsDir}/worker.key -out ${tlsDir}/worker.csr -subj "/CN=worker-ajeno"`, { stdio: 'ignore' });
    execSync(`openssl x509 -req -in ${tlsDir}/worker.csr -CA ${tlsDir}/server-ca.crt -CAkey ${tlsDir}/server-ca.key -CAcreateserial -out ${tlsDir}/worker.crt -days 30`, { stdio: 'ignore' });

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
        ca: `${tlsDir}/client-ca.crt`,
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
        ca: readFileSync(`${tlsDir}/server-ca.crt`),
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

    // 3. Cliente con identidad ajena (worker-ajeno firmado por server-ca) -> rechazado en handshake
    const resWorker = await requestHttps({
      cert: readFileSync(`${tlsDir}/worker.crt`),
      key: readFileSync(`${tlsDir}/worker.key`),
    });
    expect(resWorker.error).toBeDefined();

    // 4. Servidor backend intentando actuar como cliente -> rechazado en handshake
    const resServerAsClient = await requestHttps({
      cert: readFileSync(`${tlsDir}/server.crt`),
      key: readFileSync(`${tlsDir}/server.key`),
    });
    expect(resServerAsClient.error).toBeDefined();

    // 5. Cliente con certificado válido firmado por client-ca (Caddy) -> aceptado 200 OK
    const resValido = await requestHttps({
      cert: readFileSync(`${tlsDir}/client.crt`),
      key: readFileSync(`${tlsDir}/client.key`),
    });
    expect(resValido.status).toBe(200);
    expect(resValido.data).toBe('ok');

    server.stop(true);

    // 6. Intentar pasar requestCert: false o rejectUnauthorized: false no desactiva la protección
    const serverHardened = startWeb(stateDir, 0, {
      server: true,
      publicOrigin: 'https://fab.ejemplo.com',
      tls: {
        cert: `${tlsDir}/server.crt`,
        key: `${tlsDir}/server.key`,
        ca: `${tlsDir}/client-ca.crt`,
        ...({ requestCert: false, rejectUnauthorized: false } as any),
      },
    });
    const portHardened = serverHardened.port;
    const reqNoAuth = https.request({
      hostname: 'localhost',
      port: portHardened,
      path: '/healthz',
      method: 'GET',
      headers: { Host: 'fab.ejemplo.com' },
      ca: readFileSync(`${tlsDir}/server-ca.crt`),
      checkServerIdentity: () => undefined,
    });
    const errHardened = await new Promise<string | undefined>(resolve => {
      reqNoAuth.on('error', e => resolve(e.message));
      reqNoAuth.on('response', () => resolve(undefined));
      reqNoAuth.end();
    });
    expect(errHardened).toBeDefined(); // Debe seguir rechazando conexiones sin certificado
    serverHardened.stop(true);
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

  test('T118-H2: Modo servidor sin socket ni mTLS se niega a arrancar (falla cerrado)', async () => {
    // 1. startWeb sin socket ni TLS lanza excepción
    expect(() => {
      startWeb(stateDir, 0, { server: true, publicOrigin: 'https://fab.ejemplo.com' });
    }).toThrow('El modo servidor requiere socket Unix (socketPath) o mTLS completo');

    // 2. CLI webMain con --server y --tls-cert sin --tls-key ni --tls-ca termina con código 1
    const codeIncomplete = await webMain(
      ['--server', '--public-origin', 'https://fab.ejemplo.com', '--tls-cert', '/tmp/falsa.crt'],
      stateDir
    );
    expect(codeIncomplete).toBe(1);
  });

  test('T118-H7: Configuración de despliegue Docker y compose sin variables no expandidas ni colisiones de red', () => {
    const dockerfile = readFileSync(join(__dirname, '../deploy/docker/Dockerfile'), 'utf8');
    const compose = readFileSync(join(__dirname, '../deploy/docker/docker-compose.yml'), 'utf8');

    // 1. Dockerfile CMD no contiene literal sin expandir ${FAB_PUBLIC_ORIGIN}
    expect(dockerfile).not.toContain('${FAB_PUBLIC_ORIGIN}');
    expect(dockerfile).toContain('bun install --production');
    expect(dockerfile).toContain('USER bun');
    expect(dockerfile).not.toContain('groupadd -g 1000');

    // 2. docker-compose.yml cuenta con red pública para Caddy y red interna para backend
    expect(compose).toContain('fab-public');
    expect(compose).toContain('fab-internal');
    expect(compose).toContain('internal: true');
  });

  test('T118-H8: Rechazo estricto de publicOrigin no canónico', () => {
    const invalidOrigins = [
      'https://fab.ejemplo.com/ruta',
      'https://fab.ejemplo.com/',
      'https://FAB.ejemplo.com',
      'https://fab.ejemplo.com:443',
      'https://user:pass@fab.ejemplo.com',
      'https://localhost',
      'https://127.0.0.1',
      'https://fab.ejemplo.com?x=1',
      'https://fab.ejemplo.com#fragmento',
      'https://',
    ];

    for (const origin of invalidOrigins) {
      expect(() => {
        validateServerConfig({ server: true, publicOrigin: origin });
      }).toThrow();
    }

    // Orígenes válidos y canónicos
    const valid1 = validateServerConfig({ server: true, publicOrigin: 'https://fab.ejemplo.com' });
    expect(valid1.canonicalHost).toBe('fab.ejemplo.com');
    expect(valid1.publicOrigin).toBe('https://fab.ejemplo.com');

    const valid2 = validateServerConfig({ server: true, publicOrigin: 'https://fab.ejemplo.com:8443' });
    expect(valid2.canonicalHost).toBe('fab.ejemplo.com:8443');
    expect(valid2.publicOrigin).toBe('https://fab.ejemplo.com:8443');
  });

  test('T118-H9: /healthz solo existe en modo servidor y devuelve 404 en modo local (M29)', async () => {
    // 1. Modo local (sin options.server) -> /healthz devuelve 404
    const localServer = startWeb(stateDir, 0, {});
    const resLocal = await fetch(`http://127.0.0.1:${localServer.port}/healthz`);
    expect(resLocal.status).toBe(404);
    localServer.stop(true);

    // 2. Modo servidor -> /healthz devuelve 200 'ok'
    const socketPath = join(tempDir, 'healthz-test.sock');
    const serverMode = startWeb(stateDir, 0, {
      server: true,
      publicOrigin: 'https://fab.ejemplo.com',
      socketPath,
    });
    const resServer = await fetch('http://localhost/healthz', {
      unix: socketPath,
      headers: { Host: 'fab.ejemplo.com' },
    } as any);
    expect(resServer.status).toBe(200);
    expect(await resServer.text()).toBe('ok');
    serverMode.stop(true);
  });

  test('T118-H10: Cableado de server en performAction/webAction rechaza modo legacy en acceso', async () => {
    const store = new Store(join(stateDir, 'fabrica.db'));
    const ws = store.createWorkstream({ slug: 'ws-acc', goal: 'G', repo: 'R' });
    store.close();

    // 1. En servidor (server: true) -> performAction rechaza mode: legacy
    expect(async () => {
      await performAction(stateDir, 'workstreams/acceso', ws.id, { kind: 'env', mode: 'legacy' }, 'web', undefined, { server: true });
    }).toThrow('El modo servidor exige modo declarado (no se permite legacy)');

    // 2. En local (server: false / undefined) -> performAction acepta mode: legacy
    const out = await performAction(stateDir, 'workstreams/acceso', ws.id, { kind: 'env', mode: 'legacy' }, 'web', undefined);
    expect(out.result).toBe('ok');
  });

  test('T118-H11: fab.service gestiona directamente el socket sin unidad fab.socket redundante', () => {
    // 1. fab.socket no debe existir en deploy/systemd
    expect(existsSync(join(__dirname, '../deploy/systemd/fab.socket'))).toBe(false);

    // 2. fab.service define RuntimeDirectory=fab y RuntimeDirectoryMode=0770
    const serviceContent = readFileSync(join(__dirname, '../deploy/systemd/fab.service'), 'utf8');
    expect(serviceContent).toContain('RuntimeDirectory=fab');
    expect(serviceContent).toContain('RuntimeDirectoryMode=0770');
    expect(serviceContent).toContain('UMask=0007');
  });

  test('T118-H12: Caddyfile protege /healthz con 404, deduplica HSTS y fija límites de petición', () => {
    const caddyfile = readFileSync(join(__dirname, '../deploy/caddy/Caddyfile'), 'utf8');

    // 1. /healthz público responde 404
    expect(caddyfile).toContain('handle /healthz');
    expect(caddyfile).toContain('respond 404');

    // 2. Límites de tamaño de cuerpo
    expect(caddyfile).toContain('request_body');
    expect(caddyfile).toContain('max_size 10MB');

    // 3. No duplica Strict-Transport-Security en header_down
    expect(caddyfile).not.toContain('header_down Strict-Transport-Security');
    // Aparece una sola vez en el bloque de cabeceras
    const hstsMatches = caddyfile.match(/Strict-Transport-Security/g);
    expect(hstsMatches?.length).toBe(1);
  });

  test('T118-H13: En modo servidor no se emite WebAuth ni loginUrl efímero', () => {
    // 1. Modo servidor con --write: loginUrl debe ser undefined
    const socketPath = join(tempDir, 'h13-server.sock');
    const serverInstance = startWeb(stateDir, 0, {
      server: true,
      write: true,
      publicOrigin: 'https://fab.ejemplo.com',
      socketPath,
    });
    expect(serverInstance.loginUrl).toBeUndefined();
    expect(serverInstance.host).toBeUndefined();
    serverInstance.stop(true);

    // 2. Modo local con --write: loginUrl debe generarse con token
    const localInstance = startWeb(stateDir, 0, { write: true });
    expect(typeof localInstance.loginUrl).toBe('string');
    expect(localInstance.loginUrl).toContain('fab-');
    expect(localInstance.loginUrl).toContain('token=');
    localInstance.stop(true);
  });
});
